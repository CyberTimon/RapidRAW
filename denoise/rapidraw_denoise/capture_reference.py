"""Capture immutable reference outputs from the original native implementation.

Reads the native Rust-produced ``input.f32`` + ``request.json`` boundary
(without introducing another RAW decoder), runs the unchanged Torch pipeline,
and saves conditioned tiles plus direct unclipped predictions.

This is a diagnostic fixture exporter, not a production inference service.
It must not change returned values or retain full-image tensors in ordinary
jobs; the temporary observation hook here lives only inside this process.

Real-checkpoint capture requires the pinned checkpoint, a real native input
directory, and the requested device. Missing prerequisites fail closed;
synthetic or random weights are never accepted as real-checkpoint evidence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np


PINNED_CHECKPOINT_SHA256 = "c16747d852b93a95908792cdbac901f89cca98e35b91ea7db6214de42fbd3cad"
NATIVE_TILE = 320
NATIVE_HALO = 40
NATIVE_CORE = NATIVE_TILE - 2 * NATIVE_HALO


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _require_absolute(path: Path, label: str) -> Path:
    if not path.is_absolute():
        raise ValueError(f"{label} must be absolute: {path}")
    return path


def select_tile_origins(
    packed_shape: tuple[int, int, int],
    packed: np.ndarray,
    count: int = 6,
) -> list[tuple[int, int]]:
    """Deterministically select diverse tile origins in packed coordinates.

    Origins step by the retained core (192) over the unpadded image, matching
    ``tiled_apply`` traversal order. Selection covers low-signal, high-texture,
    highlight, and outer-image boundary cases where available.
    """
    _, h, w = packed_shape
    core = NATIVE_CORE
    origins: list[tuple[int, int]] = []
    for y in range(0, h, core):
        for x in range(0, w, core):
            origins.append((y, x))
    if len(origins) <= count:
        return origins
    # Per-tile statistics over the retained core region of the packed input.
    stats = []
    for idx, (y, x) in enumerate(origins):
        cy = min(core, h - y)
        cx = min(core, w - x)
        region = packed[:, y : y + cy, x : x + cx]
        stats.append(
            {
                "idx": idx,
                "mean": float(region.mean()),
                "var": float(region.var()),
                "max": float(region.max()),
                "edge": (y == 0 or x == 0 or y + cy >= h or x + cx >= w),
            }
        )
    chosen: list[int] = []
    def take(key, reverse=False):
        ordered = sorted(stats, key=lambda s: s[key], reverse=reverse)
        for s in ordered:
            if s["idx"] not in chosen:
                chosen.append(s["idx"])
                return
    # Coverage: low-signal, texture, highlight, then boundaries / interior.
    take("mean", reverse=False)
    take("var", reverse=True)
    take("max", reverse=True)
    for s in stats:
        if s["edge"] and s["idx"] not in chosen and len(chosen) < count:
            chosen.append(s["idx"])
    for s in stats:
        if s["idx"] not in chosen and len(chosen) < count:
            chosen.append(s["idx"])
    # Preserve traversal order for reproducibility.
    chosen_sorted = sorted(chosen[:count])
    return [origins[i] for i in chosen_sorted]


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--worker-directory", type=Path, required=True,
                   help="Absolute native diagnostic input dir with request.json + input.f32")
    p.add_argument("--checkpoint", type=Path, required=True,
                   help="Absolute pinned tensor-only checkpoint")
    p.add_argument("--output", type=Path, required=True,
                   help="Absolute new output directory for fixtures")
    p.add_argument("--device", choices=["cuda", "cpu"], default="cuda",
                   help="Explicit inference device for the production capture")
    p.add_argument("--noise-scale", type=float, default=1.0)
    p.add_argument("--noise-profile", type=Path, default=None,
                   help="Optional JSON NoiseProfile (four shot/read values, RGBG order)")
    p.add_argument("--max-tiles", type=int, default=6,
                   help="Number of conditioned tiles to save (minimum 6 for acceptance)")
    p.add_argument("--capture-block-io", action="store_true",
                   help="Also save features/offsets from each nonlocal block on one tile (diagnostic only)")
    p.add_argument("--label", type=str, default="production",
                   help="Label for this capture (production vs controlled-fp32)")
    p.add_argument("--allow-unpinned-checkpoint", action="store_true",
                   help="Permit a checkpoint whose SHA differs from the frozen pin. "
                   "The actual digest is recorded and the label is suffixed; output "
                   "must never be presented as pinned-checkpoint acceptance.")
    p.add_argument("--skip-full", action="store_true",
                   help="Skip full-photo assembly (e.g. 32 MP CPU inference "
                   "impractical). Tile fixtures are still captured; the report records "
                   "the skip. Full-photo gates remain pending.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    try:
        worker_dir = _require_absolute(args.worker_directory.resolve(), "--worker-directory")
        checkpoint = _require_absolute(args.checkpoint.resolve(), "--checkpoint")
        output = _require_absolute(args.output.resolve(), "--output")
        if output.exists():
            raise ValueError(f"--output already exists (never overwrite): {output}")
        if args.max_tiles < 6:
            raise ValueError("--max-tiles must be at least 6 for acceptance coverage")
        if not np.isfinite(args.noise_scale) or args.noise_scale <= 0:
            raise ValueError("--noise-scale must be positive and finite")
        request_path = worker_dir / "request.json"
        input_path = worker_dir / "input.f32"
        if not request_path.is_file():
            raise FileNotFoundError(f"Missing native request: {request_path}")
        if not input_path.is_file():
            raise FileNotFoundError(f"Missing native packed input: {input_path}")
        if not checkpoint.is_file():
            raise FileNotFoundError(f"Missing checkpoint: {checkpoint}")
        request = json.loads(request_path.read_text())
        # Validate against the frozen native worker contract before loading any model.
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from rapidraw_denoise.worker import validate_request, CHECKPOINT_SHA256
        shape = validate_request(request)
        if tuple(shape[1:]) and (request.get("tile") != NATIVE_TILE or request.get("halo") != NATIVE_HALO):
            raise ValueError("Native worker contract requires tile 320 / halo 40")
        checkpoint_sha = sha256_file(checkpoint)
        if checkpoint_sha != CHECKPOINT_SHA256 or checkpoint_sha != PINNED_CHECKPOINT_SHA256:
            if not args.allow_unpinned_checkpoint:
                raise ValueError(
                    "Checkpoint does not match frozen behaviour contract "
                    f"(actual {checkpoint_sha}); pass --allow-unpinned-checkpoint to "
                    "capture explicitly labelled non-acceptance fixtures only"
                )
            label = f"{args.label}-unpinned-{checkpoint_sha[:12]}"
        else:
            label = args.label
        expected_bytes = int(np.prod(shape)) * 4
        if input_path.stat().st_size != expected_bytes:
            raise ValueError("Input byte count does not match packed shape")
        if sha256_file(input_path) != request.get("input_sha256"):
            raise ValueError("Packed input checksum mismatch")
        packed = np.fromfile(input_path, dtype="<f4").reshape(shape)
        if not np.isfinite(packed).all():
            raise ValueError("Nonfinite RAW input")

        import torch
        from rapidraw_denoise.inference import load_model
        from rapidraw_denoise.noise import NoiseProfile, estimate_noise

        sampler = os.environ.get("RAPIDRAW_DENOISE_SAMPLER", "reference")
        # Record precision policy without changing production defaults.
        tf32_matmul = None
        tf32_cudnn = None
        try:
            tf32_matmul = bool(torch.backends.cuda.matmul.allow_tf32)
            tf32_cudnn = bool(torch.backends.cudnn.allow_tf32)
        except Exception:
            pass
        profile = None
        if args.noise_profile is not None:
            profile = NoiseProfile(**json.loads(args.noise_profile.read_text()))
        else:
            profile = estimate_noise(packed)

        # Conditioning replicates inference.denoise exactly:
        # signal clipped for the network; signed samples feed noise estimation.
        image = np.clip(packed, 0, 1)
        variance = profile.variance(packed)
        conditioned = np.concatenate(
            [image, np.sqrt(np.maximum(variance, 1e-12)) * args.noise_scale]
        )
        if conditioned.shape[0] != 8:
            raise ValueError("Conditioned input must have 8 channels")

        # Select diverse tile origins in packed coordinates.
        origins = select_tile_origins((4, shape[1], shape[2]), packed, count=args.max_tiles)

        # Load the unchanged reference pipeline and observe (not modify) predictions.
        model = load_model(checkpoint, args.device)
        model.eval()
        device = next(model.parameters()).device

        # Replicate tiled_apply padding to extract the exact model inputs.
        _, h, w = conditioned.shape
        core = NATIVE_CORE
        ny = (h + core - 1) // core
        nx = (w + core - 1) // core
        padded = np.pad(
            conditioned,
            ((0, 0), (NATIVE_HALO, ny * core - h + NATIVE_HALO), (NATIVE_HALO, nx * core - w + NATIVE_HALO)),
            mode="reflect",
        )
        # Map origin -> padded slice.
        tile_inputs: list[np.ndarray] = []
        for (y, x) in origins:
            tile = np.ascontiguousarray(padded[:, y : y + NATIVE_TILE, x : x + NATIVE_TILE])
            if tile.shape != (8, NATIVE_TILE, NATIVE_TILE):
                raise ValueError(f"Unexpected conditioned tile shape at {(y, x)}: {tile.shape}")
            if not np.isfinite(tile).all():
                raise ValueError(f"Nonfinite conditioned tile at {(y, x)}")
            tile_inputs.append(tile)

        # Optional diagnostic: capture features/offsets from each nonlocal block
        # on the first selected tile only. Hooks observe; they never modify.
        block_io: dict = {}
        handles = []
        if args.capture_block_io:
            from rapidraw_denoise.vendor.nonlocalmf.network import NonlocalBlock
            captured: dict[str, dict] = {}
            for name, module in model.named_modules():
                if isinstance(module, NonlocalBlock):
                    def make_hook(key):
                        def hook(_m, inputs, _out):
                            x = inputs[0].detach().cpu()
                            # Recompute offsets deterministically from the same forward
                            # inputs without altering the returned values.
                            with torch.inference_mode():
                                enc = _m.encoder(x.to(next(_m.parameters()).device))
                                off = _m.offset_cnn(enc)
                                off = _m.max_search_dist * torch.tanh(off)
                            captured[key] = {
                                "features_shape": list(x.shape),
                                "offsets_shape": list(off.cpu().shape),
                                "features": x.numpy(),
                                "offsets": off.cpu().numpy(),
                            }
                        return hook
                    handles.append(module.register_forward_hook(make_hook(name)))
            block_io["_handles"] = handles
            block_io["_captured"] = captured

        # Run direct unclipped predictions for each selected tile.
        tile_outputs: list[np.ndarray] = []
        with torch.inference_mode():
            for tile in tile_inputs:
                x = torch.from_numpy(tile[None]).to(device)
                if not torch.isfinite(x).all():
                    raise ValueError("Nonfinite model input tensor")
                y = model(x)
                out = y[0].float().cpu().numpy()
                if out.shape != (4, NATIVE_TILE, NATIVE_TILE) or not np.isfinite(out).all():
                    raise ValueError("Invalid RAW prediction")
                tile_outputs.append(out.astype(np.float32))
        for hnd in block_io.get("_handles", []):
            hnd.remove()
        captured_blocks = block_io.get("_captured", {})

        # Full assembled prediction when hardware permits. Uses the shared
        # denoise path.
        # --skip-full records the skip explicitly; tile fixtures (the parity
        # inputs) are still captured and full-photo gates remain pending.
        from rapidraw_denoise.inference import denoise
        full_prediction: np.ndarray | None = None
        full_info: dict | None = None
        full_skipped_reason: str | None = None
        if args.skip_full:
            full_skipped_reason = (
                "skipped by --skip-full (e.g. full-photo CPU inference "
                "impractical); full-photo assembly gates remain pending"
            )
        else:
            out, info = denoise(
                packed, model, profile, NATIVE_TILE, NATIVE_HALO,
                args.noise_scale,
            )
            if out.shape != shape or not np.isfinite(out).all():
                raise ValueError("Invalid full prediction")
            full_prediction = out.astype(np.float32)
            full_info = info

        # Publish to a temp dir then atomically rename (never overwrite).
        import tempfile, shutil
        output.parent.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix=".capture-", dir=str(output.parent)))
        try:
            (tmp / "tiles").mkdir()
            for i, ((y, x), tin, tout) in enumerate(zip(origins, tile_inputs, tile_outputs)):
                np.savez(
                    tmp / "tiles" / f"tile-{i:02d}.npz",
                    input=tin[None].astype(np.float32),
                    output=tout[None].astype(np.float32),
                    origin_y=np.int64(y),
                    origin_x=np.int64(x),
                )
            if full_prediction is not None:
                np.save(tmp / "full-prediction.npy", full_prediction, allow_pickle=False)
            if captured_blocks:
                (tmp / "blocks").mkdir()
                for key, val in captured_blocks.items():
                    safe = key.replace(".", "_").replace("/", "_")
                    np.savez(
                        tmp / "blocks" / f"{safe}.npz",
                        features=np.ascontiguousarray(val["features"]),
                        offsets=np.ascontiguousarray(val["offsets"]),
                    )
            metadata = {
                "label": label,
                "worker_directory": str(worker_dir),
                "request_sha256": hashlib.sha256(request_path.read_bytes()).hexdigest(),
                "request": request,
                "shape": list(shape),
                "input_sha256": request.get("input_sha256"),
                "source_sha256": request.get("source_sha256"),
                "checkpoint_sha256": checkpoint_sha,
                "checkpoint_pinned_sha256": PINNED_CHECKPOINT_SHA256,
                "checkpoint_pinned_match": checkpoint_sha == PINNED_CHECKPOINT_SHA256,
                "sampler": sampler,
                "device_requested": args.device,
                "device_actual": str(device),
                "torch_version": torch.__version__,
                "cuda_available": bool(torch.cuda.is_available()),
                "tf32_matmul_allow": tf32_matmul,
                "tf32_cudnn_allow": tf32_cudnn,
                "noise_scale": args.noise_scale,
                "noise_profile": profile.to_dict(),
                "tile": NATIVE_TILE,
                "halo": NATIVE_HALO,
                "core": NATIVE_CORE,
                "origins_yx": [list(o) for o in origins],
                "tile_input_shape": [1, 8, NATIVE_TILE, NATIVE_TILE],
                "tile_input_dtype": "float32",
                "tile_output_shape": [1, 4, NATIVE_TILE, NATIVE_TILE],
                "tile_output_dtype": "float32",
                "full_info": full_info,
                "full_skipped_reason": full_skipped_reason,
                "block_io_shapes": {
                    k: {"features": v["features_shape"], "offsets": v["offsets_shape"]}
                    for k, v in captured_blocks.items()
                },
            }
            (tmp / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
            # Checksums for immutability.
            checksums = {}
            for f in sorted(tmp.rglob("*")):
                if f.is_file():
                    checksums[str(f.relative_to(tmp))] = sha256_file(f)
            (tmp / "SHA256SUMS.txt").write_text(
                "".join(f"{h}  {n}\n" for n, h in sorted(checksums.items(), key=lambda kv: kv[0]))
            )
            tmp.rename(output)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        report = {
            "status": "captured",
            "output": str(output),
            "tiles": len(origins),
            "label": label,
            "sampler": sampler,
            "device": str(device),
            "checkpoint_pinned_match": checkpoint_sha == PINNED_CHECKPOINT_SHA256,
            "full_skipped": full_skipped_reason is not None,
        }
        print(json.dumps(report, indent=2))
        return 0
    except Exception as exc:  # fail closed with an actionable message
        print(json.dumps({"status": "error", "error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
