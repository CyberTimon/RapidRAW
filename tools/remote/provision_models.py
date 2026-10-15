#!/usr/bin/env python3
"""Provision RapidRAW's pinned ONNX models as darktable-worker model packs.

Creates, under --models-root, one directory per model pack:

    <models-root>/<id>/config.json   # {"id": "<id>"}
    <models-root>/<id>/<file>.onnx   # verified against the pinned SHA-256

The hashes are the same constants the RapidRAW client enforces for its
local downloads (src-tauri/src/ai_processing.rs), so a provisioned worker
serves byte-identical weights. Run this on the GPU host next to
vendor/remote_worker.py:

    python3 provision_models.py --models-root ~/darktable-models
    python3 vendor/remote_worker.py --models-root ~/darktable-models

Stdlib only. Idempotent: existing files with a matching hash are kept,
mismatches are re-downloaded.
"""

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

HF = "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main"

def _entry(fname: str, sha: str, url_name: str = None):
    """(filename, sha256, url filename). Defaults to same name on HF."""
    return (fname, sha, url_name or fname)

# Mirrors src-tauri/src/ai_processing.rs — keep in sync.
MANIFEST = {
    "rapidraw-sam": {
        "name": "SAM ViT-B image encoder + mask decoder",
        "files": [
            _entry("sam_vit_b_01ec64_encoder.onnx",
                   "16ab73d9c824886f0de2938c19df22fb9ec3deebfd0de58e65177e479213d7d1"),
            _entry("sam_vit_b_01ec64_decoder.onnx",
                   "85d0d672cf5b7fe763edcde429e5533e62f674af4b15c7d688b7673b0ef00bf7"),
        ],
    },
    "rapidraw-u2net": {
        "name": "U-2-Net foreground mask",
        "files": [_entry("u2net.onnx",
                         "8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491")],
    },
    "rapidraw-skyseg": {
        "name": "Sky segmentation (U-2-Net)",
        "files": [_entry("skyseg_u2net.onnx",
                         "ab9c34c64c3d821220a2886a4a06da4642ffa14d5b30e8d5339056a089aa1d39",
                         url_name="skyseg-u2net.onnx")],
    },
    "rapidraw-depth": {
        "name": "Depth Anything V2 ViT-S",
        "files": [_entry("depth_anything_v2_vits.onnx",
                         "d2b11a11c1d4a12b47608fa65a17ee9a4c605b55ee1730c8e3b526304f2562be")],
    },
    "rapidraw-denoise": {
        "name": "NIND RGB denoise (UTNet 684)",
        "files": [_entry("nind_denoise_utnet_684.onnx",
                         "ee3586279d514df557ff3f7dec6df37fafc51ba5d3a3435b2cc9ac2d9017e7fe")],
    },
    "rapidraw-clip": {
        "name": "CLIP zero-shot tagging",
        "files": [_entry("clip_model.onnx",
                         "57879bb1c23cdeb350d23569dd251ed4b740a96d747c529e94a2bb8040ac5d00")],
    },
    "rapidraw-lama": {
        "name": "LaMa inpainting (fp16 weights, f32 I/O)",
        "files": [_entry("lama_fp16.onnx",
                         "2d6be6277c400d6f1b91819737f7c3da935e5c63d1b521d393be1196a2bfa82c")],
    },
    "rapidraw-normal": {
        "name": "MoGe-2 ViT-S surface normals",
        "files": [_entry("moge-2-vits-normal-onnx.onnx",
                         "24eacb5dc7a2c54c7bc98f7de085ffbed79ad006ea5b664c2c2cdc02ff3a52f0")],
    },
}


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        with urllib.request.urlopen(url) as resp, tmp_path.open("wb") as out:
            shutil.copyfileobj(resp, out)
        tmp_path.replace(dest)
    finally:
        tmp_path.unlink(missing_ok=True)


def provision(root: Path, only, check: bool) -> int:
    failures = 0
    for model_id, pack in sorted(MANIFEST.items()):
        if only and model_id not in only:
            continue
        model_dir = root / model_id
        for fname, want_hash, url_name in pack["files"]:
            dest = model_dir / fname
            if dest.exists() and sha256_of(dest) == want_hash:
                print(f"ok      {model_id}/{fname}")
                continue
            if check:
                print(f"MISSING {model_id}/{fname}")
                failures += 1
                continue
            print(f"fetch   {model_id}/{fname} ...", flush=True)
            try:
                fetch(f"{HF}/{url_name}?download=true", dest)
            except OSError as exc:
                print(f"FAILED  {model_id}/{fname}: {exc}")
                failures += 1
                continue
            if sha256_of(dest) != want_hash:
                print(f"FAILED  {model_id}/{fname}: hash mismatch after download")
                dest.unlink(missing_ok=True)
                failures += 1
                continue
            print(f"fetched {model_id}/{fname}")
        config = model_dir / "config.json"
        if (model_dir / (pack["files"][0][0])).exists():
            config.write_text(json.dumps({"id": model_id, "name": pack["name"]}) + "\n")
    return failures


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    default_root = Path.home() / ".local/share/darktable/models"
    ap.add_argument("--models-root", type=Path, default=default_root,
                    help=f"worker models root (default: {default_root})")
    ap.add_argument("--only", nargs="*", default=[],
                    help="restrict to these pack ids (default: all)")
    ap.add_argument("--check", action="store_true",
                    help="verify only; do not download")
    args = ap.parse_args(argv)

    if args.models_root.name == ".." or not str(args.models_root).strip():
        ap.error("refusing unusual models root")
    root: Path = args.models_root.expanduser()
    failures = provision(root, set(args.only), args.check)
    if failures:
        print(f"{failures} problem(s); packs under {root}", file=sys.stderr)
        return 1
    print(f"models root ready: {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
