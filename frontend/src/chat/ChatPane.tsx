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
import { armSession, disarmSession, toggleTalk, toggleWake } from '../wire/useWire'
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
  const { sessionOn, mode, micLatched, ttsOn, setTts, captureSupported } = useSettingsStore()
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
  const wakeArmed = sessionOn && mode === 'wake'
  // Whether the endpointer will close this capture on its own. True for every
  // mic-mode capture; false for a wake-mode talk capture, which is hand-driven.
  const micEndpointed = !wakeArmed
  // The mic toggle is engaged and will keep re-opening between turns. Distinct
  // from `talking`, which is only "a capture is open this instant".
  const latched = sessionOn && mode === 'mic' && micLatched
  // Both mode controls are self-sufficient — either brings a session up — so a
  // down session is no reason to disable them. BUSY normally does disable,
  // since the server discards the microphone while answering; the exception is
  // a live latch, which must stay releasable mid-turn.
  const talkDisabled =
    !captureSupported ||
    (wakeArmed ? !live || wakePhase === 'busy' : wakePhase === 'busy' && !latched)

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
        {/* The two modes, as two controls. Neither is behind the other or
            behind power — each brings a session up in its own mode, and the one
            you press is the one you get. */}
        <button
          className={clsx('composer__btn composer__btn--wake', wakeArmed && 'composer__btn--on')}
          onClick={toggleWake}
          disabled={!captureSupported || (sessionOn && mode === 'mic')}
          title={
            !captureSupported
              ? 'Microphone capture unavailable in this browser'
              : sessionOn && mode === 'mic'
                ? 'Disconnect first — the mode is fixed for the life of a session'
                : wakeArmed
                  ? 'Wake word armed — say “hey nova”. Press to stop listening'
                  : 'Wake word — listens for “hey nova” for the whole session'
          }
          aria-pressed={wakeArmed}
          aria-label={wakeArmed ? 'Stop listening for the wake word' : 'Listen for the wake word'}
        >
          <WaveIcon />
        </button>
        {/* Three states, not two. `live` is a capture open this instant; `on`
            is the latch held between turns, while Nova is thinking or speaking
            and the microphone is legitimately shut. Collapsing those two would
            make the toggle look like it had switched itself off every turn. */}
        <button
          className={clsx(
            'composer__btn composer__btn--talk',
            talking ? 'composer__btn--live' : latched && 'composer__btn--on',
          )}
          onClick={() => toggleTalk(talking)}
          disabled={talkDisabled}
          title={
            !micEndpointed
              ? talking
                ? 'Send what you just said'
                : 'Talk — without the wake word'
              : latched
                ? 'Mic on — keeps listening between turns. Press to turn it off'
                : 'Mic — press once, then just talk. Each silence sends'
          }
          aria-pressed={talking || latched}
          aria-label={latched ? 'Turn the microphone off' : 'Turn the microphone on'}
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

/** The wake word: something heard across a room, rather than spoken into. */
function WaveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M7 4v6M4.6 5.4v3.2M2.2 6.3v1.4M9.4 5.4v3.2M11.8 6.3v1.4"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
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
