from .common import require_space

require_space()
from pathlib import Path
import json, time, numpy as np, torch
from rapidraw_denoise.inference import load_model
from rapidraw_denoise.study.transforms import transform, inverse_transform
from rapidraw_denoise.raw import sha256
from .evaluate import extra_metrics
from .common import ROOT as R, STUDY as S

selection = json.loads((S / "selection.json").read_text())
assert selection["frozen"]
if selection["ensemble"] not in (1, 4, 8):
    raise ValueError("Frozen ensemble must be 1, 4 or 8")
checkpoint = Path(selection["checkpoint"])
assert sha256(checkpoint) == selection["checkpoint_sha256"]
torch.set_num_threads(4)
out = S / "held-out"
out.mkdir()
folder = S / "patches-test"
manifest = json.loads((folder / "manifest.json").read_text())
assert manifest["complete"]
base = load_model(R / "models/nonlocal-raw-weights.pt")
model = load_model(checkpoint)
same = all(torch.equal(v, base.state_dict()[k]) for k, v in model.state_dict().items())
report = {
    "complete": False,
    "selection_sha256": sha256(S / "selection.json"),
    "test_manifest_sha256": sha256(folder / "manifest.json"),
    "split": "test",
    "records": [],
    "patch_contract": "384 packed input; central 256 packed scoring; 64 context border. Real output uses frozen input-derived exposure fit. Full-frame tiling convergence assessed separately.",
}
start = time.monotonic()


@torch.inference_mode()
def predict(m, x, i):
    return inverse_transform(
        m(torch.from_numpy(transform(x, i).copy()[None]).cuda())[0].cpu().numpy(), i
    ).copy()


for j, c in enumerate(manifest["records"]):
    z = np.load(folder / c["path"])
    obs = z["observed"]
    sigma = np.sqrt(
        np.maximum(
            z["shot"][:, None, None] * np.maximum(obs, 0) + z["read"][:, None, None],
            1e-12,
        )
    ).astype(np.float32)
    x = np.concatenate([np.clip(obs, 0, 1), sigma])
    ref = z["reference"][:, 64:-64, 64:-64]
    b = predict(base, x, 0)
    members = [b if same else predict(model, x, 0)] + [
        predict(model, x, i) for i in range(1, selection["ensemble"])
    ]
    preds = {"baseline": b, "quality": np.mean(members, axis=0)}
    row = {k: c[k] for k in ["scene", "kind", "level", "crop", "region", "path"]}
    arrays = {
        "reference": ref,
        "input": ((obs - z["offset"]) / z["gain"])[:, 64:-64, 64:-64],
    }
    row["input"] = extra_metrics(ref, arrays["input"])
    row["scores"] = {}
    for name, pred in preds.items():
        normalized = ((pred - z["offset"]) / z["gain"])[:, 64:-64, 64:-64]
        row["scores"][name] = extra_metrics(ref, normalized)
        arrays[name] = normalized
    np.savez_compressed(out / c["path"], **arrays)
    report["records"].append(row)
    if j % 16 == 0:
        (out / "results.json").write_text(json.dumps(report, indent=2))
        print(
            json.dumps({"done": j + 1, "seconds": time.monotonic() - start}), flush=True
        )
report["complete"] = True
report["seconds"] = time.monotonic() - start
(out / "results.json").write_text(json.dumps(report, indent=2))
print("COMPLETE", flush=True)
