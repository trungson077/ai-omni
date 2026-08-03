"""MediaPipe object detection, shared by the standalone viewer and the service."""

import cv2
import mediapipe as mp
from mediapipe.tasks.python import BaseOptions
from mediapipe.tasks.python.vision import (
    ObjectDetector,
    ObjectDetectorOptions,
    RunningMode,
)

from config import MODELS_DIR

COLOR_OBJECT = (0, 255, 0)
COLOR_TEXT_BG = (0, 0, 0)


def create_object_detector():
    options = ObjectDetectorOptions(
        base_options=BaseOptions(
            model_asset_path=str(MODELS_DIR / "efficientdet_lite0.tflite")
        ),
        running_mode=RunningMode.IMAGE,
        max_results=10,
        score_threshold=0.4,
    )
    return ObjectDetector.create_from_options(options)


def detect(object_detector, frame):
    """Run detection on a BGR frame."""
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
    return object_detector.detect(mp_image)


def summarize(result) -> list[dict]:
    """Detections as plain data, for the API and for Nova to read."""
    items = []
    for detection in result.detections:
        bbox = detection.bounding_box
        category = detection.categories[0]
        items.append(
            {
                "name": category.category_name,
                "score": round(float(category.score), 3),
                "box": [bbox.origin_x, bbox.origin_y, bbox.width, bbox.height],
            }
        )
    return items


def draw_object_detections(frame, result):
    for detection in result.detections:
        bbox = detection.bounding_box
        x, y = bbox.origin_x, bbox.origin_y
        bw, bh = bbox.width, bbox.height

        cv2.rectangle(frame, (x, y), (x + bw, y + bh), COLOR_OBJECT, 2)

        category = detection.categories[0]
        label = f"{category.category_name} {category.score:.0%}"
        text_size = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 1)[0]
        cv2.rectangle(
            frame,
            (x, y - text_size[1] - 8),
            (x + text_size[0] + 4, y),
            COLOR_OBJECT,
            -1,
        )
        cv2.putText(
            frame,
            label,
            (x + 2, y - 4),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            (0, 0, 0),
            1,
        )


def draw_info(frame, lines):
    y_offset = 25
    for line in lines:
        text_size = cv2.getTextSize(line, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 1)[0]
        cv2.rectangle(
            frame,
            (5, y_offset - text_size[1] - 4),
            (text_size[0] + 10, y_offset + 4),
            COLOR_TEXT_BG,
            -1,
        )
        cv2.putText(
            frame,
            line,
            (8, y_offset),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            (255, 255, 255),
            1,
        )
        y_offset += 28
