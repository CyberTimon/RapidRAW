"""Phase-C backend parity: refactored Torch vs frozen HEAD implementation.

Uses the real vendored network with identical weights on both paths; this is
refactor equivalence, not denoising acceptance. ONNX-vs-Torch checks reuse
saved real fixtures where present (skipped otherwise).
"""
import os
from pathlib import Path

import numpy as np
import pytest
import torch

import tests._frozen_head_inference as frozen
from rapidraw_denoise import inference as new_inference
from rapidraw_denoise.noise import NoiseProfile

try:
    import onnxruntime  # noqa: F401
    _HAS_ORT = True
except ModuleNotFoundError:
    _HAS_ORT = False

requires_ort = pytest.mark.skipif(not _HAS_ORT, reason="onnxruntime absent")

REPO = Path(__file__).resolve().parent.parent.parent
# Optional local checkpoint, never a machine-specific default: parity checks
# skip unless the developer points NONLOCAL_ONNX_CKPT at real weights.
_ckpt_env = os.environ.get("NONLOCAL_ONNX_CKPT")
LOCAL_CKPT = Path(_ckpt_env).expanduser() if _ckpt_env else None
BUNDLE = Path(os.environ.get(
    "NONLOCAL_ONNX_BUNDLE",
    REPO / "nonlocal-onnx-evidence/model/bundle-pinned-320-fp32"
))
FIXTURE_TILE = Path(os.environ.get(
    "NONLOCAL_ONNX_FIXTURE_TILE",
    REPO / "nonlocal-onnx-evidence/fixtures/portrait-controlled-fp32/tiles/tile-00.npz"
))

requires_ckpt = pytest.mark.skipif(
    LOCAL_CKPT is None or not LOCAL_CKPT.is_file(),
    reason="NONLOCAL_ONNX_CKPT not configured or missing",
)
requires_bundle = pytest.mark.skipif(
    not (BUNDLE / "model.onnx").is_file() or not FIXTURE_TILE.is_file(),
    reason="ONNX bundle or fixtures absent",
)


def _profile():
    return NoiseProfile(
        shot=[0.002] * 4, read=[0.00003] * 4, diagnostics=[])


@requires_ckpt
def test_refactored_torch_matches_frozen_original():
    torch.manual_seed(0)
    packed = np.random.default_rng(9).uniform(-0.05, 0.9, size=(4, 96, 96)).astype(np.float32)
    profile = _profile()
    frozen_model = frozen.load_model(LOCAL_CKPT, device="cpu")
    new_model = new_inference.load_model(LOCAL_CKPT, device="cpu")
    frozen_out, _, frozen_info = frozen.denoise(
        packed, frozen_model, profile, tile=64, halo=16)
    new_out, new_info = new_inference.denoise(
        packed, new_model, profile, tile=64, halo=16)
    assert np.array_equal(new_out, frozen_out), float(
        np.abs(new_out - frozen_out).max())
    for key in ("tile", "halo", "noise_scale", "parameters"):
        assert new_info[key] == frozen_info[key], key
    assert new_info["noise_profile"] == frozen_info["noise_profile"]
    assert new_info["device"] == frozen_info["device"] == "cpu"


@requires_ckpt
def test_wrappers_preserve_helper_defaults_and_contracts():
    import inspect
    for fn in ("tiled_apply",):
        assert getattr(new_inference, fn) is getattr(
            __import__("rapidraw_denoise.pipeline", fromlist=[fn]), fn)
    sig = inspect.signature(new_inference.denoise)
    assert sig.parameters["tile"].default == 256
    assert sig.parameters["halo"].default == 40
    assert "ensemble" not in sig.parameters


@requires_bundle
@requires_ort
def test_onnx_predictor_matches_torch_on_real_fixture():
    from rapidraw_denoise.onnx_backend import OnnxTilePredictor
    with np.load(FIXTURE_TILE, allow_pickle=False) as f:
        x = np.ascontiguousarray(f["input"])[0]
        ref = np.ascontiguousarray(f["output"])[0]
    predictor = OnnxTilePredictor(BUNDLE, provider="cpu")
    first_session = predictor.session
    got = predictor.predict(x)
    assert predictor.session is first_session
    assert got.shape == (4, 320, 320) and np.isfinite(got).all()
    np.testing.assert_allclose(got, ref, atol=1e-4, rtol=1e-4)
    again = predictor.predict(np.asfortranarray(x))
    assert predictor.session is first_session
    np.testing.assert_array_equal(got, again)


@requires_bundle
@requires_ort
def test_onnx_backend_rejects_bad_inputs_and_bundles(tmp_path):
    from rapidraw_denoise.onnx_backend import OnnxTilePredictor
    predictor = OnnxTilePredictor(BUNDLE, provider="cpu")
    with pytest.raises(ValueError):
        predictor.predict(np.zeros((8, 128, 128), np.float32))
    with pytest.raises(ValueError):
        predictor.predict(np.full((8, 320, 320), np.nan, np.float32))
    with pytest.raises((ValueError, RuntimeError)):
        OnnxTilePredictor(BUNDLE, provider="tpu")
    with pytest.raises((FileNotFoundError, ValueError)):
        OnnxTilePredictor(tmp_path / "no-bundle", provider="cpu")
    info = predictor.execution_info()
    assert info["runtime"] == "onnx"
    assert info["provider_actual"] == ["CPUExecutionProvider"]
    assert info["peak_tensor_vram_bytes"] is None
