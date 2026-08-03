/**
 * Continuous raw-PCM microphone capture for wake-word mode.
 *
 * openWakeWord wants 16 kHz mono int16 in 80 ms frames, so the AudioContext is
 * opened at 16 kHz and the browser resamples the mic for us — cheaper and less
 * error-prone than downsampling 48 kHz by hand. MediaRecorder can't be used
 * here: it produces compressed webm, and the detector needs samples.
 */

/** 80 ms at 16 kHz — the frame size openWakeWord predicts on. */
const FRAME_SAMPLES = 1280;
const SAMPLE_RATE = 16000;

// Runs on the audio thread. Accumulates a full frame before posting so the main
// thread gets ~12 messages a second instead of one per 128-sample render quantum.
const WORKLET_SOURCE = `
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(${FRAME_SAMPLES});
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.buf.length) {
        const out = this.buf.slice();
        this.port.postMessage(out, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
`;

export interface PcmCapture {
  analyser: AnalyserNode;
  stop: () => void;
}

export async function startPcmCapture(
  onFrame: (pcm: Int16Array) => void,
): Promise<PcmCapture> {
  // Echo cancellation is load-bearing: the mic stays open while Nova speaks,
  // so without it her voice feeds straight back into the detector.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const url = URL.createObjectURL(
    new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
  );
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-processor");
  node.port.onmessage = (e) => onFrame(e.data as Int16Array);

  // Keeps the level meter working in wake mode.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.3;

  src.connect(analyser);
  src.connect(node);
  // An AudioWorkletNode with no destination still gets pulled in Chrome, but
  // Safari only runs the graph when it reaches one. A zero-gain sink keeps the
  // processor alive without making the mic audible.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);

  return {
    analyser,
    stop: () => {
      node.port.onmessage = null;
      try {
        node.disconnect();
        src.disconnect();
        mute.disconnect();
      } catch {
        /* already torn down */
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
