import numpy as np
import sounddevice as sd

from local_models import CHUNK, SAMPLE_RATE, load_model

SECONDS = 8

model = load_model()


def measure(label):
    input(f"\n[{label}] Press Enter, then continue for {SECONDS}s...")
    scores = []
    with sd.InputStream(
        samplerate=SAMPLE_RATE, channels=1, dtype="int16", blocksize=CHUNK
    ) as stream:
        for _ in range(int(SECONDS * SAMPLE_RATE / CHUNK)):
            frame, _ = stream.read(CHUNK)
            scores.append(max(model.predict(np.squeeze(frame)).values()))

    scores = np.array(scores)
    print(f"  mean={scores.mean():.5f}  p95={np.percentile(scores, 95):.5f}  max={scores.max():.5f}")
    return scores


silence = measure("SILENCE - say nothing")
speech = measure("OTHER SPEECH - talk, but never say the wake word")
wake = measure("WAKE WORD - say 'hey nova' repeatedly")

print(f"\nwake max      = {wake.max():.5f}")
print(f"non-wake max  = {max(silence.max(), speech.max()):.5f}")
if wake.max() > max(silence.max(), speech.max()) * 3:
    print(">>> Model does separate the wake word, just with weak confidence.")
else:
    print(">>> No real separation. The model is not usable - it needs retraining.")
