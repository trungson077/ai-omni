import numpy as np
import sounddevice as sd

from local_models import CHUNK, SAMPLE_RATE, load_model

SECONDS = 8

print("Default input device:", sd.query_devices(kind="input")["name"])
model = load_model()

print(f"Say 'hey nova' a few times over the next {SECONDS} seconds...")
peak_rms = 0.0
peak_score = 0.0

with sd.InputStream(
    samplerate=SAMPLE_RATE, channels=1, dtype="int16", blocksize=CHUNK
) as stream:
    for i in range(int(SECONDS * SAMPLE_RATE / CHUNK)):
        frame, _ = stream.read(CHUNK)
        audio = np.squeeze(frame)

        rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
        score = max(model.predict(audio).values())
        peak_rms = max(peak_rms, rms)
        peak_score = max(peak_score, score)

        bar = "#" * min(40, int(rms / 100))
        print(f"rms={rms:7.1f} score={score:.4f} {bar}")

print(f"\npeak rms   = {peak_rms:.1f}")
print(f"peak score = {peak_score:.4f}")
if peak_rms < 50:
    print(">>> Mic is silent. Check System Settings > Privacy & Security > Microphone.")
elif peak_score < 0.05:
    print(">>> Mic works, but the model never reacts. Model quality is the issue.")
else:
    print(">>> Model reacts. Set THRESHOLD just below peak score.")
