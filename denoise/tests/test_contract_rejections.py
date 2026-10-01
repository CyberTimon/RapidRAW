"""Negative contract tests for the ONNX validation boundary.

Fake-session adapter tests exercise CONTROL FLOW ONLY (rejection branches,
validation order, telemetry truthfulness) with an explicitly simulated ORT
session. They are not hardware, placement, or denoising evidence. Real-model
parity lives in the parity reports; the 15-test metric suite covers the
shared numerical policy.

Every negative test asserts the INTENDED branch was reached:
- pre-inference rejections assert the fake session never ran (``runs == 0``);
- output-validation rejections assert inference ran exactly once, then failed;
- construction rejections assert on the error message domain (lineage /
  metadata / provider / hash), never on an earlier missing-file check.
"""
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from rapidraw_denoise import onnx_backend as backend_mod
from rapidraw_denoise.metrics import full_metrics

PINNED = backend_mod.PINNED_CHECKPOINT_SHA256
TILE = backend_mod.PRODUCTION_TILE


# --------------------------------------------------------------------------
# Fake ORT session (control flow only, no inference)


class FakeSession:
    """Simulated ORT session with programmable shape/dtype/poisoning."""

    shape = (1, 4, TILE, TILE)
    dtype = np.float32
    first_nan = False
    second_nan = False
    switch_cpu = False
    in_name = "raw_with_noise"
    in_shape = [1, 8, TILE, TILE]
    in_type = "tensor(float)"
    out_name = "denoised_raw"
    out_shape = [1, 4, TILE, TILE]
    out_type = "tensor(float)"

    def __init__(self, *args, **kwargs):
        self.providers = list(kwargs["providers"])
        self.fallback_disabled = False
        self.runs = 0
        self.last_input_dtype = None

    def get_providers(self):
        return list(self.providers)

    def disable_fallback(self):
        self.fallback_disabled = True

    def get_inputs(self):
        return [SimpleNamespace(name=self.in_name, shape=list(self.in_shape),
                                type=self.in_type)]

    def get_outputs(self):
        return [SimpleNamespace(name=self.out_name, shape=list(self.out_shape),
                                type=self.out_type)]

    def run(self, names, feed):
        self.runs += 1
        self.last_input_dtype = str(next(iter(feed.values())).dtype)
        if self.switch_cpu:
            self.providers = ["CPUExecutionProvider"]
        y = np.zeros(self.shape, dtype=self.dtype)
        if self.first_nan:
            y[0] = np.nan
        if self.second_nan and y.shape[0] > 1:
            y[1] = np.nan
        return [y]


class WrongMetadataSession(FakeSession):
    in_name = "WRONG"
    in_shape = [1, 3, 16, 16]
    in_type = "tensor(double)"
    out_name = "WRONG"
    out_shape = [2, 4, TILE, TILE]
    out_type = "tensor(double)"


def install_fake_ort(monkeypatch, session_cls=FakeSession):
    fake = types.ModuleType("onnxruntime")
    fake.__version__ = "FAKE_NO_INFERENCE"
    fake.get_available_providers = lambda: ["CPUExecutionProvider",
                                            "CUDAExecutionProvider",
                                            "CoreMLExecutionProvider"]
    fake.SessionOptions = type("SessionOptions", (), {})
    fake.GraphOptimizationLevel = types.SimpleNamespace(ORT_DISABLE_ALL=0)
    fake.InferenceSession = session_cls
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)
    return fake


_bundle_counter = [0]


def make_bundle(tmp_path, session_cls=FakeSession, **overrides):
    _bundle_counter[0] += 1
    bundle = tmp_path / f"bundle-{_bundle_counter[0]}"
    bundle.mkdir()
    (bundle / "model.onnx").write_bytes(b"FAKE MODEL - control flow only")
    import hashlib
    manifest = {
        "manifest_version": 1,
        "diagnostic_shape": False,
        "source_checkpoint_sha256": PINNED,
        "checkpoint_pinned_match": True,
        "model_sha256": hashlib.sha256((bundle / "model.onnx").read_bytes()).hexdigest(),
        "tile": TILE,
        "precision": "fp32",
        "input_name": "raw_with_noise",
        "input_shape": [1, 8, TILE, TILE],
        "input_dtype": "float32",
        "output_name": "denoised_raw",
        "output_shape": [1, 4, TILE, TILE],
        "output_dtype": "float32",
        "model_file": "model.onnx",
        "sampler_implementation": "reference (torch GridSample loop)",
    }
    manifest.update(overrides)
    (bundle / "manifest.json").write_text(json.dumps(manifest))
    return bundle


