import { create } from 'zustand'
import { uid } from '../core/bus'
import type { PaneKind, PaneRecord, Point, Rect } from '../core/types'
import { maxLivePanes, SPEC } from '../panes/spec'
import { escapeImmovables, overlapArea, relax, solve } from '../workspace/placement'
import { blobExclusion, blobHome, clampBlob, settleBlob } from '../workspace/layout'

const DISMISS_MS = 260

/* The blob drifts, but it must not fidget. */
const SETTLE_COOLDOWN = 2600
/** Minimum cost improvement worth relocating for. */
const SETTLE_GAIN = 0.06
/** Minimum distance worth animating at all. */
const SETTLE_MIN_PX = 80
/**
 * An ambient drift should be a visible move, not a nudge.
 *
 * Kept modest deliberately: measured on a canvas with nine panels, the hard
 * no-overlap rule leaves only a ~250px corridor to move along. A larger
 * threshold means the blob simply never drifts once the canvas is busy.
 */
const DRIFT_MIN_PX = 90

let lastSettle = 0

export interface SpawnArgs {
  id?: string
  kind: PaneKind
  title: string
  payload: unknown
  originPaneId?: string | null
  origin?: Point
  ttl?: number | null
  size?: { w: number; h: number }
  pinned?: boolean
  /** Explicit position — bypasses the placement solver entirely. */
  at?: Point
}

interface PaneState {
  panes: PaneRecord[]
  focusedId: string | null
  topZ: number
  viewport: { w: number; h: number }
  /** Centre of the blob. It drifts; see settle(). */
  blob: Point

  spawn: (a: SpawnArgs) => string
  update: (id: string, payload: unknown, title?: string, ttl?: number | null) => void
  close: (id: string) => void
  move: (id: string, x: number, y: number) => void
  resize: (id: string, r: Rect) => void
  /** Auto-fit to content height. Ignored once the user has resized the pane. */
  fitHeight: (id: string, h: number) => void
  focus: (id: string) => void
  togglePin: (id: string) => void
  pauseTtl: (id: string) => void
  resumeTtl: (id: string) => void
  reap: () => void
  collapseUnpinned: () => void
  setViewport: (w: number, h: number) => void
  /**
   * Reposition the blob.
   *  - 'layout': the panels changed; move only if it measurably helps them.
   *  - 'drift':  ambient wander through positions as good as the best one.
   */
  settle: (mode?: 'layout' | 'drift', force?: boolean) => void
  expandDeck: (id: string) => void
}

/**
 * Everything a new panel must not cover: the blob's body and labels, and the
 * chat slab. Computed rather than registered, so it is never a frame stale
 * when the blob has just moved.
 */
const protectedZones = (s: PaneState): Rect[] => [
  blobExclusion(s.blob, s.viewport),
  ...s.panes.filter((p) => p.kind === 'chat').map(({ x, y, w, h }) => ({ x, y, w, h })),
]

/** Panes that occupy space for placement purposes. */
const occupiedRects = (panes: PaneRecord[]) =>
  panes.filter((p) => !p.dismissing).map(({ x, y, w, h }) => ({ x, y, w, h }))

interface DeckPayload {
  deckOf: PaneKind
  items: { id: string; title: string; kind: PaneKind; payload: unknown }[]
}

