import clsx from 'clsx'
import { useLayoutEffect, useRef, useState } from 'react'
import { useAgentStore } from '../state/useAgentStore'
import { useSettingsStore } from '../state/useSettingsStore'
import { useWireStore } from '../state/useWireStore'
import { level } from '../voice/level'
import { Markdown } from './Markdown'
import { Waveform } from './Waveform'
import { SUGGESTIONS, submitUtterance } from '../wire/submit'
import { stripSentinels } from '../wire/sentinels'
import { armSession, disarmSession, toggleTalk } from '../wire/useWire'
import './ChatPane.css'

/* ── Messages ─────────────────────────────────────────────── */

function MessageList() {
  const messages = useAgentStore((s) => s.messages)
  const thinking = useWireStore((s) => s.flags.turn.thinking)
  const listRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, thinking])

  const lastId = messages[messages.length - 1]?.id

  return (
    <div className="chat__list scroller" ref={listRef}>
      {messages.length === 0 ? (
        <div className="chat__empty">
          <div className="chat__empty-title">Dormant</div>
          <div className="chat__hints">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chat__hint" onClick={() => submitUtterance(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        messages.map((m) => (
          <div key={m.id} className={clsx('msg', `msg--${m.role}`)}>
            <span className="msg__who">{m.role === 'nova' ? 'Nova' : 'You'}</span>
            {/* Reasoning gets its own dim channel. Appending it into the reply
                would interleave two streams into one string and produce garbage,
                since hermes.thinking replaces rather than appends. */}
            {m.id === lastId && m.role === 'nova' && thinking && (
              <div className="msg__thinking">{thinking}</div>
            )}
            <div className="msg__text">
              {/* Only Nova's side is Markdown. A user bubble is a speech
                  transcript or something typed verbatim, and running that
                  through a formatter would eat the punctuation. */}
              {m.role === 'nova' ? (
                <Markdown text={m.text} caret={m.streaming} />
              ) : (
                m.text
              )}
            </div>
          </div>
        ))
      )}
      <div className="sr-only" aria-live="polite">
        {/* Stripped like the visible copy. This mirror bypasses the Markdown
            renderer, so without it a screen reader announces the MEDIA: path
            character by character — the one thing the sentinel exists to
            avoid, read out loud. */}
        {stripSentinels(
          messages.filter((m) => m.role === 'nova' && !m.streaming).slice(-1)[0]?.text ?? '',
        )}
      </div>
    </div>
  )
}

/* ── Composer ─────────────────────────────────────────────── */