def reset_fake():
    FakeSession.shape = (1, 4, TILE, TILE)
    FakeSession.dtype = np.float32
    FakeSession.first_nan = False
    FakeSession.second_nan = False
    FakeSession.switch_cpu = False


@pytest.fixture
def fake_ort(monkeypatch):
    reset_fake()
    install_fake_ort(monkeypatch)
    yield
    reset_fake()


P = backend_mod.OnnxTilePredictor
X = np.zeros((8, TILE, TILE), np.float32)


# --------------------------------------------------------------------------
# Adapter input validation (must reject BEFORE inference: runs == 0)


def test_adapter_rejects_float64_input_before_inference(fake_ort, tmp_path):
    p = P(make_bundle(tmp_path), "cpu")
    with pytest.raises(ValueError, match="float32"):
        p.predict(X.astype(np.float64))
    assert p.session.runs == 0


def test_adapter_rejects_uint16_input_before_inference(fake_ort, tmp_path):
    p = P(make_bundle(tmp_path), "cpu")
    with pytest.raises(ValueError, match="float32"):
        p.predict(np.zeros((8, TILE, TILE), np.uint16))
    assert p.session.runs == 0


def test_adapter_rejects_wrong_shape_before_inference(fake_ort, tmp_path):
    p = P(make_bundle(tmp_path), "cpu")
    with pytest.raises(ValueError, match=r"\[8,320,320\]"):
        p.predict(np.zeros((8, 128, 128), np.float32))
    assert p.session.runs == 0


def test_adapter_rejects_nonfinite_input_before_inference(fake_ort, tmp_path):
    p = P(make_bundle(tmp_path), "cpu")
    with pytest.raises(ValueError, match="[Nn]onfinite"):
        p.predict(np.full((8, TILE, TILE), np.nan, np.float32))
    assert p.session.runs == 0


# --------------------------------------------------------------------------
# Adapter output validation (inference runs once, THEN rejection)


def test_adapter_rejects_float64_output_after_one_run(fake_ort, tmp_path):
    FakeSession.dtype = np.float64
    p = P(make_bundle(tmp_path), "cpu")
    with pytest.raises(ValueError, match="float32"):
        p.predict(X)
    assert p.session.runs == 1  # reached output validation, not an earlier branch


def test_adapter_rejects_extra_batch_after_one_run(fake_ort, tmp_path):
    FakeSession.shape = (2, 4, TILE, TILE)
    p = P(make_bundle(tmp_path), "cpu")
    with pytest.raises(ValueError, match="batch"):
        p.predict(X)
    assert p.session.runs == 1


def test_adapter_rejects_nan_in_discarded_second_batch(fake_ort, tmp_path):
    # An extra batch is rejected outright (batch count before content), so a
    # NaN hiding in the discarded batch can never become an accepted output.
    FakeSession.shape = (2, 4, TILE, TILE)
    FakeSession.second_nan = True
    p = P(make_bundle(tmp_path), "cpu")
    with pytest.raises(ValueError, match="batch"):
        p.predict(X)
    assert p.session.runs == 1


def test_adapter_rejects_nan_in_first_batch(fake_ort, tmp_path):
    FakeSession.first_nan = True
    p = P(make_bundle(tmp_path), "cpu")
    with pytest.raises(ValueError, match="[Nn]on-finite"):
        p.predict(X)
    assert p.session.runs == 1


# --------------------------------------------------------------------------
# Adapter construction: lineage, metadata, fallback, provider


def test_adapter_rejects_zero_lineage(fake_ort, tmp_path):
    bundle = make_bundle(tmp_path, source_checkpoint_sha256="0" * 64,
                         checkpoint_pinned_match=False)
    with pytest.raises(ValueError, match="[Ll]ineage"):
        P(bundle, "cpu")


def test_adapter_rejects_unpinned_lineage(fake_ort, tmp_path):
    bundle = make_bundle(tmp_path, source_checkpoint_sha256="1" * 64,
                         checkpoint_pinned_match=True)
    with pytest.raises(ValueError, match="[Ll]ineage"):
        P(bundle, "cpu")


def test_adapter_rejects_mismatched_session_metadata(monkeypatch, tmp_path):
    install_fake_ort(monkeypatch, WrongMetadataSession)
    with pytest.raises(ValueError, match="[Mm]etadata"):
        P(make_bundle(tmp_path), "cpu")


