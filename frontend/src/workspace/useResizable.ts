import { useEffect } from 'react'
import type { RefObject } from 'react'
import { usePaneStore } from '../state/usePaneStore'
import { applyTransform } from './nodes'

export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface Options {
  id: string
  nodeRef: RefObject<HTMLElement | null>
  min: { w: number; h: number }
  enabled: boolean
}

/**
 * Edge/corner resizing. Like dragging, geometry is written directly to the
 * node during the gesture and committed once on release.
 *
 * Handles are rendered by <Pane/> with data-resize="<edge>"; this hook binds
 * them via delegation so adding a handle needs no wiring here.
 */
export function useResizable({ id, nodeRef, min, enabled }: Options) {
  useEffect(() => {
    const node = nodeRef.current
    if (!node || !enabled) return

    let edge: Edge | null = null
    let sx = 0
    let sy = 0
    let s0 = { x: 0, y: 0, w: 0, h: 0 }
    let cur = { x: 0, y: 0, w: 0, h: 0 }

    const onDown = (e: PointerEvent) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-resize]')
      if (!target || e.button !== 0) return
      const st = usePaneStore.getState()
      const me = st.panes.find((p) => p.id === id)
      if (!me) return

      edge = target.dataset.resize as Edge
      sx = e.clientX
      sy = e.clientY
      s0 = { x: me.x, y: me.y, w: me.w, h: me.h }
      cur = { ...s0 }
      st.focus(id)
      node.setPointerCapture(e.pointerId)
      node.classList.add('pane--resizing')
      e.preventDefault()
      e.stopPropagation()
    }

    const onMove = (e: PointerEvent) => {
      if (!edge) return
      const dx = e.clientX - sx
      const dy = e.clientY - sy
      let { x, y, w, h } = s0

      if (edge.includes('e')) w = s0.w + dx
      if (edge.includes('s')) h = s0.h + dy
      if (edge.includes('w')) {
        w = s0.w - dx
        x = s0.x + dx
      }
      if (edge.includes('n')) {
        h = s0.h - dy
        y = s0.y + dy
      }

      // Clamp against the minimum without letting the anchored edge drift.
      if (w < min.w) {
        if (edge.includes('w')) x -= min.w - w
        w = min.w
      }
      if (h < min.h) {
        if (edge.includes('n')) y -= min.h - h
        h = min.h
      }

      cur = { x, y, w, h }
      node.style.width = `${w}px`
      node.style.height = `${h}px`
      applyTransform(node, x, y)
    }

    const onUp = (e: PointerEvent) => {
      if (!edge) return
      edge = null
      node.releasePointerCapture?.(e.pointerId)
      node.classList.remove('pane--resizing')
      usePaneStore.getState().resize(id, {
        x: Math.round(cur.x),
        y: Math.round(cur.y),
        w: Math.round(cur.w),
        h: Math.round(cur.h),
      })
    }

    node.addEventListener('pointerdown', onDown)
    node.addEventListener('pointermove', onMove)
    node.addEventListener('pointerup', onUp)
    node.addEventListener('pointercancel', onUp)
    return () => {
      node.removeEventListener('pointerdown', onDown)
      node.removeEventListener('pointermove', onMove)
      node.removeEventListener('pointerup', onUp)
      node.removeEventListener('pointercancel', onUp)
    }
  }, [id, nodeRef, min.w, min.h, enabled])
}
