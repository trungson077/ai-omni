import type { PaneKind } from '../core/types'
import type { MediaKind } from '../wire/sentinels'

/**
 * What a tool produced. Nothing about how it produced it.
 *
 * There is no `running` field and no command, which is the whole point: this
 * pane cannot exist before there is a result to put in it, so nothing opens
 * while Nova is still working. The command line stays off the canvas — asking
 * for the weather should show the weather, not the `curl` that fetched it.
 */
export interface ResultPayload {
  /** The output, ANSI-stripped, capped server-side. */
  text: string
  /** Seconds the call took, when the gateway reported one. */
  durationS: number | null
}

export interface SystemPayload {
  text: string
  items?: string[]
}

export interface ConfirmPayload {
  question: string
  detail?: string
  /**
   * Hermes offers an n-ary choice, commonly ["once", "always", "deny"]. Folding
   * that into a boolean makes "always" unreachable, which turns a long session
   * into an approval treadmill.
   */
  choices?: string[]
  onChoice?: (choice: string) => void
  /** Fallback for a plain yes/no with no wire behind it. */
  confirmLabel?: string
  cancelLabel?: string
  resolve?: (ok: boolean) => void
}

/** A file Nova named with a `MEDIA:` sentinel. */
export interface MediaPayload {
  /** Absolute path on the machine the backend runs on. */
  path: string
  kind: MediaKind
  /**
   * Bumped each time Nova names this file again.
   *
   * Without it a second mention resolves to the same pane id, updates it with
   * an identical payload, and the browser serves the first version out of
   * cache — so "take another screenshot" would show the previous one.
   */
  nonce: number
}

export interface CameraPayload {
  /** MJPEG endpoint, proxy-relative. */
  src: string
  /** Bumped to force a brand-new connection rather than a cached dead one. */
  nonce: number
  label?: string
}

export interface DeckPayload {
  deckOf: PaneKind
  items: { id: string; title: string; kind: PaneKind; payload: unknown }[]
}
