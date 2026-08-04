import { useGuideStore } from '../state/useGuideStore'
import './SnapGuides.css'

/** Alignment lines that appear only while a drag is latched to something. */
export function SnapGuides() {
  const guides = useGuideStore((s) => s.guides)
  if (!guides.length) return null
  return (
    <div className="guides" aria-hidden>
      {guides.map((g, i) => (
        <div
          key={`${g.axis}-${g.at}-${i}`}
          className={`guide guide--${g.axis}`}
          style={g.axis === 'x' ? { left: g.at } : { top: g.at }}
        />
      ))}
    </div>
  )
}
