import { startPcmCapture, type PcmCapture } from '../audio/pcmCapture'
import type { ClientMsg, ServerMsg, VoiceMode } from './protocol'
import { parseServerMsg } from './protocol'
import type { Fatal } from './flags'
import { wsUrl } from './urls'

/**
 * The one connection to the backend, and the microphone that feeds it.
 *
 * A module singleton rather than a hook, for a reason that is not stylistic:
 * every socket open creates a real Hermes gateway session server-side and loads
 * an openWakeWord model. StrictMode runs effects mount → cleanup → mount, so a
 * hook would open two of each on every page load. Refcounting alone does not fix
 * that — the count genuinely reaches zero in between — hence the deferred close.
 */

/** Long enough to bridge a StrictMode remount or an HMR swap, short enough that
 *  a real disconnect still feels immediate. */
const DEFERRED_CLOSE_MS = 300
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000]
/** Nominal frame rate: 16000 / 1280 = 12.5 per second. */
const EXPECTED_FPS = 12.5
const MIC_WATCHDOG_MS = 2000

export interface SocketHandlers {
  onMessage: (msg: ServerMsg) => void
  onAudio: (mp3: ArrayBuffer) => void
  onSocketState: (s: 'connecting' | 'open' | 'closed') => void
  onFatal: (f: Fatal | null) => void
  onMic: (state: 'off' | 'starting' | 'live' | 'silent') => void
  onRetry: (ms: number | null) => void
}

let handlers: SocketHandlers | null = null
let ws: WebSocket | null = null
let capture: PcmCapture | null = null
/** Fixed for the life of the socket; the server reads it at accept time. */
let mode: VoiceMode = 'wake'
/** Invalidates a getUserMedia still in flight from a superseded start. */
let captureGen = 0
/**
 * A talk requested before the socket finished opening.
 *
 * Mic mode makes the talk control self-sufficient — pressing it brings the
 * session up rather than requiring the power button first — so the press
 * routinely lands a few hundred ms ahead of the connection.
 */
let pendingTalk = false

let refs = 0
let closeTimer: ReturnType<typeof setTimeout> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let retryAt = 0
/** Invalidates async work from a superseded connect attempt. */
let generation = 0
/** True once the user has deliberately stopped: suppresses reconnect. */
let userClosed = false
/**
 * A failure that retrying cannot fix, so the close that follows must not be
 * treated as a dropped connection.
 *
 * `wake.error` is the case: it comes from loading the wake model, which either
 * works or does not, and the server closes immediately after sending it.
 * Without this the socket would relabel it "connection lost", overwrite the real
 * explanation, and reconnect on a loop forever.
 */
let terminal = false
let sawListening = false
let frames = 0
let micTimer: ReturnType<typeof setInterval> | undefined

export function install(h: SocketHandlers) {
  handlers = h
}

/** Only meaningful for the composer: text is dropped if this is false. */
export function isOpen(): boolean {
  return ws?.readyState === WebSocket.OPEN
}

/**
 * The capture graph's analyser, or null when no session is up.
 *
 * A getter rather than a stored value: the graph is rebuilt on every reconnect,
 * so anything holding a reference would silently read a dead node.
 */
export function captureAnalyser(): AnalyserNode | null {
  return capture?.analyser ?? null
}

function send(msg: ClientMsg): boolean {
  if (!isOpen()) return false
  ws!.send(JSON.stringify(msg))
  return true
}

export const sendText = (text: string) => send({ type: 'text', text })
export const sendApproval = (choice: string) => send({ type: 'approval', choice })

/**
 * Open or close a capture directly.
 *
 * In wake mode this is the second way in, for when saying it out loud is the
 * wrong move or the detector simply didn't hear you. In mic mode it is the only
 * way in. Either way the server turns its endpointer off for the duration, so
 * `false` is the only thing that ends it.
 *
 * An open that lands before the socket does is held and replayed on connect,
 * rather than dropped — otherwise the first press of a mic-mode session, which
 * is also the press that opens the socket, would silently do nothing.
 */
export function sendTalk(on: boolean) {
  if (send({ type: 'talk', on })) return
  pendingTalk = on
}

