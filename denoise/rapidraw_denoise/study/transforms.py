"""Rotation/flip test-time transforms used by the checkpoint-selection study."""
import numpy as np


def transform(x, i):
    x = np.rot90(x, i % 4, axes=(-2,-1))
    return x[..., ::-1] if i >= 4 else x


def inverse_transform(x, i):
    x = x[..., ::-1] if i >= 4 else x
    return np.rot90(x, -(i % 4), axes=(-2,-1))
