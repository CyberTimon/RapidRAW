"""ONNX Runtime tile predictor for the exported Nonlocal reference bundle.

Loads and validates the bundle once per job and reuses one InferenceSession
across all tiles. Fail-closed validation order:

1. Bundle files present; manifest version / tile / precision / I/O contract.
2. Pinned checkpoint lineage (non-zero, pinned-match, equals the pinned SHA).
3. Bundle model hash; external-data layouts rejected.
4. Requested provider available; session constructed with that provider only;
   Run-time fallback disabled via the real ``InferenceSession.disable_fallback``
   before any inference; requested placement verified against live session
   state (never a cached list). Per-provider session options are validated
   against a known schema (CUDA ``use_tf32`` explicit; CoreML MLProgram with
   static shapes and an artifact-scoped compile cache); effective options
   are recorded alongside what the runtime reports back.
5. Actual session input/output metadata (names, shapes, ``tensor(float)``)
   cross-checked against the manifest before any inference.
6. Per call: original input dtype must already be float32 (contiguity is
   fixed, dtype is never converted), exact ``[8,320,320]`` shape, finite.
7. Per call: the complete raw session output is validated (4D, batch count
   exactly 1, float32, finite over every batch element) BEFORE batch index
   ``[0]`` is taken, so a corrupt or extra batch can never be hidden.

No retry, no alternate provider/model/CPU substitution, no Torch use. All
session-construction failures and runtime exceptions propagate unchanged.
Unknown memory readings are reported as null with an explanation, never as
Torch allocator counters.
"""
import hashlib
import json
import platform
import tempfile
from pathlib import Path

import numpy as np

from .pipeline import TilePredictor

MANIFEST_VERSION = 1
PRODUCTION_TILE = 320
# Pinned source checkpoint; the .pt file itself is never loaded here.
PINNED_CHECKPOINT_SHA256 = "c16747d852b93a95908792cdbac901f89cca98e35b91ea7db6214de42fbd3cad"
PROVIDERS = {
    "cpu": "CPUExecutionProvider",
    "cuda": "CUDAExecutionProvider",
    "coreml": "CoreMLExecutionProvider",
}
EXPECTED_INPUT_SHAPE = [1, 8, PRODUCTION_TILE, PRODUCTION_TILE]
EXPECTED_OUTPUT_SHAPE = [1, 4, PRODUCTION_TILE, PRODUCTION_TILE]
ORT_FLOAT_TENSOR = "tensor(float)"
# Validated per-provider session options. Unknown keys/values are rejected;
# effective options are always reported, never assumed active.
# device_id is free-form but must be a nonnegative integer string.
CUDA_OPTION_VALUES = {
    "use_tf32": ("0", "1"),
    "arena_extend_strategy": ("kNextPowerOfTwo", "kSameAsRequested"),
    "cudnn_conv_algo_search": ("EXHAUSTIVE", "HEURISTIC", "DEFAULT"),
    "device_id": None,
}
# Exact production Rust CUDA policy (see nonlocal_onnx.rs open_backend):
# device 0, SameAsRequested arena, Heuristic cuDNN search, TF32 off
# (TF32 is carried by use_tf32, not this dict).
PRODUCTION_CUDA_PROVIDER_OPTIONS = {
    "device_id": "0",
    "arena_extend_strategy": "kSameAsRequested",
    "cudnn_conv_algo_search": "HEURISTIC",
}
COREML_OPTION_VALUES = {
    "ModelFormat": ("MLProgram",),
    "MLComputeUnits": ("CPUAndGPU", "ALL", "CPUOnly"),
    "RequireStaticInputShapes": ("0", "1"),
    "EnableOnSubgraphs": ("0", "1"),
    "AllowLowPrecisionAccumulationOnGPU": ("0", "1"),
    "ProfileComputePlan": ("0", "1"),
    "SpecializationStrategy": ("Default", "FastPrediction"),
    "ModelCacheDirectory": None,  # free-form path, validated non-empty
}
PROVIDER_OPTION_SCHEMA = {"cuda": CUDA_OPTION_VALUES, "coreml": COREML_OPTION_VALUES}


