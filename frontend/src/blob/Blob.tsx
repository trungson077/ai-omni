import { useEffect, useRef } from 'react'
import { subscribe } from '../core/ticker'
import { useAgentStore } from '../state/useAgentStore'
import { usePaneStore } from '../state/usePaneStore'
import { useWireStore } from '../state/useWireStore'
import { blobGeometry } from '../workspace/layout'
import { level } from '../voice/level'
import { BLOB_NODE, registerNode } from '../workspace/nodes'
import { createBlobRenderer } from './blobRenderer'
import './Blob.css'

export function Blob() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const state = useAgentStore((s) => s.state)
  const label = useWireStore((s) => s.label)
  const viewport = usePaneStore((s) => s.viewport)
  // Position is store state, not derived: the blob drifts to make room for
  // panels, and the store owns that decision so placement never reads a
  // stale position.
  const centre = usePaneStore((s) => s.blob)

  const { size, coreR } = blobGeometry(viewport)

  // So the tether layer can read where the orb actually is mid-drift.
  useEffect(() => {
    registerNode(BLOB_NODE, rootRef.current)
    return () => registerNode(BLOB_NODE, null)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // No DPR scaling: the blob is soft light with no crisp detail, so a 1×
    // backing store is indistinguishable and a quarter of the fill cost.
    canvas.width = size
    canvas.height = size

    const draw = createBlobRenderer(ctx, size)
    return subscribe((dt, now) => {
      const s = useAgentStore.getState().state
      const f = useWireStore.getState().flags

      // Amplitude comes from the flags, not from the rendered state: the state
      // derivation is deliberately lossy, so using it to pick an input would
      // re-decide something already known. It also makes one server behaviour
      // visible for free — the blob stops reacting to your voice at exactly the
      // moment the server stops listening to it (mic is discarded while BUSY).
      const voice = f.speaking ? level.speech : f.wakePhase === 'busy' ? 0 : level.mic
      // The wake flare rides on top, so "heard you" registers even though the
      // mic is at a lull right at that instant.
      const amp = Math.min(1, voice + level.wake * 0.85)

      draw(dt, now, size, size, { state: s, amp })
    })
  }, [size])

  return (
    <div
      ref={rootRef}
      className="blob"
      style={{
        width: size,
        height: size,
        // Transform, not left/top: this animates on the compositor, and the
        // drift is a long transition.
        ['--bx' as string]: `${centre.x}px`,
        ['--by' as string]: `${centre.y}px`,
        ['--label-offset' as string]: `${Math.round(coreR * 1.5 + 14)}px`,
      }}
    >
      <div className="blob__mark">Nova</div>
      <canvas
        ref={canvasRef}
        className="blob__canvas"
        style={{ width: size, height: size }}
        aria-hidden
      />
      {/* data-state drives the CSS; the text is the richer derived label, which
          can say “say hey nova” or “running bash” without costing an ease. */}
      <div className="blob__state" data-state={state}>
        {label}
      </div>
    </div>
  )
}
