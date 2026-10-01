"""File protocol for RapidRAW's CUDA RAW worker; no decoding or colour processing."""
import argparse
import json
import os
from pathlib import Path
import numpy as np
from .raw import sha256

PROTOCOL = 1
ALGORITHM = "nonlocal-raw-v1"
CHECKPOINT_SHA256 = "c16747d852b93a95908792cdbac901f89cca98e35b91ea7db6214de42fbd3cad"


def validate_request(request):
    if request.get("protocol") != PROTOCOL or request.get("algorithm") != ALGORITHM:
        raise ValueError("Unsupported Nonlocal worker protocol")
    shape = request.get("shape")
    if (not isinstance(shape, list) or len(shape) != 3 or shape[0] != 4
            or any(type(v) is not int or v < 1 or v > 20000 for v in shape)
            or min(shape[1:]) < 8 or np.prod(shape, dtype=np.int64) > 200_000_000):
        raise ValueError("Invalid packed RGBG shape")
    if request.get("model_sha256") != CHECKPOINT_SHA256:
        raise ValueError("Unrecognized Nonlocal checkpoint")
    if request.get("tile") != 320 or request.get("halo") != 40:
        raise ValueError("Unsupported native inference configuration")
    return tuple(shape)


def run(directory, checkpoint):
    directory = Path(directory)
    request_path = directory / "request.json"
    request = json.loads(request_path.read_text())
    shape = validate_request(request)
    input_path = directory / "input.f32"
    if input_path.stat().st_size != int(np.prod(shape)) * 4:
        raise ValueError("Input byte count does not match packed shape")
    if sha256(input_path) != request["input_sha256"]:
        raise ValueError("Packed input checksum mismatch")
    if sha256(checkpoint) != CHECKPOINT_SHA256:
        raise ValueError("Checkpoint checksum mismatch")
    # Native RAW normalization preserves negative samples for noise estimation.
    packed = np.fromfile(input_path, dtype="<f4").reshape(shape)
    if not np.isfinite(packed).all():
        raise ValueError("Nonfinite RAW input")
    import torch
    from .inference import denoise, load_model
    torch.set_num_threads(4)
    def progress(event):
        fraction = event["completed_tiles"] / max(event["total_tiles"], 1)
        print(json.dumps({"progress": min(fraction, 1), "stage": "Nonlocal RAW tiles"}), flush=True)
    print(json.dumps({"progress": 0, "stage": "Loading Nonlocal CUDA model"}), flush=True)
    model = load_model(checkpoint, "cuda")
    output, info = denoise(packed, model, tile=320, halo=40, progress=progress)
    if output.shape != shape or not np.isfinite(output).all():
        raise ValueError("Invalid RAW prediction")
    temporary = directory / "prediction.f32.partial"
    with temporary.open("xb") as stream:
        output.astype("<f4", copy=False).tofile(stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.rename(directory / "prediction.f32")
    result = {"protocol": PROTOCOL, "algorithm": ALGORITHM, "shape": list(shape),
              "request_sha256": sha256(request_path), "input_sha256": request["input_sha256"],
              "model_sha256": CHECKPOINT_SHA256,
              "prediction_sha256": sha256(directory / "prediction.f32"),
              "sampler": os.environ.get("RAPIDRAW_DENOISE_SAMPLER", "reference"),
              "inference": info}
    (directory / "result.json.partial").write_text(json.dumps(result, indent=2) + "\n")
    (directory / "result.json.partial").rename(directory / "result.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    args = parser.parse_args()
    run(args.directory, args.checkpoint)


if __name__ == "__main__":
    main()
