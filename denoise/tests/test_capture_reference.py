"""Fast CPU tests for the diagnostic reference-capture path.

These verify orchestration, fail-closed behaviour, and byte-exact transport.
They are not denoising-quality evidence and never substitute for
real-checkpoint acceptance.
"""
import json
from pathlib import Path

import numpy as np
import pytest

from rapidraw_denoise.capture_reference import (
    NATIVE_HALO,
    NATIVE_TILE,
    build_arg_parser,
    main,
    select_tile_origins,
)
from rapidraw_denoise.worker import ALGORITHM, CHECKPOINT_SHA256


def _write_native_dir(tmp_path: Path, h: int = 64, w: int = 64) -> Path:
    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    packed = np.random.default_rng(7).normal(size=(4, h, w)).astype(np.float32)
    input_path = worker_dir / "input.f32"
    packed.astype("<f4", copy=False).tofile(input_path)
    import hashlib
    input_sha = hashlib.sha256(input_path.read_bytes()).hexdigest()
    request = {
        "protocol": 1,
        "algorithm": ALGORITHM,
        "model_sha256": CHECKPOINT_SHA256,
        "input_sha256": input_sha,
        "source_sha256": "source",
        "shape": [4, h, w],
        "tile": 320,
        "halo": 40,
    }
    (worker_dir / "request.json").write_text(json.dumps(request))
    return worker_dir


def test_tile_selection_is_deterministic_and_covers_edges():
    packed = np.random.default_rng(11).normal(size=(4, 512, 512)).astype(np.float32)
    # Inject a bright highlight block to exercise highlight selection.
    packed[:, 400:, 400:] += 3.0
    first = select_tile_origins((4, 512, 512), packed, count=6)
    second = select_tile_origins((4, 512, 512), packed, count=6)
    assert first == second
    assert len(first) == 6
    assert len(set(first)) == 6
    # Origins step by the retained core and include at least one edge tile.
    core = NATIVE_TILE - 2 * NATIVE_HALO
    for y, x in first:
        assert y % core == 0 and x % core == 0
    assert any(y == 0 or x == 0 for y, x in first)


def test_small_image_returns_all_available_tiles():
    packed = np.zeros((4, 64, 64), np.float32)
    origins = select_tile_origins((4, 64, 64), packed, count=6)
    assert origins == [(0, 0)]


def test_capture_fails_closed_on_missing_request(tmp_path):
    worker_dir = tmp_path / "empty"
    worker_dir.mkdir()
    out = tmp_path / "new-output"
    code = main([
        "--worker-directory", str(worker_dir.resolve()),
        "--checkpoint", str((tmp_path / "missing.pt").resolve()),
        "--output", str(out.resolve()),
        "--device", "cpu",
    ])
    assert code == 1
    assert not out.exists()


def test_capture_fails_closed_on_missing_checkpoint(tmp_path):
    worker_dir = _write_native_dir(tmp_path)
    out = tmp_path / "new-output"
    code = main([
        "--worker-directory", str(worker_dir.resolve()),
        "--checkpoint", str((tmp_path / "missing.pt").resolve()),
        "--output", str(out.resolve()),
        "--device", "cpu",
    ])
    assert code == 1
    assert not out.exists()


def test_capture_rejects_unpinned_checkpoint_by_default(tmp_path):
    worker_dir = _write_native_dir(tmp_path)
    fake_ckpt = tmp_path / "fake.pt"
    fake_ckpt.write_bytes(b"not-a-checkpoint")
    out = tmp_path / "new-output"
    code = main([
        "--worker-directory", str(worker_dir.resolve()),
        "--checkpoint", str(fake_ckpt.resolve()),
        "--output", str(out.resolve()),
        "--device", "cpu",
    ])
    assert code == 1
    assert not out.exists()


def test_capture_refuses_to_overwrite_output(tmp_path):
    worker_dir = _write_native_dir(tmp_path)
    out = tmp_path / "existing"
    out.mkdir()
    code = main([
        "--worker-directory", str(worker_dir.resolve()),
        "--checkpoint", str((tmp_path / "missing.pt").resolve()),
        "--output", str(out.resolve()),
        "--device", "cpu",
    ])
    assert code == 1


def test_capture_rejects_small_tile_request(tmp_path):
    # Acceptance requires at least six tiles; smaller requests fail closed.
    worker_dir = _write_native_dir(tmp_path)
    out = tmp_path / "new-output"
    code = main([
        "--worker-directory", str(worker_dir.resolve()),
        "--checkpoint", str((tmp_path / "missing.pt").resolve()),
        "--output", str(out.resolve()),
        "--device", "cpu",
        "--max-tiles", "2",
    ])
    assert code == 1


def test_native_transport_roundtrip_is_little_endian(tmp_path):
    worker_dir = _write_native_dir(tmp_path, h=16, w=32)
    raw = (worker_dir / "input.f32").read_bytes()
    request = json.loads((worker_dir / "request.json").read_text())
    assert request["shape"] == [4, 16, 32]
    assert request["tile"] == 320 and request["halo"] == 40
    arr = np.fromfile(worker_dir / "input.f32", dtype="<f4").reshape(4, 16, 32)
    assert arr.shape == (4, 16, 32)
    assert np.isfinite(arr).all()
    # Manual LE encoding matches file bytes (same contract as Rust helper).
    assert raw == arr.astype("<f4", copy=False).tobytes()
