import { usePaneStore } from '../state/usePaneStore'
import type { ConfirmPayload, DeckPayload, SystemPayload } from './payloads'
import './kinds.css'

/* Every kind receives the raw payload plus its own pane id. Payloads are typed
 * at the call site (wire/adapter.ts) and cast here — the alternative, a
 * discriminated union threaded through the store, buys nothing for a fixed set
 * of kinds. */
export interface KindProps {
  id: string
  payload: unknown
}

export function SystemPane({ payload }: KindProps) {
  const p = payload as SystemPayload
  return (
    <div className="pk">
      <p className="pk-system__text">{p.text}</p>
      {p.items && (
        <ul className="pk-system__items">
          {p.items.map((it) => (
            <li key={it}>{it}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Choices Hermes uses to mean "no". Styled as the cancel action. */
const DENY = new Set(['deny', 'no', 'reject', 'cancel'])

export function ConfirmPane({ id, payload }: KindProps) {
  const p = payload as ConfirmPayload
  const close = usePaneStore((s) => s.close)

  // n-ary path: one button per choice Hermes actually offered.
  if (p.choices?.length) {
    const choices = p.choices
    const answer = (choice: string) => {
      p.onChoice?.(choice)
      close(id)
    }
    return (
      <div className="pk">
        <div className="pk-confirm__q">{p.question}</div>
        {p.detail && <div className="pk-confirm__d">{p.detail}</div>}
        <div className="pk-confirm__actions">
          {choices.map((c, i) => (
            <button
              key={c}
              className={
                !DENY.has(c.toLowerCase()) && i === choices.length - 1
                  ? 'pk-btn pk-btn--primary'
                  : 'pk-btn'
              }
              onClick={() => answer(c)}
              autoFocus={i === 0}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
    )
  }

  const answer = (ok: boolean) => {
    p.resolve?.(ok)
    close(id)
  }
  return (
    <div className="pk">
      <div className="pk-confirm__q">{p.question}</div>
      {p.detail && <div className="pk-confirm__d">{p.detail}</div>}
      <div className="pk-confirm__actions">
        <button className="pk-btn" onClick={() => answer(false)}>
          {p.cancelLabel ?? 'Cancel'}
        </button>
        <button className="pk-btn pk-btn--primary" onClick={() => answer(true)} autoFocus>
          {p.confirmLabel ?? 'Authorize'}
        </button>
      </div>
    </div>
  )
}

export function DeckPane({ id, payload }: KindProps) {
  const p = payload as DeckPayload
  const expand = usePaneStore((s) => s.expandDeck)
  return (
    <div className="pk-deck">
      <div className="pk-deck__hint">{p.items.length} collapsed · canvas full</div>
      {p.items.slice(-3).map((it) => (
        <div className="pk-deck__item" key={it.id}>
          {it.title}
        </div>
      ))}
      <button className="pk-deck__all" onClick={() => expand(id)}>
        Restore all
      </button>
    </div>
  )
}
