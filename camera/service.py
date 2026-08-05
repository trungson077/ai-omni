"""God Eye camera service: MJPEG stream + detection readouts over HTTP."""

import asyncio
import logging

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from stream import stream

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BOUNDARY = "frame"

app = FastAPI(title="God Eye Camera Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", **stream.status()}


@app.post("/start")
async def start():
    """Warm up the capture so the first viewer doesn't stare at a blank frame."""
    stream.start()
    ready = await asyncio.to_thread(stream.wait_for_frame, 10.0)
    status = stream.status()
    if not ready:
        return {"ready": False, **status}
    return {"ready": True, **status}


@app.post("/stop")
def stop():
    stream.stop()
    return {"stopped": True}


@app.get("/detections")
def detections():
    return {"detections": stream.detections(), "fps": stream.status()["fps"]}


@app.get("/snapshot")
def snapshot(annotated: bool = True):
    """A single still from the feed.

    `annotated=false` is the one to hand a vision model — see
    CameraStream.clean_snapshot for why the drawn labels have to go. The
    default keeps the boxes, because a still fetched by a person is being
    looked at by a person.
    """
    stream.start()
    if not stream.wait_for_frame(10.0):
        raise HTTPException(503, "camera not available")
    jpeg = stream.snapshot() if annotated else stream.clean_snapshot()
    if jpeg is None:
        raise HTTPException(503, "camera not available")
    return Response(content=jpeg, media_type="image/jpeg")


@app.get("/mjpeg")
async def mjpeg():
    stream.acquire()

    async def generate():
        try:
            frames = stream.frames()
            while True:
                jpeg = await asyncio.to_thread(next, frames, None)
                if jpeg is None:
                    break
                yield (
                    f"--{BOUNDARY}\r\n"
                    "Content-Type: image/jpeg\r\n"
                    f"Content-Length: {len(jpeg)}\r\n\r\n"
                ).encode() + jpeg + b"\r\n"
        finally:
            stream.release()
            logger.info("[mjpeg] viewer left, %d remaining", stream.status()["viewers"])

    logger.info("[mjpeg] viewer joined")
    return StreamingResponse(
        generate(),
        media_type=f"multipart/x-mixed-replace; boundary={BOUNDARY}",
        headers={"Cache-Control": "no-store", "Connection": "close"},
    )


if __name__ == "__main__":
    import uvicorn

    from config import SERVICE_HOST, SERVICE_PORT

    uvicorn.run(app, host=SERVICE_HOST, port=SERVICE_PORT)
