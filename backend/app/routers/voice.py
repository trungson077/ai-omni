"""Wake-word voice loop: "hey nova" → STT → Hermes → TTS → listen again.

The browser streams raw 16 kHz mono int16 PCM for as long as the mode is on.
Everything else happens here, because openWakeWord is a Python model and the
endpointing decision needs the same PCM the detector is already reading.

State machine per connection:

    ARMED     feed PCM to openWakeWord, ignore everything else
    CAPTURING wake word fired — accumulate the utterance, watch for the end
    BUSY      transcribing / asking Hermes / speaking; mic input is discarded

BUSY drops audio on purpose: without it Nova's own voice comes back through the
mic and both re-triggers the wake word and corrupts the next utterance.
"""

import asyncio
import io
import json
import logging
import math
import wave

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import (
    ELEVENLABS_STT_MODEL,
    HERMES_TOKEN,
    HERMES_URL,
    REARM_DELAY_MS,
    UTTERANCE_MAX_MS,
    UTTERANCE_NO_SPEECH_MS,
    UTTERANCE_SILENCE_MS,
    UTTERANCE_SPEECH_RMS,
    WAKEWORD_SAMPLE_RATE,
    WAKEWORD_THRESHOLD,
)
from app.hermes import HermesClient
from app.tts import el_client, split_complete_sentences, tts_worker
from app.wakeword import Detector

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Voice"])

ARMED, CAPTURING, BUSY = "armed", "capturing", "busy"

# int16 at 16 kHz: 16 samples per millisecond, 2 bytes per sample.
_BYTES_PER_MS = WAKEWORD_SAMPLE_RATE * 2 // 1000


