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
 * The talk control, for both places that offer it.
 *
 * In wake mode this is one of two ways in, and the capture is already running —
 * so it is nothing but a message. In mic mode it is the whole interaction: it
 * brings the session up if it is down, owns the microphone's lifetime, and is
 * the only thing that ever opens a capture.
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

  if (mode === 'wake') {
    sendTalk(true)
    return
  }

  // Mic mode. Nothing is behind the power button here: pressing talk is what
  // brings the session up, and sendTalk holds the open until the socket lands.
  if (!sessionOn) useSettingsStore.getState().setSession(true)
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
