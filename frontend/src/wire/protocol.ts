/**
 * The wire, exactly as `backend/app/routers/voice.py` and `backend/app/hermes.py`
 * speak it. This file is the single source of truth for the contract; if the
 * backend gains an event, adding it here turns every unhandled site into a
 * compile error rather than a silent no-op.
 *
 * Two things about this socket are easy to get wrong and impossible to see:
 *
 *  - Client→server binary frames are microphone PCM; server→client binary
 *    frames are MP3. Same socket, no envelope, direction is the only tag.
 *  - There is no id on any frame. A transcript is matched to its reply purely
 *    by arrival order.
 */

/**
 * Which way into a turn this connection has.
 *
 * Fixed for the life of the socket, because the server decides whether to load
 * the wake model at accept time — before any client frame exists to carry the
 * choice. It travels as a query parameter for that reason, not as a ClientMsg.
 *
 *  - `wake` — the detector is armed for the whole session and the capture runs
 *    continuously to feed it. Saying "hey nova" opens a turn.
 *  - `mic`  — no detector at all. The talk control is the only way in, and the
 *    microphone is only open while it is engaged.
 */
export type VoiceMode = 'mic' | 'wake'

/** Server → client, JSON text frames. */
export type ServerMsg =
  /* ── wake word ─────────────────────────────────────────── */
  /**
   * Sent once, immediately after accept. `threshold` is null in mic mode: no
   * detector was loaded, so there is no score to compare anything against.
   */
  | { type: 'wake.listening'; threshold: number | null }
  /**
   * A capture opened. `source` says which of the two ways in it was: the wake
   * word firing, or the talk control being pressed. One event for both, so the
   * client has a single path into "capturing" — `score` is null for `manual`,
   * since nothing was scored.
   */
  | { type: 'wake.detected'; score: number | null; source?: 'wake' | 'manual' }
  /** Turn barrier. The only event guaranteed to end a turn. */
  | { type: 'wake.rearm' }
  /**
   * Fatal, and always the first frame: it comes from Detector construction,
   * which runs before the Hermes connect. The server closes right after.
   */
  | { type: 'wake.error'; message: string }
  /* ── speech to text ────────────────────────────────────── */
  | { type: 'stt.start' }
  /** `source` is present only for typed directives echoed back. */
  | { type: 'transcript'; text: string; source?: 'text' }
  /* ── the agent ─────────────────────────────────────────── */
  | { type: 'hermes.connected'; session_id: string | null }
  /**
   * Overloaded. Before `hermes.connected` it means "the gateway is unreachable,
   * this whole session is transcription-only"; after, it means "this turn
   * failed" — and no `hermes.complete` will follow.
   */
  | { type: 'hermes.error'; message: string }
  | { type: 'hermes.delta'; text: string }
  | { type: 'hermes.complete'; text: string }
  /** Reasoning text. Replaces rather than appends. */
  | { type: 'hermes.thinking'; text: string }
  /**
   * `tool_id` correlates a start with its completion. Matching on `name`
   * instead is wrong the moment one tool runs twice in a turn, which the
   * agent does routinely — a weather question ran `terminal` five times.
   *
   * `context` is the command for shell-style tools, and arrives on `start`. The
   * UI deliberately ignores it: a panel that opens to announce what is about to
   * run is the agent's scaffolding, not its answer. The command reaches us again
   * in `args` on completion, where it is used for provenance only.
   */
  | { type: 'hermes.tool'; name: string; status: 'start'; tool_id?: string; context?: string }
  | {
      type: 'hermes.tool'
      name: string
      status: 'complete'
      tool_id?: string
      args?: unknown
      duration_s?: number | null
      /** stdout+stderr, truncated server-side. */
      output?: string
      /** Non-zero means the command failed. */
      exit_code?: number | null
      error?: string | null
    }
  /** Blocks the agent for up to 600s until answered. */
  | { type: 'hermes.approval'; prompt: string; choices?: string[] }
  | { type: 'hermes.approval.done' }
  /* ── text to speech ────────────────────────────────────── */
  /**
   * Not an audio signal — it fires before the first delta. What it actually
   * means is "the turn was accepted and a reply is coming".
   */
  | { type: 'tts.start' }
  /** Last sentence *sent*, not finished playing. */
  | { type: 'tts.complete' }
  /* ── failures ──────────────────────────────────────────── */
  | { type: 'error'; message: string }

/** Client → server, JSON text frames. Everything else is binary PCM. */
export type ClientMsg =
  | { type: 'approval'; choice: string }
  /** Submits an utterance without the microphone, skipping STT. */
  | { type: 'text'; text: string }
  /**
   * Opens or closes a capture directly. In wake mode this is the second way in;
   * in mic mode it is the only one.
   */
  | { type: 'talk'; on: boolean }
  /** Ends the session. There is no "stop talking" primitive. */
  | { type: 'stop' }

export type ServerMsgType = ServerMsg['type']

/**
 * Parses a text frame, or returns null for anything unrecognised.
 *
 * Deliberately tolerant: an unknown `type` from a newer backend should be
 * ignored, not thrown. The compile-time exhaustiveness check lives at the
 * consumer instead, where it can actually be acted on.
 */
export function parseServerMsg(raw: string): ServerMsg | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const t = (data as { type?: unknown }).type
  return typeof t === 'string' ? (data as ServerMsg) : null
}
