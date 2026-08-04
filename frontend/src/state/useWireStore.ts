import { create } from 'zustand'
import type { Flags } from '../wire/flags'
import { initialFlags } from '../wire/flags'

/**
 * The session's flags, exposed to React.
 *
 * Kept out of usePaneStore for the same reason useGuideStore is: pane state
 * changes on user gestures, this changes on network events, and merging them
 * means every wake-word twitch re-renders the canvas.
 *
 * The label is stored rather than derived in the component so the blob does not
 * recompute it every frame.
 */
interface WireState {
  flags: Flags
  label: string
  /** ms until the next reconnect attempt; null when not retrying. */
  retryInMs: number | null
  setFlags: (f: Flags) => void
  setLabel: (s: string) => void
  setRetryInMs: (ms: number | null) => void
}

export const useWireStore = create<WireState>((set) => ({
  flags: initialFlags(),
  label: 'dormant',
  retryInMs: null,
  setFlags: (flags) => set({ flags }),
  setLabel: (label) => set({ label }),
  setRetryInMs: (retryInMs) => set({ retryInMs }),
}))
