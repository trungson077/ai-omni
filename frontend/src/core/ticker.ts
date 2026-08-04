/**
 * One requestAnimationFrame loop for the whole app.
 *
 * The orb renderer, the mic analyser and the particle field all subscribe
 * here. Three independent rAF loops would each pay their own scheduling
 * and layout-read cost; one loop with three callbacks does not.
 */
type Tick = (dt: number, now: number) => void

const subs = new Set<Tick>()
let raf = 0
let last = 0

function loop(now: number) {
  const dt = last ? Math.min(now - last, 64) : 16
  last = now
  for (const s of subs) s(dt, now)
  raf = requestAnimationFrame(loop)
}

export function subscribe(fn: Tick) {
  subs.add(fn)
  if (!raf) {
    last = 0
    raf = requestAnimationFrame(loop)
  }
  return () => {
    subs.delete(fn)
    if (subs.size === 0 && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }
}

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches
