/** Agent lifecycle. Drives the orb, the backdrop pulse, and the composer state. */
export type AgentState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'responding'
  | 'executing'

/**
 * Every kind here has a real source on the wire, and every one of them shows
 * something that happened rather than something that is happening.
 *
 * `toolcall` and `terminal` used to exist. Both opened the moment a call
 * *started* — a signature and a spinner, or a shell prompt with the command in
 * it — which put the agent's working on the canvas and buried the answer in
 * scaffolding. `result` replaces them and is born complete.
 *
 * `notify` is gone for the same reason from the other direction: a transient
 * notice is not something you work with, so spending a solver slot and a
 * neighbour reshuffle on one was backwards. Those live in the corner now, in
 * `state/useToastStore`.
 */
export type PaneKind =
  | 'chat'
  | 'result'
  | 'media'
  | 'camera'
  | 'system'
  | 'confirm'
  | 'deck'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

export interface PaneRecord extends Rect {
  id: string
  kind: PaneKind
  title: string
  payload: unknown
  z: number
  /** Pinned panes never auto-dismiss and are exempt from relax(). */
  pinned: boolean
  /** Where it flew in from — anchors the tether line. */
  origin: Point | null
  /** id of the pane that spawned it, for tether re-anchoring on drag. */
  originPaneId: string | null
  /** epoch ms when this pane should self-dismiss; null = sticky. */
  expiresAt: number | null
  /** total TTL in ms, kept so the drain hairline can compute a ratio. */
  ttl: number | null
  /** epoch ms when TTL was paused by hover/focus; null = running. */
  pausedAt: number | null
  /** Once the user resizes a pane, stop auto-fitting its height to content. */
  userSized: boolean
  /** Transient: true while the spawn animation plays. */
  spawning: boolean
  /** Transient: true while dismissing, before removal. */
  dismissing: boolean
  createdAt: number
}

export interface Message {
  id: string
  role: 'user' | 'nova'
  text: string
  at: number
  /** true while tokens are still streaming in */
  streaming?: boolean
}

/* ────────────────────────────────────────────────────────────
 * The event contract.
 *
 * The UI subscribes to these and to nothing else, which is the joint that let
 * the whole canvas — solver, blob, glass, panes — survive being moved from a
 * scripted mock onto a live backend untouched. `wire/adapter.ts` translates the
 * voice socket into these shapes; nothing downstream knows where they came from.
 * ──────────────────────────────────────────────────────────── */
export type NovaEvent =
  | { t: 'agent.state'; state: AgentState }
  | { t: 'agent.message'; role: 'user' | 'nova'; text: string; id?: string }
  | { t: 'agent.token'; id: string; text: string }
  | { t: 'agent.done'; id: string }
  | {
      t: 'pane.spawn'
      id?: string
      kind: PaneKind
      title: string
      payload: unknown
      originPaneId?: string | null
      ttl?: number | null
      size?: { w: number; h: number }
      /** Exempts the pane from coalescing and from TTL. Approvals need it:
       *  a folded approval can't be answered, and an unanswered one blocks
       *  the agent for ten minutes. */
      pinned?: boolean
    }
  | {
      t: 'pane.update'
      id: string
      payload: unknown
      title?: string
      /** Starts (or clears) a TTL on an existing pane. A tool pane can't be
       *  born with one — its completion arrives later and would expire it
       *  mid-execution — so the countdown has to begin on update. */
      ttl?: number | null
    }
  | { t: 'pane.close'; id: string }
  /** A transient notice. Renders in the corner, never as a pane. */
  | { t: 'toast'; text: string; detail?: string; tone?: 'info' | 'warn' | 'ok' }