def test_adapter_disables_fallback_before_inference(fake_ort, tmp_path):
    p = P(make_bundle(tmp_path), "cuda")
    assert p.session.fallback_disabled is True
    assert p.execution_info()["fallback_disabled"] is True


def test_adapter_detects_provider_switch_with_live_telemetry(fake_ort, tmp_path):
    FakeSession.switch_cpu = True
    p = P(make_bundle(tmp_path), "cuda")
    with pytest.raises(RuntimeError, match="[Pp]rovider"):
        p.predict(X)
    # Telemetry reflects the LIVE session, not the construction-time list.
    assert p.execution_info()["provider_actual"] == ["CPUExecutionProvider"]


def test_adapter_rejects_unavailable_provider_without_running(monkeypatch, tmp_path):
    fake = install_fake_ort(monkeypatch)
    fake.get_available_providers = lambda: ["CPUExecutionProvider"]
    with pytest.raises(RuntimeError, match="unavailable"):
        P(make_bundle(tmp_path), "cuda")


def test_adapter_rejects_model_hash_mismatch(fake_ort, tmp_path):
    bundle = make_bundle(tmp_path)
    (bundle / "model.onnx").write_bytes(b"TAMPERED")
    with pytest.raises(ValueError, match="[Hh]ash"):
        P(bundle, "cpu")


def test_adapter_rejects_missing_bundle_files(fake_ort, tmp_path):
    with pytest.raises(FileNotFoundError, match="model.onnx"):
        P(tmp_path / "no-such-bundle", "cpu")


def test_adapter_rejects_unknown_provider_option(fake_ort, tmp_path):
    with pytest.raises(ValueError, match="[Uu]nknown provider"):
        P(make_bundle(tmp_path), "tpu")


def test_adapter_rejects_tf32_without_cuda(fake_ort, tmp_path):
    with pytest.raises(ValueError, match="tf32"):
        P(make_bundle(tmp_path), "cpu", use_tf32=True)


def test_adapter_rejects_external_data_layout(fake_ort, tmp_path):
    with pytest.raises(ValueError, match="[Ee]xternal-data"):
        P(make_bundle(tmp_path, external_data=True), "cpu")


# --------------------------------------------------------------------------
# Structured provider options (fake session captures construction kwargs)


def _kwargs_session(monkeypatch):
    captured = {}

    class KwSession(FakeSession):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            captured.update(kwargs)

    install_fake_ort(monkeypatch, KwSession)
    return captured


def test_cuda_default_options_disable_tf32(monkeypatch, tmp_path):
    reset_fake()
    captured = _kwargs_session(monkeypatch)
    P(make_bundle(tmp_path), "cuda")
    assert captured["providers"] == ["CUDAExecutionProvider"]
    assert captured["provider_options"] == [{"use_tf32": "0"}]
    reset_fake()


def test_cuda_options_conflict_rejected(monkeypatch, tmp_path):
    reset_fake()
    _kwargs_session(monkeypatch)
    with pytest.raises(ValueError, match="use_tf32"):
        P(make_bundle(tmp_path), "cuda", use_tf32=True,
          provider_options={"use_tf32": "0"})
    with pytest.raises(ValueError, match="[Uu]nknown.*provider option"):
        P(make_bundle(tmp_path), "cuda", provider_options={"nope": "1"})
    with pytest.raises(ValueError, match="not in"):
        P(make_bundle(tmp_path), "cuda", provider_options={"use_tf32": "2"})
    reset_fake()


def test_cuda_tf32_true_records_effective_option(monkeypatch, tmp_path):
    reset_fake()
    captured = _kwargs_session(monkeypatch)
    p = P(make_bundle(tmp_path), "cuda", use_tf32=True)
    assert captured["provider_options"] == [{"use_tf32": "1"}]
    assert p.execution_info()["use_tf32"] is True
    reset_fake()


def test_cpu_rejects_provider_options(monkeypatch, tmp_path):
    reset_fake()
    _kwargs_session(monkeypatch)
    with pytest.raises(ValueError, match="[Uu]nknown cpu provider option"):
        P(make_bundle(tmp_path), "cpu", provider_options={"use_tf32": "0"})
    reset_fake()


