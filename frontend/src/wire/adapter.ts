import { emit, uid } from '../core/bus'
import { useWireStore } from '../state/useWireStore'
import { level } from '../voice/level'
import type {
  CameraPayload,
  ConfirmPayload,
  MediaPayload,
  ResultPayload,
} from '../panes/payloads'
import { toast } from '../state/useToastStore'
import { basename, mediaKind, mediaPaths } from './sentinels'
import { createTtsPlayer, type TtsPlayer } from '../audio/ttsPlayer'
import {
  deriveAgentState,
  deriveLabel,
  initialFlags,
  reduce,
  short,
  type Fatal,
  type Flags,
} from './flags'
import { createStateGate } from './gate'
import type { ServerMsg, VoiceMode } from './protocol'
import { install, sendApproval, stopCapture } from './socket'

/**
 * The voice socket, translated into NovaEvents.
 *
 * This is the only file that knows both languages. Everything downstream — the
 * canvas, the placement solver, the blob, the panes — sees the same event
 * contract it saw when a scripted mock was driving it, which is why none of it
 * had to change.
 */

/**
 * Tools whose output is a result the user asked for.
 *
 * Matched on the unprefixed name. Everything else Hermes calls — file reads,
 * skill lookups, her own bookkeeping — is how she works rather than what she
 * found, and a panel for each of those buries the answer in scaffolding.
 */
const RESULT_TOOLS = ['terminal', 'bash', 'shell', 'sh', 'zsh', 'exec', 'run_command', 'python']

const isResultTool = (name: string) => RESULT_TOOLS.includes(short(name).toLowerCase())

/** Fixed id, so a second god_eye_show updates rather than duplicating. */
const CAMERA_PANE_ID = 'camera'
const HERMES_DOWN_PANE_ID = 'sys-hermes'
const FATAL_PANE_ID = 'sys-fatal'

let flags: Flags = initialFlags()
let player: TtsPlayer | null = null

/** Id of the reply currently streaming, or null between turns. */
let replyId: string | null = null

const gate = createStateGate((state) => emit({ t: 'agent.state', state }))

function publish(opts?: { immediate?: boolean }) {
  useWireStore.getState().setFlags(flags)
  useWireStore.getState().setLabel(deriveLabel(flags))
  gate.push(deriveAgentState(flags), opts)
}

function update(next: Flags, opts?: { immediate?: boolean }) {
  flags = next
  publish(opts)
}

/** The reply bubble, created lazily so an empty turn never leaves a blank one. */
function ensureReply(): string {
  if (replyId) return replyId
  replyId = uid('msg')
  emit({ t: 'agent.message', role: 'nova', text: '', id: replyId })
  return replyId
}

function endReply() {
  if (!replyId) return
  emit({ t: 'agent.done', id: replyId })
  replyId = null
}

/**
 * Files Nova named, opened as panes.
 *
 * Run once the reply is complete rather than per token: a `MEDIA:` path arrives
 * a few characters at a time, so spawning mid-stream would open a pane for
 * `/Users/tri` and then another for the real path. The chat strips the tag on
 * every token regardless, so nothing is visible in the meantime.
 *
 * A path keeps the same pane across mentions, so naming a file twice updates one
 * panel rather than stacking two — but the payload carries a fresh nonce each
 * time, so a file rewritten at the same path is actually re-fetched.
 */
const mediaPanes = new Map<string, string>()
let mediaSeq = 0

function openMedia(text: string) {
  for (const path of mediaPaths(text)) {
    // A generated id, not `media:${path}`. Pane ids are round-tripped through
    // a comma-joined string in the tether layer, and a filename may contain a
    // comma — which would split one id into two that match nothing.
    let id = mediaPanes.get(path)
    if (!id) {
      id = uid('media')
      mediaPanes.set(path, id)
    }
    const payload: MediaPayload = { path, kind: mediaKind(path), nonce: ++mediaSeq }
    emit({ t: 'pane.spawn', id, kind: 'media', title: basename(path), payload, ttl: null })
  }
}

function systemPane(id: string, text: string, items?: string[]) {
  emit({ t: 'pane.spawn', id, kind: 'system', title: 'System', payload: { text, items }, ttl: null })
}

function onFatal(f: Fatal | null) {
  if (!f) {
    emit({ t: 'pane.close', id: FATAL_PANE_ID })
    update({ ...flags, fatal: null })
    return
  }
  // Sticky, never a toast: none of these clear themselves, and a fatal that
  // auto-dismissed would leave a dead session looking like a resting one.
  const copy: Record<Fatal['kind'], string> = {
    'wake-model': `The wake-word model could not be loaded, so voice cannot start. ${f.message}`,
    unreachable: `${f.message} Start it with \`make dev-be\`, then reconnect.`,
    'mic-denied': f.message,
    'mic-lost': f.message,
    dropped: `${f.message} Reconnecting — note that a new connection starts a fresh Hermes session, with no memory of this one.`,
  }
  systemPane(FATAL_PANE_ID, copy[f.kind])
  // Immediate: a broken session must not wait out a cosmetic dwell.
  update({ ...flags, fatal: f }, { immediate: true })
}

