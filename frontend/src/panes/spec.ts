import type { PaneKind } from '../core/types'

export interface PaneSpec {
  defaultSize: { w: number; h: number }
  minSize: { w: number; h: number }
  /** ms until self-dismissal; null = sticky until closed. */
  ttl: number | null
  /** CSS colour driving --accent for this pane kind. */
  accent: string
  glow: string
  /** Panes of the same kind beyond this count collapse into a deck. */
  maxConcurrent: number
  resizable: boolean
  /** Opt out of fitting height to content. Undefined = fit. */
  autoFit?: boolean
  /** Overrides the default share of viewport width a pane may claim. */
  widthCapRatio?: number
}

/* One hue, so one accent. The palette used to give each pane kind its own
   colour; with a single-hue scheme, kinds are told apart by their content and
   their title, which is the honest signal anyway. */
const ACCENT = { accent: '#0A84FF', glow: 'rgba(10, 132, 255, 0.2)' }

export const SPEC: Record<PaneKind, PaneSpec> = {
  chat: {
    defaultSize: { w: 460, h: 380 },
    minSize: { w: 340, h: 220 },
    ttl: null,
    ...ACCENT,
    maxConcurrent: 1,
    resizable: true,
  },
  result: {
    defaultSize: { w: 400, h: 200 },
    minSize: { w: 280, h: 108 },
    // A result pane is spawned already complete, so it can be born counting
    // down. Long enough to read a forecast, and hovering pauses it.
    ttl: 45_000,
    ...ACCENT,
    // Three, then the oldest folds into a deck. One question can genuinely
    // produce several results and they are all worth keeping.
    maxConcurrent: 3,
    resizable: true,
    // Auto-fit is right here — a two-line answer gets a two-line pane. The
    // interior caps its own height and scrolls past that, so a large document
    // cannot drive the pane to fill the window.
    widthCapRatio: 0.32,
  },
  camera: {
    // A 16:9 stage plus chrome.
    defaultSize: { w: 480, h: 318 },
    minSize: { w: 320, h: 228 },
    ttl: null,
    ...ACCENT,
    // One MJPEG connection, ever. The fixed pane id is the real guard, but this
    // stops the coalescer ever considering a second.
    maxConcurrent: 1,
    resizable: true,
    // An <img> reports its intrinsic height (720), which would drive the pane to
    // fill the viewport the moment it spawns.
    autoFit: false,
    // The one pane whose entire point is pixels; the default cap would leave a
    // ~400px feed on a 1440px window.
    widthCapRatio: 0.5,
  },
  system: {
    defaultSize: { w: 296, h: 168 },
    minSize: { w: 240, h: 120 },
    ttl: null,
    ...ACCENT,
    maxConcurrent: 2,
    resizable: true,
  },
  confirm: {
    defaultSize: { w: 340, h: 172 },
    minSize: { w: 300, h: 150 },
    ttl: null,
    ...ACCENT,
    maxConcurrent: 2,
    resizable: false,
  },
  media: {
    // A 16:9 screenshot at a readable size, which is what almost every one of
    // these is. Portrait and square images fit inside it via object-fit.
    defaultSize: { w: 520, h: 340 },
    minSize: { w: 260, h: 180 },
    // Sticky. Nova was asked to show this; expiring it out from under the
    // person who asked would be absurd.
    ttl: null,
    ...ACCENT,
    maxConcurrent: 3,
    resizable: true,
    // An <img> reports its intrinsic height — 1800px for a retina screenshot —
    // which would drive the pane to fill the viewport on spawn. Same reason
    // the camera opts out.
    autoFit: false,
    // The one thing here whose entire point is pixels.
    widthCapRatio: 0.5,
  },
  deck: {
    defaultSize: { w: 300, h: 152 },
    minSize: { w: 260, h: 120 },
    ttl: null,
    ...ACCENT,
    maxConcurrent: 2,
    resizable: false,
  },
}

/**
 * Hard ceiling on simultaneously blurred surfaces. `backdrop-filter` forces a
 * separate compositing pass per layer; past ~8 the frame budget goes.
 */
export const MAX_LIVE_PANES = 8

/**
 * How many panes this canvas can actually hold.
 *
 * The blur budget is only one of the two limits — the other is space. A
 * 1280×720 window minus the blob and the chat slab has room for about four
 * panes, and forcing an eighth in means overlapping something that cannot
 * move. Coalescing earlier on a small screen is the honest answer.
 */
export function maxLivePanes(viewport: { w: number; h: number }): number {
  const perPane = 190_000 // px² of canvas each pane wants to itself
  return Math.max(4, Math.min(MAX_LIVE_PANES, Math.floor((viewport.w * viewport.h) / perPane)))
}
