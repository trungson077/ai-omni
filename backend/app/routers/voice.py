"""Voice loop: capture → STT → Hermes → TTS → listen again.

The browser streams raw 16 kHz mono int16 PCM. Everything else happens here,
because openWakeWord is a Python model and the endpointing decision needs the
same PCM the detector is already reading.

Two modes, chosen with `?mode=` and fixed for the life of the connection —
whether to load the wake model is decided here at accept time, before any client
frame exists to carry the choice:

    wake  the detector is armed for the whole session and the browser streams
          continuously to feed it. Saying "hey nova" opens a capture.
    mic   no detector is constructed at all. The `talk` command is the only way
          into a capture, and the browser only streams while one is open.

The endpointer runs in both modes: press, speak, fall silent, and the utterance
is sent. The one exception is a `talk` capture in *wake* mode, which is
hand-driven on purpose — see `hand_driven` below.

State machine per connection, in both modes:

    ARMED     wake: feed PCM to openWakeWord.  mic: nothing is listening.
    CAPTURING accumulate the utterance, watch for the end
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
    MANUAL_MAX_MS,
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

    # Anything that is not an explicit "mic" stays on the wake word, so an old
    # client that sends no mode at all behaves exactly as it did before.
    wake_enabled = websocket.query_params.get("mode", "wake") != "mic"
    logger.info("[voice] client connected (mode=%s)", "wake" if wake_enabled else "mic")

    detector: Detector | None = None
    if wake_enabled:
        try:
            detector = Detector()
        except Exception as e:
            logger.error("[voice] wake model failed to load: %s", e)
            await websocket.send_json(
                {"type": "wake.error", "message": f"Wake model unavailable: {e}"}
            )
            await websocket.close()
            return

    def reset_detector() -> None:
        """Drop the detector's feature history, if there is one to drop.

        Mic mode never constructs one, so every re-arm point has to tolerate its
        absence — and a missing wake model must not be able to take the
        microphone down with it, which is the whole point of the mode.
        """
        if detector is not None:
            detector.reset()

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
    # True when this capture was opened by the talk control rather than by the
    # wake word. It changes who decides the utterance is over: the endpointer,
    # or the person holding the button.
    manual = False

    # bytes = captured PCM awaiting STT; str = a typed directive that skips it.
    work_q: asyncio.Queue[bytes | str] = asyncio.Queue()
    done = asyncio.Event()

    # Sent in both modes: it is the "server is ready, state is ARMED" signal,
    # not a wake-word-only one. The threshold is null when nothing is scoring.
    await websocket.send_json(
        {
            "type": "wake.listening",
            "threshold": WAKEWORD_THRESHOLD if wake_enabled else None,
        }
    )

    async def read_audio():
        nonlocal state, elapsed_ms, silence_ms, saw_speech, manual
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
                    if cmd_type == "text":
                        typed = (cmd.get("text") or "").strip()
                        if not typed:
                            continue
                        logger.info("[voice] typed directive: '%s'", typed[:100])
                        # A typed directive supersedes the mic. If the wake word
                        # had fired and we were mid-utterance, throw that away —
                        # the user has clearly changed their mind about how to
                        # talk to us, and transcribing the abandoned half would
                        # queue a second, garbage turn behind this one. Nothing
                        # is billed: that audio never reached STT.
                        if state == CAPTURING:
                            utter.clear()
                            elapsed_ms = silence_ms = 0
                            saw_speech = False
                            reset_detector()
                        # Go BUSY here rather than in respond(), so no mic audio
                        # can reach the detector in the window before the turn
                        # is picked up. Already BUSY is a no-op and the queue
                        # simply serialises this behind the turn in flight.
                        state = BUSY
                        manual = False
                        await work_q.put(typed)
                    if cmd_type == "talk":
                        # In wake mode this is the second way into a turn, for
                        # when saying it out loud is the wrong move or the
                        # detector simply didn't hear you, and it is hand-driven
                        # end to end. In mic mode it is the only way in, and
                        # only the *open* half is pressed in the normal case —
                        # the endpointer closes it when you stop talking.
                        if cmd.get("on", True):
                            # Ignored while BUSY on purpose: the mic is being
                            # discarded anyway, so opening a capture here would
                            # record Nova's own voice. Already CAPTURING is a
                            # no-op rather than a restart.
                            if state == ARMED:
                                reset_detector()
                                utter.clear()
                                elapsed_ms = silence_ms = 0
                                saw_speech = False
                                manual = True
                                state = CAPTURING
                                # Same event the wake word sends, so the client
                                # has one path into "capturing" rather than two.
                                await websocket.send_json(
                                    {"type": "wake.detected", "score": None, "source": "manual"}
                                )
                        elif state == CAPTURING:
                            # What the off-press means is the whole character of
                            # the two modes.
                            #
                            # Wake mode: the capture is hand-driven, the
                            # endpointer is off, and this press is the only
                            # thing that can end it — so it submits.
                            #
                            # Mic mode: the endpointer is the only thing that
                            # submits. Off is a stop, and a stop throws the
                            # audio away — otherwise turning the microphone off
                            # would be a second, silent way to send, which is
                            # the exact thing you reach for the off switch to
                            # avoid. Nothing is billed: it never reached STT.
                            if wake_enabled and saw_speech and utter:
                                state = BUSY
                                await websocket.send_json({"type": "stt.start"})
                                await work_q.put(bytes(utter))
                                utter.clear()
                            else:
                                logger.info(
                                    "[voice] capture stopped, discarding %d bytes",
                                    len(utter),
                                )
                                reset_detector()
                                utter.clear()
                                elapsed_ms = silence_ms = 0
                                saw_speech = False
                                state = ARMED
                                await websocket.send_json({"type": "wake.rearm"})
                            manual = False
                    continue

                pcm = msg.get("bytes")
                if not pcm:
                    continue

                # Nova is answering — throw the mic away rather than record her.
                if state == BUSY:
                    continue

                if state == ARMED:
                    # Mic mode: nothing is listening here. The browser closes
                    # its capture between turns, so anything that still arrives
                    # is a straggler from one already shutting down — dropping
                    # it is the point, not a fallback.
                    if detector is None:
                        continue
                    score = await asyncio.to_thread(detector.push, pcm)
                    if score is None:
                        continue
                    logger.info("[voice] wake word fired, score=%.4f", score)
                    detector.reset()
                    utter.clear()
                    elapsed_ms = silence_ms = 0
                    saw_speech = False
                    manual = False
                    state = CAPTURING
                    await websocket.send_json(
                        {"type": "wake.detected", "score": round(score, 4), "source": "wake"}
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

                # Who decides the utterance is over.
                #
                # A talk capture in *wake* mode is explicitly hand-driven: it
                # exists for when the wake word is the wrong move, the person is
                # holding the control, and a silence there is a pause for
                # thought rather than a full stop. Cutting in after 1.2s of it
                # would make the button feel broken.
                #
                # Mic mode is the opposite by design: pressing the control is
                # how you start and falling silent is how you finish, so the
                # endpointer runs for every capture exactly as it does after the
                # wake word. A second press is then an early send, not the only
                # way out.
                hand_driven = manual and wake_enabled
                # A capture someone opened on purpose gets the longer bound —
                # they may well have more to say than a wake-word turn.
                cap_ms = MANUAL_MAX_MS if manual else UTTERANCE_MAX_MS

                ended = False
                if hand_driven:
                    if elapsed_ms >= cap_ms:
                        logger.info("[voice] manual capture hit the cap")
                        ended = True
                elif saw_speech and silence_ms >= UTTERANCE_SILENCE_MS:
                    ended = True
                elif elapsed_ms >= cap_ms:
                    ended = True
                elif not saw_speech and elapsed_ms >= UTTERANCE_NO_SPEECH_MS:
                    # Opened but nobody spoke — don't pay for an STT call on
                    # silence, just go back to listening. In mic mode this also
                    # closes the microphone client-side, so a press that was a
                    # misfire costs nothing and leaves nothing recording.
                    logger.info("[voice] no speech after open, re-arming")
                    reset_detector()
                    state = ARMED
                    manual = False
                    await websocket.send_json({"type": "wake.rearm"})
                    continue

                if ended:
                    state = BUSY
                    manual = False
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
        nonlocal state, manual
        try:
            while not done.is_set():
                try:
                    item = await asyncio.wait_for(work_q.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

                # Also covers an item queued while we were between turns.
                state = BUSY
                try:
                    if isinstance(item, bytes):
                        await _handle_utterance(item)
                    else:
                        await _handle_text(item)
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
                reset_detector()
                state = ARMED
                # The turn barrier clears this too. A talk capture that ended by
                # hitting the cap leaves it set, and the next wake-word turn
                # would then inherit a disabled endpointer and never end.
                manual = False
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

        await _run_turn(text)

    async def _handle_text(text: str):
        """A typed directive: the same turn, without STT and without audio in.

        The transcript is echoed rather than rendered optimistically in the
        browser, so both input paths have exactly one producer for it and the
        client needs no de-duplication.
        """
        await websocket.send_json(
            {"type": "transcript", "text": text, "source": "text"}
        )
        if not hermes_ok:
            await websocket.send_json(
                {"type": "error", "message": "Hermes unavailable — nothing was sent."}
            )
            return
        await _run_turn(text)

    async def _run_turn(text: str):
        await hermes.submit(text)

        tts_q: asyncio.Queue[str | None] = asyncio.Queue()
        tts_task = asyncio.create_task(tts_worker(tts_q, websocket))
        await websocket.send_json({"type": "tts.start"})

        sentence_buf = ""
        # Whether anything has been handed to TTS yet. Tracked separately from
        # sentence_buf because an emptied buffer and an unspoken reply are
        # different states, and conflating them made every reply speak twice:
        # a delta stream ending in whitespace splits cleanly, leaving the buffer
        # empty, and hermes.complete would then refill it with the whole answer.
        spoken_any = False
        async for event in hermes.stream_response():
            await websocket.send_json(event)

            if event.get("type") == "hermes.delta":
                sentence_buf += event.get("text", "")
                sentences, sentence_buf = split_complete_sentences(sentence_buf)
                for s in sentences:
                    await tts_q.put(s)
                    spoken_any = True
            elif event.get("type") == "hermes.approval":
                prompt = event.get("prompt", "")
                if prompt:
                    await tts_q.put(prompt)
            elif event.get("type") == "hermes.complete":
                # Only a fallback for a reply that arrived with no deltas at all.
                if not spoken_any and not sentence_buf:
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
