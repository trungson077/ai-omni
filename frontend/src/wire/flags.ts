import type { AgentState } from '../core/types'
import type { ServerMsg, VoiceMode } from './protocol'

/**
 * Everything known about the session, and the two functions that turn it into
 * something renderable.
 *
 * Pure on purpose — no store, no emit, no side effects. Three drivers (tool
 * execution, token streaming, audio playback) overlap in time, so assigning
 * AgentState per-event makes the blob flicker between moods. Collecting facts
 * first and deriving once is what keeps that stable.
 */

export type FatalKind =
  /** The wake model failed to load. Deterministic; retrying loops forever. */
  | 'wake-model'
  /** Never reached the backend at all. */
  | 'unreachable'
  | 'mic-denied'
  | 'mic-lost'
  /** Closed unexpectedly mid-session. The only kind worth reconnecting. */
  | 'dropped'

export interface Fatal {
  kind: FatalKind
  message: string
}

/** Mirrors the server's ARMED / CAPTURING / BUSY. */
export type WakePhase = 'armed' | 'capturing' | 'busy'

export interface TurnFlags {
  /** Bumped every turn, so late async work can tell it is stale. */
  id: number
  /** Between the first delta and hermes.complete. */
  streaming: boolean
  /** hermes.thinking replaces this rather than appending. */
  thinking: string
  /**
   * Tool names started but not yet completed. A list rather than a counter:
   * a start whose complete never arrives (turn killed by timeout) would pin a
   * counter above zero and freeze the blob in `executing` for the whole
   * session. This is wiped at the wake.rearm barrier instead.
   */
  activeTools: string[]
  approval: { prompt: string; choices: string[] } | null
  error: string | null
}

export interface Flags {
  socket: 'idle' | 'connecting' | 'open' | 'closed'
  fatal: Fatal | null
  /** Which way into a turn this session has. See VoiceMode. */
  mode: VoiceMode
  /**
   * Four states, not a boolean.
   *
   * "Frames are reaching the server" matters because socket-open-with-a-dead-mic
   * is the worst failure a voice UI can have, and it is otherwise invisible:
   * sends are guarded on readyState, so frames just vanish while the server
   * waits in ARMED forever.
   *
   * But a boolean cannot tell "not started yet" from "started and gone deaf",
   * and getUserMedia resolves well after the socket opens — so a two-state
   * version reports a silent microphone for the whole permission prompt, which
   * is a lie at exactly the moment the user is deciding whether to trust it.
   *
   * `off` is the fourth, and it is what makes mic mode expressible: a closed
   * capture that is closed on purpose. Without it, resting between turns in mic
   * mode is indistinguishable from a microphone that never came up.
   */
  mic: 'off' | 'starting' | 'live' | 'silent'
  wakePhase: WakePhase
  /**
   * The capture in flight was opened by the talk control, not the wake word.
   *
   * Worth tracking because the server behaves differently: its endpointer is
   * off for the duration, so nothing but a second press will end the utterance.
   * A UI that showed the two the same way would leave someone waiting for a
   * silence timeout that is never coming.
   */
  manual: boolean
  /** Three states, not a boolean: "no event yet" is what disambiguates the
   *  two meanings of hermes.error. */
  hermes: 'unknown' | 'ok' | 'down'
  wakeThreshold: number | null
  sessionId: string | null
  turn: TurnFlags
  /** Owned by the audio player, not the socket. True == audible. */
  speaking: boolean
  /** Autoplay policy is blocking playback. */
  audioBlocked: boolean
}

export const freshTurn = (id: number): TurnFlags => ({
  id,
  streaming: false,
  thinking: '',
  activeTools: [],
  approval: null,
  error: null,
})

export const initialFlags = (): Flags => ({
  socket: 'idle',
  fatal: null,
  mode: 'wake',
  mic: 'off',
  wakePhase: 'armed',
  manual: false,
  hermes: 'unknown',
  wakeThreshold: null,
  sessionId: null,
  turn: freshTurn(0),
  speaking: false,
  audioBlocked: false,
})

