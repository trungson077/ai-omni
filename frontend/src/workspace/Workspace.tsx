import { useEffect, useRef, useState } from 'react'
import { installBridge } from '../core/bridge'
import { Blob } from '../blob/Blob'
import { usePaneStore } from '../state/usePaneStore'
import { useSettingsStore } from '../state/useSettingsStore'
import { toast } from '../state/useToastStore'
import { useWireStore } from '../state/useWireStore'
import { armSession, disarmSession, player, useWire } from '../wire/useWire'
import { reconnectNow } from '../wire/socket'
import { Backdrop } from './Backdrop'
import { chatLayout } from './layout'
import { CommandPalette } from './CommandPalette'
import { PaneLayer } from './PaneLayer'
import { SnapGuides } from './SnapGuides'
import { Tethers } from './Tethers'
import { Toasts } from './Toasts'
import './Workspace.css'

function Clock() {
  const [t, setT] = useState('')
  useEffect(() => {
    const tick = () =>
      setT(
        new Date().toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      )
    tick()
    const i = setInterval(tick, 1000)
    return () => clearInterval(i)
  }, [])
  return <span className="hud-clock">{t}</span>
}

/** Live session state, in the top-right corner. Chrome, not a panel. */
function WakeChip() {
  const sessionOn = useSettingsStore((s) => s.sessionOn)
  const flags = useWireStore((s) => s.flags)
  const retryInMs = useWireStore((s) => s.retryInMs)

  if (!sessionOn) return <span className="hud-chip">Dormant</span>
  if (flags.fatal?.kind === 'dropped' && retryInMs !== null) {
    return (
      <button className="hud-chip hud-chip--warn" onClick={reconnectNow}>
        Reconnecting <b>retry now</b>
      </button>
    )
  }
  if (flags.socket === 'connecting') return <span className="hud-chip">Connecting</span>
  if (flags.socket !== 'open') return <span className="hud-chip hud-chip--warn">Offline</span>
  if (flags.mic === 'starting') return <span className="hud-chip">Opening mic</span>
  if (flags.mic === 'silent') return <span className="hud-chip hud-chip--warn">Mic silent</span>
  if (flags.wakePhase === 'capturing') {
    return <span className="hud-chip hud-chip--live">● Listening</span>
  }
  if (flags.wakePhase === 'armed') {
    // Mic mode has nothing armed — the microphone is shut until the talk
    // control is pressed — so a chip claiming otherwise would be a lie, and the
    // threshold it hangs off does not exist there either.
    if (flags.mode === 'mic') return <span className="hud-chip">Connected</span>
    return (
      <span className="hud-chip hud-chip--live">
        ● Armed{flags.wakeThreshold !== null && <b>{flags.wakeThreshold}</b>}
      </span>
    )
  }
  return <span className="hud-chip hud-chip--live">● Working</span>
}

export function Workspace() {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const paneCount = usePaneStore((s) => s.panes.filter((p) => p.kind !== 'chat').length)
  const sessionOn = useSettingsStore((s) => s.sessionOn)
  const captureSupported = useSettingsStore((s) => s.captureSupported)
  const hermesDown = useWireStore((s) => s.flags.hermes === 'down')

  useWire()

  // Bus → stores. Installed once.
  useEffect(() => installBridge(), [])

  // Viewport tracking. The top HUD strip is handled by TOP_INSET in the
  // solver, since it spans the full width.
  useEffect(() => {
    const onResize = () => {
      usePaneStore.getState().setViewport(window.innerWidth, window.innerHeight)
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // TTL sweep. 400ms is finer than the eye needs but coarse enough to be free.
  useEffect(() => {
    const i = setInterval(() => usePaneStore.getState().reap(), 400)
    return () => clearInterval(i)
  }, [])

  // Ambient drift: every so often the blob wanders to another spot that is
  // just as good for panel packing. Long interval on purpose — it should read
  // as something alive shifting its weight, not as a UI element animating.
  useEffect(() => {
    if (useSettingsStore.getState().reducedMotion) return
    // 28s between drifts against a 6s glide: it is stationary about four fifths
    // of the time, which is what makes the movement read as ambient rather than
    // as the UI doing something.
    const i = setInterval(() => usePaneStore.getState().settle('drift'), 28_000)
    return () => clearInterval(i)
  }, [])

  // The chat slab: a normal pane, but placed deliberately rather than solved.
  useEffect(() => {
    const { spawn, panes, viewport } = usePaneStore.getState()
    if (panes.some((p) => p.kind === 'chat')) return
    const { x, y, w, h } = chatLayout(viewport)
    spawn({
      id: 'chat',
      kind: 'chat',
      title: 'Dialogue',
      payload: null,
      pinned: true,
      ttl: null,
      size: { w, h },
      at: { x, y },
    })
  }, [])

  // A browser that cannot capture PCM should say so once rather than fail at
  // the permission prompt. Text still works, so this is a note, not a wall.
  const warned = useRef(false)
  useEffect(() => {
    if (captureSupported || warned.current) return
    warned.current = true
    const t = setTimeout(() => {
      toast('Voice input is unavailable in this browser.', {
        detail: 'Needs a secure context and AudioWorklet. Typing still works.',
        tone: 'warn',
      })
    }, 1600)
    return () => clearTimeout(t)
  }, [captureSupported])

  // Global keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if (mod && e.key === '/') {
        e.preventDefault()
        // A keypress is a user gesture, so this is a valid audio-unlock point.
        if (sessionOn) disarmSession()
        else if (captureSupported) armSession()
      } else if (e.key === 'Escape') {
        player.flush()
        const { focusedId, close } = usePaneStore.getState()
        if (focusedId && focusedId !== 'chat') close(focusedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionOn, captureSupported])

  return (
    <div className="workspace">
      <Backdrop />
      <Blob />
      <Tethers />

      <div
        className="canvas"
        onDoubleClick={(e) => {
          // Only when the empty canvas itself is hit — not a pane.
          if (e.target === e.currentTarget) usePaneStore.getState().collapseUnpinned()
        }}
      >
        <PaneLayer />
      </div>

      <SnapGuides />

      <div className="hud-corner hud-corner--tl">
        <span className="hud-chip">
          NOVA <b>v0.1</b>
        </span>
        <Clock />
      </div>

      <div className="hud-corner hud-corner--tr">
        <WakeChip />
        {hermesDown && <span className="hud-chip hud-chip--warn">No agent</span>}
        <span className="hud-chip">
          Panels <b>{paneCount}</b>
        </span>
      </div>

      <Toasts />

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  )
}
