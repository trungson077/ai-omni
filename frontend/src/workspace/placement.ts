import type { Point, Rect } from '../core/types'

export const MARGIN = 24
export const GRID = 8
/** The top HUD strip is full-width, so it's an inset rather than an exclusion. */
export const TOP_INSET = 54

/* ── Geometry ─────────────────────────────────────────────── */

export function overlapArea(a: Rect, b: Rect): number {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return ox > 0 && oy > 0 ? ox * oy : 0
}

export const center = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

function clampToViewport(r: Rect, vw: number, vh: number): Rect {
  return {
    ...r,
    x: Math.min(Math.max(r.x, MARGIN), Math.max(MARGIN, vw - r.w - MARGIN)),
    y: Math.min(Math.max(r.y, TOP_INSET), Math.max(TOP_INSET, vh - r.h - MARGIN)),
  }
}

/* ── Candidate generation ─────────────────────────────────── */

const RADII = [0.34, 0.52, 0.74] // × min(vw,vh)
const ANGLES = 16

function candidates(
  size: { w: number; h: number },
  origin: Point,
  occupied: Rect[],
  vw: number,
  vh: number,
): Rect[] {
  const out: Rect[] = []
  const push = (x: number, y: number) =>
    out.push(clampToViewport({ x, y, w: size.w, h: size.h }, vw, vh))

  // 1. Rings around the origin — the natural "blooms outward from source" set.
  const base = Math.min(vw, vh)
  for (const rf of RADII) {
    const r = base * rf
    for (let i = 0; i < ANGLES; i++) {
      // Offset each ring by half a step so rings don't stack radially.
      const a = (i / ANGLES) * Math.PI * 2 + (rf * Math.PI) / ANGLES
      push(origin.x + Math.cos(a) * r - size.w / 2, origin.y + Math.sin(a) * r - size.h / 2)
    }
  }

  // 2. Slots that align to existing panes. This is what stops the canvas
  //    from looking like scattered debris — new panes butt up against
  //    neighbours on a shared edge.
  const GAP = 14
  for (const p of occupied) {
    push(p.x + p.w + GAP, p.y) // right, top-aligned
    push(p.x - size.w - GAP, p.y) // left, top-aligned
    push(p.x, p.y + p.h + GAP) // below, left-aligned
    push(p.x, p.y - size.h - GAP) // above, left-aligned
    push(p.x + p.w + GAP, p.y + p.h - size.h) // right, bottom-aligned
    push(p.x - size.w - GAP, p.y + p.h - size.h) // left, bottom-aligned
  }

  // 3. Corner fallbacks — guarantees a candidate exists on a full canvas.
  push(MARGIN, TOP_INSET)
  push(vw - size.w - MARGIN, TOP_INSET)
  push(MARGIN, vh - size.h - MARGIN)
  push(vw - size.w - MARGIN, vh - size.h - MARGIN)

  return out
}

/* ── Scoring ──────────────────────────────────────────────── */

const W = {
  overlap: 2200,
  distance: 60,
  edgeHug: 20,
  grid: 6,
  align: -22,
  vDrift: 22,
}

/**
 * Exclusion zones are a veto, not a weight.
 *
 * Weighted, they lose: covering 30% of the orb scores better than covering
 * 30% of a pane, so the solver cheerfully buries the thing the whole
 * interface is built around. This constant puts any candidate that touches a
 * protected zone below every candidate that doesn't, while the proportional
 * term still ranks them against each other for the case where every option
 * is bad.
 */
const VETO = 1_000_000

interface ScoreCtx {
  origin: Point
  occupied: Rect[]
  exclusions: Rect[]
  vw: number
  vh: number
  diag: number
}

function score(c: Rect, ctx: ScoreCtx): number {
  const area = c.w * c.h

  let overlap = 0
  for (const p of ctx.occupied) overlap += overlapArea(c, p)

  let focus = 0
  for (const z of ctx.exclusions) focus += overlapArea(c, z)

  const cc = center(c)
  const dist = Math.hypot(cc.x - ctx.origin.x, cc.y - ctx.origin.y)

  const minEdge = Math.min(c.x, c.y, ctx.vw - (c.x + c.w), ctx.vh - (c.y + c.h))
  const edgeHug = Math.max(0, 1 - minEdge / 80)

  const gridMis = ((c.x % GRID) + (c.y % GRID)) / (GRID * 2)

  // Reward sharing an edge with a neighbour (within 3px).
  let aligned = 0
  for (const p of ctx.occupied) {
    if (Math.abs(c.x - p.x) < 3 || Math.abs(c.x + c.w - (p.x + p.w)) < 3) aligned++
    if (Math.abs(c.y - p.y) < 3 || Math.abs(c.y + c.h - (p.y + p.h)) < 3) aligned++
  }

  const vDrift = Math.abs(cc.y - ctx.origin.y) / ctx.vh

  return (
    (focus > 0 ? VETO + 4000 * Math.min(focus / area, 2) : 0) +
    W.overlap * Math.min(overlap / area, 2) +
    W.distance * (dist / ctx.diag) +
    W.edgeHug * edgeHug +
    W.grid * gridMis +
    W.align * Math.min(aligned, 2) +
    W.vDrift * vDrift
  )
}

