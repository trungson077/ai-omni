import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env from project root (works for local dev)
_env_path = Path(__file__).resolve().parent.parent.parent / ".env"
if _env_path.exists():
    load_dotenv(_env_path)

ELEVENLABS_API_KEY = os.environ["ELEVENLABS_API_KEY"]
ELEVENLABS_TTS_VOICE_ID = os.environ.get(
    "ELEVENLABS_TTS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb"
)
ELEVENLABS_TTS_MODEL = os.environ.get(
    "ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2"
)
ELEVENLABS_STT_MODEL = os.environ.get("ELEVENLABS_STT_MODEL", "scribe_v2")
HERMES_URL = os.environ.get("HERMES_URL", "ws://127.0.0.1:9119/api/ws")
HERMES_TOKEN = os.environ.get("HERMES_TOKEN", "my-hermes-api-token-2024")

# --- Wake word ("hey nova") -------------------------------------------------
# Everything lives in the wakeword/ project: hey_nova.onnx as trained there,
# plus openWakeWord's shared feature extractors. Nothing is fetched at runtime.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
WAKEWORD_DIR = Path(
    os.environ.get("WAKEWORD_DIR", str(_REPO_ROOT / "wakeword" / "models"))
)

WAKEWORD_MODEL_PATH = os.environ.get(
    "WAKEWORD_MODEL_PATH", str(WAKEWORD_DIR / "hey_nova.onnx")
)
WAKEWORD_FRAMEWORK = os.environ.get("WAKEWORD_FRAMEWORK", "onnx")
WAKEWORD_MELSPEC_PATH = os.environ.get(
    "WAKEWORD_MELSPEC_PATH", str(WAKEWORD_DIR / "melspectrogram.onnx")
)
WAKEWORD_EMBEDDING_PATH = os.environ.get(
    "WAKEWORD_EMBEDDING_PATH", str(WAKEWORD_DIR / "embedding_model.onnx")
)
# Deliberately low: the trained hey_nova model peaks well under openWakeWord's
# usual 0.5. Raise it if the room triggers false wakes.
WAKEWORD_THRESHOLD = float(os.environ.get("WAKEWORD_THRESHOLD", 0.001))

# openWakeWord is trained on 16 kHz mono int16 in 80 ms frames.
WAKEWORD_SAMPLE_RATE = 16000
WAKEWORD_CHUNK = 1280

# --- Utterance endpointing (wake-word mode) ---------------------------------
# RMS on int16 samples, so these are absolute amplitudes, not 0..1.
UTTERANCE_SPEECH_RMS = float(os.environ.get("UTTERANCE_SPEECH_RMS", 300))
UTTERANCE_SILENCE_MS = int(os.environ.get("UTTERANCE_SILENCE_MS", 1200))
UTTERANCE_NO_SPEECH_MS = int(os.environ.get("UTTERANCE_NO_SPEECH_MS", 4000))
UTTERANCE_MAX_MS = int(os.environ.get("UTTERANCE_MAX_MS", 15000))
# Ignore the mic for a moment after Nova stops talking so her own voice tail
# cannot re-trigger the wake word.
REARM_DELAY_MS = int(os.environ.get("REARM_DELAY_MS", 500))
