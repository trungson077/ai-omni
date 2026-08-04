import type { Point, Rect } from '../core/types'
import { MARGIN, overlapArea } from './placement'

/**
 * Where the blob and the chat slab sit.
 *
 * The chat slab is derived from the viewport alone. The blob has a *home*
 * derived the same way, but it is free to drift from it: see settleBlob().
 */

export const CHAT_W = 460
export const CHAT_H = 380
const CHAT_BOTTOM_GAP = 34

export function chatLayout(viewport: { w: number; h: number }) {
  const w = Math.min(CHAT_W, Math.round(viewport.w * 0.42))
  const h = Math.min(CHAT_H, Math.round(viewport.h * 0.48))
  return {
    w,
    h,
    x: Math.round(viewport.w / 2 - w / 2),
    y: Math.max(24, viewport.h - h - CHAT_BOTTOM_GAP),
  }
}

/** Height of the top HUD strip the wordmark must stay clear of. */
const TOP_HUD = 56

/** Size of the blob, independent of where it currently is. */
export function blobGeometry(viewport: { w: number; h: number }) {
  // The canvas box is mostly halo — the body is 32% of it. Keeping the box
  // generous means the bloom never clips at the edge.
  const size = Math.round(
    Math.max(280, Math.min(460, Math.min(viewport.w, viewport.h) * 0.46)),
  )
  const coreR = size * 0.16
  /** Half-height of the protected region: body plus its two labels. */
  const guard = coreR * 1.5 + 30
  return { size, coreR, guard }
}

/**
 * The region no panel may cover.
 *
 * Deliberately much tighter than the canvas box: only the body and its labels
 * are off-limits. Panels floating over the outer halo look good, and it keeps
 * the blob from monopolising space it is not really using.
 */
export function blobExclusion(centre: Point, viewport: { w: number; h: number }): Rect {
  const { coreR, guard } = blobGeometry(viewport)
  return {
    x: Math.round(centre.x - (coreR * 1.5 + 24)),
    y: Math.round(centre.y - guard),
    w: Math.round(coreR * 3 + 48),
    h: Math.round(guard * 2),
  }
}

/** The composed position: off-centre left, clear of the chat slab and the HUD. */
export function blobHome(viewport: { w: number; h: number }): Point {
  const { guard } = blobGeometry(viewport)
  const chatTop = chatLayout(viewport).y
  const ceiling = chatTop - guard - 18
  const floor = guard + TOP_HUD
  return {
    x: Math.round(viewport.w * 0.38),
    y: Math.round(Math.max(floor, Math.min(viewport.h * 0.42, Math.max(floor, ceiling)))),
  }
}

/** Keeps a centre inside the bounds where the blob's halo won't clip badly. */
export function clampBlob(centre: Point, viewport: { w: number; h: number }): Point {
  const { size, guard } = blobGeometry(viewport)
  const hx = size * 0.3
  return {
    x: Math.round(Math.min(Math.max(centre.x, hx), Math.max(hx, viewport.w - hx))),
    y: Math.round(
      Math.min(Math.max(centre.y, guard + TOP_HUD), Math.max(guard + TOP_HUD, viewport.h - guard - MARGIN)),
    ),
  }
}

/* ── settleBlob ───────────────────────────────────────────────
 * The blob wanders, and prefers spots that leave room for panels.
 *
 * Three earlier attempts at this are worth recording, because each failed for
 * a reason that is easy to walk back into:
 *
 *  1. "Move away from panels" measures nothing. The blob's guard is a veto in
 *     the placement solver, so panels are never on top of it and the term is
 *     always zero.
 *  2. "Maximise the largest free rectangle" over the whole viewport hides the
 *     blob. Anywhere already unusable (behind the chat slab, inside the margin
 *     bands) costs no free space, so the optimum is to tuck the blob under
 *     something or half off-screen.
 *  3. Optimising globally makes packing *worse*. Existing panels do not
 *     re-place when the blob moves, so a "better" spot for future panels can
 *     strand the ones already down.
 *
 * What actually works: bound the wander to a region around the composed home
 * so it can never look wrong, hard-reject any position that would sit under a
 * panel, and among what survives prefer the roomiest. Small, safe, and it does
 * what was asked.
 * ─────────────────────────────────────────────────────────── */

/** Occupancy raster cell, px. Coarse on purpose; this is a fit heuristic. */
const CELL = 40
/** Candidate spacing within the wander region. */
const STEP = 64
/** How far from home the blob may wander, as a fraction of the viewport. */
const WANDER_X = 0.2
const WANDER_Y = 0.13
/** A candidate may be this much worse than the roomiest and still qualify. */
const TOLERANCE = 0.085

