import { create } from 'zustand'
import { uid } from '../core/bus'

/**
 * Transient notices.
 *
 * These used to be panes. A pane is a thing you are meant to *work with* — the
 * placement solver finds it a slot, the neighbours shuffle over to make room,
 * it can be dragged, pinned, folded into a deck. Spending all of that on
 * "Didn't catch that" was wrong twice over: it rearranged the canvas to
 * announce something the user could do nothing about, and it put a sentence in
 * the one place reserved for results.
 *
 * So notices live in the corner now, and the canvas is only ever things Nova
 * produced.
 */

export type Tone = 'info' | 'warn' | 'ok'

export interface Toast {
  id: string
  text: string
  /** A second line for the detail — an error string, usually. */
  detail?: string
  tone: Tone
}

/** Long enough to read a sentence, short enough not to become furniture. */
const LIFETIME = 5200
const WITH_DETAIL = 8000
/** Older notices drop off rather than growing a column down the screen. */
const MAX = 4

interface ToastState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: string) => void
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push: (t) => {
    const id = uid('toast')
    set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-MAX) }))
    setTimeout(() => get().dismiss(id), t.detail ? WITH_DETAIL : LIFETIME)
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/** The one call site everything else uses. */
export function toast(text: string, opts?: { detail?: string; tone?: Tone }) {
  useToastStore.getState().push({ text, detail: opts?.detail, tone: opts?.tone ?? 'info' })
}