function startMicWatchdog() {
  clearInterval(micTimer)
  frames = 0
  micTimer = setInterval(() => {
    const expected = (EXPECTED_FPS * MIC_WATCHDOG_MS) / 1000
    // Half the nominal rate is generous — the worklet is steady, so a real
    // shortfall means the graph has stalled rather than jittered.
    const live = frames >= expected * 0.5
    frames = 0
    handlers?.onMic(live ? 'live' : 'silent')
  }, MIC_WATCHDOG_MS)
}

/**
 * Opens the microphone and starts streaming frames. Resolves false if it failed
 * or was superseded, so the caller can decline to announce a capture that has
 * no audio behind it.
 *
 * Separate from `open()` because the two modes want different lifetimes for it.
 * Wake mode needs it running for the whole session — the detector has nothing
 * to listen to otherwise. Mic mode opens it per press and closes it again, so
 * the tab's recording indicator is dark whenever Nova is not being spoken to.
 */
export async function startCapture(): Promise<boolean> {
  if (capture) return true
  const gen = ++captureGen
  handlers?.onMic('starting')

  try {
    const cap = await startPcmCapture((pcm) => {
      frames++
      if (ws?.readyState === WebSocket.OPEN) ws.send(pcm)
    })
    // The await above can resolve after a stop. Without this check the
    // MediaStream is orphaned: the tab's recording indicator stays on and a
    // dead capture keeps posting frames.
    if (gen !== captureGen) {
      cap.stop()
      return false
    }
    capture = cap
    // Only clear a fatal if one is not already standing: getUserMedia resolves
    // asynchronously, so a wake.error that arrived while the permission prompt
    // was open would otherwise have its explanation wiped out here.
    if (!terminal) handlers?.onFatal(null)
    handlers?.onMic('live')
    startMicWatchdog()

    const track = cap.stream.getAudioTracks()[0]
    if (track) {
      track.onmute = () => handlers?.onMic('silent')
      track.onunmute = () => handlers?.onMic('live')
      track.onended = () =>
        handlers?.onFatal({ kind: 'mic-lost', message: 'The microphone went away.' })
    }
    return true
  } catch (err) {
    if (gen !== captureGen) return false
    handlers?.onMic('off')
    const name = err instanceof DOMException ? err.name : ''
    handlers?.onFatal(
      name === 'NotAllowedError' || name === 'SecurityError'
        ? {
            kind: 'mic-denied',
            message:
              'Microphone access was denied. Nova can still be typed to, but she cannot hear you.',
          }
        : {
            kind: 'mic-lost',
            message: `No usable microphone: ${err instanceof Error ? err.message : String(err)}`,
          },
    )
    return false
  }
}

/** Closes the microphone. `off` rather than `starting`: nothing is coming. */
export function stopCapture() {
  captureGen++
  clearInterval(micTimer)
  micTimer = undefined
  capture?.stop()
  capture = null
  handlers?.onMic('off')
}

function scheduleRetry(attempt: number) {
  const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
  // Jitter so several tabs don't stampede the backend in lockstep.
  const jittered = delay + Math.floor(Math.random() * 250)
  retryAt = Date.now() + jittered
  handlers?.onRetry(jittered)
  clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    handlers?.onRetry(null)
    void open(attempt + 1)
  }, jittered)
}

/** Remaining ms before the next attempt, for the HUD. */
export function retryRemaining(): number | null {
  if (!retryTimer) return null
  return Math.max(0, retryAt - Date.now())
}