export const usePaneStore = create<PaneState>((set, get) => ({
  panes: [],
  focusedId: null,
  topZ: 1,
  viewport: { w: window.innerWidth, h: window.innerHeight },
  blob: blobHome({ w: window.innerWidth, h: window.innerHeight }),

  spawn: (a) => {
    const spec = SPEC[a.kind]
    const id = a.id ?? uid(a.kind)
    const state = get()

    // Already exists? Treat as an update so agents can be idempotent.
    if (state.panes.some((p) => p.id === id)) {
      get().update(id, a.payload, a.title)
      return id
    }

    // Default sizes are tuned for a roomy canvas. On a smaller one a pane at
    // full width can't fit beside the orb and the chat slab at all, and the
    // solver is left choosing which thing to cover. Cap the width instead.
    const raw = a.size ?? spec.defaultSize
    // Per-kind, because the camera feed is the one pane whose whole point is
    // pixels and 28% of a 1440px window is a postage stamp.
    const widthCap = spec.widthCapRatio ?? 0.28
    const size = {
      w: Math.max(spec.minSize.w, Math.min(raw.w, Math.round(state.viewport.w * widthCap))),
      h: Math.max(spec.minSize.h, Math.min(raw.h, Math.round(state.viewport.h * 0.5))),
    }
    const originPane = a.originPaneId
      ? state.panes.find((p) => p.id === a.originPaneId)
      : undefined
    // Panels fly out of whatever produced them: the spawning panel, or the
    // blob itself. Wherever the blob currently is.
    const origin: Point =
      a.origin ??
      (originPane
        ? { x: originPane.x + originPane.w / 2, y: originPane.y + originPane.h / 2 }
        : state.blob)

    const zones = protectedZones(state)

    const solved = a.at
      ? {
          rect: { x: a.at.x, y: a.at.y, w: size.w, h: size.h },
          overlapRatio: 0,
        }
      : solve({
          size,
          origin,
          occupied: occupiedRects(state.panes),
          exclusions: zones,
          viewport: state.viewport,
        })

    // On a saturated canvas the solver may still choose a spot that clips a
    // pane nobody is allowed to move. relax() below shuffles the *neighbours*,
    // so it cannot fix that — the newcomer has to step aside itself. Same
    // reasoning as the growth path in fitHeight().
    const immovables = a.at
      ? []
      : state.panes
          .filter((p) => !p.dismissing && (p.pinned || p.kind === 'chat'))
          .map(({ x, y, w, h }) => ({ x, y, w, h }))
    const rect =
      immovables.length && immovables.some((o) => overlapArea(solved.rect, o) > 0)
        ? { ...solved.rect, ...escapeImmovables(solved.rect, immovables, state.viewport) }
        : solved.rect
    const overlapRatio = rect === solved.rect ? solved.overlapRatio : 1

    const now = Date.now()
    const ttl = a.ttl !== undefined ? a.ttl : spec.ttl
    const z = state.topZ + 1

    const rec: PaneRecord = {
      id,
      kind: a.kind,
      title: a.title,
      payload: a.payload,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      z,
      pinned: a.pinned ?? false,
      origin,
      originPaneId: a.originPaneId ?? null,
      expiresAt: ttl ? now + ttl : null,
      ttl,
      pausedAt: null,
      userSized: false,
      spawning: true,
      dismissing: false,
      createdAt: now,
    }

    let next = [...state.panes, rec]

    // Nothing fit cleanly — ask the neighbours to shuffle over. Any overlap
    // at all counts: a 2px seam between two panes reads as a rendering bug,
    // and relax() over eight panes is cheap.
    if (overlapRatio > 0) {
      const movables = next
        .filter((p) => p.id !== id && !p.pinned && !p.dismissing && p.kind !== 'chat')
        .map(({ id: mid, x, y, w, h }) => ({ id: mid, x, y, w, h }))
      const moved = relax(rect, movables, state.viewport, zones)
      if (moved.size) {
        next = next.map((p) => {
          const m = moved.get(p.id)
          return m ? { ...p, x: m.x, y: m.y } : p
        })
      }
    }

    next = coalesce(next, a.kind, id, state.viewport, zones)

    set({ panes: next, topZ: z, focusedId: id })

    // Clear the spawn flag once the entry animation has played, so the
    // pane switches from "flying in" to normal spring-to-position.
    setTimeout(() => {
      set((s) => ({
        panes: s.panes.map((p) => (p.id === id ? { ...p, spawning: false } : p)),
      }))
    }, 420)

    // The panel has landed; now the blob can consider stepping aside.
    get().settle()

    return id
  },

  update: (id, payload, title, ttl) =>
    set((s) => ({
      panes: s.panes.map((p) => {
        if (p.id !== id) return p
        const next = { ...p, payload, title: title ?? p.title }
        // A TTL can start on update, not just at spawn. Tool panes need this:
        // their completion arrives later, so a countdown begun at spawn would
        // have expired the pane while the call was still running. Pinned panes
        // are left alone — reap() respects pinning, and so should this.
        if (ttl !== undefined && !p.pinned) {
          next.ttl = ttl
          next.expiresAt = ttl ? Date.now() + ttl : null
          next.pausedAt = null
        }
        return next
      }),
    })),

  close: (id) => {
    const p = get().panes.find((x) => x.id === id)
    if (!p || p.dismissing) return
    set((s) => ({
      panes: s.panes.map((x) => (x.id === id ? { ...x, dismissing: true } : x)),
    }))
    setTimeout(() => {
      set((s) => ({
        panes: s.panes.filter((x) => x.id !== id),
        focusedId: s.focusedId === id ? null : s.focusedId,
      }))
      // Space freed up. If the canvas is now empty the blob should go home
      // promptly rather than wait out the cooldown.
      const empty = get().panes.every((x) => x.kind === 'chat')
      get().settle('layout', empty)
    }, DISMISS_MS)
  },

  move: (id, x, y) => {
    set((s) => ({ panes: s.panes.map((p) => (p.id === id ? { ...p, x, y } : p)) }))
    // Dragging a panel away is as much a reason to settle as spawning one.
    get().settle()
  },

  resize: (id, r) =>
    set((s) => ({
      panes: s.panes.map((p) => (p.id === id ? { ...p, ...r, userSized: true } : p)),
    })),

  fitHeight: (id, h) =>
    set((s) => {
      const me = s.panes.find((p) => p.id === id)
      if (!me || me.userSized || Math.abs(me.h - h) < 2) return s

      // Keep a bottom-anchored pane from walking off-screen as it grows.
      let y = Math.min(me.y, Math.max(8, s.viewport.h - h - 8))
      let x = me.x

      // Anything that cannot be asked to move — the blob, the pinned chat
      // slab, panes the user pinned — the grower must step around itself.
      // The blob belongs in this list: growing over it is the one way a panel
      // can end up covering it, since placement vetoes it and relax pushes
      // everything *except* the pane that changed.
      if (h > me.h) {
        const fixed = [
          blobExclusion(s.blob, s.viewport),
          ...s.panes
            .filter((p) => p.id !== id && !p.dismissing && (p.pinned || p.kind === 'chat'))
            .map(({ x: fx, y: fy, w, h: fh }) => ({ x: fx, y: fy, w, h: fh })),
        ]
        const esc = escapeImmovables({ x, y, w: me.w, h }, fixed, s.viewport)
        x = esc.x
        y = esc.y
      }

      const grown = { ...me, h, x, y }
      let panes = s.panes.map((p) => (p.id === id ? grown : p))

      // Growing can also collide with neighbours the solver had cleared. Only
      // the pane that changed is at fault, so it asks the others to shift.
      if (h > me.h) {
        const rect = { x: grown.x, y: grown.y, w: grown.w, h: grown.h }
        const clash = panes.some(
          (p) => p.id !== id && !p.dismissing && overlapArea(rect, p) > 0,
        )
        if (clash) {
          const movables = panes
            .filter((p) => p.id !== id && !p.pinned && !p.dismissing && p.kind !== 'chat')
            .map(({ id: mid, x, y: py, w, h: ph }) => ({ id: mid, x, y: py, w, h: ph }))
          const moved = relax(rect, movables, s.viewport, [
            blobExclusion(s.blob, s.viewport),
            ...s.panes
              .filter((p) => p.id !== id && !p.dismissing && (p.pinned || p.kind === 'chat'))
              .map(({ x: fx, y: fy, w, h: fh }) => ({ x: fx, y: fy, w, h: fh })),
          ])
          if (moved.size) {
            panes = panes.map((p) => {
              const m = moved.get(p.id)
              return m ? { ...p, x: m.x, y: m.y } : p
            })
          }
        }
      }

      return { panes }
    }),

  focus: (id) =>
    set((s) => {
      if (s.focusedId === id && s.panes.find((p) => p.id === id)?.z === s.topZ) return s
      const z = s.topZ + 1
      return {
        topZ: z,
        focusedId: id,
        panes: s.panes.map((p) => (p.id === id ? { ...p, z } : p)),
      }
    }),

  togglePin: (id) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.id === id
          ? { ...p, pinned: !p.pinned, expiresAt: !p.pinned ? null : p.expiresAt }
          : p,
      ),
    })),

  pauseTtl: (id) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.id === id && p.expiresAt && !p.pausedAt ? { ...p, pausedAt: Date.now() } : p,
      ),
    })),

  resumeTtl: (id) =>
    set((s) => ({
      panes: s.panes.map((p) => {
        if (p.id !== id || !p.pausedAt || !p.expiresAt) return p
        return { ...p, expiresAt: p.expiresAt + (Date.now() - p.pausedAt), pausedAt: null }
      }),
    })),

  reap: () => {
    const now = Date.now()
    const doomed = get().panes.filter(
      (p) => p.expiresAt && !p.pausedAt && !p.pinned && !p.dismissing && p.expiresAt <= now,
    )
    for (const p of doomed) get().close(p.id)
  },

  collapseUnpinned: () => {
    const victims = get().panes.filter((p) => !p.pinned && p.kind !== 'chat')
    for (const p of victims) get().close(p.id)
  },

  setViewport: (w, h) =>
    set((s) => ({
      viewport: { w, h },
      blob: clampBlob(s.blob, { w, h }),
      // Keep everything reachable after a resize.
      panes: s.panes.map((p) => ({
        ...p,
        x: Math.min(Math.max(p.x, 8), Math.max(8, w - p.w - 8)),
        y: Math.min(Math.max(p.y, 8), Math.max(8, h - p.h - 8)),
      })),
    })),

  settle: (mode = 'layout', force = false) => {
    const s = get()
    const now = Date.now()

    const panels = s.panes
      .filter((p) => !p.dismissing && p.kind !== 'chat')
      .map(({ x, y, w, h }) => ({ x, y, w, h }))
    const chatPane = s.panes.find((p) => p.kind === 'chat')
    const chat = chatPane
      ? { x: chatPane.x, y: chatPane.y, w: chatPane.w, h: chatPane.h }
      : null

    // A drift only ever picks a spot that is clear, but relax() can later
    // push a panel on top of the blob when the canvas is too tight to do
    // anything else. Getting out from under it is urgent, so it overrides
    // the cooldown.
    const zone = blobExclusion(s.blob, s.viewport)
    const covered = panels.some((p) => overlapArea(zone, p) > 0)

    if (!force && !covered && now - lastSettle < SETTLE_COOLDOWN) return

    const r = settleBlob(s.blob, s.viewport, panels, chat)
    const away = (p: Point) => Math.hypot(p.x - s.blob.x, p.y - s.blob.y)

    let target: Point | null = null

    if (mode === 'drift') {
      // Anything in `acceptable` is as good as the optimum for panel fit, so
      // picking freely among them can't make the layout worse. Require a real
      // distance so the drift is legible.
      const options = r.acceptable.filter((p) => away(p) >= DRIFT_MIN_PX)
      if (options.length) {
        // Bias toward the better-scoring half: still varied, still sensible.
        const pool = options.slice(0, Math.max(1, Math.ceil(options.length / 2)))
        target = pool[Math.floor(Math.random() * pool.length)]
      }
    } else if (covered) {
      // Staying put scored Infinity, so anything qualifying is an escape. No
      // distance threshold: a small hop that frees the blob is the point.
      target = r.best.x !== s.blob.x || r.best.y !== s.blob.y ? r.best : null
    } else if (
      // Two guards against twitching: worth making, and big enough to read as
      // a move rather than a wobble.
      r.currentCost - r.bestCost >= SETTLE_GAIN &&
      away(r.best) >= SETTLE_MIN_PX
    ) {
      target = r.best
    }

    if (!target && !covered) return

    const dest = target ?? s.blob
    const destZone = blobExclusion(dest, s.viewport)

    // The blob is an obstacle that just moved, so the panels get the same
    // courtesy a new panel gets: shuffle aside. Without this the drift makes
    // packing worse instead of better, because panels are placed once and
    // never reconsidered, and a saturated canvas can leave the blob with
    // nowhere clear to go at all.
    const immovable = [
      destZone,
      ...s.panes
        .filter((p) => p.pinned || p.kind === 'chat')
        .map(({ x, y, w, h }) => ({ x, y, w, h })),
    ]
    const moved = relax(
      destZone,
      s.panes
        .filter((p) => !p.pinned && !p.dismissing && p.kind !== 'chat')
        .map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
      s.viewport,
      immovable,
    )

    if (!target && moved.size === 0) return
    lastSettle = now
    set({
      blob: dest,
      panes: moved.size
        ? s.panes.map((p) => {
            const mv = moved.get(p.id)
            return mv ? { ...p, x: mv.x, y: mv.y } : p
          })
        : s.panes,
    })
  },

  expandDeck: (id) => {
    const deck = get().panes.find((p) => p.id === id)
    if (!deck || deck.kind !== 'deck') return
    const payload = deck.payload as DeckPayload
    get().close(id)
    for (const item of payload.items) {
      get().spawn({
        id: item.id,
        kind: item.kind,
        title: item.title,
        payload: item.payload,
        origin: { x: deck.x + deck.w / 2, y: deck.y + deck.h / 2 },
        ttl: null,
      })
    }
  },
}))

