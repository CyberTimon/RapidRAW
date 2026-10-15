# Vendored darktable remote AI worker

`remote_worker.py` and `test_remote_worker.py` are unmodified copies of the
darktable remote ONNX inference worker (wire protocol v1) that RapidRAW's
`src-tauri/src/remote_ai.rs` client speaks.

- Upstream project: darktable (https://github.com/darktable-org/darktable),
  `tools/ai/remote_worker.py`, GPLv3.
- Copies taken from the feature fork `joshuaswarren/darktable`,
  branch `feature/remote-ai`, commit `73af95a` ("Support Core ML GPU
  inference in the remote worker"), local checkout
  `~/.local/opt/photo-apps/darktable-src`.
- The worker is loopback-only; SSH provides authentication and encryption.
  It loads only models already present in its `--models-root`, resolved by
  basename with symlinks confined to the root.

RapidRAW itself remains a closed distribution as before; these copies are
provided so the GPU host can run the worker plus the RapidRAW model packs
provisioned by `../provision_models.py` without a darktable checkout.