def test_coreml_default_and_explicit_options(monkeypatch, tmp_path):
    reset_fake()
    captured = _kwargs_session(monkeypatch)
    p = P(make_bundle(tmp_path), "coreml")
    assert captured["providers"] == ["CoreMLExecutionProvider"]
    eff = captured["provider_options"][0]
    assert eff["ModelFormat"] == "MLProgram"
    assert eff["MLComputeUnits"] == "CPUAndGPU"
    assert eff["RequireStaticInputShapes"] == "1"
    assert eff["AllowLowPrecisionAccumulationOnGPU"] == "0"
    assert "ModelCacheDirectory" in eff and "nlx-coreml-" in eff["ModelCacheDirectory"]
    assert p.execution_info()["provider_options_effective"] == eff
    reset_fake()
    captured = _kwargs_session(monkeypatch)
    P(make_bundle(tmp_path), "coreml",
      provider_options={"MLComputeUnits": "ALL", "ProfileComputePlan": "1"})
    eff = captured["provider_options"][0]
    assert eff["MLComputeUnits"] == "ALL" and eff["ProfileComputePlan"] == "1"
    with pytest.raises(ValueError, match="not in"):
        P(make_bundle(tmp_path), "coreml",
          provider_options={"MLComputeUnits": "NEON"})
    reset_fake()


# --------------------------------------------------------------------------
# Adapter success path: session reuse, layout-only fix, live telemetry


def test_adapter_success_reuses_session_and_accepts_layout_only(fake_ort, tmp_path):
    p = P(make_bundle(tmp_path), "cpu")
    first = p.session
    got = p.predict(X)
    assert p.session is first
    assert got.shape == (4, TILE, TILE) and got.dtype == np.float32
    again = p.predict(np.asfortranarray(X))  # negative stride: layout fixed
    assert p.session is first
    assert p.session.runs == 2
    np.testing.assert_array_equal(got, again)
    info = p.execution_info()
    assert info["provider_actual"] == ["CPUExecutionProvider"]
    assert info["session_input"] == {"name": "raw_with_noise",
                                    "shape": [1, 8, TILE, TILE],
                                    "type": "tensor(float)"}
    assert info["peak_tensor_vram_bytes"] is None


# --------------------------------------------------------------------------
# Comparator entry point negatives


def _save(arr, path):
    np.save(path, arr)


def test_full_comparator_rejects_float64_candidate(tmp_path):
    from rapidraw_denoise.compare_full import compare_files
    good = np.zeros((4, 64, 400), np.float32)
    _save(good.astype(np.float64), tmp_path / "a.npy")
    _save(good, tmp_path / "r.npy")
    with pytest.raises(ValueError, match="float32"):
        compare_files("f64", tmp_path / "a.npy", tmp_path / "r.npy")


def test_full_comparator_rejects_uint16_candidate(tmp_path):
    from rapidraw_denoise.compare_full import compare_files
    good = np.zeros((4, 64, 400), np.float32)
    _save(good.astype(np.uint16), tmp_path / "a.npy")
    _save(good, tmp_path / "r.npy")
    with pytest.raises(ValueError, match="float32"):
        compare_files("u16", tmp_path / "a.npy", tmp_path / "r.npy")


def test_full_comparator_rejects_collapsed_integer_distinction(tmp_path):
    # 2**24+1 and 2**24 are distinct uint32 values that collapse to the same
    # float32; validation must precede coercion, so the pair is rejected
    # rather than reported as a zero-error PASS.
    from rapidraw_denoise.compare_full import compare_files
    _save(np.full((4, 64, 400), 2 ** 24 + 1, np.uint32), tmp_path / "a.npy")
    _save(np.full((4, 64, 400), 2 ** 24, np.uint32), tmp_path / "r.npy")
    with pytest.raises(ValueError, match="float32"):
        compare_files("u32", tmp_path / "a.npy", tmp_path / "r.npy")


def test_full_comparator_main_rejects_empty_pair_list(tmp_path):
    from rapidraw_denoise.compare_full import main
    pairs = tmp_path / "pairs.json"
    pairs.write_text("[]")
    out = tmp_path / "out.json"
    assert main([str(pairs), str(out)]) == 1  # error, not success
    assert json.loads(out.read_text())["status"] == "error"


def test_full_comparator_main_rejects_duplicate_names(tmp_path):
    from rapidraw_denoise.compare_full import main
    good = np.zeros((4, 64, 400), np.float32)
    _save(good, tmp_path / "a.npy")
    _save(good, tmp_path / "r.npy")
    pairs = tmp_path / "pairs.json"
    pairs.write_text(json.dumps([["dup", str(tmp_path / "a.npy"), str(tmp_path / "r.npy")],
                                 ["dup", str(tmp_path / "a.npy"), str(tmp_path / "r.npy")]]))
    out = tmp_path / "out.json"
    assert main([str(pairs), str(out)]) == 1
    assert "duplicate" in json.loads(out.read_text())["error"]


