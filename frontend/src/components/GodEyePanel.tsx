import { useEffect, useState } from "react";

interface Detection {
  name: string;
  score: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function GodEyePanel({ open, onClose }: Props) {
  // Bumped on every open so the browser starts a fresh MJPEG connection
  // instead of reusing a dead one.
  const [streamKey, setStreamKey] = useState(0);
  const [failed, setFailed] = useState(false);
  const [detections, setDetections] = useState<Detection[]>([]);

  useEffect(() => {
    if (!open) return;
    setFailed(false);
    setStreamKey((k) => k + 1);
  }, [open]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Poll what the detector currently sees
  useEffect(() => {
    if (!open) {
      setDetections([]);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/camera/detections");
        const data = await res.json();
        if (!cancelled) setDetections(data.detections ?? []);
      } catch {
        /* the <img> already reports connection trouble */
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open]);

  if (!open) return null;

  const counts = detections.reduce<Record<string, number>>((acc, d) => {
    acc[d.name] = (acc[d.name] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.frame} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={styles.titleRow}>
            <span style={styles.dot} />
            <span style={styles.title}>GOD EYE</span>
          </div>
          <div style={styles.headerRight}>
            {Object.entries(counts).map(([name, n]) => (
              <span key={name} style={styles.chip}>
                {name}
                {n > 1 ? ` ×${n}` : ""}
              </span>
            ))}
            <button style={styles.close} onClick={onClose} title="Close (Esc)">
              ✕
            </button>
          </div>
        </div>

        <div style={styles.stage}>
          {failed ? (
            <div style={styles.error}>
              <div style={{ fontSize: 16, marginBottom: 12 }}>
                Camera stream unavailable
              </div>
              <div style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>
                Is the camera service running on :8001?
              </div>
              <button
                style={styles.retry}
                onClick={() => {
                  setFailed(false);
                  setStreamKey((k) => k + 1);
                }}
              >
                Retry
              </button>
            </div>
          ) : (
            <img
              key={streamKey}
              src={`/camera/mjpeg?t=${streamKey}`}
              alt="God Eye live feed"
              style={styles.video}
              onError={() => setFailed(true)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    background: "rgba(0, 0, 0, 0.85)",
    backdropFilter: "blur(6px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  frame: {
    width: "min(1280px, 100%)",
    background: "#0b0b0b",
    border: "1px solid #2a3a2a",
    borderRadius: 12,
    overflow: "hidden",
    boxShadow: "0 0 60px rgba(76, 175, 80, 0.12)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 14px",
    borderBottom: "1px solid #222",
    background: "#111",
  },
  titleRow: { display: "flex", alignItems: "center", gap: 8 },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#4caf50",
    boxShadow: "0 0 8px #4caf50",
  },
  title: {
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 2,
    color: "#4caf50",
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  chip: {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 4,
    background: "#1a2a1a",
    color: "#8fce8f",
    border: "1px solid #2a4a2a",
  },
  close: {
    marginLeft: 6,
    width: 28,
    height: 28,
    borderRadius: 6,
    border: "1px solid #333",
    background: "transparent",
    color: "#aaa",
    cursor: "pointer",
    fontSize: 13,
    lineHeight: 1,
  },
  stage: {
    background: "#000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 240,
  },
  video: {
    display: "block",
    width: "100%",
    height: "auto",
    maxHeight: "calc(100vh - 140px)",
    objectFit: "contain",
  },
  error: {
    padding: 48,
    textAlign: "center",
    color: "#e0e0e0",
  },
  retry: {
    padding: "8px 18px",
    fontSize: 14,
    borderRadius: 6,
    border: "1px solid #444",
    background: "transparent",
    color: "#aaa",
    cursor: "pointer",
  },
};
