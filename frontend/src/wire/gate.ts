import type { AgentState } from '../core/types'

/**
 * Holds an emitted state for a minimum dwell, coalescing anything that changes
 * inside the window.
 *
 * Without this, a 300ms inter-sentence gap while a tool runs re-targets all
 * five of the blob's mood parameters, travels halfway through a 420ms ease, and
 * snaps back — a twitch that reads worse than either endpoint because nothing
 * motivates it.
 *
 * setTimeout rather than the shared rAF ticker: the ticker stops in a
 * background tab, and a state pinned by an invisible tab is a real bug.
 */

const MIN_DWELL_MS = 450

export interface StateGate {
  push: (s: AgentState, opts?: { immediate?: boolean }) => void
  dispose: () => void
}

export function createStateGate(
  emit: (s: AgentState) => void,
  minDwellMs = MIN_DWELL_MS,
): StateGate {
  let current: AgentState | null = null
  let pending: AgentState | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const commit = (s: AgentState) => {
    current = s
    pending = null
    emit(s)
    timer = setTimeout(() => {
      timer = undefined
      if (pending !== null && pending !== current) commit(pending)
      else pending = null
    }, minDwellMs)
  }

  return {
    push(s, opts) {
      if (s === current) {
        pending = null
        return
      }
      // Fatals must be visible at once; a user staring at a broken session
      // should not wait out a cosmetic dwell.
      if (opts?.immediate) {
        clearTimeout(timer)
        timer = undefined
        commit(s)
        return
      }
      if (timer === undefined) commit(s)
      else pending = s
    },
    dispose() {
      clearTimeout(timer)
      timer = undefined
      pending = null
      current = null
    },
  }
}
