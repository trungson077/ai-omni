import { useState } from 'react'
import type { KindProps } from './kinds'
import type { MediaPayload } from './payloads'
import { basename } from '../wire/sentinels'
import { mediaUrl } from '../wire/urls'

/**
 * A file Nova pointed at.
 *
 * The backend refuses anything outside its served directories and anything it
 * won't render, so a failure here is usually one of two real situations: the
 * file has been cleaned up, or a tool wrote it somewhere unexpected. Both are
 * worth saying out loud — a broken-image glyph would look like our bug.
 */
export function MediaPane({ payload }: KindProps) {
  const p = payload as MediaPayload
  const [error, setError] = useState<string | null>(null)
  const src = mediaUrl(p.path, p.nonce)
  const name = basename(p.path)

  if (error) {
    return (
      <div className="pk pk-media__fail">
        <div className="pk-media__fail-title">Could not open</div>
        <p className="pk-media__path">{p.path}</p>
        <p className="pk-media__reason">{error}</p>
      </div>
    )
  }

  // The reason is fetched rather than guessed: the backend distinguishes "not
  // in a served directory", "wrong type" and "not a file", and which one it is
  // decides what to do next.
  //
  // A 200 here means the bytes arrived and the *decoder* rejected them, so the
  // body is a corrupt image — never text. Reading it would paste a binary file
  // into the DOM.
  const onFail = () => {
    fetch(src)
      .then((r) => {
        if (r.ok) return 'the file arrived but could not be decoded'
        return r
          .json()
          .then((j) => (typeof j?.detail === 'string' && j.detail) || `HTTP ${r.status}`)
          .catch(() => `HTTP ${r.status}`)
      })
      // Never an empty string: `error` is the flag that swaps this view in, and
      // '' is falsy, so it would fall straight back to the broken <img>.
      .then((d) => setError(d || 'unreadable'))
      .catch(() => setError('the backend is not reachable'))
  }

  if (p.kind === 'image') {
    return (
      <div className="pk-media">
        <img className="pk-media__img" src={src} alt={name} onError={onFail} />
      </div>
    )
  }

  if (p.kind === 'video') {
    return (
      <div className="pk-media">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video className="pk-media__video" src={src} controls onError={onFail} />
      </div>
    )
  }

  if (p.kind === 'audio') {
    return (
      <div className="pk pk-media__audio">
        <div className="pk-media__name">{name}</div>
        <audio src={src} controls onError={onFail} />
      </div>
    )
  }

  // Anything else the backend agreed to serve — a PDF, mostly. Rendering it
  // inline would need a viewer; handing it to the browser's own is better than
  // a worse copy of one.
  return (
    <div className="pk pk-media__file">
      <div className="pk-media__name">{name}</div>
      <a className="pk-media__open" href={src} target="_blank" rel="noreferrer">
        Open
      </a>
    </div>
  )
}
