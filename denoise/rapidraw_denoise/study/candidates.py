from .common import require_space

require_space()
import json, time
import numpy as np
import torch
from rapidraw_denoise.inference import load_model
from rapidraw_denoise.study.transforms import transform, inverse_transform
from rapidraw_denoise.raw import sha256
from .evaluate import extra_metrics
from .common import ROOT as R, STUDY as S

torch.set_num_threads(4)
import argparse

parser = argparse.ArgumentParser()
parser.add_argument(
    "--names",
    nargs="+",
    default=["control", "detail"],
    choices=["control", "detail", "balanced"],
)
parser.add_argument("--output", default="validation-candidates")
args = parser.parse_args()
out = S / args.output
out.mkdir()
vd = S / "patches-validation"
manifest = json.loads((vd / "manifest.json").read_text())
base = json.loads((S / "validation-screen/results.json").read_text())
assert base["complete"]
models = {name: load_model(S / f"train-{name}/best.pt") for name in args.names}
initial = load_model(R / "models/nonlocal-raw-weights.pt")
unchanged = {
    name: all(
        torch.equal(v, initial.state_dict()[k]) for k, v in model.state_dict().items()
    )
    for name, model in models.items()
}
del initial
report = {
    "complete": False,
    "split": "validation",
    "checkpoint_sha256": {name: sha256(S / f"train-{name}/best.pt") for name in models},
    "patch_manifest_sha256": sha256(vd / "manifest.json"),
    "records": [],
}
start = time.monotonic()


@torch.inference_mode()
def predict(model, x, i):
    y = model(torch.from_numpy(transform(x, i).copy()[None]).cuda())[0].cpu().numpy()
    return inverse_transform(y, i).copy()


for j, (case, base_record) in enumerate(zip(manifest["records"], base["records"])):
    assert case["path"] == base_record["path"]
    z = np.load(vd / case["path"])
    sigma = np.sqrt(
        np.maximum(
            z["shot"][:, None, None] * np.maximum(z["observed"], 0)
            + z["read"][:, None, None],
            1e-12,
        )
    ).astype(np.float32)
    x = np.concatenate([np.clip(z["observed"], 0, 1), sigma])
    ref = z["reference"][:, 64:-64, 64:-64]
    record = {
        k: base_record[k]
        for k in ["scene", "kind", "level", "crop", "region", "path", "input"]
    }
    record["scores"] = {
        k: base_record["scores"][k] for k in ["baseline", "rotation4", "ensemble8"]
    }
    arrays = {}
    for name, model in models.items():
        if unchanged[name]:
            record["scores"][name] = base_record["scores"]["baseline"]
            record["scores"][name + "4"] = base_record["scores"]["rotation4"]
            continue
        members = [predict(model, x, i) for i in range(4)]
        for label, pred in [(name, members[0]), (name + "4", np.mean(members, axis=0))]:
            normalized = ((pred - z["offset"]) / z["gain"])[:, 64:-64, 64:-64]
            record["scores"][label] = extra_metrics(ref, normalized)
            arrays[label] = normalized
    np.savez_compressed(out / case["path"], **arrays)
    report["records"].append(record)
    if j % 16 == 0:
        (out / "results.json").write_text(json.dumps(report, indent=2))
        print(
            json.dumps({"done": j + 1, "seconds": time.monotonic() - start}), flush=True
        )
report["complete"] = True
report["seconds"] = time.monotonic() - start
(out / "results.json").write_text(json.dumps(report, indent=2))
print("COMPLETE", flush=True)
