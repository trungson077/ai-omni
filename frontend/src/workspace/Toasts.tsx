import { useToastStore } from '../state/useToastStore'

/**
 * The notice stack, under the HUD chips in the top-right.
 *
 * Newest at the bottom, so the column grows downward and an existing notice
 * never jumps under the reader's eye as another arrives.
 *
 * `aria-live="polite"` rather than `assertive`: none of these interrupt
 * anything, and Nova is usually speaking the same information at the time.
 */
export function Toasts() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          className="toast"
          data-tone={t.tone}
          onClick={() => dismiss(t.id)}
          title="Dismiss"
        >
          <span className="toast__text">{t.text}</span>
          {t.detail && <span className="toast__detail">{t.detail}</span>}
        </button>
      ))}
    </div>
  )
}
