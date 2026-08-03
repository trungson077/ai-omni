import { useState, useRef, useCallback, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import GodEyePanel from "./GodEyePanel";
import { startPcmCapture, type PcmCapture } from "../audio/pcmCapture";

const TIMESLICE_MS = 250;

/** "hold" = press and hold the button. "wake" = say "hey nova". */
type Mode = "hold" | "wake";

interface Approval {
  prompt: string;
  choices: string[];
}

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  tools: string[];
  done: boolean;
}

function getWsUrl(mode: Mode): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const path = mode === "wake" ? "/api/ws/voice" : "/api/ws/stt";
  return `${proto}://${location.host}${path}`;
}

export default function ChatPanel() {
  const [connected, setConnected] = useState(false);
  const [holding, setHolding] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [level, setLevel] = useState(0);
  const [hermesStatus, setNovaStatus] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [godEye, setGodEye] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<Approval | null>(null);
  const [mode, setMode] = useState<Mode>("hold");
  const [wakeStatus, setWakeStatus] = useState("");
  const hermesOkRef = useRef(false);
  const modeRef = useRef<Mode>("hold");
  const pcmRef = useRef<PcmCapture | null>(null);
  const msgIdRef = useRef(0);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsQueueRef = useRef<ArrayBuffer[]>([]);
  const ttsPlayingRef = useRef(false);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const levelRafRef = useRef(0);
  const holdingRef = useRef(false);
  const meterActiveRef = useRef(false);

  const closeGodEye = useCallback(() => setGodEye(false), []);

  // --- Audio level polling (only while holding) ---
  const getRMS = useCallback((): number => {
    const a = analyserRef.current;
    if (!a) return 0;
    const buf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }, []);

  // Hold mode meters only while the button is down; wake mode meters the whole
  // session, since the mic is open the entire time.
  const pollLevel = useCallback(() => {
    if (!meterActiveRef.current) {
      setLevel(0);
      return;
    }
    setLevel(getRMS());
    levelRafRef.current = window.setTimeout(pollLevel, 80);
  }, [getRMS]);

  // --- TTS audio queue: play chunks sequentially ---
  const playNext = useCallback(() => {
    if (ttsPlayingRef.current) return;
    const chunk = ttsQueueRef.current.shift();
    if (!chunk) {
      setSpeaking(false);
      return;
    }
    ttsPlayingRef.current = true;
    setSpeaking(true);
    const blob = new Blob([chunk], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    ttsAudioRef.current = audio;
    const cleanup = () => {
      ttsPlayingRef.current = false;
      URL.revokeObjectURL(url);
      ttsAudioRef.current = null;
      playNext();
    };
    audio.onended = cleanup;
    audio.onerror = cleanup;
    audio.play().catch(cleanup);
  }, []);

  const enqueueTtsAudio = useCallback((audioData: ArrayBuffer) => {
    ttsQueueRef.current.push(audioData);
    playNext();
  }, [playNext]);

  // --- WebSocket message handler ---
  const handleWsMessage = useCallback((e: MessageEvent) => {
    // Binary message = TTS audio chunk
    if (e.data instanceof ArrayBuffer) {
      enqueueTtsAudio(e.data);
      return;
    }

    const data = JSON.parse(e.data);
    switch (data.type) {
      case "transcript": {
        const text = data.text?.trim();
        if (!text) break;
        const userId = ++msgIdRef.current;
        if (hermesOkRef.current) {
          const assistantId = ++msgIdRef.current;
          setMessages((prev) => [
            ...prev,
            { id: userId, role: "user", text, thinking: "", tools: [], done: true },
            { id: assistantId, role: "assistant", text: "", thinking: "", tools: [], done: false },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            { id: userId, role: "user", text, thinking: "", tools: [], done: true },
          ]);
        }
        break;
      }
      case "hermes.delta":
        setMessages((prev) => {
          const idx = findLastAssistant(prev);
          if (idx === -1) return prev;
          const u = [...prev];
          u[idx] = { ...u[idx], text: u[idx].text + (data.text || "") };
          return u;
        });
        break;
      case "hermes.complete":
        setMessages((prev) => {
          const idx = findLastAssistant(prev);
          if (idx === -1) return prev;
          const u = [...prev];
          const m = u[idx];
          u[idx] = { ...m, text: m.text || data.text || "", done: true };
          return u;
        });
        break;
      case "hermes.approval":
        setPendingApproval({
          prompt: data.prompt || "",
          choices: data.choices || ["once", "deny"],
        });
        break;
      case "hermes.approval.done":
        setPendingApproval(null);
        break;
      case "wake.listening":
        setWakeStatus(`Say "hey nova" (threshold ${data.threshold})`);
        break;
      case "wake.detected":
        setWakeStatus(`Heard you (${data.score}) — speak now`);
        break;
      case "stt.start":
        setWakeStatus("Transcribing...");
        break;
      case "wake.rearm":
        setWakeStatus('Say "hey nova"');
        break;
      case "wake.error":
        setWakeStatus(`Wake word unavailable: ${data.message}`);
        break;
      case "hermes.thinking":
        setMessages((prev) => {
          const idx = findLastAssistant(prev);
          if (idx === -1) return prev;
          const u = [...prev];
          u[idx] = { ...u[idx], thinking: data.text || "" };
          return u;
        });
        break;
      case "hermes.tool":
        // Nova drives the God Eye overlay through its MCP tools. The tool name
        // may carry a server prefix, so match loosely.
        if (data.status === "start") {
          const name: string = data.name || "";
          if (name.includes("god_eye_show")) setGodEye(true);
          else if (name.includes("god_eye_hide")) setGodEye(false);
        }
        setMessages((prev) => {
          const idx = findLastAssistant(prev);
          if (idx === -1) return prev;
          const u = [...prev];
          if (data.status === "start") {
            u[idx] = { ...u[idx], tools: [...u[idx].tools, data.name] };
          }
          return u;
        });
        break;
      case "hermes.error":
        if (!hermesOkRef.current) {
          setNovaStatus("stt-only");
          break;
        }
        setMessages((prev) => {
          const idx = findLastAssistant(prev);
          if (idx === -1) return prev;
          const u = [...prev];
          u[idx] = { ...u[idx], text: `[Error: ${data.message}]`, done: true };
          return u;
        });
        break;
      case "hermes.connected":
        hermesOkRef.current = true;
        setNovaStatus("connected");
        break;
      case "tts.start":
        setSpeaking(true);
        break;
      case "tts.complete":
        // audio playback is handled by playTtsAudio
        break;
      case "tts.error":
        setSpeaking(false);
        break;
      case "error":
        console.error("STT error:", data.message);
        break;
    }
  }, [enqueueTtsAudio]);

  // --- Connect: open WS + get mic ---
  const connect = useCallback(async () => {
    // Reset state BEFORE opening the WebSocket to avoid race with hermes.connected
    hermesOkRef.current = false;
    setNovaStatus("");
    setWakeStatus("");
    modeRef.current = mode;

    const ws = new WebSocket(getWsUrl(mode));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onmessage = handleWsMessage;
    ws.onclose = () => setConnected(false);

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket failed"));
    });

    if (mode === "wake") {
      // The backend owns detection and endpointing, so all this side does is
      // shovel PCM up the socket for as long as the session lasts.
      pcmRef.current = await startPcmCapture((pcm) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
      });
      analyserRef.current = pcmRef.current.analyser;
      meterActiveRef.current = true;
      setConnected(true);
      pollLevel();
      return;
    }

    // Explicit constraints: Nova's TTS plays through the speakers while the
    // mic may be open, so echo cancellation keeps her voice out of the capture.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    streamRef.current = stream;

    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    src.connect(analyser);
    ctxRef.current = ctx;
    analyserRef.current = analyser;

    setConnected(true);
  }, [handleWsMessage, mode, pollLevel]);

  // --- Hold: start recording ---
  const holdStart = useCallback(() => {
    const stream = streamRef.current;
    const ws = wsRef.current;
    if (!stream || !ws || ws.readyState !== WebSocket.OPEN) return;

    // Reset server buffer
    ws.send(JSON.stringify({ type: "reset" }));

    const rec = new MediaRecorder(stream, { mimeType: "audio/webm" });
    rec.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(e.data);
      }
    };
    rec.start(TIMESLICE_MS);
    recorderRef.current = rec;

    holdingRef.current = true;
    meterActiveRef.current = true;
    setHolding(true);
    pollLevel();
  }, [pollLevel]);

  // --- Release: stop recording + flush ---
  const holdEnd = useCallback(() => {
    holdingRef.current = false;
    meterActiveRef.current = false;
    setHolding(false);
    setLevel(0);
    if (levelRafRef.current) clearTimeout(levelRafRef.current);

    const rec = recorderRef.current;
    if (!rec || rec.state !== "recording") return;

    rec.onstop = () => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "flush" }));
      }
    };
    rec.stop();
  }, []);

  const answerApproval = useCallback((choice: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "approval", choice }));
    }
    setPendingApproval(null);
  }, []);

  // --- Disconnect ---
  const disconnect = useCallback(() => {
    holdingRef.current = false;
    meterActiveRef.current = false;
    setHolding(false);
    setConnected(false);
    setLevel(0);
    setSpeaking(false);
    setGodEye(false);
    setPendingApproval(null);
    setWakeStatus("");
    if (levelRafRef.current) clearTimeout(levelRafRef.current);

    pcmRef.current?.stop();
    pcmRef.current = null;
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }

    const rec = recorderRef.current;
    if (rec && rec.state === "recording") {
      rec.ondataavailable = null;
      rec.onstop = null;
      rec.stop();
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close();

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
      wsRef.current.close();
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      holdingRef.current = false;
      meterActiveRef.current = false;
      if (levelRafRef.current) clearTimeout(levelRafRef.current);
      pcmRef.current?.stop();
      if (ttsAudioRef.current) ttsAudioRef.current.pause();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      ctxRef.current?.close();
      wsRef.current?.close();
    };
  }, []);

  // Auto-scroll chat
  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chatRef.current?.scrollTo(0, chatRef.current.scrollHeight);
  }, [messages]);

  const levelPct = Math.min(level * 500, 100);

  return (
    <div style={styles.panel}>
      {/* Connect / Disconnect */}
      {!connected ? (
        <>
          {/* Mode is fixed for the session: the two paths use different
              sockets and different capture, so switching mid-call would mean
              tearing the whole thing down anyway. */}
          <div style={styles.modeRow}>
            <button
              style={mode === "hold" ? styles.modeOn : styles.modeOff}
              onClick={() => setMode("hold")}
            >
              Hold to talk
            </button>
            <button
              style={mode === "wake" ? styles.modeOn : styles.modeOff}
              onClick={() => setMode("wake")}
            >
              Wake word — "hey nova"
            </button>
          </div>
          <button style={styles.btnConnect} onClick={connect}>
            Connect
          </button>
        </>
      ) : (
        <div style={styles.btnRow}>
          <button style={styles.btnDisconnect} onClick={disconnect}>
            Disconnect
          </button>
          <span style={{ fontSize: 12, color: hermesStatus === "connected" ? "#4caf50" : "#888", alignSelf: "center" }}>
            {hermesStatus === "connected" ? "Nova connected" : hermesStatus === "stt-only" ? "STT only" : "connecting..."}
          </span>
          {speaking && (
            <span style={{ fontSize: 12, color: "#ff9800", alignSelf: "center", fontWeight: 600 }}>
              Speaking...
            </span>
          )}
          <button
            style={{ ...styles.btnDisconnect, marginLeft: "auto" }}
            onClick={() => setGodEye((v) => !v)}
            title="Nova opens this by voice; this button is for testing"
          >
            God Eye
          </button>
        </div>
      )}

      {/* Approval prompt — Hermes blocks until this is answered */}
      {pendingApproval && (
        <div style={styles.approval}>
          <div style={styles.approvalLabel}>Hermes needs approval</div>
          <div style={styles.approvalPrompt}>{pendingApproval.prompt}</div>
          <div style={styles.approvalRow}>
            {pendingApproval.choices.map((c) => (
              <button
                key={c}
                style={c === "deny" ? styles.btnDeny : styles.btnApprove}
                onClick={() => answerApproval(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Wake-word mode: the loop runs itself, so there is nothing to press */}
      {connected && mode === "wake" && (
        <>
          <div style={styles.wakeBanner}>{wakeStatus || "Starting..."}</div>
          <div style={styles.levelTrack}>
            <div
              style={{
                height: "100%",
                width: `${levelPct}%`,
                background: "#03a9f4",
                borderRadius: 4,
                transition: "width 80ms",
              }}
            />
          </div>
        </>
      )}

      {/* Hold-to-talk button */}
      {connected && mode === "hold" && (
        <>
          <button
            style={holding ? styles.btnHolding : styles.btnHold}
            onMouseDown={holdStart}
            onMouseUp={holdEnd}
            onMouseLeave={holding ? holdEnd : undefined}
            onTouchStart={(e) => { e.preventDefault(); holdStart(); }}
            onTouchEnd={(e) => { e.preventDefault(); holdEnd(); }}
          >
            {holding ? "Release to send" : "Hold to talk"}
          </button>

          {/* Level bar */}
          <div style={styles.levelTrack}>
            <div
              style={{
                height: "100%",
                width: `${levelPct}%`,
                background: holding ? "#4caf50" : "#555",
                borderRadius: 4,
                transition: "width 80ms",
              }}
            />
          </div>
        </>
      )}

      {/* Chat messages */}
      <div ref={chatRef} style={styles.chat}>
        {messages.length === 0 && (
          <span style={{ color: "#555" }}>
            {connected ? "Hold the button and speak..." : "Press Connect to begin"}
          </span>
        )}
        {messages.map((msg) => (
          <div key={msg.id} style={msg.role === "user" ? styles.userMsg : styles.assistantMsg}>
            <div style={styles.roleLabel}>{msg.role === "user" ? "You" : "Nova"}</div>
            {msg.role === "assistant" && msg.thinking && (
              <div style={styles.thinking}>thinking: {msg.thinking}</div>
            )}
            {msg.role === "assistant" && msg.tools.length > 0 && (
              <div style={styles.toolList}>
                {msg.tools.map((t, i) => (
                  <span key={i} style={styles.toolBadge}>{t}</span>
                ))}
              </div>
            )}
            <div style={styles.msgText}>
              {msg.text ? (
                msg.role === "assistant" ? (
                  <ReactMarkdown components={mdComponents}>{msg.text}</ReactMarkdown>
                ) : (
                  msg.text
                )
              ) : (
                !msg.done && <span style={styles.typing}>...</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {messages.length > 0 && (
        <button style={styles.btnClear} onClick={() => setMessages([])}>
          Clear
        </button>
      )}

      <GodEyePanel open={godEye} onClose={closeGodEye} />
    </div>
  );
}

function findLastAssistant(msgs: ChatMessage[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") return i;
  }
  return -1;
}

const mdComponents: Record<string, React.FC<React.HTMLAttributes<HTMLElement>>> = {
  p: ({ children, ...props }) => <p style={{ margin: "0.4em 0" }} {...props}>{children}</p>,
  code: ({ children, className, ...props }) => {
    const isBlock = className?.includes("language-");
    return isBlock ? (
      <pre style={{
        background: "#0d0d0d", borderRadius: 6, padding: "12px 14px",
        overflowX: "auto", fontSize: 13, lineHeight: 1.5, margin: "8px 0",
        border: "1px solid #333",
      }}>
        <code {...props}>{children}</code>
      </pre>
    ) : (
      <code style={{
        background: "#333", borderRadius: 3, padding: "1px 5px", fontSize: 13,
      }} {...props}>{children}</code>
    );
  },
  pre: ({ children }) => <>{children}</>,
  ul: ({ children, ...props }) => <ul style={{ margin: "0.4em 0", paddingLeft: 20 }} {...props}>{children}</ul>,
  ol: ({ children, ...props }) => <ol style={{ margin: "0.4em 0", paddingLeft: 20 }} {...props}>{children}</ol>,
  li: ({ children, ...props }) => <li style={{ marginBottom: 2 }} {...props}>{children}</li>,
  h1: ({ children, ...props }) => <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0.5em 0 0.3em" }} {...props}>{children}</h1>,
  h2: ({ children, ...props }) => <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0.5em 0 0.3em" }} {...props}>{children}</h2>,
  h3: ({ children, ...props }) => <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0.4em 0 0.2em" }} {...props}>{children}</h3>,
  blockquote: ({ children, ...props }) => (
    <blockquote style={{
      borderLeft: "3px solid #555", paddingLeft: 12, margin: "0.4em 0",
      color: "#aaa", fontStyle: "italic",
    }} {...props}>{children}</blockquote>
  ),
  a: ({ children, ...props }) => <a style={{ color: "#7cacf8" }} target="_blank" rel="noreferrer" {...props}>{children}</a>,
  table: ({ children, ...props }) => (
    <div style={{ overflowX: "auto", margin: "8px 0" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }} {...props}>{children}</table>
    </div>
  ),
  th: ({ children, ...props }) => <th style={{ border: "1px solid #444", padding: "6px 10px", background: "#2a2a2a", textAlign: "left" }} {...props}>{children}</th>,
  td: ({ children, ...props }) => <td style={{ border: "1px solid #444", padding: "6px 10px" }} {...props}>{children}</td>,
};

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: "#1e1e1e",
    borderRadius: 12,
    padding: 24,
    border: "1px solid #333",
  },
  btnRow: {
    display: "flex", gap: 12, alignItems: "center",
  },
  btnConnect: {
    width: "100%", padding: 16, fontSize: 18, fontWeight: 600,
    border: "none", borderRadius: 8, cursor: "pointer",
    color: "#fff", background: "#646cff",
  },
  btnDisconnect: {
    padding: "10px 20px", fontSize: 14, fontWeight: 600,
    border: "1px solid #444", borderRadius: 8, cursor: "pointer",
    color: "#aaa", background: "#333",
  },
  modeRow: { display: "flex", gap: 8, marginBottom: 12 },
  modeOn: {
    flex: 1, padding: "10px 12px", fontSize: 13, fontWeight: 600,
    cursor: "pointer", borderRadius: 8,
    border: "1px solid #646cff", color: "#fff", background: "#646cff33",
  },
  modeOff: {
    flex: 1, padding: "10px 12px", fontSize: 13, fontWeight: 600,
    cursor: "pointer", borderRadius: 8,
    border: "1px solid #444", color: "#888", background: "transparent",
  },
  wakeBanner: {
    marginTop: 16, padding: "14px 16px", fontSize: 15, fontWeight: 600,
    textAlign: "center" as const, borderRadius: 10,
    border: "1px solid #03a9f4", color: "#03a9f4", background: "#03a9f411",
  },
  approval: {
    marginTop: 16, padding: "12px 14px", background: "#2a2410",
    border: "1px solid #6b5a1f", borderRadius: 8,
  },
  approvalLabel: {
    fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const,
    color: "#e0b32c", marginBottom: 6, letterSpacing: 0.5,
  },
  approvalPrompt: {
    fontSize: 14, color: "#e0e0e0", marginBottom: 10,
    wordBreak: "break-word" as const,
  },
  approvalRow: { display: "flex", gap: 8, flexWrap: "wrap" as const },
  btnApprove: {
    padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
    border: "1px solid #4caf50", borderRadius: 6,
    color: "#fff", background: "#2e7d32",
  },
  btnDeny: {
    padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
    border: "1px solid #555", borderRadius: 6,
    color: "#ccc", background: "transparent",
  },
  btnHold: {
    width: "100%", padding: 24, marginTop: 16, fontSize: 20, fontWeight: 700,
    border: "2px solid #646cff", borderRadius: 12, cursor: "pointer",
    color: "#646cff", background: "transparent",
    userSelect: "none" as const, WebkitUserSelect: "none" as const,
  },
  btnHolding: {
    width: "100%", padding: 24, marginTop: 16, fontSize: 20, fontWeight: 700,
    border: "2px solid #4caf50", borderRadius: 12, cursor: "pointer",
    color: "#fff", background: "#4caf5033",
    userSelect: "none" as const, WebkitUserSelect: "none" as const,
  },
  levelTrack: {
    marginTop: 8, height: 6, background: "#333",
    borderRadius: 4, overflow: "hidden",
  },
  chat: {
    marginTop: 20, padding: 16, background: "#111",
    borderRadius: 8, minHeight: 200, maxHeight: 500,
    overflowY: "auto" as const, border: "1px solid #333",
    display: "flex", flexDirection: "column" as const, gap: 16,
  },
  userMsg: {
    alignSelf: "flex-end" as const, maxWidth: "80%",
    background: "#2a2a5a", borderRadius: "12px 12px 4px 12px",
    padding: "10px 14px",
  },
  assistantMsg: {
    alignSelf: "flex-start" as const, maxWidth: "80%",
    background: "#2a2a2a", borderRadius: "12px 12px 12px 4px",
    padding: "10px 14px",
  },
  roleLabel: {
    fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const,
    color: "#888", marginBottom: 4, letterSpacing: 0.5,
  },
  msgText: {
    fontSize: 15, lineHeight: 1.6, color: "#e0e0e0",
  },
  thinking: {
    fontSize: 12, color: "#888", fontStyle: "italic" as const,
    marginBottom: 4, borderLeft: "2px solid #555", paddingLeft: 8,
  },
  toolList: {
    display: "flex", gap: 4, flexWrap: "wrap" as const, marginBottom: 6,
  },
  toolBadge: {
    fontSize: 11, padding: "2px 8px", borderRadius: 4,
    background: "#333", color: "#aaa", border: "1px solid #444",
  },
  typing: {
    color: "#888", fontStyle: "italic" as const,
  },
  btnClear: {
    marginTop: 12, padding: "8px 16px", fontSize: 14,
    border: "1px solid #444", borderRadius: 6, cursor: "pointer",
    color: "#aaa", background: "transparent",
  },
};
