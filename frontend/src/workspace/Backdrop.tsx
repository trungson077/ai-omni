import { useEffect, useRef } from 'react'
import { prefersReducedMotion, subscribe } from '../core/ticker'
import './Backdrop.css'

/** feTurbulence grain, inlined so there's no network request for it. */
const GRAIN = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="180" height="180" filter="url(%23n)"/></svg>`,
)}")`

interface Mote {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  a: number
  /** phase offset so they don't all twinkle in lockstep */
  ph: number
}

const COUNT = 30

function Particles() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || prefersReducedMotion()) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // 1× is plenty for 1px motes, and it keeps the per-frame clear of a
    // full-viewport canvas cheap.
    const dpr = 1
    let w = 0
    let h = 0
    const motes: Mote[] = []

    const seed = () => {
      motes.length = 0
      for (let i = 0; i < COUNT; i++) {
        motes.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.055,
          vy: -0.012 - Math.random() * 0.03,
          r: 0.5 + Math.random() * 1.2,
          a: 0.1 + Math.random() * 0.32,
          ph: Math.random() * Math.PI * 2,
        })
      }
    }

    const resize = () => {
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (motes.length === 0) seed()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const stop = subscribe((dt, now) => {
      ctx.clearRect(0, 0, w, h)
      const t = now / 1000
      for (const m of motes) {
        m.x += m.vx * dt
        m.y += m.vy * dt
        if (m.y < -4) {
          m.y = h + 4
          m.x = Math.random() * w
        }
        if (m.x < -4) m.x = w + 4
        else if (m.x > w + 4) m.x = -4

        const twinkle = 0.65 + 0.35 * Math.sin(t * 0.9 + m.ph)
        ctx.beginPath()
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(100, 181, 255, ${m.a * twinkle * 0.7})`
        ctx.fill()
      }
    })

    return () => {
      stop()
      ro.disconnect()
    }
  }, [])

  return <canvas ref={ref} className="backdrop__particles" aria-hidden />
}

export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden>
      <div className="backdrop__grid" />
      <Particles />
      <div className="backdrop__grain" style={{ ['--grain-url' as string]: GRAIN }} />
      <div className="backdrop__vignette" />
    </div>
  )
}
