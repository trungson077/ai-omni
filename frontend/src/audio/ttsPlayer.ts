/**
 * Plays Nova's voice, and exposes its amplitude.
 *
 * The server sends one complete MP3 per sentence as a binary WebSocket frame,
 * interleaved with the text deltas. The obvious implementation — one
 * `new Audio(blob)` per sentence behind a mutex — has three problems that are
 * each worse than they look: every element must fetch and decode before its
 * first sample, so there is an audible hole between sentences; there is no
 * amplitude signal at all, so nothing can react to the voice; and a blocked
 * autoplay rejects `play()`, which is indistinguishable from a finished clip
 * and silently races through the whole reply.
 *
 * So: decode into one AudioContext and schedule the buffers head to tail. That
 * removes the gaps, and the AnalyserNode gives the blob a real envelope instead
 * of a synthesised one.
 */

/** Scheduling lead. `ctx.currentTime` is only sampled at main-thread task
 *  boundaries, so scheduling at exactly "now" is one render quantum from a
 *  glitch. 20ms is inaudible and guarantees the first sample plays. */
const LEAD_S = 0.02
/** Keeps `speaking` true across a gap while the next sentence is generated. */
const HANGOVER_MS = 320
/** Ramp on flush. Stopping mid-waveform truncates at a non-zero sample. */
const FADE_S = 0.015
/**
 * With no prior gesture Chrome leaves resume() *pending forever* rather than
 * rejecting, so awaiting it bare would hang the pump with no error — identical
 * from the outside to "the backend sent nothing".
 */
const RESUME_TIMEOUT_MS = 250
/** A suspend longer than this (tab sleep, phone call) makes the rest of the
 *  reply stale; playing it minutes late is worse than dropping it. */
const STALE_RESUME_MS = 1500

export interface TtsPlayerEvents {
  onSpeakingChange: (speaking: boolean) => void
  onBlockedChange: (blocked: boolean) => void
  onDecodeError: (err: unknown) => void
}

export interface TtsPlayer {
  /** Must be called inside a user gesture, synchronously, before any await. */
  unlock: () => void
  /** Raw MP3 bytes from a binary frame, in arrival order. */
  push: (mp3: ArrayBuffer) => void
  /** No more audio can arrive for this turn: tts.complete | wake.rearm | close. */
  seal: () => void
  /** Start of a new turn. */
  beginTurn: () => void
  /** Silence everything now. */
  flush: () => void
  /** 0..1 envelope. Cheap; safe to call once per frame. */
  rms: () => number
  /** Page teardown only — close() is irreversible and discards the unlock. */
  dispose: () => void
  readonly speaking: boolean
  readonly blocked: boolean
}

