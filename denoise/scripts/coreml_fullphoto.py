"""Representative full-photo run through a converted CoreML package (diagnostic).

Wraps the .mlpackage in a TilePredictor, runs the shared
denoise_with_predictor pipeline (same TILE/HALO/CORE contract as the ONNX
full-photo runs), saves the output, and scores it against a reference
full-photo array with the frozen full_metrics gates via compare_files.
One photo per invocation; all paths are argv (no hardcodes).

Usage: coreml_fullphoto.py --package DIR --native-dir DIR --fixtures-root DIR
  --photo portrait --reference REF.npy --out OUT.npy [--report JSON]
"""
import argparse
import json
import sys
import time
from pathlib import Path

TILE, HALO = 320, 40


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--package", required=True)
    ap.add_argument("--native-dir", required=True)
    ap.add_argument("--fixtures-root", required=True)
    ap.add_argument("--photo", required=True)
    ap.add_argument("--reference", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--report", default=None)
    ns = ap.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import warnings
    warnings.filterwarnings("ignore")
    import numpy as np

    from rapidraw_denoise.noise import NoiseProfile
    from rapidraw_denoise.pipeline import TilePredictor, denoise_with_predictor
    from rapidraw_denoise.compare_full import compare_files

    pkg = Path(ns.package)
    manifest = json.loads((pkg / "manifest.json").read_text())
    import coremltools as ct
    t0 = time.monotonic()
    ml = ct.models.MLModel(str(pkg / manifest["artifact"]))
    load_s = time.monotonic() - t0
    in_name = manifest["input"]["name"]
    out_name = manifest["output"]["name"]

    class CoreMLTilePredictor(TilePredictor):
        def predict(self, tile_array):
            assert tile_array.dtype == np.float32 and tile_array.shape == (8, 320, 320)
            out = ml.predict({in_name: np.ascontiguousarray(tile_array[None])})
            y = np.asarray(out[out_name] if out_name in out
                           else out[list(out.keys())[0]])
            return np.ascontiguousarray(y[0] if y.shape[0] == 1 else y)

        def execution_info(self):
            return {"backend": "coreml-direct-mlpackage",
                    "package_sha256": manifest["package_sha256"],
                    "coremltools": ct.__version__}

    native = Path(ns.native_dir)
    req = json.loads((native / "request.json").read_text())
    packed = np.fromfile(native / "input.f32", dtype="<f4").reshape(tuple(req["shape"]))
    fxmeta = json.loads((Path(ns.fixtures_root) / f"{ns.photo}-controlled-fp32"
                         / "metadata.json").read_text())
    profile = NoiseProfile(**fxmeta["noise_profile"])
    pred = CoreMLTilePredictor()
    calls = [0]
    real_predict = pred.predict

    def counting(tile):
        calls[0] += 1
        return real_predict(tile)

    pred.predict = counting
    t1 = time.monotonic()
    out, _ = denoise_with_predictor(packed, pred, profile, TILE, HALO)
    wall = time.monotonic() - t1
    np.save(ns.out, out)
    cmp_rec = compare_files(f"coreml-{ns.photo}", ns.out, ns.reference)
    rep = {"photo": ns.photo,
           "package_sha256": manifest["package_sha256"],
           "load_s": load_s, "wall_s": wall, "tile_calls": calls[0],
           "output_shape": list(out.shape), "comparison": cmp_rec}
    rp = ns.report or str(Path(ns.out).with_suffix("")) + "-report.json"
    Path(rp).write_text(json.dumps(rep, indent=2) + "\n")
    m = {k: cmp_rec.get(k) for k in ("pass", "max_abs_err", "mae",
                                            "p99_abs_err", "elementwise_violations",
                                            "consistency_problems")}
    print(json.dumps({"photo": ns.photo,
                      "wall_s": round(wall, 1), "tiles": calls[0],
                      "pass": m.get("pass"),
                      "max_abs_err": m.get("max_abs_err")}, indent=2))
    print(f"wrote {ns.out} {rp}")
    return 0 if m.get("pass") else 1


if __name__ == "__main__":
    raise SystemExit(main())
