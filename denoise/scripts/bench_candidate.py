"""Candidate-bundle CUDA benchmark (torch-free process).

Benchmarks one ONNX bundle with NumPy-in/NumPy-out timing only: session
init, 3 warm-up + 10 measured tile runs (np.median / np.quantile-linear
P95), then xN full-photo assemblies on the representative photo. Imports numpy/scipy/onnxruntime only; asserts Torch was never
imported. One process per configuration; env fixed at launch.

Optional benchmark-only ORT profiling (--profile) records a per-node
host-observed operator timing trace for the tile runs only (ended before
the full-photo assemblies so the trace stays tractable) and embeds a
provider/operator summary. This is host-side latency attribution, NOT
device-side CUDA kernel timing (use Nsight/CUPTI for that). Never subtract
summed Node durations from wall time as measured overhead. Profiling is
opt-in and off by default; it must not change inference numerics.

Usage: bench_candidate.py --bundle DIR --fixtures DIR --out PATH
       [--provider cuda] [--optimize] [--photo portrait] [--repeats 3]
       [--profile] [--profile-dir DIR]
       [--prod-cuda] [--cuda-arena ...] [--cuda-cudnn-search ...]
       [--cuda-device-id 0] [--maps-out PATH]
"""
import argparse
import json
import os
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

# Maps-line keywords proving actual CUDA library binding (not loader intent).
MAPS_KEYWORDS = ("libcudnn", "libcublas", "libcublasLt", "libcudart")


def smi():
    try:
        out = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=utilization.gpu,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=30)
        return out.stdout.strip()
    except Exception as exc:
        return f"unavailable: {exc}"


