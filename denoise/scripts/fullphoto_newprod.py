"""Refactored-code production full-photo runs (native ext, original flags).

Timing doubles as the actual native-CUDA production baseline for benchmarks.
"""
import json
import time

import numpy as np

from rapidraw_denoise.inference import denoise, load_model
from rapidraw_denoise.noise import NoiseProfile

CKPT = "/mnt/data/rapidraw/denoise-research/models/nonlocal-raw-weights.pt"

report = {"photos": {}}
model = load_model(CKPT, device="cuda")
for photo in ["portrait", "landscape", "phone"]:
    d = f"/tmp/nlx-native/{photo}"
    request = json.load(open(f"{d}/request.json"))
    packed = np.fromfile(f"{d}/input.f32", dtype="<f4").reshape(
        tuple(request["shape"])
    )
    meta = json.load(
        open(f"/tmp/nlx-fixtures/{photo}-controlled-fp32/metadata.json")
    )
    profile = NoiseProfile(**meta["noise_profile"])
    events = []
    t1 = time.monotonic()
    out, info = denoise(
        packed, model, profile, 320, 40,
        progress=events.append,
    )
    wall = time.monotonic() - t1
    tile_events = [e for e in events if "completed_tiles" in e]
    np.save(f"/tmp/nlx-fixtures/{photo}-newprod-full.npy", out)
    pentry = {
        "photoshape": list(packed.shape),
        "wall_seconds": wall,
        "tile_events": len(tile_events),
        "inference_elapsed": info["elapsed_seconds"],
    }
    print(f"{photo}: {wall:.1f}s tile_events={len(tile_events)}", flush=True)
    report["photos"][photo] = pentry
with open("/tmp/nlx-newprod-full-report.json", "w") as f:
    json.dump(report, f, indent=2)
print("wrote /tmp/nlx-newprod-full-report.json")
