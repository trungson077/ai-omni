import type { AgentState } from '../core/types'

const TAU = Math.PI * 2

/* The one accent hue (211°), as RGB triplets for rgba() interpolation. */
const DEEP = '0, 113, 227'
const MID = '10, 132, 255'
const SOFT = '100, 181, 255'

/**
 * How alive the blob is, per state. Nothing here adds geometry — the blob is
 * always the same creature, it just breathes differently.
 *
 *  speed   overall time scale of the surface wobble
 *  churn   how fast the internal lobes orbit — the "thinking" tell
 *  drive   luminosity floor
 *  breath  breathing rate
 *  reach   how far the lobes wander from centre
 */
const MOOD: Record<
  AgentState,
  { speed: number; churn: number; drive: number; breath: number; reach: number }
> = {
  idle: { speed: 0.5, churn: 0.42, drive: 0.34, breath: 0.72, reach: 0.2 },
  listening: { speed: 0.85, churn: 0.7, drive: 0.6, breath: 1.35, reach: 0.26 },
  thinking: { speed: 1.7, churn: 2.1, drive: 0.52, breath: 2.0, reach: 0.36 },
  responding: { speed: 1.1, churn: 0.95, drive: 0.78, breath: 1.55, reach: 0.28 },
  executing: { speed: 1.45, churn: 1.5, drive: 0.7, breath: 1.8, reach: 0.32 },
}

export interface BlobInputs {
  state: AgentState
  /** 0..1 — mic level, or synthetic level while speaking. */
  amp: number
}

/** Three internal lobes, phase-offset so they never line up. */
const LOBES = [
  { phase: 0, rate: 1, wobble: 1.3 },
  { phase: TAU / 3, rate: -0.72, wobble: 0.9 },
  { phase: (TAU * 2) / 3, rate: 0.55, wobble: 1.7 },
]

const POINTS = 48

/**
 * The silhouette is filled as a stack of concentric scaled copies rather than
 * one gradient fill.
 *
 * A radial gradient is circular; a wobbling path is not. Fill the path with a
 * gradient and wherever the two disagree you get a visible clipped edge, and
 * the blob stops reading as light. Stacking scaled copies additively produces
 * a falloff that follows the wobble exactly, so there is no edge anywhere.
 *
 * The count matters: too few and the layers read as contour lines. Each step
 * has to stay under the perceptual threshold on a dark ground, which means
 * many layers at very low alpha.
 */
const LAYERS = 22
const LAYER_ALPHA = 0.028

/**
 * The blob is composited at a third of its final size and upscaled.
 *
 * Everything here is soft light with no crisp detail to preserve, so the
 * bilinear upscale costs nothing visually — and it smooths whatever banding
 * survives the layer count, which lets the stack be far cheaper. At full
 * resolution the same stack cost ~19ms/frame; this brings it under 2ms.
 */
const RENDER_SCALE = 1 / 3

/* Hue ramp, outermost → innermost. Interpolated rather than bucketed —
 * discrete colour bands are as visible as discrete alpha bands. */
const C_DEEP = [0, 113, 227]
const C_MID = [10, 132, 255]
const C_SOFT = [175, 242, 237]

function ramp(t: number): string {
  const [a, b, f] = t < 0.5 ? [C_DEEP, C_MID, t * 2] : [C_MID, C_SOFT, (t - 0.5) * 2]
  return `${Math.round(a[0] + (b[0] - a[0]) * f)}, ${Math.round(
    a[1] + (b[1] - a[1]) * f,
  )}, ${Math.round(a[2] + (b[2] - a[2]) * f)}`
}

/**
 * A living light blob.
 *
 * Built entirely from radial gradients and one soft-filled wobbling silhouette
 * — no rings, ticks or sweeps, and deliberately no outline. Softness is
 * inherent to gradients, so the whole thing reads as light rather than as a
 * drawn shape, with no blur filter and no offscreen passes.
 */
