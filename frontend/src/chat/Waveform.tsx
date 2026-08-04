import { useEffect, useRef } from 'react'
import { subscribe } from '../core/ticker'
import { level } from '../voice/level'

/**
 * Mirrored bar waveform — the voice-memo / SoundCloud shape.
 *
 * The distinction that makes it read as a waveform rather than a level meter is
 * *history*: each bar is a sample of the past, the newest on the right, older
 * ones scrolling left. A meter with bars that all move at once looks like an
 * equaliser; this looks like a recording.
 *
 * Restraint is deliberate. 2px bars on a 3px pitch, mirrored around a centre
 * line, and the older half fades out — so it reads as texture at a glance and
 * only resolves into detail if you look. Nothing pulses, nothing glows.
 */

/** Sample pitch. One bar per SAMPLE_MS of audio, regardless of frame rate. */
const SAMPLE_MS = 55
const BAR_W = 2
const GAP = 1
/** Minimum bar so silence reads as a quiet line rather than as nothing. */
const FLOOR = 0.06

interface Props {
  height?: number
  /** Half opacity for the resting state, before the mic is armed. */
  dim?: boolean
}

export function Waveform({ height = 28, dim = false }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // Width follows the composer rather than being fixed: at a fixed 116px this
    // read as a scribble in the middle of the pane instead of as a waveform.
    let width = 0
    let pitch = BAR_W + GAP
    let count = 0
    let bars = new Float32Array(0)
    let head = 0

    const resize = () => {
      const w = Math.max(60, Math.round(canvas.clientWidth))
      if (w === width) return
      width = w
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const next = Math.max(8, Math.floor(width / pitch))
      // Preserve history across a resize by replaying the tail into the new
      // buffer — a window drag should not blank the waveform.
      const prev = bars
      const prevCount = count
      const prevHead = head
      bars = new Float32Array(next)
      for (let i = 0; i < Math.min(next, prevCount); i++) {
        bars[next - 1 - i] = prev[(prevHead - i + prevCount * 2) % prevCount] || 0
      }
      count = next
      head = next - 1
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    let sinceSample = 0
    // Smoothed input, so one loud frame doesn't spike a whole bar.
    let smooth = 0

    const stop = subscribe((dt) => {
      const amp = Math.max(level.mic, level.speech, level.wake * 0.5)
      smooth += (amp - smooth) * Math.min(1, dt / 90)

      sinceSample += dt
      while (sinceSample >= SAMPLE_MS) {
        sinceSample -= SAMPLE_MS
        head = (head + 1) % count
        bars[head] = smooth
      }

      ctx.clearRect(0, 0, width, height)
      const mid = height / 2
      const maxH = mid - 1

      for (let i = 0; i < count; i++) {
        // i = 0 is the oldest (leftmost), count-1 the newest (rightmost).
        const v = bars[(head + 1 + i) % count]
        const half = Math.max(FLOOR * maxH, v * maxH)
        // Older bars recede. Squared so the fade is concentrated at the tail
        // rather than dimming the whole strip.
        const age = i / (count - 1)
        const alpha = (0.16 + 0.68 * age * age) * (dim ? 0.5 : 1)
        ctx.fillStyle = `rgba(10, 132, 255, ${alpha})`
        const x = i * pitch
        // Two rects rather than one centred rect: mirrored halves keep the
        // centre line visible at rest, which is the whole look.
        ctx.fillRect(x, mid - half, BAR_W, half)
        ctx.fillRect(x, mid + 1, BAR_W, half)
      }
    })

    return () => {
      stop()
      ro.disconnect()
    }
  }, [height, dim])

  return (
    <canvas ref={ref} className="waveform" style={{ height }} aria-hidden />
  )
}