def test_full_comparator_main_enforces_expected_identities(tmp_path):
    from rapidraw_denoise.compare_full import main
    good = np.zeros((4, 64, 400), np.float32)
    _save(good, tmp_path / "a.npy")
    _save(good, tmp_path / "r.npy")
    pairs = tmp_path / "pairs.json"
    pairs.write_text(json.dumps([["only-one", str(tmp_path / "a.npy"),
                                  str(tmp_path / "r.npy")]]))
    out = tmp_path / "out.json"
    assert main([str(pairs), str(out), "--expect-cases", "only-one,missing"]) == 1
    assert "missing" in json.loads(out.read_text())["error"]


def test_full_comparator_main_rejects_malformed_rows(tmp_path):
    from rapidraw_denoise.compare_full import main
    pairs = tmp_path / "pairs.json"
    pairs.write_text(json.dumps([["just-a-name"]]))
    out = tmp_path / "out.json"
    assert main([str(pairs), str(out)]) == 1


def test_region_masks_grid_lines_are_exact():
    from rapidraw_denoise.compare_full import _grid_lines, region_masks
    lines = sorted(_grid_lines(400))
    assert lines == (list(range(0, 8)) + list(range(232, 248))
                     + list(range(392, 400)))
    masks = region_masks(400, 400)
    assert masks["outer"].sum() > 0 and masks["seam"].sum() > 0
    assert masks["interior"].sum() > 0
    total = masks["outer"].sum() + masks["seam"].sum() + masks["interior"].sum()
    assert total == 400 * 400  # disjoint complete partition


def test_repro_source_imports_no_torch():
    # Static half of the standalone contract (runtime half is proven by
    # fresh-process reconstruction runs, where pytest has no Torch loaded).
    src = (Path(__file__).parent.parent / "scripts" / "repro_tile.py").read_text()
    assert "import torch" not in src
    assert "onnxruntime" in src and "numpy" in src or "import numpy" in src


# --------------------------------------------------------------------------
# Standalone repro negatives (fake ORT; control flow only)


def _install_fake_repro_ort(monkeypatch, output):
    fake = types.ModuleType("onnxruntime")
    fake.SessionOptions = type("Options", (), {})
    fake.GraphOptimizationLevel = types.SimpleNamespace(ORT_DISABLE_ALL=0)

    class S:
        def __init__(self, *a, **kw):
            pass

        def get_providers(self):
            return ["CPUExecutionProvider"]

        def disable_fallback(self):
            pass

        def get_inputs(self):
            return [SimpleNamespace(name="x", shape=[1, 8, TILE, TILE],
                                    type="tensor(float)")]

        def get_outputs(self):
            return [SimpleNamespace(name="y", shape=[1, 4, TILE, TILE],
                                    type="tensor(float)")]

        def run(self, *a, **kw):
            return [output]

    fake.InferenceSession = S
    fake.get_available_providers = lambda: ["CPUExecutionProvider"]
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)


def _repro_bundle_and_fixture(tmp_path, out_array):
    bundle = tmp_path / "b"
    bundle.mkdir()
    (bundle / "model.onnx").write_bytes(b"FAKE")
    import hashlib
    (bundle / "manifest.json").write_text(json.dumps({
        "manifest_version": 1, "precision": "fp32",
        "source_checkpoint_sha256": PINNED, "checkpoint_pinned_match": True,
        "model_sha256": hashlib.sha256((bundle / "model.onnx").read_bytes()).hexdigest(),
        "input_name": "x", "output_name": "y"}))
    np.savez(tmp_path / "fx.npz",
             input=np.zeros((1, 8, TILE, TILE), np.float32),
             output=np.zeros((1, 4, TILE, TILE), np.float32))
    return bundle, tmp_path / "fx.npz"


def _run_repro(monkeypatch, bundle, fixture):
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "repro_under_test",
        Path(__file__).parent.parent / "scripts" / "repro_tile.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.main(["repro", str(bundle), str(fixture)])


