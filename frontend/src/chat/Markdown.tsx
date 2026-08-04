import { useMemo, useState } from 'react'
// `md.ts`, not `markdown.ts`: this file is `Markdown.tsx`, and the two collide
// on a case-insensitive filesystem.
import type { Block } from './md'
import { isShell, parseInline, parseMarkdown } from './md'

/**
 * Nova's reply, rendered.
 *
 * The caret is threaded in rather than appended after, so a streaming reply
 * blinks at the end of its last line instead of on a line of its own — and never
 * inside a code block, where it would read as part of the command.
 */
export function Markdown({ text, caret }: { text: string; caret?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  const lastIndex = blocks.length - 1
  const tail = blocks[lastIndex]
  const inlineCaret = Boolean(caret) && (tail?.kind === 'p' || tail?.kind === 'heading')

  return (
    <div className="md">
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} caret={inlineCaret && i === lastIndex} />
      ))}
      {caret && !inlineCaret && <span className="msg__caret" />}
    </div>
  )
}

function BlockView({ b, caret }: { b: Block; caret: boolean }) {
  switch (b.kind) {
    case 'code':
      return <CodeBlock lang={b.lang} text={b.text} />

    case 'list': {
      const List = b.ordered ? 'ol' : 'ul'
      return (
        <List className="md-list" data-ordered={String(b.ordered)}>
          {b.items.map((it, i) => (
            <li key={i}>
              <Inline text={it} />
            </li>
          ))}
        </List>
      )
    }

    case 'heading':
      return (
        // One visual weight for every level. A chat bubble is not a document,
        // and six sizes of heading inside a 420px pane is noise.
        <div className="md-h" data-level={b.level}>
          <Inline text={b.text} />
          {caret && <span className="msg__caret" />}
        </div>
      )

    case 'quote':
      return (
        <blockquote className="md-quote">
          <Inline text={b.text} />
        </blockquote>
      )

    case 'p':
      return (
        <p className="md-p">
          <Inline text={b.text} />
          {caret && <span className="msg__caret" />}
        </p>
      )
  }
}

function Inline({ text }: { text: string }) {
  const spans = useMemo(() => parseInline(text), [text])
  return (
    <>
      {spans.map((s, i) => {
        switch (s.kind) {
          case 'code':
            return (
              <code className="md-code-inline" key={i}>
                {s.text}
              </code>
            )
          case 'strong':
            return <strong key={i}>{s.text}</strong>
          case 'em':
            return <em key={i}>{s.text}</em>
          case 'link':
            return (
              <a className="md-link" href={s.href} target="_blank" rel="noreferrer" key={i}>
                {s.text}
              </a>
            )
          case 'text':
            return <span key={i}>{s.text}</span>
        }
      })}
    </>
  )
}

/**
 * A fenced block, as a terminal when it holds shell.
 *
 * The prompt glyph sits in its own column rather than in the text, so copying
 * gives you the command and not a `$` you have to delete. Only the first line
 * gets one: the rest are continuations, and prompting every line would be a lie
 * about what was typed.
 */
function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const shell = isShell(lang)
  const lines = text.replace(/\n+$/, '').split('\n')

  const copy = () => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      },
      // Clipboard access can be refused outright. Saying nothing would leave
      // the button looking broken; saying "copied" would be a lie.
      () => setCopied(false),
    )
  }

  return (
    <div className="md-code" data-shell={String(shell)}>
      <div className="md-code__bar">
        <span className="md-code__lang">{lang || (shell ? 'shell' : 'text')}</span>
        <button className="md-code__copy" onClick={copy} title="Copy">
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="md-code__body">
        {lines.map((l, i) => (
          <span className="md-code__line" key={i}>
            {shell && <span className="md-code__prompt">{i === 0 ? '$' : ' '}</span>}
            <span className="md-code__text">{l}</span>
          </span>
        ))}
      </pre>
    </div>
  )
}
