import { emit } from '../core/bus'
import { isOpen, sendText } from './socket'

/**
 * Every typed utterance goes through here — the composer and the ⌘K palette.
 *
 * Note what this does *not* do: append the user's message locally. The server
 * echoes a `transcript` for typed directives exactly as it does for spoken
 * ones, so the transcript has a single producer and needs no de-duplication.
 * The round trip is a same-machine socket, so the latency is invisible.
 */
export function submitUtterance(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return

  if (!isOpen()) {
    // Never silently drop input. The old client's failure here was invisible.
    emit({
      t: 'toast',
      text: 'Not sent — Nova is asleep.',
      detail: 'Wake her with the mic control, then try again.',
      tone: 'warn',
    })
    return
  }

  sendText(trimmed)
}

/**
 * First-run prompts.
 *
 * Deliberately generic: what Nova can actually do depends on which MCP servers
 * are registered with the Hermes gateway, so promising specific capabilities
 * here would be the same theatre the scripted scenarios were.
 */
export const SUGGESTIONS = ['What can you do?', 'Show me the god eye', 'What do you see?']
