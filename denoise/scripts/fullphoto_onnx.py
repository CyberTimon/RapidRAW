"""Full-photo ONNX assembly validation + packed-RAW pipeline benchmarks.

Compares shared-pipeline ONNX full predictions against independently captured
original references under frozen gates, with seam/interior/outer analysis and
actual tile/pass counts. Benchmarks are packed-RAW pipeline timings (session
init, per-pass wall incl. transfers + materialization), NOT RapidRAW/DNG E2E.
"""
import argparse
import json
import sys
import time

import numpy as np

from rapidraw_denoise.noise import NoiseProfile
from rapidraw_denoise.onnx_backend import OnnxTilePredictor
from rapidraw_denoise.pipeline import denoise_with_predictor

TILE, HALO, CORE = 320, 40, 240
PHOTOS = ["portrait", "landscape", "phone"]


def load_native(photo):
    d = f"/tmp/nlx-native/{photo}"
    request = json.load(open(f"{d}/request.json"))
    shape = tuple(request["shape"])
    packed = np.fromfile(f"{d}/input.f32", dtype="<f4").reshape(shape)
    meta = json.load(
        open(f"/tmp/nlx-fixtures/{photo}-controlled-fp32/metadata.json")
    )
    profile = NoiseProfile(**meta["noise_profile"])
    return packed, profile, meta


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default="/tmp/nlx-model/bundle-pinned-320-fp32")
    ap.add_argument("--tag", default="onnx",
                    help="output filename tag: {photo}-{tag}-full.npy")
    ap.add_argument("--optimize", action="store_true")
    ap.add_argument("--report", default=None)
    ns = ap.parse_args(argv)
    BUNDLE = ns.bundle
    t0 = time.monotonic()
    predictor = OnnxTilePredictor(BUNDLE, provider="cuda",
                                  optimize=ns.optimize)
    init_s = time.monotonic() - t0
    print(f"session init: {init_s:.1f}s providers={predictor.execution_info()['provider_actual']}", flush=True)
    report = {
        "bundle": BUNDLE,
        "session_init_seconds": init_s,
        "provider_actual": predictor.execution_info()["provider_actual"],
        "provider_options_effective": predictor.execution_info()["provider_options_effective"],
        "fallback_disabled": predictor.execution_info()["fallback_disabled"],
        "graph_optimizations": predictor.execution_info()["graph_optimizations"],
        "photos": {},
    }
    for photo in PHOTOS:
        packed, profile, meta = load_native(photo)
        _, h, w = packed.shape
        ny = (h + CORE - 1) // CORE
        nx = (w + CORE - 1) // CORE
        pentry = {
            "packed_shape": [4, h, w],
            "expected_tiles": ny * nx,
            "source_sha256": meta["source_sha256"],
        }
        calls = [0]

        orig_predict = predictor.predict

        def counting_predict(tile, _o=orig_predict, _c=calls):
            _c[0] += 1
            return _o(tile)

        predictor.predict = counting_predict
        t1 = time.monotonic()
        out, info = denoise_with_predictor(
            packed, predictor, profile, TILE, HALO
        )
        wall = time.monotonic() - t1
        predictor.predict = orig_predict
        np.save(f"/tmp/nlx-fixtures/{photo}-{ns.tag}-full.npy", out)
        pentry.update({
            "wall_seconds": wall,
            "actual_tile_calls": calls[0],
            "expected_tile_calls": ny * nx,
            "output_shape": list(out.shape),
        })
        assert calls[0] == ny * nx, (calls[0], ny * nx)
        assert out.shape == packed.shape
        print(f"{photo}: {wall:.1f}s tiles={calls[0]}", flush=True)
        report["photos"][photo] = pentry
    report_path = ns.report or f"/tmp/nlx-{ns.tag}-full-report.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"wrote {report_path}")


if __name__ == "__main__":
    main()
