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
  /** Play the audio the server sends. */
  ttsOn: boolean
  /** This browser can capture 16kHz PCM at all. */
  captureSupported: boolean
  reducedMotion: boolean
  setSession: (v: boolean) => void
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

export const useSettingsStore = create<SettingsState>((set) => ({
  sessionOn: false,
  mode: 'wake',
  ttsOn: true,
  captureSupported: captureSupported(),
  reducedMotion:
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches,
  setSession: (sessionOn) => set({ sessionOn }),
  setMode: (mode) => set({ mode }),
  setTts: (ttsOn) => set({ ttsOn }),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
}))
