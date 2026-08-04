import { useEffect, useMemo, useRef, useState } from 'react'
import { submitUtterance } from '../wire/submit'
import { usePaneStore } from '../state/usePaneStore'
import { useSettingsStore } from '../state/useSettingsStore'
import { useWireStore } from '../state/useWireStore'
import { armSession, disarmSession, toggleTalk, toggleWake } from '../wire/useWire'
import './CommandPalette.css'

interface Command {
  id: string
  group: string
  label: string
  glyph: string
  hint?: string
  run: () => void
}

interface Props {
  onClose: () => void
}

export function CommandPalette({ onClose }: Props) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const panes = usePaneStore((s) => s.panes)
  const { sessionOn, mode, micLatched, ttsOn, setTts, captureSupported } = useSettingsStore()
  const talking = useWireStore((s) => s.flags.wakePhase === 'capturing')
  const wakeArmed = sessionOn && mode === 'wake'
  const latched = sessionOn && mode === 'mic' && micLatched

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const commands = useMemo<Command[]>(() => {
    const store = usePaneStore.getState()
    // Real directives only. What Nova can actually do depends on which MCP
    // servers are registered with the gateway, so these stay generic rather
    // than advertising capabilities that may not exist.
    const directives: Command[] = [
      ['What can you do?', '?'],
      ['Show me the god eye', 'C'],
      ['Hide the god eye', 'H'],
      ['What do you see?', 'V'],
    ].map(([label, glyph]) => ({
      id: `say:${label}`,
      group: 'Directives',
      label,
      glyph,
      hint: 'ask nova',
      run: () => submitUtterance(label),
    }))

    const controls: Command[] = [
      {
        id: 'session',
        group: 'Controls',
        label: sessionOn ? 'End the session' : 'Connect',
        glyph: '◉',
        hint: captureSupported ? '⌘/' : 'unsupported',
        run: () => {
          if (sessionOn) disarmSession()
          else if (captureSupported) armSession()
        },
      },
      {
        id: 'wake',
        group: 'Controls',
        label: wakeArmed ? 'Stop listening for the wake word' : 'Listen for the wake word',
        glyph: '◈',
        // The server reads the mode at accept time, so it cannot change under a
        // live socket. Surfaced as a hint rather than hidden, so the option
        // stays discoverable while a mic-mode session is up.
        hint: sessionOn && mode === 'mic' ? 'disconnect first' : undefined,
        run: () => toggleWake(),
      },
      {
        id: 'talk',
        group: 'Controls',
        label: wakeArmed
          ? talking
            ? 'Finish speaking'
            : 'Talk without the wake word'
          : latched
            ? 'Turn the microphone off'
            : 'Turn the microphone on',
        glyph: '◍',
        hint: latched ? 'keeps listening' : undefined,
        run: () => toggleTalk(talking),
      },
      {
        id: 'tts',
        group: 'Controls',
        label: ttsOn ? 'Mute voice output' : 'Unmute voice output',
        glyph: '♪',
        run: () => setTts(!ttsOn),
      },
      {
        id: 'clear',
        group: 'Controls',
        label: 'Clear all unpinned panels',
        glyph: '⌫',
        hint: 'dbl-click',
        run: () => store.collapseUnpinned(),
      },
    ]

    const focusables: Command[] = panes
      .filter((p) => p.kind !== 'chat')
      .map((p) => ({
        id: `focus:${p.id}`,
        group: 'Panels',
        label: p.title,
        glyph: '□',
        hint: p.kind,
        run: () => store.focus(p.id),
      }))

    return [...directives, ...controls, ...focusables]
  }, [panes, sessionOn, mode, wakeArmed, latched, ttsOn, captureSupported, setTts, talking])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return commands
    return commands.filter((c) => (c.label + c.group).toLowerCase().includes(needle))
  }, [commands, q])

  useEffect(() => {
    setActive(0)
  }, [q])

  const fire = (c: Command | undefined) => {
    if (!c) return
    c.run()
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered.length === 0 && q.trim()) {
        submitUtterance(q.trim())
        onClose()
      } else {
        fire(filtered[active])
      }
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  let lastGroup = ''

  return (
    <div className="cmdk-scrim" onPointerDown={onClose}>
      <div
        className="glass cmdk"
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          className="cmdk__input"
          placeholder="Command or directive…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="cmdk__list scroller">
          {filtered.length === 0 && (
            <div className="cmdk__empty">
              Nothing matches — press Enter to send it as a directive.
            </div>
          )}
          {filtered.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null
            lastGroup = c.group
            return (
              <div key={c.id}>
                {header && <div className="cmdk__group">{header}</div>}
                <button
                  className="cmdk__item"
                  data-active={i === active}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => fire(c)}
                >
                  <span className="cmdk__glyph">{c.glyph}</span>
                  <span>{c.label}</span>
                  {c.hint && <span className="cmdk__hint">{c.hint}</span>}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
