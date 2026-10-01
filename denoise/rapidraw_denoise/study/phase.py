from .common import require_space

require_space()
import json, time, numpy as np, torch
from .evaluate import extra_metrics
from rapidraw_denoise.inference import load_model
from rapidraw_denoise.study.transforms import transform, inverse_transform
from .common import ROOT, STUDY as S

out = S / "validation-phase"
out.mkdir()
torch.set_num_threads(4)
folder = S / "patches-validation"
manifest = json.loads((folder / "manifest.json").read_text())
baseline = json.loads((S / "validation-screen/results.json").read_text())
byname = {r["path"]: r for r in baseline["records"]}
model = load_model(ROOT / "models/nonlocal-raw-weights.pt")
report = {
    "records": [],
    "complete": False,
    "hypothesis": "The two strided downsampling layers can introduce grid-phase sensitivity. Test pixel-shift averaging and green-plane-aware D8 without model/parameter changes.",
}
start = time.monotonic()


@torch.inference_mode()
def infer(x):
    return (
        model(torch.from_numpy(np.ascontiguousarray(x[None])).cuda())[0].cpu().numpy()
    )


for j, c in enumerate(manifest["records"]):
    z = np.load(folder / c["path"])
    obs = z["observed"]
    ref = z["reference"][:, 64:-64, 64:-64]
    gain = z["gain"]
    offset = z["offset"]
    std = np.sqrt(
        np.maximum(
            z["shot"][:, None, None] * np.maximum(obs, 0) + z["read"][:, None, None],
            1e-12,
        )
    ).astype(np.float32)
    x = np.concatenate([np.clip(obs, 0, 1), std])
    preds = {}
    members = []
    for dy, dx in [(0, 0), (0, 2), (2, 0), (2, 2)]:
        p = infer(np.roll(x, (dy, dx), axis=(1, 2)))
        members.append(np.roll(p, (-dy, -dx), axis=(1, 2)))
    preds["phase4"] = np.mean(members, 0)
    # Green-plane exchange ablation; not a physically exact mosaic rotation.
    members = []
    for i in range(8):
        xx = transform(x, i).copy()
        if i % 2:
            xx = xx[[0, 3, 2, 1, 4, 7, 6, 5]]
        p = infer(xx)
        if i % 2:
            p = p[[0, 3, 2, 1]]
        members.append(inverse_transform(p, i).copy())
    preds["cfa-ensemble8"] = np.mean(members, 0)
    row = byname[c["path"]].copy()
    row["scores"] = {
        k: v for k, v in row["scores"].items() if k in ["baseline", "ensemble8"]
    }
    arrays = {}
    for name, p in preds.items():
        normalized = ((p - offset) / gain)[:, 64:-64, 64:-64]
        row["scores"][name] = extra_metrics(ref, normalized)
        arrays[name] = normalized
    np.savez_compressed(out / c["path"], **arrays)
    report["records"].append(row)
    if j % 16 == 0:
        (out / "results.json").write_text(json.dumps(report, indent=2))
        print(
            json.dumps(
                {
                    "done": j + 1,
                    "total": len(manifest["records"]),
                    "seconds": time.monotonic() - start,
                }
            ),
            flush=True,
        )
report["complete"] = True
(out / "results.json").write_text(json.dumps(report, indent=2))
print("COMPLETE", flush=True)
