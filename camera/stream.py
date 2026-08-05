"""One shared RTSP reader feeding every viewer.

A single background thread owns the capture, annotates each frame and keeps the
latest JPEG. Viewers acquire/release; the capture is dropped once nobody has
watched for IDLE_TIMEOUT seconds, and respawned on the next start().
"""

import logging
import threading
import time
from typing import Iterator

import cv2

import detector
from config import (
    FRAME_HEIGHT,
    FRAME_WIDTH,
    IDLE_TIMEOUT,
    JPEG_QUALITY,
    RTSP_URL,
)

logger = logging.getLogger(__name__)

_ENCODE_PARAMS = [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY]


class CameraStream:
    def __init__(
        self,
        url: str = RTSP_URL,
        width: int = FRAME_WIDTH,
        height: int = FRAME_HEIGHT,
        idle_timeout: float = IDLE_TIMEOUT,
    ):
        self.url = url
        self.width = width
        self.height = height
        self.idle_timeout = idle_timeout

        self._cond = threading.Condition()
        self._thread: threading.Thread | None = None
        self._stop_requested = False

        self._jpeg: bytes | None = None
        # The same frame before any drawing. See clean_snapshot().
        self._raw = None
        self._frame_id = 0
        self._detections: list[dict] = []
        self._fps = 0.0
        self._viewers = 0
        self._last_activity = 0.0
        self._error: str | None = None

    # --- lifecycle -----------------------------------------------------

    def start(self) -> None:
        """Idempotent: make sure the reader thread is running."""
        with self._cond:
            self._last_activity = time.monotonic()
            self._stop_requested = False
            if self._thread and self._thread.is_alive():
                return
            self._error = None
            self._thread = threading.Thread(
                target=self._run, name="camera-stream", daemon=True
            )
            self._thread.start()
            logger.info("[stream] reader thread started")

    def stop(self) -> None:
        with self._cond:
            self._stop_requested = True
            self._cond.notify_all()

    def wait_for_frame(self, timeout: float = 10.0) -> bool:
        """Block until at least one frame is available."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._jpeg is None and not self._error:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(remaining)
            return self._jpeg is not None

    # --- viewers -------------------------------------------------------

    def acquire(self) -> None:
        with self._cond:
            self._viewers += 1
            self._last_activity = time.monotonic()
        self.start()

    def release(self) -> None:
        with self._cond:
            self._viewers = max(0, self._viewers - 1)
            self._last_activity = time.monotonic()

    # --- reads ---------------------------------------------------------

    def snapshot(self) -> bytes | None:
        with self._cond:
            self._last_activity = time.monotonic()
            return self._jpeg

    def clean_snapshot(self) -> bytes | None:
        """The latest frame as JPEG, with no overlays burned in.

        This is the still a vision model must be given. Every frame in the
        MJPEG feed carries the detector's boxes, its class labels and the FPS
        banner drawn into the pixels — right for a human watching, actively
        misleading for a VLM, which reads those labels as part of the scene and
        ends up describing the annotation rather than the room. Worse, it
        inherits the detector's 80-class vocabulary, which is the exact
        limitation asking a VLM was meant to escape.
        Encoded on demand rather than per frame: the reader would otherwise pay
        a second JPEG encode on every frame to serve a still that is only asked
        for occasionally.
        """
        with self._cond:
            self._last_activity = time.monotonic()
            # Copy under the lock — the reader mutates its own frame in place on
            # the next iteration, so handing out the array itself would let the
            # encode below race a half-drawn frame.
            frame = None if self._raw is None else self._raw.copy()
        if frame is None:
            return None
        ok, buf = cv2.imencode(".jpg", frame, _ENCODE_PARAMS)
        return buf.tobytes() if ok else None

    def detections(self) -> list[dict]:
        with self._cond:
            self._last_activity = time.monotonic()
            return list(self._detections)

    def status(self) -> dict:
        with self._cond:
            return {
                "running": bool(self._thread and self._thread.is_alive()),
                "viewers": self._viewers,
                "fps": round(self._fps, 1),
                "has_frame": self._jpeg is not None,
                "detections": len(self._detections),
                "error": self._error,
                "url": self.url,
            }

    def frames(self, timeout: float = 15.0) -> Iterator[bytes]:
        """Yield each new JPEG. Caller must acquire()/release() around this."""
        last_seen = -1
        while True:
            with self._cond:
                deadline = time.monotonic() + timeout
                # Both conditions matter: on a cold start the reader has not
                # produced a frame yet (_jpeg is None) while _frame_id is
                # already past last_seen, so checking the id alone would fall
                # straight through and hand the first viewer an empty stream.
                while (
                    (self._jpeg is None or self._frame_id == last_seen)
                    and not self._stop_requested
                    and self._error is None
                ):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return
                    self._cond.wait(remaining)
                if self._stop_requested or self._jpeg is None:
                    return
                last_seen = self._frame_id
                jpeg = self._jpeg
            yield jpeg

    # --- reader thread -------------------------------------------------

    def _idle_expired(self) -> bool:
        with self._cond:
            if self._viewers > 0:
                return False
            return time.monotonic() - self._last_activity > self.idle_timeout

    def _open_capture(self):
        cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    def _run(self) -> None:
        logger.info("[stream] connecting to %s", self.url)
        object_detector = detector.create_object_detector()
        cap = self._open_capture()

        if not cap.isOpened():
            with self._cond:
                self._error = "cannot open RTSP stream"
                self._cond.notify_all()
            cap.release()
            object_detector.close()
            logger.error("[stream] cannot open RTSP stream")
            return

        prev_time = time.time()
        fps = 0.0

        try:
            while not self._stop_requested and not self._idle_expired():
                ok, frame = cap.read()
                if not ok:
                    logger.warning("[stream] lost connection, reconnecting...")
                    cap.release()
                    time.sleep(1)
                    cap = self._open_capture()
                    continue

                frame = cv2.resize(frame, (self.width, self.height))
                # Taken before the draw calls below, which mutate `frame` in
                # place. This is what clean_snapshot() hands to a VLM.
                raw = frame.copy()
                result = detector.detect(object_detector, frame)
                items = detector.summarize(result)
                detector.draw_object_detections(frame, result)

                now = time.time()
                fps = 0.9 * fps + 0.1 * (1.0 / max(now - prev_time, 1e-6))
                prev_time = now
                detector.draw_info(frame, [f"GOD EYE  |  FPS: {fps:.1f}"])

                ok, buf = cv2.imencode(".jpg", frame, _ENCODE_PARAMS)
                if not ok:
                    continue

                with self._cond:
                    self._jpeg = buf.tobytes()
                    self._raw = raw
                    self._detections = items
                    self._fps = fps
                    self._frame_id += 1
                    self._error = None
                    self._cond.notify_all()
        except Exception as e:  # keep the service alive if the reader dies
            logger.error("[stream] reader crashed: %s", e, exc_info=True)
            with self._cond:
                self._error = str(e)
        finally:
            cap.release()
            object_detector.close()
            with self._cond:
                self._jpeg = None
                self._raw = None
                self._detections = []
                self._fps = 0.0
                self._thread = None
                self._cond.notify_all()
            logger.info("[stream] reader thread stopped")


stream = CameraStream()