export function createBlobRenderer(target: CanvasRenderingContext2D, size: number) {
  // Low-resolution scratch buffer everything is drawn into.
  const buf = document.createElement('canvas')
  buf.width = Math.max(48, Math.round(size * RENDER_SCALE))
  buf.height = buf.width
  const ctx = buf.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  const s = buf.width / size

  target.imageSmoothingEnabled = true
  target.imageSmoothingQuality = 'high'

  let ampS = 0
  let driveS = 0.34
  let speedS = 0.5
  let churnS = 0.42
  let reachS = 0.2
  let breathS = 0.72
  /** Own clock, advanced by mood speed, so state changes ease the motion. */
  let clock = 0
  let churnClock = 0

  return function draw(dt: number, now: number, w: number, h: number, input: BlobInputs) {
    void now
    const m = MOOD[input.state]

    // Ease every parameter — a hard state switch should feel like a mood
    // changing, not a different creature appearing.
    const k = Math.min(1, dt / 420)
    ampS += (input.amp - ampS) * Math.min(1, dt / 110)
    driveS += (m.drive - driveS) * k
    speedS += (m.speed - speedS) * k
    churnS += (m.churn - churnS) * k
    reachS += (m.reach - reachS) * k
    breathS += (m.breath - breathS) * k

    const sec = dt / 1000
    clock += sec * speedS
    churnClock += sec * churnS

    const dim = Math.min(w, h)
    const coreR = dim * 0.16
    const bloomR = dim * 0.48

    // Luminosity: mood floor plus whatever the voice is doing.
    const lum = Math.min(1, driveS + ampS * 0.55)
    const breathe = 1 + 0.05 * Math.sin(clock * breathS * 2.2) + ampS * 0.16

    // Draw in world units, centred on the origin; the transform maps that
    // into the scratch buffer.
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, buf.width, buf.height)
    ctx.setTransform(s, 0, 0, s, buf.width / 2, buf.height / 2)
    ctx.save()

    /* ── 1. Ambient bloom ───────────────────────────────────── */
    // Generous, because it is the only thing lighting the room.
    const bloom = ctx.createRadialGradient(0, 0, coreR * 0.2, 0, 0, bloomR)
    bloom.addColorStop(0, `rgba(${MID}, ${0.4 * lum})`)
    bloom.addColorStop(0.22, `rgba(${DEEP}, ${0.2 * lum})`)
    bloom.addColorStop(0.48, `rgba(${DEEP}, ${0.075 * lum})`)
    bloom.addColorStop(0.76, `rgba(${DEEP}, ${0.022 * lum})`)
    bloom.addColorStop(1, `rgba(${DEEP}, 0)`)
    ctx.fillStyle = bloom
    ctx.beginPath()
    ctx.arc(0, 0, bloomR, 0, TAU)
    ctx.fill()

    /* ── 2. Silhouette ──────────────────────────────────────── */
    // Radius modulated by three detuned harmonics: never a circle, never
    // repeating, never spiky.
    const radiusAt = (a: number) =>
      coreR *
      breathe *
      (1 +
        0.075 * Math.sin(3 * a + clock * 0.9) +
        0.05 * Math.sin(5 * a - clock * 0.62) +
        0.035 * Math.sin(2 * a + clock * 1.4) +
        ampS * 0.09 * Math.sin(4 * a + clock * 2.1))

    const pts: { x: number; y: number }[] = []
    for (let i = 0; i < POINTS; i++) {
      const a = (i / POINTS) * TAU
      const r = radiusAt(a)
      pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r })
    }

    // Closed curve through midpoints — C1 continuous, so no visible facets.
    const path = new Path2D()
    {
      const first = pts[0]
      const last = pts[pts.length - 1]
      path.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2)
      for (let i = 0; i < pts.length; i++) {
        const cur = pts[i]
        const nxt = pts[(i + 1) % pts.length]
        path.quadraticCurveTo(cur.x, cur.y, (cur.x + nxt.x) / 2, (cur.y + nxt.y) / 2)
      }
      path.closePath()
    }

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'

    // Constant low alpha, geometrically-spaced scales. The spacing is dense
    // near the rim (where a step would be noticed) and loose toward the
    // centre (where the hot core covers it).
    const alpha = LAYER_ALPHA * (0.5 + lum * 0.85)
    for (let i = 0; i < LAYERS; i++) {
      const t = i / (LAYERS - 1) // 0 = outermost
      const k = 1 - Math.pow(t, 1.6) * 0.95
      ctx.save()
      ctx.scale(k, k)
      ctx.fillStyle = `rgba(${ramp(t)}, ${alpha})`
      ctx.fill(path)
      ctx.restore()
    }

    /* ── 3. Internal lobes ──────────────────────────────────── */
    // Additive light pooling inside the body — this is what makes it look
    // like something is going on in there.
    for (const lobe of LOBES) {
      const a = lobe.phase + churnClock * lobe.rate
      const d = coreR * reachS * (0.7 + 0.3 * Math.sin(churnClock * lobe.wobble + lobe.phase))
      const lx = Math.cos(a) * d
      const ly = Math.sin(a) * d * 0.82
      const lr = coreR * (0.66 + 0.12 * Math.sin(churnClock * lobe.wobble * 1.4))
      const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr)
      g.addColorStop(0, `rgba(${SOFT}, ${0.2 + lum * 0.2})`)
      g.addColorStop(0.45, `rgba(${MID}, ${0.08 + lum * 0.1})`)
      g.addColorStop(1, `rgba(${DEEP}, 0)`)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(lx, ly, lr, 0, TAU)
      ctx.fill()
    }

    /* ── 4. Hot core ────────────────────────────────────────── */
    // Drifts on a slow Lissajous path so the blob never looks centred and
    // dead. Tightens and brightens with voice.
    const hx = Math.cos(clock * 0.42) * coreR * 0.14
    const hy = Math.sin(clock * 0.31) * coreR * 0.11
    const hr = coreR * (0.4 + ampS * 0.14)
    const hot = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr)
    hot.addColorStop(0, `rgba(255, 255, 255, ${0.42 + lum * 0.45})`)
    hot.addColorStop(0.3, `rgba(${SOFT}, ${0.24 + lum * 0.3})`)
    hot.addColorStop(1, `rgba(${MID}, 0)`)
    ctx.fillStyle = hot
    ctx.beginPath()
    ctx.arc(hx, hy, hr, 0, TAU)
    ctx.fill()
    ctx.restore()

    /* ── Composite ──────────────────────────────────────────── */
    target.clearRect(0, 0, w, h)
    target.drawImage(buf, 0, 0, w, h)
  }
}
