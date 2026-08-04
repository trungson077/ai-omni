import { useEffect, useRef, useState } from 'react'
import { cameraUrl } from '../wire/urls'
import type { KindProps } from './kinds'
import type { CameraPayload } from './payloads'

/**
 * God Eye: the RTSP feed with MediaPipe object detection, as a pane rather than
 * a modal. Nova opens and closes it herself through her MCP tools.
 *
 * Two things here are not obvious:
 *
 *  - The retry loop is not defensive. The tool call that spawns this pane fires
 *    *before* the camera is warm — the MCP server allows 30s for /start and the
 *    service waits up to 10s for a first frame — so the first request routinely
 *    fails on a cold RTSP connect. Failing terminally would make the feature
 *    look broken every single time.
 *  - The detections poll, not the <img>, is the liveness probe. An MJPEG stream
 *    that dies mid-flight fires no `error` event at all; it just freezes on its
 *    last frame.
 */

interface Detection {
  name: string
  score: number
}

/** 1x1 transparent GIF — assigning this is how you stop an MJPEG stream. */
const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const MAX_ATTEMPTS = 4
const POLL_MS = 1000
/** Consecutive poll failures before the feed is declared dead. */
const POLL_TOLERANCE = 3

export function CameraPane({ payload }: KindProps) {
  const p = payload as CameraPayload
  const imgRef = useRef<HTMLImageElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  /**
   * Whether a frame has ever arrived.
   *
   * Needed because the interesting failure is not an error — the MJPEG request
   * can open fine and then simply never deliver anything (a cold RTSP connect,
   * or a camera that isn't reachable at all). `onError` stays silent for that,
   * and the browser renders its broken-image glyph plus the alt text, which
   * looks like the UI is broken rather than like the camera is still coming up.
   */
  const [loaded, setLoaded] = useState(false)
  const [dets, setDets] = useState<Detection[]>([])
  const [fps, setFps] = useState(0)

  // Identity of the current connection. Changing it remounts the <img>, and the
  // matching ?t= makes the browser open a fresh request instead of reusing a
  // connection that may already be dead.
  const key = `${p.nonce}:${attempt}`

  // Dropping an <img> from the DOM does not deterministically close its socket —
  // the browser may hold it until GC. Clearing src aborts it now, which is what
  // keeps connections from accumulating across the retry loop and stops MJPEG
  // hogging one of the six per-host slots after the pane is gone.
  useEffect(() => {
    const el = imgRef.current
    return () => {
      // Pointing at a data URI rather than clearing src: an empty string can
      // re-resolve to the page URL and fire a bogus request, and it leaves the
      // proxy answering a request the browser has already abandoned.
      if (el) el.src = BLANK_GIF
    }
  }, [key])

  useEffect(() => {
    let cancelled = false
    let misses = 0
    let inFlight: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      if (cancelled) return
      // A hidden tab must not keep polling: /detections touches the stream's
      // activity clock, so it holds the RTSP reader open all by itself.
      if (document.hidden) {
        timer = setTimeout(tick, POLL_MS)
        return
      }
      inFlight?.abort()
      inFlight = new AbortController()
      try {
        const res = await fetch(cameraUrl('/camera/detections'), { signal: inFlight.signal })
        const data = (await res.json()) as { detections?: Detection[]; fps?: number }
        if (cancelled) return
        misses = 0
        setDets(data.detections ?? [])
        setFps(data.fps ?? 0)
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return
        if (++misses >= POLL_TOLERANCE) setFailed(true)
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS)
    }

    void tick()
    return () => {
      cancelled = true
      inFlight?.abort()
      clearTimeout(timer)
    }
  }, [])

  const onError = () => {
    if (attempt < MAX_ATTEMPTS) {
      const delay = 1500 * 2 ** attempt
      setTimeout(() => setAttempt((a) => a + 1), delay)
    } else {
      setFailed(true)
    }
  }

  // Collapse the box list into name → count chips; ten boxes of "person" is one
  // fact, not ten.
  const counts = new Map<string, number>()
  for (const d of dets) counts.set(d.name, (counts.get(d.name) ?? 0) + 1)

  return (
    <div className="pk pk-camera">
      <div className="pk-camera__stage">
        {failed ? (
          <div className="pk-camera__error">
            <div className="pk-camera__error-title">No feed</div>
            <p>
              The camera service isn’t returning frames. It boots on demand, so give it a
              moment — or check that the RTSP device is reachable.
            </p>
            <button
              className="pk-btn"
              onClick={() => {
                setFailed(false)
                setAttempt((a) => a + 1)
              }}
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <img
              ref={imgRef}
              key={key}
              className="pk-camera__img"
              src={cameraUrl(`${p.src}?t=${key}`)}
              // Empty alt, deliberately: the placeholder below is the accessible
              // description, and a non-empty alt renders as fallback text the
              // moment a frame fails to decode.
              alt=""
              // The teardown above swaps in a data URI, which also fires load.
              // Without this guard that would report a frame that never came.
              onLoad={(e) => {
                if (!e.currentTarget.src.startsWith('data:')) setLoaded(true)
              }}
              onError={onError}
            />
            {!loaded && (
              <div className="pk-camera__waiting">
                <span className="pk-camera__spin" />
                <span>waiting for a frame</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="pk-camera__chips">
        <span className="pk-camera__fps">{fps.toFixed(1)} fps</span>
        {counts.size === 0 ? (
          <span className="pk-camera__none">nothing detected</span>
        ) : (
          [...counts].map(([name, n]) => (
            <span className="pk-camera__chip" key={name}>
              {name}
              {n > 1 && <b>×{n}</b>}
            </span>
          ))
        )}
      </div>
    </div>
  )
}
