/**
 * Every URL the app uses, in one place.
 *
 * The defaults are same-origin relative paths, which is what the Vite dev
 * proxy serves (`/api/ws` → :8000, `/camera` → :8001). That makes `npm run dev`
 * work with no configuration at all, and it is the supported mode.
 *
 * The env overrides exist so a built bundle served from somewhere else is
 * possible rather than silently broken — see .env.example.
 */

import type { VoiceMode } from './protocol'

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')
const CAMERA_BASE = (import.meta.env.VITE_CAMERA_BASE ?? '').replace(/\/$/, '')

/** ?wire=fake routes at the replay fixture instead of the real backend. */
function wirePath(): string {
  const params = new URLSearchParams(location.search)
  return params.get('wire') === 'fake' ? '/api/ws/fakewire' : '/api/ws/voice'
}

/** Which replay script the fixture should run, if any. */
export function fakeScript(): string | null {
  const params = new URLSearchParams(location.search)
  return params.get('wire') === 'fake' ? (params.get('script') ?? 'S1') : null
}

/**
 * `mode` rides in the query string rather than in a message because the server
 * has to know it before it accepts: whether to load the wake model is decided
 * up front, and no client frame has arrived by then.
 */
export function wsUrl(mode: VoiceMode): string {
  const path = wirePath()
  const script = fakeScript()
  const params = new URLSearchParams({ mode })
  if (script) params.set('script', script)
  const query = `?${params}`

  if (API_BASE) {
    return `${API_BASE.replace(/^http/, 'ws')}${path}${query}`
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}${query}`
}

/** `path` is proxy-relative and starts with /camera. */
export function cameraUrl(path: string): string {
  if (!CAMERA_BASE) return path
  return CAMERA_BASE + path.replace(/^\/camera/, '')
}

/**
 * A file on the machine Nova runs on, fetched through the backend.
 *
 * `file` is an absolute local path out of a MEDIA: sentinel — encoded, because
 * it routinely contains spaces and, on Windows, backslashes.
 */
export function mediaUrl(file: string, nonce = 0): string {
  const bust = nonce ? `&v=${nonce}` : ''
  return `${API_BASE}/api/media?path=${encodeURIComponent(file)}${bust}`
}
