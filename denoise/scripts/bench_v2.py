"""Single-backend packed-RAW benchmark (one process, fixed env, no mutation).

Usage: bench_v2.py {onnx-cuda,torch-native,torch-native-tf32off,torch-ref,
                    onnx-strict,torch-default,torch-orig,torch-strict,
                    torch-packed,torch-refstrict}
       [--repeats N]
       [--bundle DIR] [--fixtures DIR] [--photo NAME] [--ckpt PATH]
       [--out PATH]

Legacy backends (onnx-cuda, torch-native, torch-native-tf32off, torch-ref)
keep their historical meanings, paths and defaults exactly; only the
hard-coded paths grew optional CLI overrides with identical defaults.

New reproducible modes (one fresh process per mode, same portrait
[4,2327,3491] workload, same 320/40 path):
- onnx-strict: ONNX production provider policy (packed bundle, graph opt
  off, device 0, SameAsRequested, HEURISTIC, TF32 off, no fallback) in a
  TORCH-PRELOADED library context (torch is imported before ORT session
  construction, so ORT may bind PyTorch's CUDA/cuDNN libraries; see
  library_context in the report). This is NOT a fully
  native-runtime-equivalent baseline: the clean Python
  deployment-equivalent comparator is bench_candidate.py --prod-cuda,
  which never imports torch. torch.cuda.is_initialized() staying false
  does not imply an unchanged library environment.
- torch-default (T_DEFAULT): PyTorch eager + compiled native sampler with
  the process's UNMODIFIED TF32 defaults (recorded before any mutation).
- torch-orig (T_ORIG): native sampler, historical flags matmul TF32=false,
  cuDNN TF32=true explicitly set.
- torch-strict (T_STRICT): native sampler, both TF32 paths off.
- torch-packed (T_PACKED): static-packed-v1 sampler rebound explicitly
  in-process (both vendor.sampling and vendor.network entry points), both
  TF32 paths off. Never mutates source/default runtime behavior.
- torch-refstrict (T_REF): reference sampler rebound explicitly
  in-process, both TF32 paths off. Tile section always runs; the full
  photo run is skipped with a labeled reason when the tile median is prohibitive.

Sampler identity is proven behaviorally (native must differ from the
reference loop bitwise; reference must reproduce it bitwise; packed reports
its equality explicitly) plus invocation counters and binding records
(module/qualname, extension path, sampler version). Sampler identity is
never inferred from an environment string alone.

Env (set at launch, NEVER mutated in-process for legacy modes; new torch
modes set TF32 flags explicitly in-process once, except torch-default
which records without mutating): RAPIDRAW_DENOISE_SAMPLER, TF32 flags.

Records env snapshot + two-sided behavioral sampler probe with invocation
counters (reference binding must reproduce the reference loop bitwise;
native binding must differ from it; missing ext fails loud). Saves ordered
warm-up + measured samples (median = np.median; P95 = np.quantile linear,
both documented), session init separately, full-assembly NumPy-in ->
NumPy-out walls (3 repeats by default), and
scoped memory notes (Torch allocator counters on torch runs only; ORT VRAM
recorded null, never as Torch counters).
"""
import argparse
import hashlib
import json
import os
import resource
import subprocess
import sys
import time

import numpy as np

LEGACY_BACKENDS = ("onnx-cuda", "torch-native",
                   "torch-native-tf32off", "torch-ref")
NEW_BACKENDS = ("onnx-strict", "torch-default", "torch-orig",
                "torch-strict", "torch-packed", "torch-refstrict")

# New-mode TF32 plan: (action, matmul_allow, cudnn_allow).
TORCH_TF32_PLAN = {
    "torch-default": ("record-only", None, None),
    "torch-orig": ("set", False, True),
    "torch-strict": ("set", False, False),
    "torch-packed": ("set", False, False),
    "torch-refstrict": ("set", False, False),
}

# New-mode sampler binding: which implementation is rebound in-process.
SAMPLER_BINDING = {
    "torch-default": "native",
    "torch-orig": "native",
    "torch-strict": "native",
    "torch-packed": "packed",
    "torch-refstrict": "reference",
}

