import clsx from 'clsx'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PaneRecord } from '../core/types'
import { subscribe } from '../core/ticker'
import { usePaneStore } from '../state/usePaneStore'
import { SPEC } from '../panes/spec'
import { applyTransform, registerNode } from './nodes'
import { useDraggable } from './useDraggable'
import { useResizable } from './useResizable'
import type { Edge } from './useResizable'
import './Pane.css'

const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

/** Elapsed-time readout in the header — grounds the pane in the session. */
function Age({ from }: { from: number }) {
  const [s, setS] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setS(Math.floor((Date.now() - from) / 1000)), 1000)
    return () => clearInterval(t)
  }, [from])
  if (s < 1) return null
  return <span className="pane__meta">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`}</span>
}

/** Drains left-to-right as the pane's TTL burns down. Paused on hover. */
function TtlBar({ pane }: { pane: PaneRecord }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pane.ttl || !pane.expiresAt) return
    return subscribe(() => {
      const el = ref.current
      if (!el) return
      const p = usePaneStore.getState().panes.find((x) => x.id === pane.id)
      if (!p?.expiresAt || !p.ttl) return
      const now = p.pausedAt ?? Date.now()
      const left = Math.max(0, Math.min(1, (p.expiresAt - now) / p.ttl))
      el.style.width = `${left * 100}%`
      el.style.opacity = p.pausedAt ? '0.25' : '0.7'
    })
  }, [pane.id, pane.ttl, pane.expiresAt])

  if (!pane.ttl || pane.pinned) return null
  return <div ref={ref} className="pane__ttl" style={{ width: '100%' }} />
}

interface Props {
  pane: PaneRecord
  children: ReactNode
  /** Right-aligned extras injected into the header by specific pane kinds. */
  headerExtra?: ReactNode
}

function PaneBase({ pane, children, headerExtra }: Props) {
  const nodeRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const spec = SPEC[pane.kind]
  const focused = usePaneStore((s) => s.focusedId === pane.id)
  const { focus, close, togglePin, pauseTtl, resumeTtl, move } = usePaneStore.getState()
  const [entering, setEntering] = useState(pane.spawning)

  useDraggable({ id: pane.id, nodeRef, handleRef: headRef })
  useResizable({
    id: pane.id,
    nodeRef,
    min: spec.minSize,
    enabled: spec.resizable,
  })

  // Register for tether/guide geometry reads.
  useLayoutEffect(() => {
    registerNode(pane.id, nodeRef.current)
    return () => registerNode(pane.id, null)
  }, [pane.id])

  // Spawn: start at the origin point, then release to the solved position on
  // the next frame so the transition has something to animate from.
  useLayoutEffect(() => {
    const node = nodeRef.current
    if (!node) return
    if (pane.spawning && entering) {
      const o = pane.origin ?? { x: pane.x, y: pane.y }
      node.style.transition = 'none'
      applyTransform(node, o.x - pane.w / 2, o.y - pane.h / 2)
      // Force a style flush so the browser registers the start position.
      void node.offsetWidth
      node.style.transition = ''
      requestAnimationFrame(() => {
        applyTransform(node, pane.x, pane.y)
        setEntering(false)
      })
    } else {
      applyTransform(node, pane.x, pane.y)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.x, pane.y])

  // Fit height to content. Panes carry a default size for the placement
  // solver to work with, but a status pane with three rows shouldn't hold
  // the same box as one with eight — and nothing should ever be clipped.
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // spec.autoFit === false opts out entirely. The camera pane needs that: an
    // <img> reports its intrinsic 720px height, which would drive the pane to
    // fill the viewport the instant it spawns.
    if (pane.kind === 'chat' || pane.userSized || spec.autoFit === false) return
    const body = bodyRef.current
    const content = body?.firstElementChild
    if (!body || !content) return

    const fit = () => {
      const node = nodeRef.current
      if (!node) return
      const vh = usePaneStore.getState().viewport.h
      // Derive the chrome height rather than assuming it: header, borders and
      // any sub-pixel rounding are all folded in, so the fit is exact.
      const chrome = node.offsetHeight - body.clientHeight
      let desired = Math.ceil(content.getBoundingClientRect().height) + chrome
      // Second opinion: whatever is actually still scrolling out of view.
      // Catches the window where styles have not fully applied and the
      // content box under-reports its own height.
      const deficit = body.scrollHeight - body.clientHeight
      if (deficit > 0) desired = Math.max(desired, node.offsetHeight + deficit)

      usePaneStore
        .getState()
        .fitHeight(pane.id, Math.min(Math.max(desired, spec.minSize.h), vh - 48))
    }
    fit()
    // Both elements: content for what it wants, body for what it got. A pass
    // that changes one re-fires the other until they agree.
    const ro = new ResizeObserver(fit)
    ro.observe(content)
    ro.observe(body)
    return () => ro.disconnect()
  }, [pane.id, pane.kind, pane.userSized, spec.minSize.h, spec.autoFit])

  // Nudge with the keyboard when the header has focus.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1 : 8
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    if (d[e.key]) {
      e.preventDefault()
      move(pane.id, pane.x + d[e.key][0], pane.y + d[e.key][1])
    } else if (e.key === 'Escape') {
      close(pane.id)
    }
  }

  return (
    <div
      ref={nodeRef}
      className={clsx('pane', entering && 'pane--entering', pane.dismissing && 'pane--leaving')}
      // Reflected so the kind and pin state are inspectable from outside React —
      // the wire-replay suite asserts on both, and per-kind CSS can hook them.
      data-kind={pane.kind}
      data-pinned={String(pane.pinned)}
      style={{
        width: pane.w,
        height: pane.h,
        zIndex: pane.z,
        ['--accent' as string]: spec.accent,
        ['--accent-glow' as string]: spec.glow,
      }}
      onPointerDown={() => focus(pane.id)}
      onPointerEnter={() => pauseTtl(pane.id)}
      onPointerLeave={() => resumeTtl(pane.id)}
      role="dialog"
      aria-label={pane.title}
    >
      <div className={clsx('glass', 'pane__shell', focused && 'glass--live')}>
        <TtlBar pane={pane} />
        <div
          ref={headRef}
          className="pane__head"
          tabIndex={0}
          onKeyDown={onKeyDown}
          aria-label={`${pane.title} — drag or use arrow keys to move`}
        >
          <span
            className={clsx('pane__pip', pane.kind === 'camera' && 'pane__pip--pulse')}
          />
          <span className="pane__title">{pane.title}</span>
          {headerExtra}
          <Age from={pane.createdAt} />
          <button
            data-no-drag
            className={clsx('pane__btn', pane.pinned && 'pane__btn--on')}
            onClick={() => togglePin(pane.id)}
            title={pane.pinned ? 'Unpin' : 'Pin — keeps it here, cancels auto-dismiss'}
            aria-pressed={pane.pinned}
          >
            <PinIcon filled={pane.pinned} />
          </button>
          <button
            data-no-drag
            className="pane__btn pane__btn--danger"
            onClick={() => close(pane.id)}
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>
        <div ref={bodyRef} className="pane__body scroller">
          {children}
        </div>
      </div>

      {spec.resizable &&
        EDGES.map((e) => (
          <div
            key={e}
            className="pane__grip"
            data-resize={e}
            data-corner={e.length === 2 ? '' : undefined}
          />
        ))}
    </div>
  )
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M4.6 1h2.8l-.3 3.1 1.7 1.6v.9H6.5V11l-.5.6-.5-.6V6.6H3.2v-.9l1.7-1.6L4.6 1Z"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

export const Pane = memo(PaneBase)
