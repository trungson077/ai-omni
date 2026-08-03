import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"

RTSP_URL = os.environ.get(
    "CAMERA_RTSP_URL", "rtsp://admin:8Seneca123@192.168.88.90:554/h264_stream"
)
FRAME_WIDTH = int(os.environ.get("CAMERA_WIDTH", 1280))
FRAME_HEIGHT = int(os.environ.get("CAMERA_HEIGHT", 720))
JPEG_QUALITY = int(os.environ.get("CAMERA_JPEG_QUALITY", 80))

# Seconds with no viewer before the RTSP connection is dropped.
IDLE_TIMEOUT = float(os.environ.get("CAMERA_IDLE_TIMEOUT", 30))

SERVICE_HOST = os.environ.get("CAMERA_SERVICE_HOST", "127.0.0.1")
SERVICE_PORT = int(os.environ.get("CAMERA_SERVICE_PORT", 8001))
SERVICE_URL = os.environ.get(
    "CAMERA_SERVICE_URL", f"http://{SERVICE_HOST}:{SERVICE_PORT}"
)
