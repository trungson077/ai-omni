import type { Rect } from '../core/types'

export const SNAP_TOLERANCE = 12

export interface Guide {
  axis: 'x' | 'y'
  /** viewport coordinate of the line */
  at: number
  /** extent of the highlight along the other axis */
  from: number
  to: number
}

export interface SnapResult {
  x: number
  y: number
  guides: Guide[]
}

/**
 * Magnetic snapping while dragging. Candidate lines come from:
 *   - every edge and centre-line of every other pane
 *   - the viewport margins, centre, and thirds
 *
 * Only the single closest line per axis wins, so a pane never gets tugged
 * two directions at once.
 */
export function snap(
  moving: Rect,
  others: Rect[],
  viewport: { w: number; h: number },
  margin: number,
): SnapResult {
  const xLines: number[] = [
    margin,
    viewport.w - margin,
    viewport.w / 2,
    viewport.w / 3,
    (viewport.w * 2) / 3,
  ]
  const yLines: number[] = [
    margin,
    viewport.h - margin,
    viewport.h / 2,
    viewport.h / 3,
    (viewport.h * 2) / 3,
  ]

  for (const o of others) {
    xLines.push(o.x, o.x + o.w, o.x + o.w / 2)
    yLines.push(o.y, o.y + o.h, o.y + o.h / 2)
  }

  // Which points on the moving rect can latch onto a line.
  const mx = [moving.x, moving.x + moving.w, moving.x + moving.w / 2]
  const my = [moving.y, moving.y + moving.h, moving.y + moving.h / 2]

  let bestX: { delta: number; at: number } | null = null
  for (let i = 0; i < mx.length; i++) {
    for (const line of xLines) {
      const d = line - mx[i]
      if (Math.abs(d) <= SNAP_TOLERANCE && (!bestX || Math.abs(d) < Math.abs(bestX.delta))) {
        bestX = { delta: d, at: line }
      }
    }
  }

  let bestY: { delta: number; at: number } | null = null
  for (let i = 0; i < my.length; i++) {
    for (const line of yLines) {
      const d = line - my[i]
      if (Math.abs(d) <= SNAP_TOLERANCE && (!bestY || Math.abs(d) < Math.abs(bestY.delta))) {
        bestY = { delta: d, at: line }
      }
    }
  }

  const x = moving.x + (bestX?.delta ?? 0)
  const y = moving.y + (bestY?.delta ?? 0)

  const guides: Guide[] = []
  if (bestX) guides.push({ axis: 'x', at: bestX.at, from: 0, to: viewport.h })
  if (bestY) guides.push({ axis: 'y', at: bestY.at, from: 0, to: viewport.w })

  return { x, y, guides }
}