/* ── Public API ───────────────────────────────────────────── */

export interface SolveInput {
  size: { w: number; h: number }
  origin: Point
  /** Rects already on the canvas that the new pane should avoid. */
  occupied: Rect[]
  /** Regions the new pane must never cover (orb core, composer). */
  exclusions: Rect[]
  viewport: { w: number; h: number }
}

export interface SolveResult {
  rect: Rect
  /** Fraction of the new pane covered by existing panes at this spot. */
  overlapRatio: number
}

export function solve(input: SolveInput): SolveResult {
  const { size, origin, occupied, exclusions, viewport } = input
  const vw = viewport.w
  const vh = viewport.h

  // A pane larger than the viewport can't be placed sensibly; shrink it.
  const w = Math.min(size.w, vw - MARGIN * 2)
  const h = Math.min(size.h, vh - MARGIN * 2)
  const sized = { w, h }

  const ctx: ScoreCtx = {
    origin,
    occupied,
    exclusions,
    vw,
    vh,
    diag: Math.hypot(vw, vh),
  }

  const list = candidates(sized, origin, occupied, vw, vh)
  let best = list[0]
  let bestScore = Infinity
  for (const c of list) {
    const s = score(c, ctx)
    if (s < bestScore) {
      bestScore = s
      best = c
    }
  }

  // Snap the winner to the 8px grid, then re-clamp.
  const snapped = clampToViewport(
    {
      ...best,
      x: Math.round(best.x / GRID) * GRID,
      y: Math.round(best.y / GRID) * GRID,
    },
    vw,
    vh,
  )

  let ov = 0
  for (const p of occupied) ov += overlapArea(snapped, p)

  return { rect: snapped, overlapRatio: ov / (w * h) }
}

/* ── relax() — panes politely make room ───────────────────── */

export interface Movable extends Rect {
  id: string
}

/** Gap panes should settle into, not just "not overlapping". */
const SEPARATION = 7

/**
 * Minimal translation that clears `rect` of obstacles that cannot themselves
 * move — the pinned chat slab, user-pinned panes.
 *
 * Used when a pane grows to fit its content and lands on one of them: relax()
 * can't help, because the thing in the way is exactly the thing it may not
 * touch. Prefers the smallest displacement so a height change doesn't read as
 * the pane jumping somewhere new.
 */
export function escapeImmovables(
  rect: Rect,
  obstacles: Rect[],
  viewport: { w: number; h: number },
): Point {
  const GAP = 12
  let { x, y } = rect

  for (let pass = 0; pass < 3; pass++) {
    let moved = false
    for (const o of obstacles) {
      const cur = { x, y, w: rect.w, h: rect.h }
      if (overlapArea(cur, o) <= 0) continue

      const options: { x: number; y: number; cost: number }[] = [
        { x, y: o.y - rect.h - GAP, cost: Math.abs(o.y - rect.h - GAP - y) },
        { x, y: o.y + o.h + GAP, cost: Math.abs(o.y + o.h + GAP - y) },
        { x: o.x - rect.w - GAP, y, cost: Math.abs(o.x - rect.w - GAP - x) },
        { x: o.x + o.w + GAP, y, cost: Math.abs(o.x + o.w + GAP - x) },
      ]
        .filter(
          (c) =>
            c.x >= MARGIN &&
            c.y >= TOP_INSET &&
            c.x + rect.w <= viewport.w - MARGIN &&
            c.y + rect.h <= viewport.h - MARGIN,
        )
        .sort((a, b) => a.cost - b.cost)

      if (options.length) {
        x = options[0].x
        y = options[0].y
        moved = true
      }
    }
    if (!moved) break
  }

  return { x: Math.round(x / GRID) * GRID, y: Math.round(y / GRID) * GRID }
}

const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + by * 2,
  h: r.h + by * 2,
})

/**
 * Force-directed nudge. Each movable pane is pushed away from the incoming
 * rect and from its neighbours, capped at MAX_NUDGE total so nothing teleports.
 * Returns only the panes that actually moved.
 */