/** Folds one server message into the flags. Never mutates the input. */
export function reduce(f: Flags, msg: ServerMsg): Flags {
  switch (msg.type) {
    case 'wake.listening':
      return { ...f, wakePhase: 'armed', manual: false, wakeThreshold: msg.threshold }

    case 'wake.detected':
      // Which way in it was, kept so the talk control can show its own state
      // and the label can stop saying “say hey nova” at someone who just
      // pressed a button instead.
      return { ...f, wakePhase: 'capturing', manual: msg.source === 'manual' }

    case 'wake.rearm':
      // The turn barrier. This is the only event guaranteed to arrive at the
      // end of a turn — tts.complete is skipped entirely when the Hermes
      // stream raises rather than times out.
      return { ...f, wakePhase: 'armed', manual: false, turn: freshTurn(f.turn.id + 1) }

    case 'wake.error':
      // Unreachable in mic mode: no detector is constructed there, so there is
      // nothing that can fail to load.
      return {
        ...f,
        fatal: { kind: 'wake-model', message: msg.message },
        mic: 'off',
      }

    case 'stt.start':
      return { ...f, wakePhase: 'busy', manual: false }

    case 'transcript':
      return f

    case 'hermes.connected':
      return { ...f, hermes: 'ok', sessionId: msg.session_id }

    case 'hermes.error':
      // Before `connected` this is a session-wide verdict; after, it is a
      // failed turn and no hermes.complete will follow, so end the stream here.
      return f.hermes === 'unknown'
        ? { ...f, hermes: 'down' }
        : { ...f, turn: { ...f.turn, streaming: false, error: msg.message } }

    case 'hermes.delta':
      return { ...f, turn: { ...f.turn, streaming: true } }

    case 'hermes.complete':
      return { ...f, turn: { ...f.turn, streaming: false } }

    case 'hermes.thinking':
      return { ...f, turn: { ...f.turn, thinking: msg.text } }

    case 'hermes.tool': {
      if (msg.status === 'start') {
        return {
          ...f,
          turn: { ...f.turn, activeTools: [...f.turn.activeTools, msg.name] },
        }
      }
      // Resolve the oldest unresolved call of that name. The wire carries no
      // call id, so two concurrent calls to one tool are indistinguishable;
      // FIFO is the best available answer.
      const i = f.turn.activeTools.indexOf(msg.name)
      if (i === -1) return f
      const activeTools = [...f.turn.activeTools]
      activeTools.splice(i, 1)
      return { ...f, turn: { ...f.turn, activeTools } }
    }

    case 'hermes.approval':
      return {
        ...f,
        turn: {
          ...f.turn,
          approval: {
            prompt: msg.prompt,
            choices: msg.choices?.length ? msg.choices : ['once', 'deny'],
          },
        },
      }

    case 'hermes.approval.done':
      return { ...f, turn: { ...f.turn, approval: null } }

    case 'tts.start':
    case 'tts.complete':
      // Neither says anything about audibility: tts.start fires before the
      // first delta, and tts.complete means "last sentence sent". `speaking`
      // is owned by the player.
      return f

    case 'error':
      return { ...f, turn: { ...f.turn, error: msg.message } }
  }
}

/**
 * The one place AgentState is decided.
 *
 * Order is the whole design, so each branch is justified:
 *
 *  - `speaking` outranks even a dead socket. The remaining sentences are
 *    already scheduled in the audio graph, so "finishing the sentence" is the
 *    honest render rather than an instant snap to idle. Safe above `fatal`
 *    because wake.error can only fire before any audio exists.
 *  - `responding` outranks `executing`: audio is the dominant channel, a mood
 *    that contradicts the voice you can hear is simply wrong, and tool identity
 *    has a better home in its own pane. It is also mechanically load-bearing —
 *    the blob attenuates the speech envelope outside `responding`.
 *  - ARMED and CAPTURING share `listening` in wake mode deliberately. See
 *    deriveLabel. In mic mode they do not, because there ARMED genuinely means
 *    the microphone is shut.
 */
export function deriveAgentState(f: Flags): AgentState {
  if (f.speaking) return 'responding'
  if (f.socket !== 'open') return 'idle'
  // Deaf is a fault in either mode.
  if (f.mic === 'silent') return 'idle'
  // A closed capture is only a fault in wake mode, where it is supposed to run
  // for the whole session. "Not listening yet" must not read as ready either.
  if (f.mode === 'wake' && f.mic !== 'live') return 'idle'
  if (f.turn.approval) return 'executing'
  if (f.turn.activeTools.length > 0) return 'executing'
  if (f.wakePhase === 'busy') return 'thinking'
  // Nothing is being heard in mic mode until the talk control is engaged, so an
  // armed-but-closed capture is rest, not readiness.
  if (f.mode === 'mic' && f.wakePhase === 'armed') return 'idle'
  return 'listening'
}

/**
 * The text under the blob.
 *
 * Split from the mood because text costs nothing to change and a mood costs a
 * 420ms ease. So the label carries every distinction the mood must not: at the
 * default wake threshold the app enters CAPTURING every few seconds on room
 * noise, and a mood that eased in and out on that loop would read as a slow
 * unexplained pulse. A word swap reads as attentiveness.
 */
export function deriveLabel(f: Flags): string {
  if (f.fatal) {
    switch (f.fatal.kind) {
      case 'wake-model':
        return 'wake word unavailable'
      case 'unreachable':
        return 'no connection'
      case 'mic-denied':
        return 'microphone blocked'
      case 'mic-lost':
        return 'no microphone'
      case 'dropped':
        return 'reconnecting'
    }
  }
  if (f.socket === 'connecting') return 'connecting'
  if (f.socket !== 'open') return 'dormant'
  if (f.mic === 'starting') return 'opening the microphone'
  if (f.mic === 'silent') return 'microphone silent'
  if (f.audioBlocked) return 'tap to hear nova'
  if (f.speaking) return 'speaking'
  if (f.turn.approval) return 'waiting for you'
  if (f.turn.activeTools.length > 0) return `running ${short(f.turn.activeTools[0])}`
  if (f.wakePhase === 'busy') return f.turn.streaming ? 'thinking' : 'transcribing'
  if (f.hermes === 'down') return 'transcribing only'
  if (f.wakePhase === 'capturing') return f.manual ? 'go ahead' : 'listening'
  // Resting. What ends the rest is the only thing worth saying, and the two
  // modes end it differently.
  return f.mode === 'mic' ? 'press to talk' : 'say “hey nova”'
}

/** Hermes prefixes MCP tools with their server: mcp__god-eye__god_eye_show. */
export function short(toolName: string): string {
  const parts = toolName.split('__')
  return parts[parts.length - 1] || toolName
}