/* Colour and cursor control from anything that thought it was writing to a
   terminal. It isn't, and the escape codes read as line noise. Anchored on the
   escape byte rather than on the bracket — a looser `[…]` match would eat JSON. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

function sanitize(output: string): string {
  return output
    .replace(ANSI, '')
    .replace(/\r\n?/g, '\n')
    // Scripts pad their output; a panel shouldn't carry the padding.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * A title with provenance, but never the command line.
 *
 * A URL in the command names the source better than any label we could invent —
 * "api.open-meteo.com" is the honest answer to "where did this come from". There
 * is nothing to say about the rest, so they say nothing.
 */
function titleFor(args: unknown): string {
  const command =
    typeof args === 'object' && args !== null && typeof (args as { command?: unknown }).command === 'string'
      ? ((args as { command: string }).command)
      : ''
  const host = command.match(/https?:\/\/([^/\s"'`]+)/)
  return host ? host[1].replace(/^www\./, '') : 'Result'
}

function handleTool(msg: Extract<ServerMsg, { type: 'hermes.tool' }>) {
  const name = msg.name ?? ''

  if (msg.status === 'start') {
    // The camera aside, a call that has only started has produced nothing, so
    // there is nothing to put in a panel. What is running belongs in the blob's
    // label, which already says it.
    //
    // Nova drives the camera through her own MCP tools. Hermes prefixes tool
    // names with the server that provides them, so match loosely. god_eye_look
    // deliberately matches neither: it reports without changing the view.
    if (name.includes('god_eye_show')) {
      const payload: CameraPayload = {
        src: '/camera/mjpeg',
        // A fresh nonce means a fresh connection rather than a cached dead one.
        nonce: Date.now(),
        label: 'GOD EYE',
      }
      emit({
        t: 'pane.spawn',
        id: CAMERA_PANE_ID,
        kind: 'camera',
        title: 'God Eye',
        payload,
        ttl: null,
      })
    } else if (name.includes('god_eye_hide')) {
      emit({ t: 'pane.close', id: CAMERA_PANE_ID })
    }
    return
  }

  if (!isResultTool(name)) return

  // A failed step is scaffolding too. Asked for the weather, Hermes reaches for
  // `python`, gets a 127, and reaches for `curl` instead — all before she says a
  // word. A red panel for a step she recovered from reads as a broken app. A
  // turn that actually fails still arrives as hermes.error and gets a panel.
  if (msg.error != null || (msg.exit_code != null && msg.exit_code !== 0)) return

  const text = sanitize(msg.output ?? '')
  // Plenty of commands succeed silently. Nothing came back, so nothing opens.
  if (!text) return

  const payload: ResultPayload = { text, durationS: msg.duration_s ?? null }
  emit({
    t: 'pane.spawn',
    id: uid('result'),
    kind: 'result',
    title: titleFor(msg.args),
    payload,
  })
}

function handle(msg: ServerMsg) {
  const next = reduce(flags, msg)

  // The talk control is not the only thing that can end a mic-mode capture:
  // the server closes one itself when it hits MANUAL_MAX_MS, and a typed
  // directive discards one mid-utterance. Neither goes through the control, so
  // without this the microphone would stay open — recording indicator and all —
  // for the rest of a session the user believes they closed.
  //
  // Keyed on leaving CAPTURING rather than on either message, so a third way
  // out cannot quietly reintroduce the leak. Acted on after `update(next)`
  // below, not here: stopCapture publishes mic:'off' itself, and `next` was
  // computed while the capture was still open, so it would put 'live' back.
  const captureEnded =
    flags.mode === 'mic' && flags.wakePhase === 'capturing' && next.wakePhase !== 'capturing'

  switch (msg.type) {
    case 'wake.detected':
      // A one-shot flare rather than a mood change. At the default threshold
      // this fires every few seconds on room noise, and mic amplitude is at a
      // local minimum here anyway — the user has just finished saying the wake
      // word and is drawing breath, so amplitude alone would *dim* the blob at
      // the exact moment it should acknowledge.
      level.wake = 1
      break

    case 'wake.rearm':
      // The turn barrier, and the only event guaranteed to arrive. Seal here
      // too: when the Hermes stream raises rather than times out, tts.complete
      // is never sent and `speaking` would otherwise stick true forever.
      endReply()
      player?.seal()
      break

    case 'transcript': {
      const text = msg.text.trim()
      if (text) {
        emit({ t: 'agent.message', role: 'user', text })
      } else {
        emit({ t: 'toast', text: 'Didn’t catch that.', tone: 'warn' })
      }
      break
    }

    case 'hermes.connected':
      emit({ t: 'pane.close', id: HERMES_DOWN_PANE_ID })
      // A reconnect is a brand-new gateway session with no memory of the last
      // one. That is a real change in what Nova knows, so it survives as its
      // own notice rather than living on the fatal pane the reconnect clears.
      if (flags.sessionId && flags.sessionId !== msg.session_id) {
        emit({
          t: 'toast',
          text: 'Reconnected — a fresh Hermes session, with no memory of the previous one.',
          tone: 'warn',
        })
      }
      break

    case 'hermes.error':
      if (flags.hermes === 'unknown') {
        // Session-wide verdict: the gateway was unreachable at open.
        systemPane(
          HERMES_DOWN_PANE_ID,
          'Hermes is unavailable, so Nova cannot reply this session. Speech is still transcribed.',
          [msg.message],
        )
      } else {
        // One failed turn, not a broken session — so a notice, not a panel.
        // The next thing the user does is ask again, and a pane they have to
        // dismiss first is in the way of exactly that.
        endReply()
        emit({ t: 'toast', text: 'That turn failed.', detail: msg.message, tone: 'warn' })
      }
      break

    case 'hermes.delta':
      emit({ t: 'agent.token', id: ensureReply(), text: msg.text })
      break

    case 'hermes.complete':
      // Fall back to the complete text for a reply that arrived with no deltas.
      if (!replyId && msg.text) emit({ t: 'agent.token', id: ensureReply(), text: msg.text })
      endReply()
      // Carries the whole reply whether or not deltas streamed, so this is the
      // one place a MEDIA: path is guaranteed to be complete.
      openMedia(msg.text)
      break

    case 'hermes.tool':
      handleTool(msg)
      break

    case 'hermes.approval': {
      const choices = next.turn.approval?.choices ?? ['once', 'deny']
      const payload: ConfirmPayload = {
        question: msg.prompt || 'Hermes is asking for approval.',
        choices,
        onChoice: (choice) => sendApproval(choice),
      }
      emit({
        t: 'pane.spawn',
        id: 'approval',
        kind: 'confirm',
        title: 'Authorization',
        payload,
        ttl: null,
        // Pinned so the coalescer can never fold it away. A folded approval
        // cannot be answered, and an unanswered one blocks the agent for ten
        // minutes with the microphone discarded the whole time.
        pinned: true,
      })
      break
    }

    case 'hermes.approval.done':
      emit({ t: 'pane.close', id: 'approval' })
      break

    case 'tts.start':
      // Despite the name this is not an audio signal — it fires before the
      // first delta. What it actually marks is "the turn was accepted".
      player?.beginTurn()
      break

    case 'tts.complete':
      // Exact, with no counting: the server awaits its TTS worker before
      // sending this, and frame order on one socket is strict, so every MP3
      // for the turn has already reached us.
      player?.seal()
      break

    case 'error':
      // The reference client logged these to the console, where no user has
      // ever looked. A notice is enough: the pipeline stays up.
      emit({ t: 'toast', text: 'Voice pipeline error.', detail: msg.message, tone: 'warn' })
      break

    case 'wake.error':
      // The server closes right after this, so it is terminal by construction.
      onFatal({ kind: 'wake-model', message: msg.message })
      return

    case 'wake.listening':
    case 'stt.start':
    case 'hermes.thinking':
      break
  }

  update(next)
  if (captureEnded) stopCapture()
}

/**
 * Mirrors the chosen mode into the flags, so the pure derive functions can see
 * it without reaching into a store.
 */
export function setMode(mode: VoiceMode) {
  if (flags.mode === mode) return
  update({ ...flags, mode })
}

/** Wires the socket to the bus. Call once, at module init. */
export function installAdapter(): TtsPlayer {
  player = createTtsPlayer({
    onSpeakingChange: (speaking) => update({ ...flags, speaking }),
    onBlockedChange: (audioBlocked) => update({ ...flags, audioBlocked }),
    onDecodeError: (err) =>
      toast('A sentence of Nova’s reply could not be decoded.', {
        detail: err instanceof Error ? err.message : String(err),
        tone: 'warn',
      }),
  })

  install({
    onMessage: handle,
    onAudio: (mp3) => player?.push(mp3),
    onSocketState: (socket) => {
      if (socket !== 'open') {
        // Nothing more is coming; release the player so `speaking` can settle.
        player?.seal()
        endReply()
      }
      update({ ...flags, socket })
    },
    onFatal,
    onMic: (mic) => update({ ...flags, mic }),
    onRetry: (ms) => useWireStore.getState().setRetryInMs(ms),
  })

  return player
}