/* ── Coalescing ───────────────────────────────────────────────
 * Two ceilings: per-kind (SPEC.maxConcurrent) and global
 * (MAX_LIVE_PANES, the backdrop-filter budget). Overflow folds into
 * a stacked deck rather than being silently dropped — the user can
 * always click a deck open again.
 * ─────────────────────────────────────────────────────────── */
/**
 * Kinds that must never be folded into a deck.
 *
 * A deck shows titles only, so a folded approval cannot be answered — and an
 * unanswered approval blocks the agent for ten minutes with the microphone
 * discarded the whole time. Approvals are also spawned pinned, which already
 * exempts them; this is the belt to that braces, because the cost of getting it
 * wrong is a silently wedged agent.
 */
const UNFOLDABLE = new Set<PaneKind>(['confirm'])

function coalesce(
  panes: PaneRecord[],
  kind: PaneKind,
  keepId: string,
  viewport: { w: number; h: number },
  exclusions: Rect[],
): PaneRecord[] {
  let next = panes
  if (kind !== 'deck' && kind !== 'chat' && !UNFOLDABLE.has(kind)) {
    next = foldKind(next, kind, SPEC[kind].maxConcurrent, keepId, viewport, exclusions)
  }

  const cap = maxLivePanes(viewport)
  const live = next.filter((p) => !p.dismissing && p.kind !== 'chat')
  if (live.length > cap) {
    const overflowCount = live.length - cap
    const eligible = live
      .filter((p) => !p.pinned && p.id !== keepId && !UNFOLDABLE.has(p.kind))
      // Fold real panels before decks — but decks are foldable too. Exempting
      // them means that once the canvas is mostly decks the cap can never be
      // met, and panels start overlapping instead.
      .sort((a, b) =>
        a.kind === b.kind
          ? a.createdAt - b.createdAt
          : a.kind === 'deck'
            ? 1
            : b.kind === 'deck'
              ? -1
              : a.createdAt - b.createdAt,
      )
      .slice(0, overflowCount)
    if (eligible.length) next = fold(next, eligible, viewport, exclusions)
  }
  return next
}

