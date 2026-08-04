import type { NovaEvent } from './types'

type Handler = (e: NovaEvent) => void

const handlers = new Set<Handler>()

export function emit(e: NovaEvent) {
  for (const h of handlers) h(e)
}

export function on(h: Handler) {
  handlers.add(h)
  return () => {
    handlers.delete(h)
  }
}

/** Monotonic id source. Content-independent, so no hashing needed. */
let n = 0
export const uid = (prefix = 'p') => `${prefix}_${(n++).toString(36)}_${Math.floor(performance.now())}`
