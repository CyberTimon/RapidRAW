# Vendored darktable remote AI worker

`remote_worker.py` and `test_remote_worker.py` derive from the
darktable remote ONNX inference worker (wire protocol v1) that RapidRAW's
`src-tauri/src/remote_ai.rs` client speaks.

- Upstream project: darktable (https://github.com/darktable-org/darktable),
  `tools/ai/remote_worker.py`, GPLv3.
- Copies taken from the feature fork `joshuaswarren/darktable`,
  branch `feature/remote-ai`, commit `73af95a` ("Support Core ML GPU
  inference in the remote worker").
- **Local patch (rank-0 scalars)**: `MIN_RANK` 1→0 so `shape: []`
  descriptors are valid — inputs with `bytes == elemsize`, dynamic scalar
  outputs with `bytes == 0`; the worker reshapes to a true 0-d array and
  replies `shape: []` with exact bytes. Needed for MoGe-2's scalar
  `num_tokens` input. Backward compatible: every rank 1..8 frame is
  unchanged, and workers without the patch reject rank-0 frames loudly
  (fail closed). The darktable upstream proposal includes the same change.
  Vendored `test_remote_worker.py` gained `test_scalar_rank0_descriptors`
  and `test_dynamic_scalar_output_ok`; two rank-0 rejection expectations
  were updated to the new contract.
- The worker is loopback-only; SSH provides authentication and encryption.
  It loads only models already present in its `--models-root`, resolved by
  basename with symlinks confined to the root.

The worker runs as a separate process. These GPLv3 copies let the remote
host serve model packs from `../provision_models.py` without a darktable
checkout.