function foldKind(
  panes: PaneRecord[],
  kind: PaneKind,
  max: number,
  keepId: string,
  viewport: { w: number; h: number },
  exclusions: Rect[],
): PaneRecord[] {
  const same = panes.filter((p) => p.kind === kind && !p.dismissing && !p.pinned)
  if (same.length <= max) return panes
  const overflow = same
    .filter((p) => p.id !== keepId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, same.length - max)
  return overflow.length ? fold(panes, overflow, viewport, exclusions) : panes
}

function fold(
  panes: PaneRecord[],
  victims: PaneRecord[],
  viewport: { w: number; h: number },
  exclusions: Rect[],
): PaneRecord[] {
  const victimIds = new Set(victims.map((v) => v.id))
  const anchor = victims[0]
  // A deck of decks would be absurd, so folding a deck flattens its contents.
  const items = victims.flatMap((v) =>
    v.kind === 'deck'
      ? (v.payload as DeckPayload).items
      : [{ id: v.id, title: v.title, kind: v.kind, payload: v.payload }],
  )
  // The deck keeps the kind it was opened for even once it absorbs others.
  // It is the deck's identity — three decks all titled "panels" tells the
  // user nothing, and the item list already shows what is inside.
  const label = anchor.kind === 'deck' ? (anchor.payload as DeckPayload).deckOf : anchor.kind
  const deckOf = label

  // Must exclude victims — otherwise a deck being folded can be picked as
  // its own merge target.
  const existing = panes.find(
    (p) =>
      p.kind === 'deck' &&
      !p.dismissing &&
      !victimIds.has(p.id) &&
      (p.payload as DeckPayload).deckOf === deckOf,
  )

  const remaining = panes.filter((p) => !victimIds.has(p.id))

  if (existing) {
    return remaining.map((p) =>
      p.id === existing.id
        ? {
            ...p,
            payload: {
              deckOf,
              items: [...(p.payload as DeckPayload).items, ...items],
            } satisfies DeckPayload,
            title: `${label} · ${(p.payload as DeckPayload).items.length + items.length}`,
          }
        : p,
    )
  }

  // The deck is a different size from the pane it replaces, so it needs its
  // own placement rather than inheriting the victim's coordinates — those
  // could easily put it on top of the chat slab.
  const spec = SPEC.deck
  const chatZones = remaining
    .filter((p) => p.kind === 'chat')
    .map(({ x, y, w, h }) => ({ x, y, w, h }))
  const obstacles = [...exclusions, ...chatZones]

  const { rect, overlapRatio } = solve({
    size: spec.defaultSize,
    origin: { x: anchor.x + anchor.w / 2, y: anchor.y + anchor.h / 2 },
    occupied: remaining.filter((p) => !p.dismissing).map(({ x, y, w, h }) => ({ x, y, w, h })),
    exclusions: obstacles,
    viewport,
  })

  // On a tight canvas the best slot may still overlap. Decks get the same
  // courtesy as any other pane: the neighbours shuffle over.
  let settled = remaining
  if (overlapRatio > 0) {
    const moved = relax(
      rect,
      remaining
        .filter((p) => !p.pinned && !p.dismissing && p.kind !== 'chat')
        .map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
      viewport,
      obstacles,
    )
    if (moved.size) {
      settled = remaining.map((p) => {
        const mv = moved.get(p.id)
        return mv ? { ...p, x: mv.x, y: mv.y } : p
      })
    }
  }

  const deck: PaneRecord = {
    id: uid('deck'),
    kind: 'deck',
    title: `${label} · ${items.length}`,
    payload: { deckOf, items } satisfies DeckPayload,
    x: rect.x,
    y: rect.y,
    w: spec.defaultSize.w,
    h: spec.defaultSize.h,
    z: anchor.z,
    pinned: false,
    origin: { x: anchor.x + anchor.w / 2, y: anchor.y + anchor.h / 2 },
    originPaneId: null,
    expiresAt: null,
    ttl: null,
    pausedAt: null,
    userSized: false,
    spawning: true,
    dismissing: false,
    createdAt: Date.now(),
  }
  return [...settled, deck]
}
