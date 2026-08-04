/**
 * The subset of Markdown Hermes actually writes, and nothing else.
 *
 * Replies arrive as Markdown — `**bold**`, bullet lists, and fenced code blocks
 * holding the commands she ran — so rendering them as plain text puts asterisks
 * and backticks on screen. A full CommonMark engine is ~150kB to solve a problem
 * with five shapes in it, and it would still need overriding to make a fence
 * look like a terminal rather than a grey box.
 *
 * Two rules make this safe to hand-roll:
 *   1. It never throws. Anything it fails to recognise falls through as text, so
 *      the worst case is what we had before rather than a blank reply.
 *   2. Unterminated markup is normal, not an error. Every reply is parsed dozens
 *      of times while it streams, so a half-typed `**bo` or an open fence has to
 *      render as *something* on every keystroke, and that something must not
 *      change shape when the closing marker finally lands.
 */

import { stripSentinels } from '../wire/sentinels'

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; text: string }

const FENCE = /^\s*(?:```|~~~)\s*([\w+-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
/** A horizontal rule, which we drop: it separates nothing in a chat bubble. */
const RULE = /^\s*(?:[-*_]\s*){3,}$/

export function parseMarkdown(src: string): Block[] {
  // Protocol sentinels are stripped before anything else looks at the text.
  // `MEDIA:/path/to.png` is an instruction to open a pane, not a sentence, and
  // the pane is already doing that.
  const lines = stripSentinels(src).split('\n')
  const blocks: Block[] = []
  let para: string[] = []

  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join('\n') })
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      // Runs to the end of input when the closing fence hasn't streamed in yet.
      // That is deliberate: the block appears as code on the first line rather
      // than as a paragraph that later reflows into one.
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++])
      blocks.push({ kind: 'code', lang: fence[1], text: body.join('\n') })
      continue
    }

    if (!line.trim()) {
      flush()
      continue
    }

    if (RULE.test(line)) {
      flush()
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      flush()
      const body = [quote[1]]
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1])) {
        body.push(QUOTE.exec(lines[++i])![1])
      }
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }

    const bullet = BULLET.exec(line)
    const ordered = bullet ? null : ORDERED.exec(line)
    if (bullet || ordered) {
      flush()
      const isOrdered = !bullet
      const items = [(bullet ?? ordered)![1]]
      // Consecutive markers of the same flavour are one list. A switch from
      // bullets to numbers starts a new one, which is what the author meant.
      while (i + 1 < lines.length) {
        const next = lines[i + 1]
        const m = isOrdered ? ORDERED.exec(next) : BULLET.exec(next)
        if (!m) break
        items.push(m[1])
        i++
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }

    para.push(line)
  }

  flush()
  return blocks
}

/* ── Inline ───────────────────────────────────────────────── */

export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'link'; text: string; href: string }

/*
 * Code first, so backticks win over anything inside them.
 *
 * `_underscore_` emphasis is deliberately absent. Hermes talks about API fields
 * — `relative_humidity_2m`, `utc_offset_seconds` — and supporting it would
 * italicise the middle of every one of them.
 */
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g

export function parseInline(src: string): Span[] {
  const spans: Span[] = []
  let last = 0

  for (const m of src.matchAll(INLINE)) {
    const at = m.index
    if (at > last) spans.push({ kind: 'text', text: src.slice(last, at) })
    const tok = m[0]

    if (m[1]) spans.push({ kind: 'code', text: tok.slice(1, -1) })
    else if (m[2]) spans.push({ kind: 'strong', text: tok.slice(2, -2) })
    else if (m[3]) spans.push({ kind: 'em', text: tok.slice(1, -1) })
    else {
      const split = tok.indexOf('](')
      spans.push({
        kind: 'link',
        text: tok.slice(1, split),
        href: tok.slice(split + 2, -1),
      })
    }
    last = at + tok.length
  }

  if (last < src.length) spans.push({ kind: 'text', text: src.slice(last) })
  return spans
}

/** Shell-ish languages get a prompt glyph; everything else is just code. */
const SHELL = new Set(['bash', 'sh', 'zsh', 'shell', 'console', 'terminal', 'fish'])

export const isShell = (lang: string) => SHELL.has(lang.toLowerCase())
