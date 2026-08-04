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
 * What the second press means differs, and that is the mode's whole character.
 * In wake mode the capture is hand-driven: the server turns its endpointer off,
 * so pressing again is the only thing that ends it. In mic mode the endpointer
 * runs — you press, speak, stop, and it sends itself — so pressing again is an
 * early send rather than the only way out.
 *
 * `talking` is the current state, read off the wire rather than from a local
 * flag: the server is free to refuse, and a control that toggled on its own
 * would be claiming a capture that never opened.
 */
export function toggleTalk(talking: boolean) {
  const { mode, sessionOn, captureSupported } = useSettingsStore.getState()

  if (talking) {
    sendTalk(false)
    // Order matters only for honesty, not correctness: the server has every
    // frame it is going to get, so closing the microphone after telling it we
    // are done just means the recording indicator goes dark a beat sooner.
    if (mode === 'mic') stopCapture()
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
    useSettingsStore.getState().setMode('mic')
    useSettingsStore.getState().setSession(true)
  }
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