function Composer() {
  const [value, setValue] = useState('')
  const agentState = useAgentStore((s) => s.state)
  const label = useWireStore((s) => s.label)
  const socket = useWireStore((s) => s.flags.socket)
  const wakePhase = useWireStore((s) => s.flags.wakePhase)
  const micState = useWireStore((s) => s.flags.mic)
  const { sessionOn, mode, setMode, ttsOn, setTts, captureSupported } = useSettingsStore()
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Grow with content, up to the CSS max-height.
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 92)}px`
  }, [value])

  const send = () => {
    const text = value.trim()
    if (!text) return
    setValue('')
    submitUtterance(text)
  }

  const busy = agentState === 'thinking' || agentState === 'responding'
  const live = sessionOn && socket === 'open'
  // Straight off the wire rather than from a local click flag: the server is
  // free to refuse (it ignores `talk` while BUSY), and a button that lit up on
  // its own would be claiming a capture that never opened.
  const talking = wakePhase === 'capturing'
  // In mic mode the talk control is self-sufficient — it brings the session up
  // itself — so a down session is no reason to disable it. What it cannot do in
  // either mode is interrupt: the server discards the microphone while BUSY.
  const talkDisabled = !captureSupported || wakePhase === 'busy' || (mode === 'wake' && !live)

  return (
    <div className="composer">
      {/* Where interim dictation used to go. Transcription is server-side now,
          so this carries the session's own status instead. */}
      <div className="composer__interim">{sessionOn ? label : ''}</div>
      {(sessionOn || level.speech > 0) && (
        <div className="composer__wave-row">
          {/* Dim on the capture rather than on the session: in mic mode the two
              come apart, and a waveform drawing a microphone that is shut is
              just an animation. */}
          <Waveform dim={micState !== 'live'} />
        </div>
      )}
      <div className="composer__row">
        <textarea
          ref={taRef}
          className="composer__input"
          rows={1}
          placeholder="Type here:"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          aria-label="Message NOVA"
        />
        {/* Power is the connection, not the microphone. In wake mode bringing
            it up also opens the capture, because the detector has nothing to
            listen to otherwise. In mic mode it opens nothing but the socket —
            the talk control below owns the microphone, and pressing that will
            bring the session up on its own, so power is only ever needed to
            end one. */}
        <button
          className={clsx('composer__btn composer__btn--power', sessionOn && 'composer__btn--on')}
          // This click is the audio-unlock gesture, which is why armSession()
          // runs synchronously before any await.
          onClick={() => (sessionOn ? disarmSession() : armSession())}
          disabled={!captureSupported}
          title={
            !captureSupported
              ? 'Microphone capture unavailable in this browser'
              : sessionOn
                ? 'Disconnect — ends the session (⌘/)'
                : mode === 'wake'
                  ? 'Connect — opens the mic and arms the wake word (⌘/)'
                  : 'Connect — opens the socket, not the mic (⌘/)'
          }
          aria-pressed={sessionOn}
          aria-label={sessionOn ? 'End the session' : 'Connect'}
        >
          <PowerIcon />
        </button>
        {/* The server turns its endpointer off for a talk capture, so the
            second press is the only thing that ends it. */}
        <button
          className={clsx('composer__btn composer__btn--talk', talking && 'composer__btn--live')}
          onClick={() => toggleTalk(talking)}
          disabled={talkDisabled}
          title={
            talking
              ? 'Send what you just said'
              : mode === 'mic'
                ? 'Talk — opens the mic for as long as you hold the turn'
                : 'Talk — without the wake word'
          }
          aria-pressed={talking}
          aria-label={talking ? 'Finish speaking' : 'Talk to Nova'}
        >
          <MicIcon />
        </button>
        <button
          className="composer__btn composer__btn--send"
          onClick={send}
          disabled={!value.trim() || busy}
          title="Send (Enter)"
        >
          <SendIcon />
        </button>
      </div>
      <div className="composer__foot">
        {/* ⌘/ used to be hinted here too. It arms and disarms the mic — which
            is exactly what the button two inches above does, so the hint was
            labelling a control that was already visible. ⌘K stays because the
            palette is the only way to reach "clear all unpinned panels". */}
        <span className="composer__kbd">
          <b>⌘K</b> palette
        </span>
        <span className="composer__spacer" />
        {/* The mode, phrased as the thing it actually switches. Off is the pure
            mic toggle: no detector is loaded at all, and the microphone only
            opens while the talk control is engaged.

            Disabled while connected because the server reads the mode at accept
            time, so changing it means a new socket — and a new socket is a new
            Hermes session with no memory of this one. Better to make that the
            user's deliberate act than a side effect of flipping a switch. */}
        <button
          className="composer__kbd"
          onClick={() => setMode(mode === 'wake' ? 'mic' : 'wake')}
          disabled={sessionOn}
          style={{ color: mode === 'wake' ? 'var(--acc)' : undefined }}
          title={
            sessionOn
              ? 'Disconnect first — the mode is fixed for the life of a session'
              : mode === 'wake'
                ? 'Wake word armed for the whole session'
                : 'Pure mic toggle — nothing listens until you press talk'
          }
          aria-pressed={mode === 'wake'}
        >
          wake word · <b>{mode === 'wake' ? 'on' : 'off'}</b>
        </button>
        <button
          className="composer__kbd"
          onClick={() => setTts(!ttsOn)}
          style={{ color: ttsOn ? 'var(--acc)' : undefined }}
          aria-pressed={ttsOn}
        >
          voice out · <b>{ttsOn ? 'on' : 'off'}</b>
        </button>
      </div>
    </div>
  )
}

export function ChatPane() {
  return (
    <div className="chat">
      <MessageList />
      <Composer />
    </div>
  )
}

/** The session control. A power glyph, because that is what it does now. */
function PowerIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M4.4 3.4a4.6 4.6 0 1 0 5.2 0"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <path d="M7 1.4v5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="5" y="1.5" width="4" height="7" rx="2" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M3 6.6v.8a4 4 0 0 0 8 0v-.8M7 11.4V13"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2 7h9M7.4 3.2 11.6 7l-4.2 3.8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