export function relax(
  incoming: Rect,
  movables: Movable[],
  viewport: { w: number; h: number },
  /** Zones that push but never yield: the orb, the chat slab, pinned panes. */
  obstacles: Rect[] = [],
  iterations = 5,
): Map<string, Point> {
  const MAX_NUDGE = 72
  const work = movables.map((m) => ({ ...m, ox: m.x, oy: m.y }))

  for (let it = 0; it < iterations; it++) {
    for (const m of work) {
      let fx = 0
      let fy = 0

      const others: Rect[] = [incoming, ...obstacles, ...work.filter((o) => o.id !== m.id)]
      for (const o of others) {
        // Inflate both rects so panes settle with breathing room rather
        // than converging on exactly touching.
        const a = overlapArea(inflate(m, SEPARATION), inflate(o, SEPARATION))
        if (a <= 0) continue
        const mc = center(m)
        const oc = center(o)
        let dx = mc.x - oc.x
        let dy = mc.y - oc.y
        const d = Math.hypot(dx, dy) || 1
        // Push along the axis of least resistance — feels less chaotic than
        // pure radial repulsion when two panes are near-coincident.
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
          dx = 1
          dy = 0
        }
        // The 0.4 floor matters: a 2px overlap deserves a real nudge, not a
        // proportionally tiny one that leaves the panes still touching.
        const strength = (0.4 + Math.min(a / (m.w * m.h), 1)) * 26
        fx += (dx / d) * strength
        fy += (dy / d) * strength
      }

      m.x += fx
      m.y += fy
      m.x = Math.min(Math.max(m.x, MARGIN), Math.max(MARGIN, viewport.w - m.w - MARGIN))
      m.y = Math.min(Math.max(m.y, TOP_INSET), Math.max(TOP_INSET, viewport.h - m.h - MARGIN))
    }
  }

  // Clamp the travel and snap to the grid — this is the part the user sees
  // as panes politely sliding aside.
  const settled = work.map((m) => {
    let dx = m.x - m.ox
    let dy = m.y - m.oy
    const d = Math.hypot(dx, dy)
    if (d > MAX_NUDGE) {
      dx = (dx / d) * MAX_NUDGE
      dy = (dy / d) * MAX_NUDGE
    }
    return {
      id: m.id,
      w: m.w,
      h: m.h,
      ox: m.ox,
      oy: m.oy,
      x: Math.round((m.ox + dx) / GRID) * GRID,
      y: Math.round((m.oy + dy) / GRID) * GRID,
    }
  })

  // Exact separation pass.
  //
  // MAX_NUDGE and grid snapping both leave residue: a pane that wanted to
  // move 74px stops at 72, and rounding can shove it back up to 4px. Either
  // way you get a 2px seam, which reads as a rendering bug — far worse than
  // a pane sitting slightly off the grid. Correctness wins here.
  const GAP = 6
  const maxX = Math.max(MARGIN, viewport.w - MARGIN)
  const maxY = Math.max(TOP_INSET, viewport.h - MARGIN)

  for (let pass = 0; pass < 6; pass++) {
    let dirty = false
    for (const m of settled) {
      const peers = settled.filter((o) => o.id !== m.id)
      for (const o of [incoming, ...obstacles, ...peers]) {
        const ox = Math.min(m.x + m.w, o.x + o.w) - Math.max(m.x, o.x)
        const oy = Math.min(m.y + m.h, o.y + o.h) - Math.max(m.y, o.y)
        if (ox <= 0 || oy <= 0) continue

        // Try all four escapes and take the cheapest one that actually fits.
        // Picking the smaller axis blindly is what stalls: if that direction
        // is against a viewport edge, the clamp puts the pane straight back
        // and the loop spins without ever separating them.
        const options = [
          { x: m.x, y: o.y - m.h - GAP },
          { x: m.x, y: o.y + o.h + GAP },
          { x: o.x - m.w - GAP, y: m.y },
          { x: o.x + o.w + GAP, y: m.y },
        ]
          .filter(
            (c) => c.x >= MARGIN && c.y >= TOP_INSET && c.x + m.w <= maxX && c.y + m.h <= maxY,
          )
          .sort((a, b) => Math.hypot(a.x - m.x, a.y - m.y) - Math.hypot(b.x - m.x, b.y - m.y))

        if (!options.length) continue // genuinely nowhere to go
        m.x = options[0].x
        m.y = options[0].y
        dirty = true
      }
    }
    if (!dirty) break
  }

  const moved = new Map<string, Point>()
  for (const m of settled) {
    if (Math.hypot(m.x - m.ox, m.y - m.oy) < 1) continue
    moved.set(m.id, { x: Math.round(m.x), y: Math.round(m.y) })
  }
  return moved
}
