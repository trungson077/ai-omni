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
# The cap when the capture was opened by the talk control instead of the wake
# word. Much longer, because nothing else will end it: the endpointer is off in
# that mode, so this is the only bound on how much audio one press can gather.
MANUAL_MAX_MS = int(os.environ.get("MANUAL_MAX_MS", 60000))
# Ignore the mic for a moment after Nova stops talking so her own voice tail
# cannot re-trigger the wake word.
REARM_DELAY_MS = int(os.environ.get("REARM_DELAY_MS", 500))

# --- Approvals --------------------------------------------------------------
# Run every tool call without asking.
#
# This removes the only gate between Nova and your machine. Hermes' security
# scanner still runs, but its verdict is no longer acted on — the `curl | python3`
# it grades [HIGH] executes, and so does anything else the model reaches for.
# Turn it back on with NOVA_AUTO_APPROVE=0.
#
# Two reasons this is worth having as a flag rather than a code edit: the
# approval prompt is *spoken* here (voice.py feeds it to TTS), so a blocked turn
# reads a whole shell heredoc out loud; and answering it needs a click, which
# defeats a hands-free assistant.
AUTO_APPROVE = os.environ.get("NOVA_AUTO_APPROVE", "1").strip().lower() not in {
    "0",
    "false",
    "no",
    "off",
    "",
}

# --- Clarify bypass ---------------------------------------------------------
# Hermes' `clarify` tool asks a question and blocks the agent thread until
# something calls clarify.respond — for agent.clarify_timeout seconds, an hour
# by default. Nothing in this app can answer it: there is no clarify surface,
# and while a turn streams the wire only runs one way. So an ambiguous request
# parked the whole session on "running clarify" with no way out but to wait.
#
# We answer the instant it arrives and push the question into Nova's spoken
# reply instead, which is the right place for it anyway — the user is talking,
# not clicking, and can just answer out loud.
#
# The wording is an instruction to the model, because that is what the tool
# hands back: clarify returns {"user_response": <this text>}, so it lands in the
# transcript as if the user had said it. It deliberately does not name a
# language — Nova should ask in whatever language the conversation is already
# using.
CLARIFY_BYPASS_ANSWER = os.environ.get(
    "NOVA_CLARIFY_BYPASS_ANSWER",
    "The clarify tool cannot reach the user in this session and returned no "
    "answer. Do not call it again this turn. Ask your question directly in "
    "your reply instead — one short sentence, in the language the user is "
    "speaking — then stop and wait for them to answer out loud.",
)
# After this many clarify calls in one turn the instruction above is clearly not
# landing, so stop being polite about it. Without a ceiling a model that reaches
# for clarify on every rejection can spin here, and each round is a full model
# call the user waits through.
CLARIFY_BYPASS_LIMIT = int(os.environ.get("NOVA_CLARIFY_BYPASS_LIMIT", 3))
CLARIFY_BYPASS_FINAL = os.environ.get(
    "NOVA_CLARIFY_BYPASS_FINAL",
    "clarify is disabled in this session and will never return an answer. "
    "Stop calling it. Reply to the user in words now, asking for whatever you "
    "still need to know.",
)
