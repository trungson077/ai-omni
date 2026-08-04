/**
 * Protocol sentinels Hermes writes into her reply text.
 *
 * These are instructions to the client, not prose. Left alone they render as
 * `MEDIA:/Users/…/browser_screenshot_e065.png` in the middle of a sentence,
 * which is both ugly and useless — the whole point of the tag is that the
 * client is supposed to *show the file*.
 *
 * Matched against Hermes' own implementations, which disagree with each other:
 * `ui-tui/src/components/markdown.tsx` anchors the tag to a whole line, while
 * `mcp_serve.py` finds it anywhere in the message. We follow the permissive
 * one. The strict version misses `Here you go: MEDIA:/tmp/a.png`, which the
 * model writes often, and the cost of being wrong is asymmetric: a false
 * positive fails to resolve and shows a "not found" card, while a false
 * negative silently drops the file the user asked to see.
 */

/*
 * Guarded on a word character rather than on whitespace. `SOMEMEDIA:` and the
 * lowercase `media:` in prose are both left alone — Hermes' own tests require
 * that — but `(MEDIA:/tmp/a.png)` and `[x](MEDIA:...)` still match, which a
 * whitespace guard would have missed.
 *
 * Quotes and backticks are accepted on either side of the colon, and in runs
 * rather than singly: the model writes `MEDIA:/tmp/a.png`, MEDIA:"/tmp/a.png",
 * and `MEDIA:"/tmp/a.png"` — where a single optional closer leaves the outer
 * backtick stranded in the prose.
 *
 * `[ \t]*` and not `\s*`, so a bare `MEDIA:` at the end of a line cannot reach
 * across the newline and swallow the first word of the next sentence as a path.
 */
const MEDIA = /(?<![A-Za-z0-9_])[`"']*MEDIA:[ \t]*[`"']*([^\s`"'<>]+)[`"']*/g

/*
 * Sentence punctuation the model puts *after* the tag, which the path pattern
 * would otherwise swallow: "Here you go: MEDIA:/tmp/a.png." must not ask the
 * backend for `a.png.`, and mediaKind must not read its extension as empty and
 * call a screenshot a document.
 *
 * Closers are in here too, for `(MEDIA:/tmp/a.png)`. Only a *trailing* run is
 * trimmed, so a genuine `screenshot (1).png` keeps its bracket — though such a
 * path also contains a space, which the protocol cannot express either way.
 */
const TRAILING = /[.,;:!?)\]]+$/

/** A directive to the voice layer. It is never meant to be read. */
const AUDIO_DIRECTIVE = /^[ \t]*\[\[audio_as_voice\]\][ \t]*$/gm

export function mediaPaths(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(MEDIA)) {
    const path = m[1].replace(TRAILING, '')
    // Same file named twice in one reply is one panel, not two.
    if (path && !out.includes(path)) out.push(path)
  }
  return out
}

/**
 * The reply with every sentinel removed, ready to render.
 *
 * Runs on each streamed token, so a half-arrived `MEDIA:/Users/tri` goes too and
 * the path never flickers into view as it completes. The one frame it can be
 * seen is a buffer ending exactly at `MEDIA` or `MEDIA:`, where there is not yet
 * a path to match.
 *
 * Removes and nothing else. An earlier version also collapsed blank runs and
 * trimmed line ends, which read as tidying up — but this runs over the whole
 * reply before the Markdown parser has found the fences, so that tidying was
 * silently rewriting the inside of code blocks.
 */
export function stripSentinels(text: string): string {
  return text.replace(MEDIA, '').replace(AUDIO_DIRECTIVE, '')
}

/** What to render a path as, decided by extension — the backend agrees. */
export type MediaKind = 'image' | 'video' | 'audio' | 'doc'

const BY_EXT: Record<string, MediaKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  avif: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  flac: 'audio',
  pdf: 'doc',
}

export function mediaKind(path: string): MediaKind {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return BY_EXT[ext] ?? 'doc'
}

/** Last path segment, for a title. Windows paths arrive from Hermes too. */
export function basename(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}