export function createTtsPlayer(events: TtsPlayerEvents): TtsPlayer {
  let ctx: AudioContext | null = null
  let gain: GainNode | null = null
  let analyser: AnalyserNode | null = null
  /** Allocated once. A fresh Float32Array per frame is pure garbage. */
  let scratch = new Float32Array(0)

  const pending: ArrayBuffer[] = []
  /**
   * Scheduled-but-not-yet-ended nodes.
   *
   * This set is the load-bearing part of the design. Because every sentence is
   * scheduled the moment it decodes, most of a reply lives inside the audio
   * graph as started-in-the-future nodes — so clearing a JS queue silences
   * nothing. Both `speaking` and flush() are defined in terms of this.
   */
  const live = new Set<AudioBufferSourceNode>()
  let pumping = false
  /** Bumped by flush(), so in-flight decodes and late onended can tell. */
  let generation = 0
  let playHead = 0
  let sealed = false
  let hangover: ReturnType<typeof setTimeout> | undefined
  let suspendedAt: number | null = null

  let speaking = false
  let blocked = false

  const setSpeaking = (v: boolean) => {
    if (speaking === v) return
    speaking = v
    events.onSpeakingChange(v)
  }

  const setBlocked = (v: boolean) => {
    if (blocked === v) return
    blocked = v
    events.onBlockedChange(v)
  }

  function build(): AudioContext {
    if (ctx) return ctx
    // No sampleRate: requesting one forces an OS resample on top of the one
    // decodeAudioData already does. 'playback' buys a larger buffer, which is
    // the right trade when the server already gates all the timing.
    const c = new AudioContext({ latencyHint: 'playback' })
    const g = c.createGain()
    const a = c.createAnalyser()
    // ~23ms at 44.1kHz. 2048 over-smooths a 60fps envelope. smoothingTimeConstant
    // is deliberately not set: it only affects frequency-domain reads.
    a.fftSize = 1024
    g.connect(a)
    a.connect(c.destination)
    ctx = c
    gain = g
    analyser = a
    scratch = new Float32Array(a.fftSize)

    c.addEventListener('statechange', () => {
      if (c.state === 'suspended') {
        suspendedAt = performance.now()
      } else if (c.state === 'running' && suspendedAt !== null) {
        const gap = performance.now() - suspendedAt
        suspendedAt = null
        // A suspended context stops currentTime and never fires onended, so
        // `live` would never drain and `speaking` would stick true forever with
        // the blob miming in silence. Fixing the cause beats a watchdog.
        if (gap > STALE_RESUME_MS) flush()
      }
    })
    return c
  }

  function unlock() {
    const c = build()
    void c.resume()
    // iOS additionally wants an actual start() inside the gesture.
    const s = c.createBufferSource()
    s.buffer = c.createBuffer(1, 1, c.sampleRate)
    s.connect(c.destination)
    s.start(0)
  }

  /** Reading through a function defeats narrowing — deliberate, because the
   *  state can change across the await below. */
  const stateOf = (c: AudioContext): AudioContextState => c.state

  async function ensureRunning(c: AudioContext): Promise<boolean> {
    if (stateOf(c) === 'running') return true
    if (stateOf(c) === 'closed') return false
    const ok = await Promise.race([
      c.resume().then(() => true).catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), RESUME_TIMEOUT_MS)),
    ])
    return ok && stateOf(c) === 'running'
  }

  function schedule(buf: AudioBuffer, gen: number) {
    const c = ctx
    if (!c || !gain) return
    const at = Math.max(c.currentTime + LEAD_S, playHead)
    const src = c.createBufferSource()
    src.buffer = buf
    src.connect(gain)
    src.start(at)
    playHead = at + buf.duration
    live.add(src)

    if (live.size === 1) {
      clearTimeout(hangover)
      hangover = undefined
      setSpeaking(true)
    }

    src.onended = () => {
      if (gen !== generation) return
      live.delete(src)
      if (live.size === 0) maybeEndRun()
    }
  }

  function maybeEndRun() {
    if (live.size > 0 || pending.length > 0 || pumping) return
    if (sealed) {
      setSpeaking(false)
      return
    }
    // Generation normally outruns playback, but one slow ElevenLabs call empties
    // `live` mid-reply. Without the hangover that flickers responding →
    // thinking → responding for a few hundred milliseconds.
    clearTimeout(hangover)
    hangover = setTimeout(() => {
      hangover = undefined
      setSpeaking(false)
    }, HANGOVER_MS)
  }

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (pending.length > 0) {
        const c = build()
        if (!(await ensureRunning(c))) {
          // Drop rather than bank: by the time a gesture arrives the turn has
          // moved on, and a two-minute-old answer is worse than silence.
          pending.length = 0
          setBlocked(true)
          setSpeaking(false)
          break
        }
        setBlocked(false)

        const bytes = pending.shift()
        if (!bytes) break
        const gen = generation

        let buf: AudioBuffer
        try {
          // Serial, one at a time. Concurrent decodeAudioData calls resolve in
          // no guaranteed order, which would both mis-order the sentences and
          // advance playHead by the wrong durations — permanently. Awaiting in
          // a loop makes that impossible, and costs nothing: decoding a 3s MP3
          // is single-digit milliseconds against 3000ms of playback.
          buf = await c.decodeAudioData(bytes)
        } catch (err) {
          // A hole, never a stall. One corrupt frame must not strand the rest.
          events.onDecodeError(err)
          continue
        }
        if (gen !== generation) continue
        schedule(buf, gen)
      }
    } finally {
      pumping = false
      maybeEndRun()
    }
  }

  function flush() {
    generation++
    pending.length = 0
    clearTimeout(hangover)
    hangover = undefined

    const c = ctx
    if (c && gain && live.size > 0) {
      const t = c.currentTime
      gain.gain.setValueAtTime(gain.gain.value, t)
      gain.gain.linearRampToValueAtTime(0.0001, t + FADE_S)
      for (const n of live) {
        try {
          n.stop(t + FADE_S + 0.005)
        } catch {
          // Already stopped.
        }
      }
      gain.gain.setValueAtTime(1, t + FADE_S + 0.015)
    }
    live.clear()
    playHead = 0
    setSpeaking(false)
  }

  return {
    unlock,

    push(mp3) {
      pending.push(mp3)
      void pump()
    },

    seal() {
      sealed = true
      // A turn where every ElevenLabs call threw yields tts.complete with an
      // empty queue, and no onended will ever come to resolve `speaking`.
      maybeEndRun()
    },

    beginTurn() {
      sealed = false
      playHead = 0
    },

    flush,

    rms() {
      const a = analyser
      if (!a || !speaking) return 0
      a.getFloatTimeDomainData(scratch)
      let sum = 0
      for (let i = 0; i < scratch.length; i++) sum += scratch[i] * scratch[i]
      const raw = Math.sqrt(sum / scratch.length)
      // TTS is normalised louder than mic speech, so the mic curve would clip.
      return Math.min(1, Math.pow(raw * 2.2, 0.7))
    },

    dispose() {
      flush()
      void ctx?.close()
      ctx = null
      gain = null
      analyser = null
    },

    get speaking() {
      return speaking
    },
    get blocked() {
      return blocked
    },
  }
}
