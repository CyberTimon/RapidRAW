"""Focused tests for bench_v2.py reproducible modes (no GPU required).

Covers: mode tables (TF32 plan, sampler binding, probe expectations),
CLI surface (new modes + path overrides in --help), legacy defaults
preserved, out-refusal validation, and the guard that new torch modes
rebind BOTH vendor entry points (network + sampling) with restore.
"""
import subprocess
import sys
from pathlib import Path

import pytest

from rapidraw_denoise.onnx_backend import PRODUCTION_CUDA_PROVIDER_OPTIONS

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "bench_v2.py"


def _bench_v2():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "bench_v2_under_test", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_mode_tables_cover_new_backends():
    mod = _bench_v2()
    assert set(mod.NEW_BACKENDS) == {
        "onnx-strict", "torch-default", "torch-orig",
        "torch-strict", "torch-packed", "torch-refstrict"}
    for mode in ("torch-default", "torch-orig", "torch-strict",
                 "torch-packed", "torch-refstrict"):
        assert mod.torch_tf32_plan(mode)[0] in ("record-only", "set")
        assert mod.SAMPLER_BINDING[mode] in ("native", "packed", "reference")
    with pytest.raises(ValueError, match="not a new torch mode"):
        mod.torch_tf32_plan("torch-native")


def test_tf32_plan_matches_historical_flags():
    mod = _bench_v2()
    assert mod.torch_tf32_plan("torch-default") == ("record-only", None, None)
    assert mod.torch_tf32_plan("torch-orig") == ("set", False, True)
    assert mod.torch_tf32_plan("torch-strict") == ("set", False, False)


def test_probe_expectations():
    mod = _bench_v2()
    assert mod.expected_probe_equal("native") is False
    assert mod.expected_probe_equal("reference") is True
    assert mod.expected_probe_equal("packed") is None
    with pytest.raises(ValueError, match="unknown sampler binding"):
        mod.expected_probe_equal("cuda")


def test_prod_options_mirror_rust_policy():
    assert PRODUCTION_CUDA_PROVIDER_OPTIONS == {
        "device_id": "0",
        "arena_extend_strategy": "kSameAsRequested",
        "cudnn_conv_algo_search": "HEURISTIC",
    }


def test_library_context_labels_preloaded_ort():
    mod = _bench_v2()
    assert mod.ort_library_context("onnx-strict", True) == \
        "torch-preloaded-for-ort"
    assert mod.ort_library_context("onnx-strict", False) == "torch-free"
    assert mod.ort_library_context("torch-orig", True) == "n/a-torch-mode"


def test_onnx_strict_doc_disclaims_native_equivalence():
    src = SCRIPT.read_text()
    assert "torch-preloaded" in src.lower()
    assert "NOT a fully" in src or "not a fully" in src.lower()
    assert "bench_candidate.py --prod-cuda" in src


def test_cli_lists_new_modes_and_overrides():
    proc = subprocess.run([sys.executable, str(SCRIPT), "--help"],
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0
    for mode in ("onnx-strict", "torch-default", "torch-orig",
                 "torch-strict", "torch-packed", "torch-refstrict"):
        assert mode in proc.stdout
    for flag in ("--bundle", "--fixtures", "--photo", "--ckpt", "--out",
                 "--repeats"):
        assert flag in proc.stdout


def test_cli_refuses_to_overwrite_out(tmp_path):
    out = tmp_path / "existing.json"
    out.write_text("{}")
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "torch-strict",
         "--ckpt", "/tmp/nope.pt", "--fixtures", "/tmp/nope",
         "--out", str(out)],
        capture_output=True, text=True, timeout=120)
    assert proc.returncode == 1
    assert "refusing to overwrite" in proc.stderr
    assert out.read_text() == "{}"


def test_new_modes_rebind_both_entry_points_with_restore():
    src = SCRIPT.read_text()
    # The model calls network.deform_neighbourhood (bound at import); the
    # dispatcher lives at sampling.deform_neighbourhood. Both must be
    # rebound and restored.
    assert "network_mod.deform_neighbourhood = counting" in src
    assert "sampling_mod.deform_neighbourhood = counting" in src
    assert "network_mod.deform_neighbourhood = orig_network" in src
    assert "sampling_mod.deform_neighbourhood = orig_sampling" in src
    assert "packed_deform_neighbourhood" in src
    assert "static-packed" in src or "static_packed_sampler" in src
    assert "torch.cuda.is_initialized" in src


def test_legacy_behavior_text_preserved():
    src = SCRIPT.read_text()
    # Legacy meanings/defaults must survive the extension.
    assert '"torch-native-tf32off"' in src or "'torch-native-tf32off'" in src
    assert "bundle-pinned-320-fp32" in src
    assert "torch.backends.cuda.matmul.allow_tf32 = False" in src
    assert "native-ext-binding" in src
