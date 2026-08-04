import { useEffect, useRef } from 'react'
import { subscribe } from '../core/ticker'
import { usePaneStore } from '../state/usePaneStore'
import { useSettingsStore } from '../state/useSettingsStore'
import { BLOB_NODE, liveRect, renderedCentre } from './nodes'
import './Tethers.css'

/**
 * Hairline connectors from each pane back to whatever produced it — the orb,
 * or the pane that spawned it. This is what makes the canvas read as a
 * system rather than a pile of windows.
 *
 * Paths are rewritten imperatively on the shared rAF so they track panes
 * mid-drag without re-rendering React.
 */
export function Tethers() {
  const ids = usePaneStore((s) =>
    s.panes
      .filter((p) => p.kind !== 'chat' && !p.dismissing)
      .map((p) => p.id)
      .join(','),
  )
  const reduced = useSettingsStore((s) => s.reducedMotion)
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || reduced) return

    return subscribe(() => {
      const { panes, blob } = usePaneStore.getState()
      // Once per frame, not once per pane: this is the one measurement here
      // that forces layout. The store's point is where the orb is *going*; the
      // drift takes six seconds to get there, and a tether anchored to the
      // destination hangs in mid-air for all of it.
      const orb = renderedCentre(BLOB_NODE) ?? blob
      for (const p of panes) {
        const path = svg.querySelector<SVGPathElement>(`[data-tether="${p.id}"]`)
        if (!path) continue

        const rect = liveRect(p.id) ?? { x: p.x, y: p.y, w: p.w, h: p.h }
        const src = p.originPaneId
          ? (() => {
              const r = liveRect(p.originPaneId)
              const rec = panes.find((x) => x.id === p.originPaneId)
              const base = r ?? (rec ? { x: rec.x, y: rec.y, w: rec.w, h: rec.h } : null)
              return base
                ? { x: base.x + base.w / 2, y: base.y + base.h / 2 }
                : (p.origin ?? orb)
            })()
          : // Where the orb is *now*, not where it was when the panel spawned
            // and not where it is heading — otherwise the tethers detach.
            orb

        // Attach to whichever edge midpoint faces the source.
        const cx = rect.x + rect.w / 2
        const cy = rect.y + rect.h / 2
        const dx = src.x - cx
        const dy = src.y - cy
        const horizontal = Math.abs(dx) > Math.abs(dy)
        const ax = horizontal ? (dx > 0 ? rect.x + rect.w : rect.x) : cx
        const ay = horizontal ? cy : dy > 0 ? rect.y + rect.h : rect.y

        // Control points pulled along the dominant axis for a lazy S-curve.
        const k = 0.42
        const c1x = horizontal ? ax + dx * k : ax
        const c1y = horizontal ? ay : ay + dy * k
        const c2x = horizontal ? src.x - dx * k : src.x
        const c2y = horizontal ? src.y : src.y - dy * k

        path.setAttribute('d', `M ${ax} ${ay} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${src.x} ${src.y}`)
      }
    })
  }, [reduced])

  if (reduced) return null

  const list = ids ? ids.split(',') : []

  return (
    <svg ref={svgRef} className="tethers" aria-hidden>
      {list.map((id) => (
        <path key={id} data-tether={id} className="tether" />
      ))}
    </svg>
  )
}
