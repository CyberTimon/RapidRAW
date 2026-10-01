import numpy as np
import pytest
from rapidraw_denoise.worker import validate_request, ALGORITHM, CHECKPOINT_SHA256
from rapidraw_denoise.inference import tiled_apply


def request(**overrides):
    return dict(protocol=1, algorithm=ALGORITHM, model_sha256=CHECKPOINT_SHA256,
                shape=[4, 128, 256], tile=320, halo=40) | overrides


@pytest.mark.parametrize("override", [
    {"shape": [4, 2**64, 16]}, {"shape": [4, 0, 32]}, {"shape": [3, 16, 16]},
    {"shape": [4, 16., 16]}, {"shape": [4, 7, 32]},
    {"model_sha256": "wrong"}, {"protocol": 2}, {"halo": 0}, {"halo": 64},
])
def test_invalid_protocol_fails_before_loading_model(override):
    with pytest.raises(ValueError):
        validate_request(request(**override))


def test_protocol_and_tile_progress_preserve_pixels():
    assert validate_request(request()) == (4, 128, 256)
    image = np.random.default_rng(41).normal(size=(4, 83, 71)).astype(np.float32)
    progress = []
    output = tiled_apply(image, lambda x: x, tile=32, halo=8,
                         progress=lambda done, total: progress.append((done, total)))
    assert np.array_equal(output, image)
    assert [done for done, total in progress] == list(range(1, len(progress) + 1))
    assert all(total == len(progress) for done, total in progress)
