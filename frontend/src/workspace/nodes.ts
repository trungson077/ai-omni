/**
 * Live DOM references for every mounted pane, keyed by id.
 *
 * Tethers and guides need each pane's *current* on-screen rect at 60fps —
 * including mid-drag, when position lives only in the node's transform and
 * has not been committed to the store yet. Reading from here avoids making
 * drag a stateful, re-rendering operation.
 */
const nodes = new Map<string, HTMLElement>()

/** The orb. Not a pane, but the tether layer needs its live geometry too. */
export const BLOB_NODE = '__blob'

export function registerNode(id: string, el: HTMLElement | null) {
  if (el) nodes.set(id, el)
  else nodes.delete(id)
}

/** Current visual rect in viewport coordinates, or null if unmounted. */
export function liveRect(id: string) {
  const el = nodes.get(id)
  if (!el) return null
  return {
    x: el.offsetLeft + currentTx(el),
    y: el.offsetTop + currentTy(el),
    w: el.offsetWidth,
    h: el.offsetHeight,
  }
}

/* Panes are absolutely positioned at 0,0 and moved purely by transform,
 * so offsetLeft/Top are 0 and the transform carries everything. Reading
 * the inline style is far cheaper than getBoundingClientRect(), which
 * forces layout. */
function currentTx(el: HTMLElement) {
  return Number(el.dataset.x ?? 0)
}
function currentTy(el: HTMLElement) {
  return Number(el.dataset.y ?? 0)
}

/**
 * The *rendered* centre of a node, transitions included.
 *
 * liveRect() reads the transform we last wrote, which is the destination — fine
 * for panes, whose moves are near-instant. The blob glides for six seconds, so
 * anchoring a tether to its stored point leaves the line hanging in empty space
 * for the whole drift. getBoundingClientRect is the only reading that reflects
 * an in-flight transition; it costs a layout flush, so this is called once per
 * frame for the one element that needs it, never per pane.
 */
export function renderedCentre(id: string) {
  const el = nodes.get(id)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
}

export function applyTransform(el: HTMLElement, x: number, y: number) {
  el.dataset.x = String(x)
  el.dataset.y = String(y)
  el.style.transform = `translate3d(${x}px, ${y}px, 0)`
}
