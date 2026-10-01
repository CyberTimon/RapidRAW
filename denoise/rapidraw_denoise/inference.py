"""Memory-bounded RAW inference with a frozen photometric noise profile."""
import torch
from .pipeline import TilePredictor, denoise_with_predictor, tiled_apply
from .vendor.nonlocalmf.network import SimpleBlockMatchingUNet

__all__ = ["load_model", "tiled_apply", "denoise", "TorchTilePredictor", "SimpleBlockMatchingUNet"]


def load_model(checkpoint, device="cuda"):
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; select --device cpu explicitly for a small diagnostic run")
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    state = state.get("state_dict", state)
    # Only pure tensor checkpoints are supported by the runtime.
    if not all(isinstance(v, torch.Tensor) for v in state.values()):
        raise ValueError("Convert the research checkpoint to a pure tensor state dict first")
    state = {k.removeprefix("network.").removeprefix("model."): v for k, v in state.items()}
    model = SimpleBlockMatchingUNet(input_channels=8, output_channels=4, n_features=32)
    model.load_state_dict(state, strict=True)
    return model.eval().to(device)


class TorchTilePredictor(TilePredictor):
    def __init__(self, model):
        self.model = model
        self.device = next(model.parameters()).device
        if self.device.type == "cuda":
            torch.cuda.reset_peak_memory_stats(self.device)

    def predict(self, tile_array):
        import numpy as np
        with torch.inference_mode():
            x = torch.from_numpy(tile_array[None]).to(self.device)
            y = self.model(x)
            return y[0].float().cpu().numpy()

    def execution_info(self):
        import torch as _torch
        device = self.device
        return {"torch": _torch.__version__, "device": str(device),
                "parameters": sum(p.numel() for p in self.model.parameters()),
                "peak_tensor_vram_bytes": torch.cuda.max_memory_allocated(device) if device.type == "cuda" else 0,
                "peak_reserved_vram_bytes": torch.cuda.max_memory_reserved(device) if device.type == "cuda" else 0}


@torch.inference_mode()
def denoise(packed, model, profile=None, tile=256, halo=40, noise_scale=1., pilot=False, progress=None, row_correction=False):
    return denoise_with_predictor(packed, TorchTilePredictor(model), profile, tile, halo, noise_scale, pilot, progress, row_correction)