def snapshot_maps():
    """Benchmark-only: actually-mapped CUDA library realpaths.

    Reads /proc/self/maps (Linux) and keeps libcudnn/cublas/cublasLt/cudart
    mappings with realpaths resolved, so the report proves which libraries
    the process bound rather than what LD_LIBRARY_PATH intended. Never
    fails the benchmark: a missing /proc yields a note instead.
    """
    try:
        text = Path("/proc/self/maps").read_text()
    except OSError as exc:
        return {"note": f"/proc/self/maps unavailable: {exc}"}
    hits = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 6:
            continue
        path = parts[-1]
        if path.startswith("[") or "/" not in path:
            continue
        base = path.rsplit("/", 1)[-1]
        if not base.startswith(MAPS_KEYWORDS):
            continue
        try:
            real = os.path.realpath(path)
        except OSError:
            real = path
        hits.setdefault(base, real)
    return {"libraries": dict(sorted(hits.items()))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--maps-out", default=None,
                    help="Benchmark-only: write the actually-mapped CUDA "
                    "library snapshot (see snapshot_maps) to this JSON path "
                    "as well as embedding it in the report. Refuses to "
                    "overwrite.")
    ap.add_argument("--provider", default="cuda", choices=("cuda", "cpu"))
    ap.add_argument("--optimize", action="store_true",
                    help="Enable ORT graph optimizations (vs controlled off)")
    ap.add_argument("--io-binding", action="store_true",
                    help="Use preallocated reusable device buffers (CUDA only)")
    ap.add_argument("--tf32", action="store_true",
                    help="FAST_EXPERIMENTAL only: CUDA TF32 on (labels the run "
                    "experimental; never a strict pass)")
    ap.add_argument("--photo", default="portrait")
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--torch-prime", action="store_true",
                    help="Diagnostic only: import torch and touch the CUDA "
                    "context/allocator before session creation (mimics the "
                    "older bench_v2 process state). Recorded, never default.")
    ap.add_argument("--prod-cuda", action="store_true",
                    help="Benchmark-only exact production-equivalent CUDA "
                    "provider options: device 0, arena kSameAsRequested, "
                    "cuDNN HEURISTIC, TF32 off. Requires --provider cuda; "
                    "conflicts with --tf32. Explicit --cuda-* flags override "
                    "individual keys for isolated H/E comparisons.")
    ap.add_argument("--cuda-arena", default=None,
                    choices=("kSameAsRequested", "kNextPowerOfTwo"),
                    help="Isolated CUDA arena override (benchmark-only). "
                    "Without --prod-cuda, sets only this key.")
    ap.add_argument("--cuda-cudnn-search", default=None,
                    choices=("HEURISTIC", "EXHAUSTIVE", "DEFAULT"),
                    help="Isolated cuDNN search override (benchmark-only). "
                    "Without --prod-cuda, sets only this key.")
    ap.add_argument("--cuda-device-id", default=None,
                    help="Isolated CUDA device override (benchmark-only, "
                    "nonnegative integer string). Without --prod-cuda, sets "
                    "only this key.")
    ap.add_argument("--profile", action="store_true",
                    help="Benchmark-only: enable ORT per-node profiling for "
                    "the tile runs and embed a provider/operator summary. "
                    "Off by default; trace covers tile runs only.")
    ap.add_argument("--profile-dir", default=None,
                    help="Directory for the ORT profile trace (requires "
                    "--profile). Defaults to the system temp dir so traces "
                    "stay outside tracked source.")
    ns = ap.parse_args()
    out_path = Path(ns.out)
    if out_path.exists():
        print(json.dumps({"status": "error",
                          "error": f"refusing to overwrite {out_path}"}),
              file=sys.stderr)
        return 1
    if ns.profile_dir is not None and not ns.profile:
        print(json.dumps({"status": "error",
                          "error": "--profile-dir requires --profile"}),
              file=sys.stderr)
        return 1
    if ns.prod_cuda and ns.provider != "cuda":
        print(json.dumps({"status": "error",
                          "error": "--prod-cuda requires --provider cuda"}),
              file=sys.stderr)
        return 1
    if ns.prod_cuda and ns.tf32:
        print(json.dumps({"status": "error",
                          "error": "--prod-cuda conflicts with --tf32 "
                          "(production is TF32 off)"}),
              file=sys.stderr)
        return 1
    for flag, name in ((ns.cuda_arena, "--cuda-arena"),
                       (ns.cuda_cudnn_search, "--cuda-cudnn-search"),
                       (ns.cuda_device_id, "--cuda-device-id")):
        if flag is not None and ns.provider != "cuda":
            print(json.dumps({"status": "error",
                              "error": f"{name} requires --provider cuda"}),
                  file=sys.stderr)
            return 1
    if ns.cuda_device_id is not None and not ns.cuda_device_id.isdigit():
        print(json.dumps({"status": "error",
                          "error": "--cuda-device-id must be a nonnegative "
                          "integer string"}),
              file=sys.stderr)
        return 1
    maps_path = Path(ns.maps_out) if ns.maps_out else None
    if maps_path is not None and maps_path.exists():
        print(json.dumps({"status": "error",
                          "error": f"refusing to overwrite {maps_path}"}),
              file=sys.stderr)
        return 1
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from rapidraw_denoise.noise import NoiseProfile
    from rapidraw_denoise.onnx_backend import (
        PRODUCTION_CUDA_PROVIDER_OPTIONS, OnnxTilePredictor)
    from rapidraw_denoise.pipeline import denoise_with_predictor

    fx = Path(ns.fixtures)
    # Native packed-RAW input + noise profile mirror the closeout bench.
    native_dir = Path(f"/tmp/nlx-native/{ns.photo}")
    req = json.load(open(native_dir / "request.json"))
    photo = np.fromfile(native_dir / "input.f32",
                        dtype="<f4").reshape(tuple(req["shape"]))
    meta = json.load(open(fx / "metadata.json"))
    profile = NoiseProfile(**meta["noise_profile"])
    with np.load(fx / "tiles/tile-00.npz", allow_pickle=False) as f:
        tile8 = np.ascontiguousarray(f["input"])[0]

    # Benchmark-only CUDA provider-option policy. X (prior default) passes
    # no extra options (ORT defaults: EXHAUSTIVE / kNextPowerOfTwo). P
    # (--prod-cuda) reproduces the Rust production policy exactly; explicit
    # --cuda-* flags override individual keys for isolated comparisons.
    cuda_provider_options = None
    cuda_policy = "prior-default"
    if ns.provider == "cuda" and (ns.prod_cuda or ns.cuda_arena is not None
                                  or ns.cuda_cudnn_search is not None
                                  or ns.cuda_device_id is not None):
        cuda_provider_options = dict(PRODUCTION_CUDA_PROVIDER_OPTIONS) \
            if ns.prod_cuda else {}
        overrides = []
        if ns.cuda_arena is not None:
            cuda_provider_options["arena_extend_strategy"] = ns.cuda_arena
            overrides.append(f"arena={ns.cuda_arena}")
        if ns.cuda_cudnn_search is not None:
            cuda_provider_options["cudnn_conv_algo_search"] = ns.cuda_cudnn_search
            overrides.append(f"cudnn={ns.cuda_cudnn_search}")
        if ns.cuda_device_id is not None:
            cuda_provider_options["device_id"] = ns.cuda_device_id
            overrides.append(f"device={ns.cuda_device_id}")
        if ns.prod_cuda and not overrides:
            cuda_policy = "production-equivalent"
        elif ns.prod_cuda:
            cuda_policy = f"production+override:{','.join(overrides)}"
        else:
            cuda_policy = f"isolated:{','.join(overrides)}"
    rep = {"bundle": ns.bundle, "fixtures": ns.fixtures,
           "provider": ns.provider,
           "optimize": ns.optimize, "io_binding": ns.io_binding,
           "use_tf32": ns.tf32, "photo": ns.photo,
           "cuda_policy": cuda_policy,
           "cuda_provider_options_requested": cuda_provider_options,
           "native_request": {"shape": list(req["shape"]),
                              "input_sha256": req.get("input_sha256"),
                              "model_sha256": req.get("model_sha256")},
           "torch_prime": ns.torch_prime,
           "torch_imported_at_start": "torch" in sys.modules,
           # Library-context label: this harness never imports torch, so
           # ORT binds only the process library resolution (system or
           # LD_LIBRARY_PATH). Contrast bench_v2.py onnx-strict, which
           # imports torch first ("torch-preloaded-for-ort").
           "library_context": "torch-free",
           "torch_preloaded_for_ort": False,
           "profiling_requested": ns.profile,
           "smi_before": smi()}
    if ns.torch_prime:
        import torch  # noqa: diagnostic path only
        torch.cuda.init()
        rep["torch_cuda_prime_alloc_B"] = torch.cuda.max_memory_allocated()
    profile_prefix = None
    if ns.profile:
        profile_dir = Path(ns.profile_dir) if ns.profile_dir else Path(tempfile.gettempdir())
        profile_dir.mkdir(parents=True, exist_ok=True)
        policy_token = {"prior-default": "pydefault",
                          "production-equivalent": "prod"}.get(
                              cuda_policy, "cust")
        tag = (f"nlx-candidate-{ns.photo}-"
               f"{'opt' if ns.optimize else 'noopt'}-"
               f"{'bind' if ns.io_binding else 'nobind'}-"
               f"{'tf32' if ns.tf32 else 'notf32'}-"
               f"{policy_token}")
        profile_prefix = str(profile_dir / tag)
    t0 = time.monotonic()
    pred = OnnxTilePredictor(ns.bundle, provider=ns.provider,
                             optimize=ns.optimize,
                             io_binding=ns.io_binding,
                             use_tf32=ns.tf32,
                             provider_options=cuda_provider_options,
                             enable_profiling=ns.profile,
                             profile_prefix=profile_prefix)
    if ns.tf32:
        rep["precision_policy"] = ("FAST_EXPERIMENTAL tf32 (not strict; "
                                   "gates must be reported separately)")
    else:
        rep["precision_policy"] = "strict-fp32"
    rep["session_init_s"] = time.monotonic() - t0
    info = pred.execution_info()
    rep["providers"] = info["provider_actual"]
    rep["provider_options_effective"] = info["provider_options_effective"]
    rep["provider_options_reported"] = info["provider_options_reported"]
    rep["fallback_disabled"] = info["fallback_disabled"]
    rep["graph_optimizations"] = info["graph_optimizations"]
    rep["io_binding"] = info["io_binding"]
    rep["profiling_enabled"] = info["profiling_enabled"]
    rep["model_sha256"] = info["model_sha256"]
    rep["sampler_implementation"] = info["sampler_implementation"]
    rep["source_checkpoint_sha256"] = info["source_checkpoint_sha256"]
    import onnxruntime as ort
    rep["onnxruntime"] = ort.__version__

    warm, meas = [], []
    for _ in range(3):
        t = time.monotonic()
        pred.predict(tile8)
        warm.append((time.monotonic() - t) * 1000)
    for _ in range(10):
        t = time.monotonic()
        pred.predict(tile8)
        meas.append((time.monotonic() - t) * 1000)
    rep["warmup_ms_ordered"] = warm
    rep["measured_ms_ordered"] = list(meas)
    rep["median_ms"] = float(np.median(meas))
    rep["median_method"] = "np.median over 10 measured tile runs"
    rep["p95_ms"] = float(np.quantile(meas, 0.95, method="linear"))
    rep["p95_method"] = "np.quantile linear interpolation over 10 measured runs"
    # Actual library binding is proven after CUDA/cuDNN late-load (first
    # warmups), before the full-photo assemblies.
    rep["ld_library_path"] = os.environ.get("LD_LIBRARY_PATH")
    rep["mapped_cuda_libraries"] = snapshot_maps()
    if maps_path is not None:
        maps_path.write_text(json.dumps(rep["mapped_cuda_libraries"],
                                        indent=2) + "\n")
        rep["maps_out"] = str(maps_path)
    if ns.profile:
        # End profiling before the full-photo assemblies: the trace then
        # covers the 3+10 tile runs only and stays tractable. Full-photo
        # timing below remains unprofiled.
        from rapidraw_denoise.profile_audit import audit_profile
        profile_path = pred.end_profiling()
        audit = audit_profile(profile_path)
        rep["profile_path"] = profile_path
        rep["profile_scope"] = "tile runs only (3 warmup + 10 measured); full-photo runs unprofiled"
        rep["profile_summary"] = audit
        print(f"profile: {profile_path} "
              f"nodes={audit['node_events']} "
              f"by_provider={audit['node_events_by_provider']}", flush=True)

    rep["full_wall_s_runs"] = []
    for r in range(ns.repeats):
        t1 = time.monotonic()
        out, _ = denoise_with_predictor(photo, pred, profile, 320, 40)
        wall = time.monotonic() - t1
        assert out.shape == photo.shape and np.isfinite(out).all()
        rep["full_wall_s_runs"].append(wall)
        print(f"run{r}: wall={wall:.1f}s", flush=True)
    rep["torch_imported_at_end"] = "torch" in sys.modules
    if not ns.torch_prime:
        assert "torch" not in sys.modules, "torch must not be imported on this path"
    rep["torch_vram_alloc_B"] = None
    rep["torch_vram_reserved_B"] = None
    rep["vram_note"] = "ORT VRAM not measured; no Torch in this process"
    rep["rss_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    rep["smi_after"] = smi()
    out_path.write_text(json.dumps(rep, indent=2) + "\n")
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
