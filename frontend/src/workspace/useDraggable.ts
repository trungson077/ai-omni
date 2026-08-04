import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { useGuideStore } from '../state/useGuideStore'
import { usePaneStore } from '../state/usePaneStore'
import { applyTransform } from './nodes'
import { MARGIN } from './placement'
import { snap } from './snapping'

interface Options {
  id: string
  nodeRef: RefObject<HTMLElement | null>
  handleRef: RefObject<HTMLElement | null>
  disabled?: boolean
}

/**
 * Pointer-driven pane dragging.
 *
 * Position is written straight to the node's transform on every pointermove
 * and committed to the store only on pointerup. React never renders during
 * a drag, which is the difference between "attached to the cursor" and
 * "swimming behind it".
 */
export function useDraggable({ id, nodeRef, handleRef, disabled }: Options) {
  const dragging = useRef(false)

  useEffect(() => {
    const handle = handleRef.current
    const node = nodeRef.current
    if (!handle || !node || disabled) return

    let startX = 0
    let startY = 0
    let originX = 0
    let originY = 0
    let curX = 0
    let curY = 0
    let others: { x: number; y: number; w: number; h: number }[] = []

    const onDown = (e: PointerEvent) => {
      // Ignore drags started on buttons inside the header.
      if ((e.target as HTMLElement).closest('[data-no-drag]')) return
      if (e.button !== 0) return

      const st = usePaneStore.getState()
      const me = st.panes.find((p) => p.id === id)
      if (!me) return

      dragging.current = true
      startX = e.clientX
      startY = e.clientY
      originX = me.x
      originY = me.y
      curX = me.x
      curY = me.y
      others = st.panes
        .filter((p) => p.id !== id && !p.dismissing)
        .map(({ x, y, w, h }) => ({ x, y, w, h }))

      st.focus(id)
      node.setPointerCapture(e.pointerId)
      node.classList.add('pane--dragging')
      document.body.style.cursor = 'grabbing'
      e.preventDefault()
    }

    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return
      const vp = usePaneStore.getState().viewport
      const raw = {
        x: originX + (e.clientX - startX),
        y: originY + (e.clientY - startY),
        w: node.offsetWidth,
        h: node.offsetHeight,
      }

      // Holding a modifier suspends snapping for pixel-exact placement.
      const free = e.altKey || e.metaKey
      const s = free
        ? { x: raw.x, y: raw.y, guides: [] }
        : snap(raw, others, vp, MARGIN)

      curX = Math.min(Math.max(s.x, -raw.w + 64), vp.w - 64)
      curY = Math.min(Math.max(s.y, 0), vp.h - 40)

      applyTransform(node, curX, curY)
      useGuideStore.getState().set(s.guides)
    }

    const onUp = (e: PointerEvent) => {
      if (!dragging.current) return
      dragging.current = false
      node.releasePointerCapture?.(e.pointerId)
      node.classList.remove('pane--dragging')
      document.body.style.cursor = ''
      useGuideStore.getState().set([])
      usePaneStore.getState().move(id, Math.round(curX), Math.round(curY))
    }

    handle.addEventListener('pointerdown', onDown)
    node.addEventListener('pointermove', onMove)
    node.addEventListener('pointerup', onUp)
    node.addEventListener('pointercancel', onUp)
    return () => {
      handle.removeEventListener('pointerdown', onDown)
      node.removeEventListener('pointermove', onMove)
      node.removeEventListener('pointerup', onUp)
      node.removeEventListener('pointercancel', onUp)
    }
  }, [id, nodeRef, handleRef, disabled])
}