def default_coreml_cache_dir(model_sha256, ort_version, compute_units):
    """Content-scoped CoreML compile cache (not a prediction cache).

    Keyed by model hash + ORT version + OS + compute policy, outside
    per-job temp dirs, so recompilation is reused across runs while a
    different model/policy can never hit a stale entry. CoreML EP does not
    track model content changes for all cache-key routes, hence the hash.
    """
    key = f"{model_sha256[:16]}-{ort_version}-{platform.system()}-{compute_units}"
    safe = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in key)
    return str(Path(tempfile.gettempdir()) / f"nlx-coreml-{safe}")


def validate_provider_options(provider, options):
    """Validate a provider-options mapping against the known schema."""
    schema = PROVIDER_OPTION_SCHEMA.get(provider, {})
    if options is None:
        return {}
    if not isinstance(options, dict):
        raise ValueError(f"provider_options must be a str->str mapping, got {type(options)}")
    effective = {}
    for key, value in options.items():
        if key not in schema:
            raise ValueError(
                f"Unknown {provider} provider option {key!r}; "
                f"expected one of {sorted(schema)}")
        if not isinstance(value, str) or not value:
            raise ValueError(f"Provider option {key!r} must be a non-empty string")
        allowed = schema[key]
        if allowed is not None and value not in allowed:
            raise ValueError(
                f"Provider option {key!r}={value!r} not in {list(allowed)}")
        if (provider == "cuda" and key == "device_id"
                and not value.isdigit()):
            raise ValueError(
                f"Provider option 'device_id' must be a nonnegative integer "
                f"string, got {value!r}")
        effective[key] = value
    return effective


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _meta_shape(node):
    return [int(v) for v in node.shape]


