"""Standalone viewer: RTSP + object detection in an OpenCV window.

For the web UI, run `python service.py` instead.
"""

import argparse
import time

import cv2

import detector
from config import FRAME_HEIGHT, FRAME_WIDTH, RTSP_URL


def main():
    parser = argparse.ArgumentParser(description="MediaPipe RTSP Camera AI")
    parser.add_argument("--url", default=RTSP_URL, help="RTSP stream URL")
    parser.add_argument(
        "--width", type=int, default=FRAME_WIDTH, help="Display width"
    )
    parser.add_argument(
        "--height", type=int, default=FRAME_HEIGHT, help="Display height"
    )
    args = parser.parse_args()

    print(f"Connecting to RTSP: {args.url}")
    cap = cv2.VideoCapture(args.url, cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    if not cap.isOpened():
        print("ERROR: Cannot open RTSP stream!")
        return

    print("Stream connected. Loading model...")

    object_detector = detector.create_object_detector()

    print("Model loaded. Starting detection...")
    print("Press [Q] to quit")

    prev_time = time.time()
    fps = 0.0

    while True:
        ret, frame = cap.read()
        if not ret:
            print("Lost connection, reconnecting...")
            cap.release()
            time.sleep(1)
            cap = cv2.VideoCapture(args.url, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            continue

        frame = cv2.resize(frame, (args.width, args.height))

        result = detector.detect(object_detector, frame)
        detector.draw_object_detections(frame, result)

        curr_time = time.time()
        fps = 0.9 * fps + 0.1 * (1.0 / max(curr_time - prev_time, 1e-6))
        prev_time = curr_time

        detector.draw_info(
            frame, [f"FPS: {fps:.1f}", "Object Detection ON | [q] quit"]
        )

        cv2.imshow("MediaPipe Camera AI", frame)

        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    object_detector.close()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