def test_repro_rejects_single_channel_bias_violation(monkeypatch, tmp_path):
    # 2e-5 error confined to channel 0: global MAE (5e-6) and zero
    # elementwise violations would pass a weak gate, but the shared
    # per-channel bias gate (1e-5) must fail every entry point.
    y = np.zeros((1, 4, TILE, TILE), np.float32)
    y[:, 0] = 2e-5
    _install_fake_repro_ort(monkeypatch, y)
    bundle, fixture = _repro_bundle_and_fixture(tmp_path, y)
    assert _run_repro(monkeypatch, bundle, fixture) == 2
    m = full_metrics("oracle", y[0], np.zeros((4, TILE, TILE), np.float32))
    assert not m["pass"]  # shared gate agrees: this input must fail


def test_repro_accepts_exact_match(monkeypatch, tmp_path):
    y = np.zeros((1, 4, TILE, TILE), np.float32)
    _install_fake_repro_ort(monkeypatch, y)
    bundle, fixture = _repro_bundle_and_fixture(tmp_path, y)
    assert _run_repro(monkeypatch, bundle, fixture) == 0


def test_repro_rejects_float64_fixture_without_inference(monkeypatch, tmp_path):
    y = np.zeros((1, 4, TILE, TILE), np.float32)
    _install_fake_repro_ort(monkeypatch, y)
    bundle, _ = _repro_bundle_and_fixture(tmp_path, y)
    bad = tmp_path / "bad.npz"
    np.savez(bad, input=np.zeros((1, 8, TILE, TILE), np.float64),
             output=np.zeros((1, 4, TILE, TILE), np.float32))
    assert _run_repro(monkeypatch, bundle, bad) == 1


def test_repro_rejects_missing_bundle(monkeypatch, tmp_path):
    y = np.zeros((1, 4, TILE, TILE), np.float32)
    _install_fake_repro_ort(monkeypatch, y)
    _, fixture = _repro_bundle_and_fixture(tmp_path, y)
    assert _run_repro(monkeypatch, tmp_path / "no-bundle", fixture) == 1


# --------------------------------------------------------------------------
# onnx_validate failure reports are durable


def test_validate_saves_failure_report_for_missing_bundle(tmp_path):
    from rapidraw_denoise import onnx_validate
    report = tmp_path / "report.json"
    code = onnx_validate.main([
        "--bundle", str(tmp_path / "no-such-bundle"),
        "--fixtures", str(tmp_path),
        "--provider", "cpu",
        "--report", str(report),
    ])
    assert code == 1
    saved = json.loads(report.read_text())
    assert saved["status"] == "error" and "Bundle" in saved["error"]


def test_validate_unavailable_provider_uses_real_bundle_contract(tmp_path):
    # The bundle here is structurally valid (correct lineage + model hash),
    # so the failure provably comes from provider validation, not from an
    # earlier missing-file check masquerading as a provider test.
    real_ort = pytest.importorskip("onnxruntime")
    if "CUDAExecutionProvider" in real_ort.get_available_providers():
        pytest.skip("CUDA provider unexpectedly available")
    from rapidraw_denoise import onnx_validate
    bundle = make_bundle(tmp_path)
    report = tmp_path / "report.json"
    code = onnx_validate.main([
        "--bundle", str(bundle),
        "--fixtures", str(tmp_path),
        "--provider", "cuda",
        "--report", str(report),
    ])
    assert code == 1
    saved = json.loads(report.read_text())
    assert saved["status"] == "error" and "unavailable" in saved["error"]


def test_validate_refuses_to_overwrite_report(tmp_path):
    from rapidraw_denoise import onnx_validate
    report = tmp_path / "report.json"
    report.write_text("{}")
    code = onnx_validate.main([
        "--bundle", str(make_bundle(tmp_path)),
        "--fixtures", str(tmp_path),
        "--provider", "cpu",
        "--report", str(report),
    ])
    assert code == 1
    assert report.read_text() == "{}"  # untouched


# --------------------------------------------------------------------------
# Independent oracle: plain-loop channel bias agrees with shared metrics


def test_independent_loop_oracle_agrees_with_full_metrics():
    rng = np.random.default_rng(21)
    ref = (rng.normal(size=(4, 9, 11)) * 0.01).astype(np.float32)
    out = (ref.astype("float64") + rng.normal(size=(4, 9, 11)) * 2e-6).astype(np.float32)
    e = full_metrics("oracle", out, ref)
    for c in range(4):
        total = 0.0
        n = 0
        for r in range(9):
            for w in range(11):
                total += float(out[c, r, w]) - float(ref[c, r, w])
                n += 1
        assert e["signed_mean_err_per_channel"][c] == pytest.approx(total / n, rel=1e-6)