class OnnxTilePredictor(TilePredictor):
    def __init__(self, bundle, provider="cpu", use_tf32=False,
                 optimize=False, allow_diagnostic_shape=False,
                 provider_options=None, io_binding=False,
                 enable_profiling=False, profile_prefix=None):
        bundle = Path(bundle)
        model_path = bundle / "model.onnx"
        manifest_path = bundle / "manifest.json"
        if not model_path.is_file() or not manifest_path.is_file():
            raise FileNotFoundError(f"Bundle must contain model.onnx + manifest.json: {bundle}")
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("manifest_version") != MANIFEST_VERSION:
            raise ValueError(f"Unknown manifest version: {manifest.get('manifest_version')}")
        if manifest.get("diagnostic_shape") and not allow_diagnostic_shape:
            raise ValueError("Diagnostic-shape bundle rejected by the production predictor")
        tile = manifest.get("tile")
        if tile != PRODUCTION_TILE and not allow_diagnostic_shape:
            raise ValueError(f"Bundle tile {tile} != production {PRODUCTION_TILE}")
        if manifest.get("precision") != "fp32":
            raise ValueError(f"Unknown bundle precision: {manifest.get('precision')}")
        if (manifest.get("input_shape") != [1, 8, tile, tile]
                or manifest.get("output_shape") != [1, 4, tile, tile]
                or manifest.get("input_dtype") != "float32"
                or manifest.get("output_dtype") != "float32"):
            raise ValueError("Bundle I/O contract mismatch")
        lineage = manifest.get("source_checkpoint_sha256")
        if not lineage or lineage == "0" * 64:
            raise ValueError("Bundle checkpoint lineage missing or all-zero")
        if manifest.get("checkpoint_pinned_match") is not True:
            raise ValueError("Bundle checkpoint is not marked pinned-match")
        if lineage != PINNED_CHECKPOINT_SHA256:
            raise ValueError("Bundle checkpoint lineage != pinned checkpoint")
        if manifest.get("external_data"):
            raise ValueError("External-data bundle layout not supported")
        if manifest.get("model_sha256") != sha256_file(model_path):
            raise ValueError("Bundle model hash mismatch (modified graph rejected)")
        if provider not in PROVIDERS:
            raise ValueError(f"Unknown provider {provider!r}; expected one of {sorted(PROVIDERS)}")
        if use_tf32 and provider != "cuda":
            raise ValueError("use_tf32 is only meaningful with the cuda provider")
        # Pure-Python contract checks above run before touching the runtime.
        import onnxruntime as ort
        requested = PROVIDERS[provider]
        extra_options = validate_provider_options(provider, provider_options)
        if provider == "cuda":
            want_tf32 = "1" if use_tf32 else "0"
            if "use_tf32" in extra_options and extra_options["use_tf32"] != want_tf32:
                raise ValueError(
                    f"use_tf32={use_tf32} conflicts with provider_options "
                    f"use_tf32={extra_options['use_tf32']}")
            effective_options = {"use_tf32": want_tf32, **extra_options}
        elif provider == "coreml":
            compute_units = extra_options.get("MLComputeUnits", "CPUAndGPU")
            effective_options = {
                "ModelFormat": "MLProgram",
                "MLComputeUnits": compute_units,
                "RequireStaticInputShapes": "1",
                "EnableOnSubgraphs": "0",
                "AllowLowPrecisionAccumulationOnGPU": "0",
                **extra_options,
            }
            if "ModelCacheDirectory" not in effective_options:
                effective_options["ModelCacheDirectory"] = default_coreml_cache_dir(
                    manifest.get("model_sha256", ""), ort.__version__,
                    effective_options["MLComputeUnits"])
        else:
            if extra_options:
                raise ValueError(
                    f"No provider options supported for {provider!r}; got {extra_options}")
            effective_options = None
        available = ort.get_available_providers()
        if requested not in available:
            raise RuntimeError(
                f"Requested provider {requested} unavailable (available: {available}); "
                "refusing silent fallback"
            )
        if not isinstance(enable_profiling, bool):
            raise ValueError("enable_profiling must be a bool")
        if profile_prefix is not None and not enable_profiling:
            raise ValueError("profile_prefix requires enable_profiling=True")
        if profile_prefix is not None and not str(profile_prefix):
            raise ValueError("profile_prefix must be a non-empty path when given")
        options = ort.SessionOptions()
        if not optimize:
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        # Benchmark-only ORT profiling: opt-in, off by default. Enabling
        # profiling must not change inference numerics; it only records a
        # per-node timing trace retrievable via end_profiling().
        if enable_profiling:
            options.enable_profiling = True
            if profile_prefix is not None:
                options.profile_file_prefix = str(profile_prefix)
        session_kwargs = {"sess_options": options, "providers": [requested]}
        if effective_options is not None:
            session_kwargs["provider_options"] = [effective_options]
        session = ort.InferenceSession(str(model_path), **session_kwargs)
        disable = getattr(session, "disable_fallback", None)
        if disable is None:
            raise RuntimeError(
                "ORT session lacks disable_fallback(); refusing to run without "
                "an explicit no-retry guarantee"
            )
        disable()
        self.fallback_disabled = True
        live_providers = session.get_providers()
        if requested not in live_providers:
            raise RuntimeError(
                f"Session did not take requested provider {requested} "
                f"(actual: {live_providers})"
            )
        # Cross-check actual runtime metadata against the manifest contract.
        inputs = session.get_inputs()
        outputs = session.get_outputs()
        if (len(inputs) != 1 or inputs[0].name != manifest["input_name"]
                or _meta_shape(inputs[0]) != manifest["input_shape"]
                or inputs[0].type != ORT_FLOAT_TENSOR):
            raise ValueError(
                f"Session input metadata {[ (i.name, _meta_shape(i), i.type) for i in inputs ]} "
                f"!= manifest contract ({manifest['input_name']}, "
                f"{manifest['input_shape']}, {ORT_FLOAT_TENSOR})"
            )
        if (len(outputs) != 1 or outputs[0].name != manifest["output_name"]
                or _meta_shape(outputs[0]) != manifest["output_shape"]
                or outputs[0].type != ORT_FLOAT_TENSOR):
            raise ValueError(
                f"Session output metadata {[ (o.name, _meta_shape(o), o.type) for o in outputs ]} "
                f"!= manifest contract ({manifest['output_name']}, "
                f"{manifest['output_shape']}, {ORT_FLOAT_TENSOR})"
            )
        self.session = session
        self.input_name = manifest["input_name"]
        self.output_name = manifest["output_name"]
        self.provider_key = provider
        self.provider_requested = requested
        self.provider_options_effective = effective_options
        # What ORT reports back (may be absent on older builds; recorded
        # as-is, never assumed active from the request alone).
        get_opts = getattr(session, "get_provider_options", None)
        try:
            self.provider_options_reported = get_opts() if get_opts else None
        except Exception:
            self.provider_options_reported = None
        self.manifest = manifest
        self.bundle = str(bundle)
        self.ort_version = ort.__version__
        self.use_tf32 = bool(use_tf32) if provider == "cuda" else False
        self.optimize = bool(optimize)
        self.tile = int(tile)
        self.session_input_meta = {
            "name": inputs[0].name, "shape": _meta_shape(inputs[0]),
            "type": inputs[0].type}
        self.session_output_meta = {
            "name": outputs[0].name, "shape": _meta_shape(outputs[0]),
            "type": outputs[0].type}
        # Optional I/O binding path (CUDA only): preallocated device buffers
        # reused across tiles/passes. NumPy-in/NumPy-out semantics and the
        # complete output validation below are unchanged.
        if io_binding and provider != "cuda":
            raise ValueError("io_binding is only supported with the cuda provider")
        self.io_binding = bool(io_binding)
        self._bound_input = None
        self._bound_output = None
        if self.io_binding:
            self._bind_buffers(ort)
        # Profiling state is benchmark-only and off by default; the profile
        # file is materialized only when end_profiling() is called.
        self.profiling_enabled = bool(enable_profiling)
        self.profile_prefix = (str(profile_prefix)
                               if profile_prefix is not None else None)
        self._profile_path = None

    def _live_providers(self):
        # Never trust a cached list: placement is re-read from the session.
        return list(self.session.get_providers())

    def end_profiling(self):
        """Materialize the ORT profiling trace for this benchmark session.

        Benchmark-only and opt-in: raises unless the predictor was
        constructed with enable_profiling=True. Returns the trace path as a
        string and records it for execution_info(). The trace contains
        per-node host-observed operator durations with provider tags; it
        must not be treated as device-only CUDA kernel times (device timing
        requires CUPTI/Nsight). Do not subtract summed Node durations from
        wall time as measured overhead.
        """
        if not self.profiling_enabled:
            raise RuntimeError("profiling was not enabled for this session")
        end = getattr(self.session, "end_profiling", None)
        if end is None:
            raise RuntimeError("ORT session lacks end_profiling()")
        path = str(end())
        self._profile_path = path
        return path

    def _bind_buffers(self, ort):
        self._bound_input = ort.OrtValue.ortvalue_from_shape_and_type(
            [1, 8, self.tile, self.tile], np.float32, "cuda", 0)
        self._bound_output = ort.OrtValue.ortvalue_from_shape_and_type(
            [1, 4, self.tile, self.tile], np.float32, "cuda", 0)
        self._binding = self.session.io_binding()
        self._binding.bind_input(
            self.input_name, "cuda", 0, np.float32,
            [1, 8, self.tile, self.tile], self._bound_input.data_ptr())
        self._binding.bind_output(
            self.output_name, "cuda", 0, np.float32,
            [1, 4, self.tile, self.tile], self._bound_output.data_ptr())

    def _run_bound(self, tile):
        # Reused device buffers; stable addresses across calls.
        self._bound_input.update_inplace(tile[None])
        self.session.run_with_iobinding(self._binding)
        return self._binding.copy_outputs_to_cpu()[0]

    def predict(self, tile_array):
        arr = np.asarray(tile_array)
        if arr.dtype != np.dtype("float32"):
            raise ValueError(
                f"ONNX predictor requires original float32 input, got {arr.dtype}; "
                "refusing dtype conversion")
        if arr.ndim != 3 or arr.shape != (8, self.tile, self.tile):
            raise ValueError(
                f"ONNX predictor requires [8,{self.tile},{self.tile}], got {arr.shape}")
        tile = np.ascontiguousarray(arr)  # layout only; dtype already float32
        if not np.isfinite(tile).all():
            raise ValueError("Nonfinite ONNX model input")
        live = self._live_providers()
        if self.provider_requested not in live:
            raise RuntimeError(
                f"Session providers changed since construction (now: {live}); "
                "refusing to run under an unapproved placement"
            )
        raw = (self._run_bound(tile) if self.io_binding
               else self.session.run([self.output_name],
                                     {self.input_name: tile[None]})[0])
        live_after = self._live_providers()
        if self.provider_requested not in live_after:
            raise RuntimeError(
                f"Session providers changed during inference (now: {live_after}); "
                "discarding the output rather than mislabelling placement"
            )
        # Validate the COMPLETE raw output before selecting batch 0: an extra
        # batch, a wrong dtype, or a non-finite anywhere must fail loudly,
        # even if batch 0 alone looks valid.
        if not isinstance(raw, np.ndarray):
            raise ValueError(f"Session returned non-array output: {type(raw)}")
        if raw.ndim != 4 or raw.shape[0] != 1:
            raise ValueError(
                f"Session output must be 4D with batch 1, got shape {raw.shape}")
        if raw.dtype != np.dtype("float32"):
            raise ValueError(
                f"Session output must be float32, got {raw.dtype}; "
                "refusing dtype conversion")
        if raw.shape[1:] != (4, self.tile, self.tile):
            raise ValueError(f"Session output shape {raw.shape} != [1,4,{self.tile},{self.tile}]")
        if not np.isfinite(raw).all():
            raise ValueError("Non-finite values in session output (all batches checked)")
        return np.array(raw[0], copy=True)

    def execution_info(self):
        return {"runtime": "onnx",
                "provider_requested": self.provider_requested,
                "provider_actual": self._live_providers(),
                "provider_options_effective": self.provider_options_effective,
                "provider_options_reported": self.provider_options_reported,
                "fallback_disabled": self.fallback_disabled,
                "io_binding": self.io_binding,
                "profiling_enabled": self.profiling_enabled,
                "profile_prefix": self.profile_prefix,
                "profile_path": self._profile_path,
                "session_input": self.session_input_meta,
                "session_output": self.session_output_meta,
                "shape_policy": "diagnostic-labelled"
                if self.tile != PRODUCTION_TILE else "production-320",
                "graph_optimizations": "enabled" if self.optimize else "disabled",
                "use_tf32": self.use_tf32,
                "onnxruntime": self.ort_version,
                "artifact": self.manifest.get("model_file"),
                "model_sha256": self.manifest.get("model_sha256"),
                "source_checkpoint_sha256": self.manifest.get("source_checkpoint_sha256"),
                "checkpoint_pinned_match": self.manifest.get("checkpoint_pinned_match"),
                "sampler_implementation": self.manifest.get("sampler_implementation"),
                "parameters": None,
                "peak_tensor_vram_bytes": None,
                "peak_tensor_vram_note": "ORT VRAM not measured; Torch allocator counters do not apply",
                "peak_reserved_vram_bytes": None}
