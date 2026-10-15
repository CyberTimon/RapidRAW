# Remote AI worker (RapidRAW)

Everything needed to run RapidRAW's AI models on a GPU/CPU host over the
darktable wire protocol v1, independently of a darktable install.

## 1. Provision models (pinned hashes)

```sh
python3 tools/remote/provision_models.py --models-root ~/darktable-models
python3 tools/remote/provision_models.py --models-root ~/darktable-models --check
```

Downloads each RapidRAW ONNX model from the CyberTimon/RapidRAW-Models HF
repo, verifies the same SHA-256 constants the client enforces locally
(`src-tauri/src/ai_processing.rs`), and writes `<models-root>/<id>/config.json`
with a matching `id` — the layout `vendor/remote_worker.py` requires.
Idempotent: verified files are kept, mismatches are re-downloaded.

## 2. Run the worker

```sh
python3 tools/remote/vendor/remote_worker.py --models-root ~/darktable-models
# Apple Silicon: add --gpu-provider coreml
```

Binds 127.0.0.1:8794 (loopback only). Reach it through an SSH tunnel:

```sh
ssh -N -L 8794:127.0.0.1:8794 gpu-host &
```

The worker accepts at most **4** concurrent model connections, each held for
the socket's lifetime. RapidRAW's client therefore keeps at most
`REMOTE_POOL_CAP = 3` live sessions (lazy connect, LRU eviction) and leaves
one slot of headroom for the transient sensor-RAW/upscale connections.
`config.json` may mark files `cpu_only` per pack exactly as darktable does.
The client sends an explicit `opt: 0` (all graph optimizations).

## 3. Point RapidRAW at it

Settings → Processing → Generative AI: set the endpoint (numeric loopback
HOST:PORT only) and enable **Run all AI remotely**. While enabled, no local
ORT sessions are created and no model weights are downloaded or checked
(the CLIP tokenizer stays a local asset); endpoint failures are returned
to the caller, never a local fallback. Changes to the mode or endpoint
invalidate cached AI models before the next request.

## 4. Verify

Offline (no worker needed):

```sh
(cd src-tauri && cargo test --lib)
python3 tools/remote/vendor/test_remote_worker.py
```

Real worker, explicit CPU session (no GPU contention):

```sh
cd src-tauri
RAPIDRAW_REMOTE_SMOKE_ENDPOINT=127.0.0.1:8794 \
  cargo test --lib live_worker_normal_smoke -- --ignored --nocapture
```

This check runs the provisioned `rapidraw-normal` MoGe model with an image
and a rank-0 token-count tensor. It checks the named normal output.

## Provenance

`vendor/` contains the GPLv3 darktable worker and tests with scalar-tensor
support. See `vendor/ATTRIBUTION.md` for the source commit and changes.
