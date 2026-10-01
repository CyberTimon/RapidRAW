from .common import require_space

require_space()
from pathlib import Path
import argparse, json, time
import numpy as np
import torch
from scipy.ndimage import gaussian_filter
from rapidraw_denoise.raw import sha256
from rapidraw_denoise.inference import load_model
from rapidraw_denoise.study.transforms import transform, inverse_transform
from rapidraw_denoise.benchmark import metrics
from .common import ROOT, STUDY


def extra_metrics(ref, out):
    result = metrics(ref, out)
    high_ref = ref - gaussian_filter(ref, (0, 1, 1))
    high_out = out - gaussian_filter(out, (0, 1, 1))
    result["highpass_rmse"] = float(np.sqrt(np.mean((high_ref - high_out) ** 2)))
    result["mean_abs_bias"] = float(np.mean(np.abs((out - ref).mean((1, 2)))))
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--split", choices=["validation", "test"], required=True)
    p.add_argument("--mode", choices=["screen", "compare"], default="screen")
    p.add_argument(
        "--checkpoint", type=Path, default=ROOT / "models/nonlocal-raw-weights.pt"
    )
    p.add_argument("--candidate", type=Path)
    p.add_argument("--output", required=True)
    a = p.parse_args()
    torch.set_num_threads(4)
    folder = STUDY / f"patches-{a.split}"
    while not (folder / "manifest.json").exists() or not json.loads(
        (folder / "manifest.json").read_text()
    ).get("complete"):
        time.sleep(3)
    manifest = json.loads((folder / "manifest.json").read_text())
    out = STUDY / a.output
    out.mkdir()
    model = load_model(a.checkpoint)
    candidate = load_model(a.candidate) if a.candidate else None
    report = {
        "split": a.split,
        "mode": a.mode,
        "checkpoint_sha256": sha256(a.checkpoint),
        "candidate_sha256": sha256(a.candidate) if a.candidate else None,
        "patch_manifest_sha256": sha256(folder / "manifest.json"),
        "records": [],
        "complete": False,
    }
    start = time.monotonic()
    torch.cuda.reset_peak_memory_stats()

    @torch.inference_mode()
    def predict(x, m, i):
        transformed = transform(x, i).copy()
        result = m(torch.from_numpy(transformed[None]).cuda())[0].cpu().numpy()
        return inverse_transform(result, i).copy()

    for j, case in enumerate(manifest["records"]):
        z = np.load(folder / case["path"])
        image = np.clip(z["observed"], 0, 1)
        shot = z["shot"][:, None, None]
        read = z["read"][:, None, None]
        sigma = np.sqrt(
            np.maximum(shot * np.maximum(z["observed"], 0) + read, 1e-12)
        ).astype(np.float32)
        ref = z["reference"][:, 64:-64, 64:-64]
        gain = z["gain"]
        offset = z["offset"]
        preds = {}
        x = np.concatenate([image, sigma])
        base = predict(x, model, 0)
        preds["baseline"] = base
        if a.mode == "screen":
            for scale in [0.8, 0.9, 1.1]:
                preds[f"scale-{scale}"] = predict(
                    np.concatenate([image, sigma * scale]), model, 0
                )
            members = [base] + [predict(x, model, i) for i in range(1, 8)]
            preds["rotation4"] = np.mean(members[:4], axis=0)
            preds["flip2"] = np.mean([members[0], members[4]], axis=0)
            preds["ensemble8"] = np.mean(members, axis=0)
        else:
            preds["ensemble8"] = np.mean(
                [base] + [predict(x, model, i) for i in range(1, 8)], axis=0
            )
            if candidate:
                members = [predict(x, candidate, i) for i in range(8)]
                preds["adapted"] = members[0]
                preds["adapted8"] = np.mean(members, axis=0)
        record = {
            k: case[k] for k in ["scene", "kind", "level", "crop", "region", "path"]
        }
        record["input"] = extra_metrics(
            ref, ((z["observed"] - offset) / gain)[:, 64:-64, 64:-64]
        )
        record["scores"] = {}
        arrays = {
            "reference": ref,
            "input": ((z["observed"] - offset) / gain)[:, 64:-64, 64:-64],
        }
        for name, pred in preds.items():
            normalized = ((pred - offset) / gain)[:, 64:-64, 64:-64]
            if not np.isfinite(normalized).all():
                raise ValueError("Nonfinite prediction")
            record["scores"][name] = extra_metrics(ref, normalized)
            if name in ["baseline", "ensemble8", "adapted", "adapted8"]:
                arrays[name] = normalized
        np.savez_compressed(out / case["path"], **arrays)
        report["records"].append(record)
        if j % 8 == 0:
            report["elapsed_seconds"] = time.monotonic() - start
            report["peak_tensor_vram_bytes"] = torch.cuda.max_memory_allocated()
            (out / "results.json").write_text(json.dumps(report, indent=2))
            print(
                json.dumps(
                    {
                        "completed": j + 1,
                        "total": len(manifest["records"]),
                        "scene": case["scene"],
                        "seconds": time.monotonic() - start,
                        "vram_mib": torch.cuda.max_memory_allocated() / 1024**2,
                    }
                ),
                flush=True,
            )
    report["complete"] = True
    report["elapsed_seconds"] = time.monotonic() - start
    (out / "results.json").write_text(json.dumps(report, indent=2))
    print("COMPLETE", flush=True)


if __name__ == "__main__":
    main()
