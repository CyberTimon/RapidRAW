"""Host-side refactor check: NEW pipeline-based denoise vs PRISTINE release code.

Release package == frozen HEAD (verified byte-identical). Same Torch/cuDNN
environment, same model, controlled CPU/reference setting.
"""
import sys

import numpy as np

sys.path.insert(0, "/mnt/cache/rapidraw/releases/nonlocal-native-20260916/denoise")
import rapidraw_denoise.inference as frozen  # noqa: E402

sys.path.pop(0)
sys.path.insert(0, "/tmp/nlx-pkg")
import rapidraw_denoise.inference as new  # noqa: E402

from rapidraw_denoise.noise import NoiseProfile  # noqa: E402

CKPT = "/mnt/data/rapidraw/denoise-research/models/nonlocal-raw-weights.pt"
profile = NoiseProfile(shot=[0.002] * 4, read=[0.00003] * 4, diagnostics=[])
packed = np.random.default_rng(9).uniform(-0.05, 0.9, size=(4, 96, 96)).astype(
    np.float32
)

fm = frozen.load_model(CKPT, device="cpu")
nm = new.load_model(CKPT, device="cpu")
fo, _, fi = frozen.denoise(packed, fm, profile, tile=64, halo=16)
no, ni = new.denoise(packed, nm, profile, tile=64, halo=16)
print("bitwise equal:", np.array_equal(no, fo))
print("max abs diff:", float(np.abs(no.astype("float64") - fo.astype("float64")).max()))
for key in ("tile", "halo", "noise_scale", "parameters", "device"):
    assert ni[key] == fi[key], key
assert ni["noise_profile"] == fi["noise_profile"]
print("info keys match")