async function open(attempt = 0) {
  if (ws) return
  const gen = ++generation
  userClosed = false
  terminal = false
  sawListening = false
  handlers?.onSocketState('connecting')

  const sock = new WebSocket(wsUrl(mode))
  // Default is 'blob', and with 'blob' the ArrayBuffer branch below never fires:
  // every MP3 would be dropped with no error anywhere. Set before anything else.
  sock.binaryType = 'arraybuffer'

  // Assigned synchronously, never inside onopen. The server pushes
  // hermes.connected / hermes.error and wake.listening the instant it accepts;
  // a handler attached later misses them and the UI waits forever on a healthy
  // socket.
  sock.onmessage = (e) => {
    if (gen !== generation) return
    if (e.data instanceof ArrayBuffer) {
      handlers?.onAudio(e.data)
      return
    }
    if (e.data instanceof Blob) {
      // Unreachable with binaryType set, but a future refactor must not be able
      // to silently re-break audio.
      void e.data.arrayBuffer().then((b) => handlers?.onAudio(b))
      return
    }
    if (typeof e.data !== 'string') return
    const msg = parseServerMsg(e.data)
    if (!msg) return
    if (msg.type === 'wake.listening') sawListening = true
    // Noted here rather than in the adapter, because this is where the
    // reconnect decision is made.
    if (msg.type === 'wake.error') terminal = true
    handlers?.onMessage(msg)
  }

  sock.onopen = () => {
    if (gen !== generation) return
    handlers?.onSocketState('open')
    handlers?.onRetry(null)
    // A talk pressed while this was still connecting. Replayed rather than
    // dropped, because in mic mode that press is what opened the socket.
    if (pendingTalk) {
      pendingTalk = false
      send({ type: 'talk', on: true })
    }
  }

  sock.onclose = () => {
    if (gen !== generation) return
    ws = null
    pendingTalk = false
    // In either mode: a capture whose socket has gone is streaming into
    // nothing, and the server it reconnects to starts back at ARMED.
    stopCapture()
    handlers?.onSocketState('closed')

    // A terminal failure has already explained itself; retrying would loop
    // forever and overwrite that explanation with "connection lost".
    if (userClosed || refs === 0 || terminal) return
    if (!sawListening && attempt >= BACKOFF_MS.length - 1) {
      handlers?.onFatal({
        kind: 'unreachable',
        message: 'The voice backend is not responding on :8000.',
      })
      return
    }
    handlers?.onFatal({ kind: 'dropped', message: 'Connection lost.' })
    scheduleRetry(attempt)
  }

  ws = sock

  // Wake mode needs the capture up for the whole session — the detector is the
  // only thing listening, and it cannot hear a microphone that is closed. Doing
  // it here rather than in onopen keeps the permission prompt at a predictable
  // moment; frames are dropped until the socket is actually open.
  //
  // Mic mode deliberately does not: there, the talk control owns the microphone
  // and nothing should be recorded until it is pressed.
  if (mode === 'wake') {
    await startCapture()
    // A start that resolved after the session was released leaves the
    // MediaStream live and the tab's recording indicator on.
    if (gen !== generation || refs === 0) stopCapture()
  }
}

function reallyClose() {
  generation++
  clearTimeout(retryTimer)
  retryTimer = undefined
  pendingTalk = false
  handlers?.onRetry(null)
  stopCapture()
  if (ws) {
    const sock = ws
    ws = null
    // `stop` lets the server tear the Hermes session down cleanly rather than
    // waiting for the disconnect. It sends no reply, so don't wait for one.
    if (sock.readyState === WebSocket.OPEN) {
      try {
        sock.send(JSON.stringify({ type: 'stop' } satisfies ClientMsg))
      } catch {
        /* closing anyway */
      }
    }
    sock.onclose = null
    sock.close()
  }
  handlers?.onSocketState('closed')
}

/**
 * Refcounted. The first acquire opens; the last release closes, eventually.
 *
 * `next` is only read when a socket is actually opened. Changing modes mid
 * session would mean reconnecting, which means a fresh Hermes session with no
 * memory of this one — so the control that sets it is disabled while a session
 * is up rather than silently wiping the conversation here.
 */
export function acquire(next: VoiceMode) {
  refs++
  clearTimeout(closeTimer)
  closeTimer = undefined
  if (!ws) {
    mode = next
    void open()
  }
}

export function release() {
  refs = Math.max(0, refs - 1)
  if (refs > 0) return
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => {
    closeTimer = undefined
    if (refs === 0) reallyClose()
  }, DEFERRED_CLOSE_MS)
}

/** An explicit user disconnect: no reconnect, no fatal banner. */
export function disconnect() {
  userClosed = true
  refs = 0
  clearTimeout(closeTimer)
  closeTimer = undefined
  reallyClose()
  handlers?.onFatal(null)
}

/** Retry now, from a user gesture. */
export function reconnectNow() {
  clearTimeout(retryTimer)
  retryTimer = undefined
  handlers?.onRetry(null)
  handlers?.onFatal(null)
  if (refs === 0) refs = 1
  if (!ws) void open()
}
