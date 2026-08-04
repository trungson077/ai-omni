import { create } from 'zustand'
import type { VoiceMode } from '../wire/protocol'

/**
 * `sessionOn` was `micOn`, and the rename is the point: it never meant "the
 * microphone is open", it meant "the socket is up". Conflating the two is what
 * made the microphone unreachable without the wake word — see `mode`.
 *
 * `captureSupported` replaces the old Web Speech feature check. Capture needs a
 * secure context, getUserMedia, and AudioWorklet — the last of which is what the
 * PCM pipeline is built on.
 */
interface SettingsState {
  /** The session is up: socket open, Hermes connected. */
  sessionOn: boolean
  /**
   * Which way into a turn. Fixed for the life of a session, because the server
   * reads it at accept time to decide whether to load the wake model — so the
   * control that sets it is disabled while `sessionOn`.
   */
  mode: VoiceMode
  /**
   * The mic toggle is engaged (mic mode only).
   *
   * Distinct from "a capture is open right now", which is what the wire
   * reports. This is the latch: it survives the whole turn — send, reply,
   * re-arm — and re-opens the microphone for the next thing you say. Without
   * it the control would be a push-to-talk you had to press for every single
   * utterance, which is not what a toggle is.
   */
  micLatched: boolean
  /** Play the audio the server sends. */
  ttsOn: boolean
  /** This browser can capture 16kHz PCM at all. */
  captureSupported: boolean
  reducedMotion: boolean
  setSession: (v: boolean) => void
  setMicLatched: (v: boolean) => void
  setMode: (m: VoiceMode) => void
  setTts: (v: boolean) => void
  setReducedMotion: (v: boolean) => void
}

/**
 * getUserMedia is only exposed in a secure context, and the capture pipeline is
 * an AudioWorklet — so both are hard requirements, and both are worth checking
 * up front rather than failing at the permission prompt.
 */
function captureSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof window.AudioWorkletNode === 'function'
  )
}

/**
 * Bring the session up on load rather than on a click.
 *
 * A hands-free assistant that needs a click before it will listen is not
 * hands-free. Gated on `captureSupported` because a session in wake mode with
 * no microphone can never produce a turn, and skipped for ?wire=fake so the
 * replay fixtures still start from a cold, deliberate state.
 *
 * What this *cannot* do is unlock audio playback: browsers only resume an
 * AudioContext inside a user gesture, so Nova can listen immediately but stays
 * mute until the first interaction anywhere on the page. See installAudioUnlock.
 * Set ?autoconnect=0 to opt out.
 */
function autoConnect(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(location.search)
  if (params.get('autoconnect') === '0') return false
  if (params.get('wire') === 'fake') return false
  return captureSupported()
}

export const useSettingsStore = create<SettingsState>((set) => ({
  sessionOn: autoConnect(),
  mode: 'wake',
  micLatched: false,
  ttsOn: true,
  captureSupported: captureSupported(),
  reducedMotion:
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches,
  setSession: (sessionOn) => set({ sessionOn }),
  setMicLatched: (micLatched) => set({ micLatched }),
  setMode: (mode) => set({ mode }),
  setTts: (ttsOn) => set({ ttsOn }),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
}))
