import argparse

import numpy as np
import sounddevice as sd

from local_models import CHUNK, HEY_NOVA, SAMPLE_RATE, load_model

# Parse input arguments
parser = argparse.ArgumentParser()
parser.add_argument(
    "--chunk_size",
    help="How much audio (in number of samples) to predict on at once",
    type=int,
    default=CHUNK,
    required=False,
)
parser.add_argument(
    "--model_path",
    help="The path of a specific model to load",
    type=str,
    default=str(HEY_NOVA),
    required=False,
)
parser.add_argument(
    "--inference_framework",
    help="The inference framework to use (either 'onnx' or 'tflite')",
    type=str,
    default="onnx",
    required=False,
)
parser.add_argument(
    "--threshold",
    help="Score above which a wakeword is considered detected",
    type=float,
    default=0.5,
    required=False,
)
args = parser.parse_args()

# Microphone stream settings
CHANNELS = 1
RATE = SAMPLE_RATE
CHUNK = args.chunk_size

# Load openwakeword model(s)
owwModel = load_model(args.model_path, args.inference_framework)

n_models = len(owwModel.models.keys())

# Run capture loop continuously, checking for wakewords
if __name__ == "__main__":
    print("\n\n")
    print("#" * 100)
    print(f"Listening for wakewords (threshold={args.threshold})...")
    print("#" * 100)
    print("\n" * (n_models * 3))

    with sd.InputStream(
        samplerate=RATE, channels=CHANNELS, dtype="int16", blocksize=CHUNK
    ) as mic_stream:
        while True:
            # Get audio
            frame, _ = mic_stream.read(CHUNK)
            audio = np.squeeze(frame)

            # Feed to openWakeWord model
            owwModel.predict(audio)

            # Column titles
            n_spaces = 16
            output_string_header = """
            Model Name         | Score | Wakeword Status
            --------------------------------------
            """

            for mdl in owwModel.prediction_buffer.keys():
                # Add scores in formatted table
                scores = list(owwModel.prediction_buffer[mdl])
                curr_score = format(scores[-1], ".20f").replace("-", "")
                status = (
                    "--" + " " * 20
                    if scores[-1] <= args.threshold
                    else "Wakeword Detected!"
                )

                output_string_header += f"""{mdl}{" " * (n_spaces - len(mdl))}   | {curr_score[0:5]} | {status}
            """

            # Print results table
            print("\033[F" * (4 * n_models + 1))
            print(output_string_header, "                             ", end="\r")
