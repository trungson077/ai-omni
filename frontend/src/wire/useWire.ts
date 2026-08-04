import { useEffect } from 'react'
import { subscribe } from '../core/ticker'
import { useSettingsStore } from '../state/useSettingsStore'
import { level, WAKE_DECAY_MS } from '../voice/level'
import type { TtsPlayer } from '../audio/ttsPlayer'
import { installAdapter, setMode } from './adapter'
import { acquire, captureAnalyser, release, sendTalk, startCapture, stopCapture } from './socket'

/**
 * Installed at module scope rather than in an effect, so StrictMode's
 * double-mount cannot build two players or two sets of socket handlers.
 */
export const player: TtsPlayer = installAdapter()

/**
 * Brings the session up. Must be called inside a user gesture, synchronously.
 *
 * The ordering is the whole trick: `unlock()` has to happen before the first
 * `await` in the gesture's task, because after `await getUserMedia(...)` the
 * browser no longer treats the context as user-activated and the audio unlock
 * silently fails. It fails only on iOS, so it survives every desktop test.
 */
export function armSession() {
  player.unlock()
  useSettingsStore.getState().setSession(true)
}

export function disarmSession() {
  player.flush()
  useSettingsStore.getState().setMicLatched(false)
  useSettingsStore.getState().setSession(false)
}

/**
 * The wake-word control. Neither mode button is behind the other, or behind the
 * power button: each brings a session up in its own mode.
 *
 * Pressing this while a mic-mode session is up is a no-op rather than a silent
 * reconnect — the server reads the mode at accept time, so switching would
 * throw away the Hermes conversation. The button reports that instead.
 */
export function toggleWake() {
  const { sessionOn, mode, captureSupported } = useSettingsStore.getState()
  if (!captureSupported) return

  if (sessionOn) {
    // Own mode: this is the off switch. Other mode: not ours to end.
    if (mode === 'wake') disarmSession()
    return
  }
  // Same unlock ordering as armSession — before the first await.
  player.unlock()
  useSettingsStore.getState().setMode('wake')
  useSettingsStore.getState().setSession(true)
}

/**
 * The microphone control, for both places that offer it.
 *
 * The two modes make it a different kind of control, and that is the point.
 *
 * Wake mode: a hand-driven capture. The server turns its endpointer off, so
 * pressing again is the only thing that ends it, and it sends.
 *
 * Mic mode: a latch, not a push-to-talk. One press opens it and it *stays*
 * open across turns — you speak, the silence sends it, Nova replies, and it
 * re-opens for the next thing you say without being pressed again. The latch is
 * what survives that round trip; see `micLatched`. Pressing again releases it,
 * and releasing discards whatever was captured rather than sending it, since
 * the endpointer is the only thing that submits here.
 *
 * `talking` is the current state, read off the wire rather than from a local
 * flag: the server is free to refuse, and a control that toggled on its own
 * would be claiming a capture that never opened.
 */
export function toggleTalk(talking: boolean) {
  const s = useSettingsStore.getState()
  const { mode, sessionOn, captureSupported, micLatched } = s

  // Releasing the latch. Covers the mid-turn case too: Nova may be thinking or
  // speaking with no capture open, and this is how you say "stop listening"
  // before she comes back around for the next one.
  if (sessionOn && mode === 'mic' && micLatched) {
    s.setMicLatched(false)
    if (talking) sendTalk(false)
    stopCapture()
    return
  }

  if (talking) {
    // Wake mode's hand-driven capture: this press is the send.
    sendTalk(false)
    return
  }

  if (!captureSupported) return
  // Same unlock ordering as armSession, and for the same reason — this runs
  // before the first await in the gesture's task.
  player.unlock()

  // An up wake-mode session already has the microphone open; this is just the
  // second way in, so it is nothing but a message.
  if (sessionOn && mode === 'wake') {
    sendTalk(true)
    return
  }

  // Otherwise this press owns the session. Down means mic mode, whatever the
  // last one was; sendTalk holds the open until the socket lands.
  if (!sessionOn) {
    s.setMode('mic')
    s.setSession(true)
  }
  s.setMicLatched(true)
  void startCapture().then((ok) => {
    if (ok) sendTalk(true)
  })
}

/**
 * Holds the connection while the session is up, and feeds all three amplitude
 * channels off the one shared ticker.
 */
export function useWire() {
  const sessionOn = useSettingsStore((s) => s.sessionOn)
  const mode = useSettingsStore((s) => s.mode)

  useEffect(() => setMode(mode), [mode])

  useEffect(() => {
    if (!sessionOn) return
    acquire(mode)
    return release
    // `mode` is read only when a socket is actually opened, and it cannot
    // change while one is up — the control that sets it is disabled then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionOn])

  useEffect(() => {
    let analyser: AnalyserNode | null = null
    let buf = new Uint8Array(0)

    return subscribe((dt) => {
      // Both of these are now real signals: `speech` from the playback graph's
      // analyser, `mic` from the capture graph's. The browser-TTS build had to
      // synthesise the former from word-boundary events.
      level.speech = player.rms()

      const live = captureAnalyser()
      if (live !== analyser) {
        analyser = live
        buf = analyser ? new Uint8Array(analyser.frequencyBinCount) : new Uint8Array(0)
      }
      if (analyser) {
        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / buf.length)
        // Mild curve so quiet speech still visibly moves the blob.
        level.mic = Math.min(1, Math.pow(rms * 3.4, 0.75))
      } else {
        level.mic = 0
      }

      if (level.wake > 0) level.wake = Math.max(0, level.wake - dt / WAKE_DECAY_MS)
    })
  }, [])
}
