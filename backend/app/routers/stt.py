import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import ELEVENLABS_STT_MODEL, HERMES_URL, HERMES_TOKEN
from app.hermes import HermesClient
from app.tts import el_client, split_complete_sentences, tts_worker

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

router = APIRouter(tags=["STT"])


@router.websocket("/ws/stt")
async def ws_stt(websocket: WebSocket):
    await websocket.accept()
    logger.info("[ws] client connected")

    # Connect to Hermes
    hermes = HermesClient(HERMES_URL, HERMES_TOKEN)
    hermes_ok = False
    try:
        logger.info("[hermes] connecting to %s", HERMES_URL)
        await hermes.connect()
        hermes_ok = True
        logger.info("[hermes] connected, session=%s", hermes.session_id)
        await websocket.send_json({
            "type": "hermes.connected",
            "session_id": hermes.session_id,
        })
    except Exception as e:
        logger.error("[hermes] connection FAILED: %s", e)
        await websocket.send_json({
            "type": "hermes.error",
            "message": f"Hermes unavailable: {e}",
        })

    audio_buffer = bytearray()
    hermes_queue: asyncio.Queue[str] = asyncio.Queue()
    done = asyncio.Event()

    async def read_fe():
        """Read audio chunks and commands from the frontend."""
        try:
            while not done.is_set():
                msg = await websocket.receive()

                if msg["type"] == "websocket.disconnect":
                    logger.info("[ws] client disconnected")
                    break

                if "bytes" in msg and msg["bytes"]:
                    audio_buffer.extend(msg["bytes"])

                elif "text" in msg and msg["text"]:
                    cmd = json.loads(msg["text"])
                    cmd_type = cmd.get("type")
                    logger.info("[ws] cmd: %s", cmd_type)

                    if cmd_type == "flush":
                        buf_size = len(audio_buffer)
                        logger.info("[stt] flush, buffer=%d bytes", buf_size)

                        if buf_size <= 500:
                            logger.info("[stt] buffer too small, skipping")
                            audio_buffer.clear()
                            await websocket.send_json(
                                {"type": "transcript", "text": ""}
                            )
                            continue

                        audio_data = bytes(audio_buffer)
                        audio_buffer.clear()

                        try:
                            logger.info("[stt] calling ElevenLabs...")
                            result = await asyncio.to_thread(
                                el_client.speech_to_text.convert,
                                file=audio_data,
                                model_id=ELEVENLABS_STT_MODEL,
                                tag_audio_events=False,
                            )
                            text = result.text or ""
                            logger.info("[stt] transcript: '%s'", text[:100])
                            await websocket.send_json(
                                {"type": "transcript", "text": text}
                            )
                            # Queue for Hermes
                            if text.strip() and hermes_ok:
                                logger.info("[hermes] queuing text for hermes")
                                await hermes_queue.put(text)
                            elif text.strip() and not hermes_ok:
                                logger.warning("[hermes] NOT queued - hermes_ok=%s", hermes_ok)
                        except Exception as e:
                            logger.error("[stt] error: %s", e)
                            await websocket.send_json(
                                {"type": "error", "message": str(e)}
                            )

                    elif cmd_type == "approval":
                        choice = cmd.get("choice", "deny")
                        logger.info("[hermes] approval choice: %s", choice)
                        if hermes_ok:
                            try:
                                await hermes.respond_approval(choice)
                            except Exception as e:
                                logger.error("[hermes] approval failed: %s", e)

                    elif cmd_type == "reset":
                        logger.info("[ws] reset buffer")
                        audio_buffer.clear()

                    elif cmd_type == "stop":
                        logger.info("[ws] stop requested")
                        break

        except WebSocketDisconnect:
            logger.info("[ws] disconnected")
        except Exception as e:
            logger.error("[read_fe] error: %s", e, exc_info=True)
        finally:
            logger.info("[read_fe] done")
            done.set()

    async def process_hermes():
        """Take transcripts from queue, send to Hermes, stream response back."""
        logger.info("[hermes] process_hermes started")
        try:
            while not done.is_set():
                try:
                    text = await asyncio.wait_for(
                        hermes_queue.get(), timeout=1.0
                    )
                except asyncio.TimeoutError:
                    continue

                logger.info("[hermes] submitting: '%s'", text[:100])
                try:
                    await hermes.submit(text)
                    logger.info("[hermes] submitted, streaming response...")

                    # TTS queue + worker: runs in parallel with text streaming
                    tts_q: asyncio.Queue[str | None] = asyncio.Queue()
                    tts_task = asyncio.create_task(tts_worker(tts_q, websocket))
                    await websocket.send_json({"type": "tts.start"})

                    event_count = 0
                    sentence_buf = ""

                    async for event in hermes.stream_response():
                        event_count += 1
                        logger.info("[hermes] event #%d: %s", event_count, event.get("type"))
                        await websocket.send_json(event)

                        if event.get("type") == "hermes.delta":
                            sentence_buf += event.get("text", "")
                            sentences, sentence_buf = split_complete_sentences(
                                sentence_buf
                            )
                            for s in sentences:
                                logger.info("[tts] queuing sentence: '%s'", s[:60])
                                await tts_q.put(s)

                        elif event.get("type") == "hermes.approval":
                            # Speak the approval question too — otherwise it
                            # only ever appears as text and the user is left
                            # waiting on a silent prompt.
                            prompt = event.get("prompt", "")
                            if prompt:
                                await tts_q.put(prompt)

                        elif event.get("type") == "hermes.complete":
                            # Use complete text if no deltas came
                            if not sentence_buf:
                                sentence_buf = event.get("text", "")

                    logger.info("[hermes] response complete (%d events)", event_count)

                    # Flush remaining text
                    remaining = sentence_buf.strip()
                    if remaining:
                        logger.info("[tts] queuing remaining: '%s'", remaining[:60])
                        await tts_q.put(remaining)

                    # Signal worker to stop and wait
                    await tts_q.put(None)
                    await tts_task
                    await websocket.send_json({"type": "tts.complete"})

                except Exception as e:
                    logger.error("[hermes] stream error: %s", e, exc_info=True)
                    try:
                        await websocket.send_json(
                            {"type": "hermes.error", "message": str(e)}
                        )
                    except Exception:
                        break
        except Exception as e:
            logger.error("[process_hermes] fatal: %s", e, exc_info=True)
        finally:
            logger.info("[process_hermes] done")

    try:
        logger.info("[ws] starting tasks, hermes_ok=%s", hermes_ok)
        if hermes_ok:
            await asyncio.gather(read_fe(), process_hermes())
        else:
            await read_fe()
    finally:
        logger.info("[ws] cleaning up")
        await hermes.close()