def _pcm_to_wav(pcm: bytes) -> bytes:
    """Wrap raw mono int16 PCM in a WAV container for the STT API."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(WAKEWORD_SAMPLE_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


def _rms(pcm: bytes) -> float:
    """RMS amplitude of int16 PCM, without pulling in numpy for a few frames."""
    n = len(pcm) // 2
    if n == 0:
        return 0.0
    total = 0
    for i in range(0, n * 2, 2):
        s = pcm[i] | (pcm[i + 1] << 8)
        if s >= 0x8000:
            s -= 0x10000
        total += s * s
    return math.sqrt(total / n)


@router.websocket("/ws/voice")
async def ws_voice(websocket: WebSocket):
    await websocket.accept()
    logger.info("[voice] client connected")

    try:
        detector = Detector()
    except Exception as e:
        logger.error("[voice] wake model failed to load: %s", e)
        await websocket.send_json(
            {"type": "wake.error", "message": f"Wake model unavailable: {e}"}
        )
        await websocket.close()
        return

    hermes = HermesClient(HERMES_URL, HERMES_TOKEN)
    hermes_ok = False
    try:
        logger.info("[voice] connecting to hermes %s", HERMES_URL)
        await hermes.connect()
        hermes_ok = True
        await websocket.send_json(
            {"type": "hermes.connected", "session_id": hermes.session_id}
        )
    except Exception as e:
        logger.error("[voice] hermes connection FAILED: %s", e)
        await websocket.send_json(
            {"type": "hermes.error", "message": f"Hermes unavailable: {e}"}
        )

    state = ARMED
    utter = bytearray()
    elapsed_ms = 0
    silence_ms = 0
    saw_speech = False

    work_q: asyncio.Queue[bytes] = asyncio.Queue()
    done = asyncio.Event()

    await websocket.send_json(
        {"type": "wake.listening", "threshold": WAKEWORD_THRESHOLD}
    )

    async def read_audio():
        nonlocal state, elapsed_ms, silence_ms, saw_speech
        try:
            while not done.is_set():
                msg = await websocket.receive()

                if msg["type"] == "websocket.disconnect":
                    logger.info("[voice] client disconnected")
                    break

                if msg.get("text"):
                    cmd = json.loads(msg["text"])
                    cmd_type = cmd.get("type")
                    if cmd_type == "stop":
                        logger.info("[voice] stop requested")
                        break
                    if cmd_type == "approval" and hermes_ok:
                        choice = cmd.get("choice", "deny")
                        logger.info("[voice] approval choice: %s", choice)
                        try:
                            await hermes.respond_approval(choice)
                        except Exception as e:
                            logger.error("[voice] approval failed: %s", e)
                    continue

                pcm = msg.get("bytes")
                if not pcm:
                    continue

                # Nova is answering — throw the mic away rather than record her.
                if state == BUSY:
                    continue

                if state == ARMED:
                    score = await asyncio.to_thread(detector.push, pcm)
                    if score is None:
                        continue
                    logger.info("[voice] wake word fired, score=%.4f", score)
                    detector.reset()
                    utter.clear()
                    elapsed_ms = silence_ms = 0
                    saw_speech = False
                    state = CAPTURING
                    await websocket.send_json(
                        {"type": "wake.detected", "score": round(score, 4)}
                    )
                    continue

                # CAPTURING
                utter.extend(pcm)
                chunk_ms = len(pcm) // _BYTES_PER_MS or 1
                elapsed_ms += chunk_ms
                level = await asyncio.to_thread(_rms, pcm)

                if level > UTTERANCE_SPEECH_RMS:
                    saw_speech = True
                    silence_ms = 0
                elif saw_speech:
                    silence_ms += chunk_ms

                ended = False
                if saw_speech and silence_ms >= UTTERANCE_SILENCE_MS:
                    ended = True
                elif elapsed_ms >= UTTERANCE_MAX_MS:
                    ended = True
                elif not saw_speech and elapsed_ms >= UTTERANCE_NO_SPEECH_MS:
                    # Wake word fired but nobody spoke — don't pay for an STT
                    # call on silence, just go back to listening.
                    logger.info("[voice] no speech after wake, re-arming")
                    detector.reset()
                    state = ARMED
                    await websocket.send_json({"type": "wake.rearm"})
                    continue

                if ended:
                    state = BUSY
                    await websocket.send_json({"type": "stt.start"})
                    await work_q.put(bytes(utter))
                    utter.clear()

        except WebSocketDisconnect:
            logger.info("[voice] disconnected")
        except Exception as e:
            logger.error("[read_audio] error: %s", e, exc_info=True)
        finally:
            done.set()

    async def respond():
        """STT → Hermes → TTS for each finished utterance, then re-arm."""
        nonlocal state
        try:
            while not done.is_set():
                try:
                    pcm = await asyncio.wait_for(work_q.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

                try:
                    await _handle_utterance(pcm)
                except Exception as e:
                    logger.error("[voice] utterance failed: %s", e, exc_info=True)
                    try:
                        await websocket.send_json(
                            {"type": "error", "message": str(e)}
                        )
                    except Exception:
                        break

                # Let the speakers fall quiet before the detector listens again.
                await asyncio.sleep(REARM_DELAY_MS / 1000)
                detector.reset()
                state = ARMED
                try:
                    await websocket.send_json({"type": "wake.rearm"})
                except Exception:
                    break
        finally:
            logger.info("[voice] respond loop done")

    async def _handle_utterance(pcm: bytes):
        wav = _pcm_to_wav(pcm)
        logger.info("[voice] transcribing %d bytes of wav", len(wav))
        result = await asyncio.to_thread(
            el_client.speech_to_text.convert,
            file=wav,
            model_id=ELEVENLABS_STT_MODEL,
            tag_audio_events=False,
        )
        text = (result.text or "").strip()
        logger.info("[voice] transcript: '%s'", text[:100])
        await websocket.send_json({"type": "transcript", "text": text})

        if not text or not hermes_ok:
            return

        await hermes.submit(text)

        tts_q: asyncio.Queue[str | None] = asyncio.Queue()
        tts_task = asyncio.create_task(tts_worker(tts_q, websocket))
        await websocket.send_json({"type": "tts.start"})

        sentence_buf = ""
        async for event in hermes.stream_response():
            await websocket.send_json(event)

            if event.get("type") == "hermes.delta":
                sentence_buf += event.get("text", "")
                sentences, sentence_buf = split_complete_sentences(sentence_buf)
                for s in sentences:
                    await tts_q.put(s)
            elif event.get("type") == "hermes.approval":
                prompt = event.get("prompt", "")
                if prompt:
                    await tts_q.put(prompt)
            elif event.get("type") == "hermes.complete":
                if not sentence_buf:
                    sentence_buf = event.get("text", "")

        remaining = sentence_buf.strip()
        if remaining:
            await tts_q.put(remaining)

        await tts_q.put(None)
        await tts_task
        await websocket.send_json({"type": "tts.complete"})

    try:
        await asyncio.gather(read_audio(), respond())
    finally:
        logger.info("[voice] cleaning up")
        await hermes.close()
