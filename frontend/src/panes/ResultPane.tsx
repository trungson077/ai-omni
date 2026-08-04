import { useMemo } from 'react'
import type { KindProps } from './kinds'
import type { ResultPayload } from './payloads'

/**
 * A tool's output, read rather than dumped.
 *
 * Almost everything Nova shells out for answers in JSON — weather APIs, geo
 * lookups, anything with a `--json` flag — and a wall of braces is technically
 * the result while being useless as one. So structured output is laid out as
 * labelled rows, and only genuinely unstructured text falls back to a monospace
 * block. Values are never reformatted, rounded, or reworded: the layout is ours,
 * the data is the tool's.
 */
export function ResultPane({ payload }: KindProps) {
  const p = payload as ResultPayload
  const structured = useMemo(() => parse(p.text), [p.text])

  return (
    <div className="pk pk-result">
      {structured === undefined ? (
        <pre className="pk-result__raw">{p.text}</pre>
      ) : (
        <Node v={structured} depth={0} />
      )}
      {p.durationS !== null && (
        <div className="pk-result__meta">{duration(p.durationS)}</div>
      )}
    </div>
  )
}

/**
 * JSON, or nothing.
 *
 * Only objects and arrays count. `JSON.parse` also happily accepts `42` and
 * `"ok"`, and turning a one-word answer into a single labelled row is worse than
 * just printing the word.
 */
function parse(text: string): unknown {
  const t = text.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined
  try {
    const v: unknown = JSON.parse(t)
    return typeof v === 'object' && v !== null ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * Past this, nesting stops earning its indentation and the rows get too narrow
 * to read in a 400px pane. Deeper values print as compact JSON, which is honest
 * about being a blob.
 */
const MAX_DEPTH = 3

function Node({ v, depth }: { v: unknown; depth: number }) {
  if (v === null || v === undefined) return <span className="pk-result__nil">—</span>
  if (typeof v !== 'object') return <span className="pk-result__val">{String(v)}</span>
  if (depth >= MAX_DEPTH) return <span className="pk-result__val">{JSON.stringify(v)}</span>

  if (Array.isArray(v)) {
    if (!v.length) return <span className="pk-result__nil">empty</span>
    // A list of scalars is a row of values; a list of objects is a run of
    // numbered sections. Same markup for both would make one of them unreadable.
    if (v.every((x) => x === null || typeof x !== 'object')) {
      return (
        <span className="pk-result__inline">
          {v.map((x, i) => (
            <span className="pk-result__val" key={i}>
              {x === null ? '—' : String(x)}
            </span>
          ))}
        </span>
      )
    }
    return (
      <div className="pk-result__nest">
        {v.map((x, i) => (
          <section className="pk-result__sect" key={i}>
            <h4 className="pk-result__key">{i + 1}</h4>
            <Node v={x} depth={depth + 1} />
          </section>
        ))}
      </div>
    )
  }

  const rows = Object.entries(v as Record<string, unknown>)
  if (!rows.length) return <span className="pk-result__nil">empty</span>

  return (
    <dl className="pk-result__rows">
      {rows.map(([k, val]) => {
        // A nested object needs the full width, so its label goes above it
        // rather than beside it. A scalar reads better as a two-column row.
        const block = val !== null && typeof val === 'object' && depth + 1 < MAX_DEPTH
        return (
          <div className="pk-result__row" data-block={String(block)} key={k}>
            <dt className="pk-result__key">{label(k)}</dt>
            <dd className="pk-result__value">
              <Node v={val} depth={depth + 1} />
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

/** `relative_humidity_2m` reads as a label, not as an identifier. */
function label(key: string): string {
  return key.replace(/[_-]+/g, ' ').trim() || '—'
}

function duration(s: number): string {
  return s < 1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(1)}s`
}
