/**
 * Audio amplitude, 0..1, shared between the analysers and the blob.
 *
 * Deliberately a mutable module singleton rather than store state: this
 * updates every frame, and pushing it through React would re-render the
 * tree 60 times a second for a value only a canvas consumes.
 */
export const level = {
  /** Smoothed mic input, from the capture graph's analyser. */
  mic: 0,
  /** Nova's voice, from the playback graph's analyser. Real, not synthesised. */
  speech: 0,
  /**
   * One-shot flare on wake.detected, decayed by the ticker.
   *
   * A third channel, because neither of the other two can express this moment.
   * A mood change is too slow (the blob eases over ~420ms, and at the default
   * threshold the wake word fires every few seconds on room noise, so it would
   * read as an unexplained pulse on a loop). And amplitude is actively wrong:
   * the user has just *finished* saying "hey nova", so `mic` is at a local
   * minimum right when the blob should be brightest.
   */
  wake: 0,
}

/** ms for the wake flare to fall from 1 to 0. */
export const WAKE_DECAY_MS = 280
