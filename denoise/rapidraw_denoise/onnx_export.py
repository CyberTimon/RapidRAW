"""Export the Nonlocal network to fixed-shape FP32 ONNX.

Uses the current vendored network and strict loader; no retraining, no
quantization, no dynamic shapes. ``--sampler reference`` exports the
existing loop/grid sampler (first artifact). ``--sampler static-packed``
exports an export-only clone routed through the static packed sampler
(one grid_sample per block); weights, names and the default forward path
are untouched — only the export process rebinds the sampler name, restored
afterwards. The packed artifact is a separately hashed new bundle; the
immutable reference artifact is never overwritten.

Fails closed on: wrong checkpoint, unpinned checkpoint (unless explicitly
allowed and labelled), non-reference sampler environment (reference mode),
non-finite or wrong-shaped fixtures, eager-vs-fixture mismatch, packed
binding that does not reproduce the loop, graph-check failure, custom-op
residue, runtime load failure, ORT-vs-eager mismatch.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from collections import Counter
from pathlib import Path

import numpy as np

PINNED_CHECKPOINT_SHA256 = "c16747d852b93a95908792cdbac901f89cca98e35b91ea7db6214de42fbd3cad"
PRODUCTION_TILE = 320
HALO = 40
INPUT_NAME = "raw_with_noise"
OUTPUT_NAME = "denoised_raw"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--checkpoint", type=Path, required=True)
    p.add_argument("--fixtures", type=Path, required=True,
                   help="Fixture dir from capture_reference.py (uses tiles/tile-*.npz)")
    p.add_argument("--tile", type=int, default=320)
    p.add_argument("--opset", type=int, default=18)
    p.add_argument("--sampler", type=str, default="reference",
                   choices=["reference", "static-packed"],
                   help="'reference': existing loop sampler; 'static-packed': "
                   "export-only packed sampler on an isolated clone (new artifact)")
    p.add_argument("--output", type=Path, required=True,
                   help="New bundle directory to create")
    p.add_argument("--allow-unpinned-checkpoint", action="store_true",
                   help="Permit a checkpoint whose SHA differs from the frozen pin; "
                   "recorded and labelled, never presented as pinned acceptance")
    p.add_argument("--allow-diagnostic-shape", action="store_true",
                   help="Permit a non-320 tile for smoke tests only; the bundle is "
                   "labelled diagnostic and rejected by production validation")
    p.add_argument("--atol", type=float, default=1e-4)
    p.add_argument("--rtol", type=float, default=1e-4)
    return p


def _load_fixture_tile(fixtures: Path) -> tuple[np.ndarray, np.ndarray]:
    tiles = sorted((fixtures / "tiles").glob("tile-*.npz"))
    if not tiles:
        raise ValueError(f"No fixture tiles in {fixtures / 'tiles'}")
    with np.load(tiles[0], allow_pickle=False) as f:
        x = np.ascontiguousarray(f["input"])
        ref = np.ascontiguousarray(f["output"])
    return x, ref


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    try:
        for name in ("checkpoint", "fixtures", "output"):
            p = getattr(args, name)
            if name != "output" and not p.is_absolute():
                raise ValueError(f"--{name} must be absolute: {p}")
        checkpoint = args.checkpoint.resolve()
        fixtures = args.fixtures.resolve()
        output = args.output.resolve()
        if output.exists():
            raise ValueError(f"--output already exists (never overwrite): {output}")
        if os.environ.get("RAPIDRAW_DENOISE_SAMPLER", "reference") != "reference":
            raise ValueError(
                "Export process must run with RAPIDRAW_DENOISE_SAMPLER=reference "
                f"(actual: {os.environ.get('RAPIDRAW_DENOISE_SAMPLER')!r})"
            )
        if args.tile != PRODUCTION_TILE and not args.allow_diagnostic_shape:
            raise ValueError(
                f"Production shape is tile {PRODUCTION_TILE}; pass "
                "--allow-diagnostic-shape for a labelled smoke bundle only"
            )
        if not checkpoint.is_file():
            raise FileNotFoundError(f"Missing checkpoint: {checkpoint}")
        checkpoint_sha = sha256_file(checkpoint)
        unpinned = checkpoint_sha != PINNED_CHECKPOINT_SHA256
        if unpinned and not args.allow_unpinned_checkpoint:
            raise ValueError(
                f"Checkpoint does not match frozen pin (actual {checkpoint_sha}); "
                "pass --allow-unpinned-checkpoint for a labelled non-acceptance bundle only"
            )

        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        import torch
        from rapidraw_denoise.inference import load_model
        from rapidraw_denoise.vendor.nonlocalmf import network as network_mod
        from rapidraw_denoise.vendor.nonlocalmf import sampling as sampling_mod

        # Prove the actual imported binding is the reference implementation.
        torch.manual_seed(0)
        probe_x = torch.randn(1, 2, 9, 11)
        probe_off = torch.randn(1, 2 * 9, 9, 11) * 0.3
        got = network_mod.deform_neighbourhood(
            probe_x, probe_off, neighbourhood_size=(3, 3), stride=1,
            padding=(1, 1), dilation=1, offset_groups=1,
        )
        want = sampling_mod.reference_sampling(
            probe_x, probe_off, (3, 3), padding=(1, 1),
        )
        if not torch.allclose(got, want, atol=0, rtol=0):
            raise ValueError("Sampler probe failed: network binding is not the reference sampler")
        sampler_label = "reference (torch GridSample loop)"
        if args.sampler == "static-packed":
            from rapidraw_denoise.static_packed_sampler import (
                SAMPLER_VERSION,
                packed_deform_neighbourhood,
            )
            # Export-only route: rebind the network sampler name in THIS
            # process (restored below); weights/names/default path untouched.
            network_mod.deform_neighbourhood = packed_deform_neighbourhood
            try:
                packed = network_mod.deform_neighbourhood(
                    probe_x, probe_off, neighbourhood_size=(3, 3), stride=1,
                    padding=(1, 1), dilation=1, offset_groups=1,
                )
                if not torch.equal(packed, want):
                    raise ValueError(
                        "Packed sampler does not reproduce the reference loop")
            except BaseException:
                network_mod.deform_neighbourhood = sampling_mod.deform_neighbourhood
                raise
            sampler_label = f"static-packed ({SAMPLER_VERSION}; export-only route)"

        x_np, ref_np = _load_fixture_tile(fixtures)
        if x_np.dtype != np.float32 or ref_np.dtype != np.float32:
            raise TypeError("Fixture tiles must be FP32")
        if x_np.ndim != 4 or x_np.shape[:2] != (1, 8):
            raise ValueError(f"Fixture input must be [1,8,H,W], got {x_np.shape}")
        if ref_np.shape != (1, 4, *x_np.shape[2:]):
            raise ValueError(f"Fixture output must be [1,4,H,W], got {ref_np.shape}")
        if x_np.shape[2] != args.tile or x_np.shape[3] != args.tile:
            raise ValueError(
                f"Fixture tile {x_np.shape[2:]} does not match --tile {args.tile}"
            )
        if not np.isfinite(x_np).all() or not np.isfinite(ref_np).all():
            raise ValueError("Fixture tensors contain non-finite values")

        model = load_model(checkpoint, device="cpu")
        model.eval().float()
        with torch.inference_mode():
            eager = model(torch.from_numpy(x_np)).cpu().numpy().astype(np.float32)
        # Pre-export gate: eager must reproduce the saved controlled reference
        # under the frozen full-network tolerances before any graph is written.
        np.testing.assert_allclose(eager, ref_np, atol=args.atol, rtol=args.rtol)

        import onnx
        import onnxruntime as ort

        output.parent.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix=".onnx-export-", dir=str(output.parent)))
        try:
            model_path = tmp / "model.onnx"
            reports = tmp / "export-reports"
            reports.mkdir()
            with torch.inference_mode():
                torch.onnx.export(
                    model,
                    (torch.from_numpy(x_np),),
                    str(model_path),
                    input_names=[INPUT_NAME],
                    output_names=[OUTPUT_NAME],
                    opset_version=args.opset,
                    dynamo=True,
                    dynamic_shapes=None,
                    external_data=False,
                    optimize=False,
                    report=True,
                    verify=True,
                    artifacts_dir=str(reports),
                )
            proto = onnx.load(str(model_path))
            onnx.checker.check_model(proto, full_check=True)
            # Inventory top-level graph plus functions/subgraphs; any native
            # sampler or PatchMatch residue fails the export.
            op_counts: Counter[str] = Counter()
            domains: set[str] = set()
            def visit(graph) -> None:
                for node in graph.node:
                    op_counts[f"{node.domain or 'ai.onnx'}::{node.op_type}"] += 1
                    domains.add(node.domain or "ai.onnx")
                    for attr in node.attribute:
                        if attr.HasField("g"):
                            visit(attr.g)
                        for sub in attr.graphs:
                            visit(sub)
            visit(proto.graph)
            lowered = " ".join(
                [n.op_type for n in proto.graph.node]
                + [f.name for f in proto.functions]
                + list(domains)
            ).lower()
            if "deform" in lowered or "patchmatch" in lowered or "patch_match" in lowered:
                raise RuntimeError("A native custom sampler op remains in the exported graph")
            in_info = [(i.name, [d.dim_value for d in i.type.tensor_type.shape.dim],
                        i.type.tensor_type.elem_type) for i in proto.graph.input]
            out_info = [(o.name, [d.dim_value for d in o.type.tensor_type.shape.dim],
                         o.type.tensor_type.elem_type) for o in proto.graph.output]
            if [n for n, _, _ in in_info] != [INPUT_NAME]:
                raise ValueError(f"Unexpected model inputs: {in_info}")
            if [n for n, _, _ in out_info] != [OUTPUT_NAME]:
                raise ValueError(f"Unexpected model outputs: {out_info}")
            opsets = {op.domain or "ai.onnx": op.version for op in proto.opset_import}

            # ORT CPU check with optimizations disabled (first configuration).
            options = ort.SessionOptions()
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
            session = ort.InferenceSession(
                str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
            )
            if session.get_providers() != ["CPUExecutionProvider"]:
                raise RuntimeError(f"Unexpected ORT providers: {session.get_providers()}")
            actual = session.run([OUTPUT_NAME], {INPUT_NAME: x_np})[0]
            if actual.shape != ref_np.shape or actual.dtype != np.float32:
                raise ValueError(f"ORT output {actual.shape}/{actual.dtype} != fixture {ref_np.shape}")
            if not np.isfinite(actual).all():
                raise ValueError("ORT output contains non-finite values")
            np.testing.assert_allclose(actual, eager, atol=args.atol, rtol=args.rtol)
            np.testing.assert_allclose(actual, ref_np, atol=args.atol, rtol=args.rtol)

            model_sha = sha256_file(model_path)
            validation = {
                "status": "single-fixture FP32 CPU parity passed (export-time check); "
                          "full multi-fixture acceptance requires onnx_validate.py",
                "torch": torch.__version__,
                "onnx": onnx.__version__,
                "onnxruntime": ort.__version__,
                "checkpoint_sha256": checkpoint_sha,
                "checkpoint_pinned_match": not unpinned,
                "model_sha256": model_sha,
                "sampler": ("static-packed-v1"
                            if args.sampler == "static-packed" else "reference"),
                "shape": list(x_np.shape),
                "ir_version": proto.ir_version,
                "opsets": opsets,
                "inputs": in_info,
                "outputs": out_info,
                "operators": dict(op_counts),
                "eager_vs_fixture_max_abs": float(np.abs(eager.astype("float64") - ref_np).max()),
                "ort_vs_fixture_max_abs": float(np.abs(actual.astype("float64") - ref_np).max()),
            }
            (tmp / "export-validation.json").write_text(json.dumps(validation, indent=2) + "\n")
            validation_sha = sha256_file(tmp / "export-validation.json")
            # Manifest finalized last; it hashes the model and report without
            # any circular self-reference.
            diagnostic = args.tile != PRODUCTION_TILE
            manifest = {
                "manifest_version": 1,
                "artifact": "model.onnx" if not diagnostic else "diagnostic model.onnx",
                "diagnostic_shape": diagnostic,
                "source_repository": "sheldonxxxx/RapidRAW",
                "source_checkpoint_sha256": checkpoint_sha,
                "checkpoint_pinned_sha256": PINNED_CHECKPOINT_SHA256,
                "checkpoint_pinned_match": not unpinned,
                "architecture": {
                    "class": "SimpleBlockMatchingUNet",
                    "input_channels": 8,
                    "output_channels": 4,
                    "n_features": 32,
                    "neighbours": {"scale1": [5, 5], "scale2": [3, 5], "scale3": [3, 3]},
                    "max_search_dist": 9.0,
                    "bias": False,
                },
                "model_file": "model.onnx",
                "model_sha256": model_sha,
                "input_name": INPUT_NAME,
                "input_shape": [1, 8, args.tile, args.tile],
                "input_dtype": "float32",
                "output_name": OUTPUT_NAME,
                "output_shape": [1, 4, args.tile, args.tile],
                "output_dtype": "float32",
                "cfa_order": "RGBG",
                "normalization_contract": "per-channel black subtraction, white normalization; "
                                          "signal clipped [0,1]; noise sqrt(max(var,1e-12))",
                "pipeline_revision": "inference.py@tiled_apply+denoise (shared; unmodified)",
                "tile": args.tile,
                "halo": HALO,
                "retained_core": args.tile - 2 * HALO,
                "sampler_implementation": sampler_label,
                "precision": "fp32",
                "opset_imports": opsets,
                "ir_version": proto.ir_version,
                "exporter": {
                    "torch": torch.__version__,
                    "onnx": onnx.__version__,
                    "onnxscript": __import__("onnxscript").__version__,
                    "onnxruntime_validation": ort.__version__,
                    "opset_requested": args.opset,
                    "dynamo": True,
                    "optimize": False,
                    "external_data": False,
                },
                "validation_report_file": "export-validation.json",
                "validation_report_sha256": validation_sha,
                "tolerances": {"atol": args.atol, "rtol": args.rtol},
            }
            (tmp / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
            checksums = {n: sha256_file(tmp / n) for n in
                         ["model.onnx", "export-validation.json", "manifest.json"]}
            (tmp / "SHA256SUMS.txt").write_text(
                "".join(f"{h}  {n}\n" for n, h in sorted(checksums.items()))
            )
            tmp.rename(output)
        except BaseException:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
            if args.sampler == "static-packed":
                network_mod.deform_neighbourhood = sampling_mod.deform_neighbourhood
            raise
        if args.sampler == "static-packed":
            network_mod.deform_neighbourhood = sampling_mod.deform_neighbourhood
        print(json.dumps({"status": "exported", "output": str(output),
                          "model_sha256": model_sha,
                          "diagnostic": args.tile != PRODUCTION_TILE}, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