# torch-refstrict skips its full-photo run above this tile-median threshold.
REFSTRICT_TILE_SKIP_MS = 1500.0


def ort_library_context(backend, torch_imported):
    """Pure helper: ORT library-context label for a benchmark report.

    bench_v2 imports torch before ORT session construction, so its
    onnx-strict mode runs with PyTorch's CUDA/cuDNN libraries preloaded
    for ORT to bind. torch.cuda.is_initialized() staying false does not
    imply an unchanged library environment (upstream ORT documents this
    preload effect). The clean deployment-equivalent comparator is
    bench_candidate.py --prod-cuda, which never imports torch.
    """
    if backend == "onnx-strict" and torch_imported:
        return "torch-preloaded-for-ort"
    if backend == "onnx-strict":
        return "torch-free"
    return "n/a-torch-mode"


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


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def torch_tf32_plan(backend):
    """Pure helper: TF32 action for a new torch mode (testable, no torch)."""
    if backend not in TORCH_TF32_PLAN:
        raise ValueError(f"not a new torch mode: {backend!r}")
    return TORCH_TF32_PLAN[backend]


def expected_probe_equal(binding):
    """Pure helper: probe equality expectation per sampler binding.

    Native must differ from the reference loop (False); reference must
    reproduce it (True); packed reports its measured value (None here —
    numerical identity is verified against the fixture gate instead).
    """
    if binding == "native":
        return False
    if binding == "reference":
        return True
    if binding == "packed":
        return None
    raise ValueError(f"unknown sampler binding: {binding!r}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("backend", choices=LEGACY_BACKENDS + NEW_BACKENDS)
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--bundle", default=None,
                    help="ONNX bundle dir (default: packed for onnx-strict, "
                    "pinned legacy otherwise)")
    ap.add_argument("--fixtures", default="/tmp/nlx-fixtures",
                    help="Fixture root (default: /tmp/nlx-fixtures)")
    ap.add_argument("--photo", default="portrait")
    ap.add_argument("--ckpt", default="/mnt/data/rapidraw/denoise-research/"
                    "models/nonlocal-raw-weights.pt")
    ap.add_argument("--out", default=None,
                    help="Report path (default: /tmp/nlx-bench-v2-BACKEND.json)")
    ns = ap.parse_args()
    backend = ns.backend
    if backend in NEW_BACKENDS and ns.repeats < 0:
        print(json.dumps({"status": "error",
                          "error": "--repeats must be >= 0"}),
              file=sys.stderr)
        return 1

    import torch  # noqa: F401  (required by pipeline/noise; onnx path never calls it)
    from rapidraw_denoise.noise import NoiseProfile
    from rapidraw_denoise.pipeline import denoise_with_predictor

    fx_root = ns.fixtures
    if backend == "onnx-strict":
        bundle = ns.bundle or "/tmp/nlx-model/bundle-packed-320-fp32"
    elif backend == "onnx-cuda":
        bundle = ns.bundle or "/tmp/nlx-model/bundle-pinned-320-fp32"
    else:
        bundle = ns.bundle
    out_name = ns.out or f"/tmp/nlx-bench-v2-{backend}.json"
    if os.path.exists(out_name):
        print(json.dumps({"status": "error",
                          "error": f"refusing to overwrite {out_name}"}),
              file=sys.stderr)
        return 1

    if backend in NEW_BACKENDS:
        return run_new_mode(ns, out_name, bundle, fx_root)

    if backend in ("torch-ref", "torch-native-tf32off"):
        # Controlled/equal-precision configuration, applied once before load.
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
    env_snapshot = {
        "RAPIDRAW_DENOISE_SAMPLER": os.environ.get("RAPIDRAW_DENOISE_SAMPLER"),
        "cuda_matmul_tf32": torch.backends.cuda.matmul.allow_tf32,
        "cudnn_tf32": torch.backends.cudnn.allow_tf32,
        "torch": torch.__version__,
    }
    rep = {"backend": backend, "env_snapshot": env_snapshot,
           "bundle": bundle, "fixtures": fx_root, "photo": ns.photo,
           "ckpt": ns.ckpt if backend != "onnx-cuda" else None,
           "smi_before": smi()}

    request = json.load(open(f"/tmp/nlx-native/{ns.photo}/request.json"))
    portrait = np.fromfile(f"/tmp/nlx-native/{ns.photo}/input.f32",
                           dtype="<f4").reshape(tuple(request["shape"]))
    meta = json.load(
        open(f"{fx_root}/{ns.photo}-controlled-fp32/metadata.json"))
    profile = NoiseProfile(**meta["noise_profile"])
    with np.load(f"{fx_root}/{ns.photo}-controlled-fp32/tiles/tile-00.npz",
                 allow_pickle=False) as f:
        tile8 = np.ascontiguousarray(f["input"])[0]

    if backend == "onnx-cuda":
        from rapidraw_denoise.onnx_backend import OnnxTilePredictor
        import onnxruntime as ort
        rep["onnxruntime"] = ort.__version__
        t0 = time.monotonic()
        pred = OnnxTilePredictor(bundle, provider="cuda")
        rep["session_init_s"] = time.monotonic() - t0
        info = pred.execution_info()
        rep["providers"] = info["provider_actual"]
        rep["fallback_disabled"] = info["fallback_disabled"]
        rep["sampler_probe"] = "n/a (ONNX graph; reference-sampler export)"
    else:
        from rapidraw_denoise.inference import TorchTilePredictor, load_model
        from rapidraw_denoise.vendor.nonlocalmf import sampling as sampling_mod
        # Two-sided behavioral probe with invocation counters BEFORE timed runs.
        calls = {"deform": 0, "reference": 0}
        orig_deform = sampling_mod.deform_neighbourhood
        orig_ref = sampling_mod.reference_sampling

        def counting_deform(*a, **k):
            calls["deform"] += 1
            return orig_deform(*a, **k)

        def counting_ref(*a, **k):
            calls["reference"] += 1
            return orig_ref(*a, **k)

        sampling_mod.deform_neighbourhood = counting_deform
        sampling_mod.reference_sampling = counting_ref
        try:
            torch.manual_seed(123)
            px = torch.randn(1, 2, 9, 11).to("cuda")
            po = torch.randn(1, 18, 9, 11).to("cuda") * 0.3
            try:
                got = sampling_mod.deform_neighbourhood(
                    px, po, neighbourhood_size=(3, 3), stride=1, padding=(1, 1),
                    dilation=1, offset_groups=1)
            except ModuleNotFoundError as exc:
                rep["sampler_probe"] = f"EXT-MISSING-FAIL: {exc}"
                raise
            want = sampling_mod.reference_sampling(px, po, (3, 3), padding=(1, 1))
            equal = bool(torch.equal(got, want))
        finally:
            sampling_mod.deform_neighbourhood = orig_deform
            sampling_mod.reference_sampling = orig_ref
        rep["sampler_probe_calls"] = calls
        # Mechanism corroboration: in reference mode deform_neighbourhood
        # delegates to reference_sampling internally (2 counted reference
        # calls: delegated + explicit probe); in native mode the only
        # reference call is the explicit probe (deform took the ext path).
        expected_ref_calls = {"torch-native": 1, "torch-native-tf32off": 1,
                              "torch-ref": 2}[backend]
        assert calls["deform"] >= 1 and calls["reference"] == expected_ref_calls, calls
        rep["sampler_probe_bitwise_equal_to_reference"] = equal
        expected_equal = {"torch-native": False, "torch-native-tf32off": False,
                          "torch-ref": True}[backend]
        rep["sampler_probe"] = ("reference-binding" if equal
                                else "native-ext-binding")
        assert equal == expected_equal, rep["sampler_probe"]
        t0 = time.monotonic()
        model = load_model(ns.ckpt, device="cuda")
        rep["model_load_s"] = time.monotonic() - t0
        pred = TorchTilePredictor(model)

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
    if backend == "onnx-cuda":
        rep["torch_vram_alloc_B"] = None
        rep["torch_vram_reserved_B"] = None
        rep["vram_note"] = ("ORT VRAM not measured; Torch allocator counters "
                            "do not apply to the ONNX path")
    else:
        rep["torch_vram_alloc_B"] = torch.cuda.max_memory_allocated()
        rep["torch_vram_reserved_B"] = torch.cuda.max_memory_reserved()
    rep["rss_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024

    rep["full_wall_s_runs"] = []
    for r in range(ns.repeats):
        t1 = time.monotonic()
        out, _ = denoise_with_predictor(portrait, pred, profile, 320, 40)
        wall = time.monotonic() - t1
        assert out.shape == portrait.shape and np.isfinite(out).all()
        rep["full_wall_s_runs"].append(wall)
        print(f"{backend} run{r}: wall={wall:.1f}s", flush=True)
    rep["smi_after"] = smi()
    with open(out_name, "w") as f:
        json.dump(rep, f, indent=2)
    print(f"wrote {out_name}")
    return 0


def run_new_mode(ns, out_name, bundle, fx_root):
    """Reproducible torch/onnx-strict matrix modes (see module docstring)."""
    import torch
    from rapidraw_denoise.noise import NoiseProfile
    from rapidraw_denoise.pipeline import denoise_with_predictor

    backend = ns.backend
    # TF32 process defaults are captured BEFORE any mutation so T_DEFAULT
    # can be proven equal (or not) to the historical T_ORIG flags.
    tf32_before = {
        "matmul_allow_tf32": bool(torch.backends.cuda.matmul.allow_tf32),
        "cudnn_allow_tf32": bool(torch.backends.cudnn.allow_tf32),
    }
    cudnn_extra_before = {
        "cudnn_benchmark": bool(torch.backends.cudnn.benchmark),
        "cudnn_deterministic": bool(torch.backends.cudnn.deterministic),
    }
    action, want_matmul, want_cudnn = torch_tf32_plan(backend) \
        if backend != "onnx-strict" else ("none", None, None)
    if action == "set":
        torch.backends.cuda.matmul.allow_tf32 = want_matmul
        torch.backends.cudnn.allow_tf32 = want_cudnn
    tf32_effective = {
        "matmul_allow_tf32": bool(torch.backends.cuda.matmul.allow_tf32),
        "cudnn_allow_tf32": bool(torch.backends.cudnn.allow_tf32),
    }

    native_dir = f"/tmp/nlx-native/{ns.photo}"
    req = json.load(open(f"{native_dir}/request.json"))
    photo = np.fromfile(f"{native_dir}/input.f32",
                        dtype="<f4").reshape(tuple(req["shape"]))
    fx = f"{fx_root}/{ns.photo}-controlled-fp32"
    meta = json.load(open(f"{fx}/metadata.json"))
    profile = NoiseProfile(**meta["noise_profile"])
    with np.load(f"{fx}/tiles/tile-00.npz", allow_pickle=False) as f:
        tile8 = np.ascontiguousarray(f["input"])[0]
        tile00_ref = np.ascontiguousarray(f["output"])[0]

    rep = {"backend": backend,
           "bundle": bundle, "fixtures": fx, "photo": ns.photo,
           "ckpt": ns.ckpt,
           "native_request": {"shape": list(req["shape"]),
                              "input_sha256": req.get("input_sha256"),
                              "model_sha256": req.get("model_sha256"),
                              "source_sha256": req.get("source_sha256")},
           "torch_version": torch.__version__,
           "torch_cuda_version": torch.version.cuda,
           # GPU name is filled after inference on the onnx-strict path:
           # get_device_name() would initialize a Torch CUDA context, and
           # the onnx-strict proof requires none exists before inference.
           "torch_cuda_device": torch.cuda.get_device_name(0)
           if (torch.cuda.is_available() and backend != "onnx-strict")
           else None,
           "tf32_process_defaults": tf32_before,
           "cudnn_flags_before": cudnn_extra_before,
           "tf32_effective": tf32_effective,
           "cudnn_benchmark": bool(torch.backends.cudnn.benchmark),
           "cudnn_deterministic": bool(torch.backends.cudnn.deterministic),
           "sampler_env": os.environ.get("RAPIDRAW_DENOISE_SAMPLER"),
           "torch_imported_at_start": "torch" in sys.modules,
           "smi_before": smi()}

    if backend == "onnx-strict":
        from rapidraw_denoise.onnx_backend import (
            PRODUCTION_CUDA_PROVIDER_OPTIONS, OnnxTilePredictor)
        import onnxruntime as ort
        rep["onnxruntime"] = ort.__version__
        rep["precision_policy"] = "strict-fp32"
        rep["cuda_policy"] = "production-equivalent"
        rep["library_context"] = ort_library_context(
            backend, "torch" in sys.modules)
        rep["torch_preloaded_for_ort"] = \
            rep["library_context"] == "torch-preloaded-for-ort"
        rep["cuda_provider_options_requested"] = dict(
            PRODUCTION_CUDA_PROVIDER_OPTIONS)
        rep["torch_cuda_initialized_before_inference"] = \
            torch.cuda.is_initialized()
        assert not torch.cuda.is_initialized(), \
            "torch must not initialize CUDA before onnx-strict inference"
        t0 = time.monotonic()
        pred = OnnxTilePredictor(bundle, provider="cuda", optimize=False,
                                 io_binding=False, use_tf32=False,
                                 provider_options=dict(
                                     PRODUCTION_CUDA_PROVIDER_OPTIONS))
        rep["session_init_s"] = time.monotonic() - t0
        info = pred.execution_info()
        rep["providers"] = info["provider_actual"]
        rep["provider_options_effective"] = info["provider_options_effective"]
        rep["provider_options_reported"] = info["provider_options_reported"]
        rep["fallback_disabled"] = info["fallback_disabled"]
        rep["graph_optimizations"] = info["graph_optimizations"]
        rep["model_sha256"] = info["model_sha256"]
        rep["sampler_implementation"] = info["sampler_implementation"]
        sampler_evidence = {"binding": "onnx-graph-static-packed",
                            "note": "sampler is baked into the accepted graph"}
    else:
        from rapidraw_denoise.inference import TorchTilePredictor, load_model
        from rapidraw_denoise.vendor.nonlocalmf import sampling as sampling_mod
        from rapidraw_denoise.vendor.nonlocalmf import network as network_mod
        binding = SAMPLER_BINDING[backend]
        rep["ckpt_sha256"] = sha256_file(ns.ckpt)
        # Explicit in-process sampler binding (both entry points: the model
        # calls network.deform_neighbourhood, bound at import time, while
        # external callers use sampling.deform_neighbourhood).
        if binding == "native":
            try:
                from deform_neighbourhood_sampling.ops import (
                    deform_neighbourhood as native_fn)
            except ModuleNotFoundError as exc:
                print(json.dumps(
                    {"status": "error",
                     "error": f"compiled native sampler absent: {exc}"}),
                    file=sys.stderr)
                return 2
            target = native_fn
            target_id = {"module": getattr(native_fn, "__module__", None),
                         "qualname": getattr(native_fn, "__qualname__", None),
                         "ext_file": getattr(
                             sys.modules.get("deform_neighbourhood_sampling.ops"),
                             "__file__", None)}
        elif binding == "packed":
            from rapidraw_denoise.static_packed_sampler import (
                SAMPLER_VERSION, packed_deform_neighbourhood)
            target = packed_deform_neighbourhood
            target_id = {"module": target.__module__,
                         "qualname": target.__qualname__,
                         "sampler_version": SAMPLER_VERSION}
        elif binding == "reference":
            target = sampling_mod.reference_sampling
            target_id = {"module": target.__module__,
                         "qualname": target.__qualname__}
        else:  # pragma: no cover
            raise ValueError(f"unknown binding {binding!r}")
        calls = {"deform": 0}
        orig_network = network_mod.deform_neighbourhood
        orig_sampling = sampling_mod.deform_neighbourhood

        def counting(*a, **k):
            calls["deform"] += 1
            return target(*a, **k)

        network_mod.deform_neighbourhood = counting
        sampling_mod.deform_neighbourhood = counting
        try:
            # Behavioral probe BEFORE timed runs.
            torch.manual_seed(123)
            px = torch.randn(1, 2, 9, 11).to("cuda")
            po = torch.randn(1, 18, 9, 11).to("cuda") * 0.3
            probe_calls_before = calls["deform"]
            got = network_mod.deform_neighbourhood(
                px, po, neighbourhood_size=(3, 3), stride=1, padding=(1, 1),
                dilation=1, offset_groups=1)
            want = sampling_mod.reference_sampling(
                px, po, (3, 3), padding=(1, 1))
            equal = bool(torch.equal(got, want))
            rep["sampler_probe_calls"] = {
                "deform_during_probe": calls["deform"] - probe_calls_before,
            }
            rep["sampler_probe_bitwise_equal_to_reference"] = equal
            rep["sampler_binding_expected_equal"] = expected_probe_equal(
                binding)
            if binding in ("native", "reference"):
                assert equal == expected_probe_equal(binding), (
                    f"{binding} probe equality {equal}")
            rep["sampler_probe"] = (
                f"{binding}-binding-bitwise-equal"
                if equal else f"{binding}-binding-differs")
            t0 = time.monotonic()
            model = load_model(ns.ckpt, device="cuda")
            rep["model_load_s"] = time.monotonic() - t0
            pred = TorchTilePredictor(model)
            sampler_evidence = {"binding": binding, "bound_to": target_id,
                                "env_at_launch": rep["sampler_env"]}
            # Packed pre-check: tile-00 must reproduce the fixture under the
            # strict gate before its timings are used.
            if binding == "packed":
                pre = pred.predict(tile8).astype(np.float64)
                err = np.abs(pre - tile00_ref.astype(np.float64))
                rep["packed_precheck"] = {
                    "max_abs": float(err.max()),
                    "mae": float(err.mean())}
                assert float(err.max()) <= 1e-4, rep["packed_precheck"]
        except BaseException:
            network_mod.deform_neighbourhood = orig_network
            sampling_mod.deform_neighbourhood = orig_sampling
            raise
        rep["sampler_binding_evidence"] = sampler_evidence

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
    # Tile-00 output hash supports T_DEFAULT-vs-T_ORIG equality without
    # extra full-photo work.
    rep["tile00_sha256"] = hashlib.sha256(
        np.ascontiguousarray(pred.predict(tile8)).tobytes()).hexdigest()
    if backend == "onnx-strict":
        # GPU identity is read here, AFTER inference, so this call is the
        # first thing that may initialize a Torch CUDA context on this path.
        rep["torch_cuda_device"] = torch.cuda.get_device_name(0) \
            if torch.cuda.is_available() else None
        rep["torch_cuda_initialized_at_end"] = torch.cuda.is_initialized()
        rep["torch_vram_alloc_B"] = None
        rep["torch_vram_reserved_B"] = None
        rep["vram_note"] = ("ORT VRAM not measured; Torch allocator "
                            "counters do not apply to the ONNX path")
    else:
        rep["deform_calls_during_timing"] = calls["deform"]
        rep["torch_vram_alloc_B"] = torch.cuda.max_memory_allocated()
        rep["torch_vram_reserved_B"] = torch.cuda.max_memory_reserved()
    rep["rss_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024

    rep["full_wall_s_runs"] = []
    if backend == "torch-refstrict" and float(np.median(meas)) > \
            REFSTRICT_TILE_SKIP_MS:
        rep["full_skipped"] = (
            f"tile median {float(np.median(meas)):.0f} ms exceeds "
            f"{REFSTRICT_TILE_SKIP_MS:.0f} ms; tile-only comparison")
    else:
        for r in range(ns.repeats):
            t1 = time.monotonic()
            out, _ = denoise_with_predictor(photo, pred, profile,
                                            320, 40)
            wall = time.monotonic() - t1
            assert out.shape == photo.shape and np.isfinite(out).all()
            rep["full_wall_s_runs"].append(wall)
            print(f"{backend} run{r}: wall={wall:.1f}s", flush=True)
    if backend != "onnx-strict":
        network_mod.deform_neighbourhood = orig_network
        sampling_mod.deform_neighbourhood = orig_sampling
        rep["sampler_restored"] = True
    rep["torch_imported_at_end"] = "torch" in sys.modules
    rep["smi_after"] = smi()
    with open(out_name, "w") as f:
        json.dump(rep, f, indent=2)
    print(f"wrote {out_name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