export interface SettleResult {
  /** Roomiest position found. */
  best: Point
  bestCost: number
  /** Cost of staying put, for the caller's improvement threshold. */
  currentCost: number
  /** Everything within TOLERANCE of best, ranked. Safe to drift to. */
  acceptable: Point[]
}

/** Marks every cell a rect touches. */
function stamp(grid: Uint8Array, cols: number, rows: number, r: Rect) {
  const x0 = Math.max(0, Math.floor(r.x / CELL))
  const y0 = Math.max(0, Math.floor(r.y / CELL))
  const x1 = Math.min(cols - 1, Math.ceil((r.x + r.w) / CELL) - 1)
  const y1 = Math.min(rows - 1, Math.ceil((r.y + r.h) / CELL) - 1)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) grid[y * cols + x] = 1
  }
}

/**
 * Largest all-free axis-aligned rectangle, in cells. This is the "will a panel
 * still fit" measure. Per-row histogram plus the standard monotonic stack.
 */
function largestFreeRect(grid: Uint8Array, cols: number, rows: number): number {
  const heights = new Int32Array(cols)
  const stack: number[] = []
  let best = 0

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      heights[x] = grid[y * cols + x] ? 0 : heights[x] + 1
    }
    stack.length = 0
    for (let x = 0; x <= cols; x++) {
      const h = x === cols ? 0 : heights[x]
      while (stack.length && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop() as number
        const left = stack.length ? stack[stack.length - 1] + 1 : 0
        const area = heights[top] * (x - left)
        if (area > best) best = area
      }
      stack.push(x)
    }
  }
  return best
}

export function settleBlob(
  current: Point,
  viewport: { w: number; h: number },
  panels: Rect[],
  chat: Rect | null,
): SettleResult {
  const home = blobHome(viewport)
  const diag = Math.hypot(viewport.w, viewport.h)

  const cols = Math.ceil(viewport.w / CELL)
  const rows = Math.ceil(viewport.h / CELL)
  const cellArea = CELL * CELL
  const canvasArea = viewport.w * viewport.h

  // Only real obstacles. Deliberately NOT the margin bands: marking those
  // occupied is what let the blob claim credit for hanging off the edge.
  const base = new Uint8Array(cols * rows)
  for (const p of panels) stamp(base, cols, rows, p)
  if (chat) stamp(base, cols, rows, chat)

  const work = new Uint8Array(base.length)
  const obstacles = chat ? [...panels, chat] : panels

  /** null = disqualified. Lower is better. */
  const costAt = (c: Point): number | null => {
    const rect = blobExclusion(c, viewport)

    // Hard constraint, not a penalty: the blob is never allowed under a panel.
    for (const o of obstacles) if (overlapArea(rect, o) > 0) return null

    work.set(base)
    stamp(work, cols, rows, rect)
    const free = (largestFreeRect(work, cols, rows) * cellArea) / canvasArea

    // Roomiest wins, with a light tether to the composed position so the
    // wander stays balanced rather than pooling in one corner.
    return -free + 0.25 * (Math.hypot(c.x - home.x, c.y - home.y) / diag)
  }

  const currentCost = costAt(current)
  let best = current
  let bestCost = currentCost ?? Infinity

  const scored: { c: Point; cost: number }[] = []
  const x0 = home.x - viewport.w * WANDER_X
  const x1 = home.x + viewport.w * WANDER_X
  const y0 = home.y - viewport.h * WANDER_Y
  const y1 = home.y + viewport.h * WANDER_Y

  for (let y = y0; y <= y1; y += STEP) {
    for (let x = x0; x <= x1; x += STEP) {
      // clampBlob keeps the halo from clipping at the viewport edge.
      const c = clampBlob({ x: Math.round(x), y: Math.round(y) }, viewport)
      const cost = costAt(c)
      if (cost === null) continue
      scored.push({ c, cost })
      if (cost < bestCost) {
        bestCost = cost
        best = c
      }
    }
  }

  const acceptable = scored
    .filter((v) => v.cost <= bestCost + TOLERANCE)
    .sort((a, b) => a.cost - b.cost)
    .map((v) => v.c)

  return {
    best,
    bestCost,
    // If staying put is disqualified (a panel drifted over the blob), any
    // qualifying move is an improvement.
    currentCost: currentCost ?? Infinity,
    acceptable,
  }
}
