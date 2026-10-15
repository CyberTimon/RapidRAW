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
The client always sends an explicit `opt: 0`, so the upstream
`DT_AI_OPT_DEFAULT=-1` opt-range issue does not affect this pairing.

## 3. Point RapidRAW at it

Settings → Processing → Generative AI: set the endpoint (numeric loopback
HOST:PORT only) and enable **Run all AI remotely**. While enabled, no local
ORT sessions are created and no model weights are downloaded or checked
(the CLIP tokenizer stays a local asset); endpoint failures are returned
to the caller — never a local fallback.

## 4. Verify

Offline (no worker needed):

```sh
cd src-tauri && cargo test --lib
python3 tools/remote/vendor/test_remote_worker.py   # worker's own suite
```

Real worker, explicit CPU session (no GPU contention):

```sh
RAPIDRAW_REMOTE_SMOKE_ENDPOINT=127.0.0.1:8794 \
RAPIDRAW_SMOKE_MODEL=upscale-realplksr RAPIDRAW_SMOKE_FILE=model_x2.onnx \
  cargo test --lib live_worker_typed_smoke -- --ignored --nocapture
```

Default model is `upscale-realplksr/model_x2.onnx`; any provisioned pack
works, e.g. `RAPIDRAW_SMOKE_MODEL=rapidraw-u2net RAPIDRAW_SMOKE_FILE=u2net.onnx`
against a local `--models-root` instance.

## Provenance

`vendor/` holds unmodified copies of darktable's `tools/ai/remote_worker.py`
and its tests — see `vendor/ATTRIBUTION.md` (GPLv3, joshuaswarren/darktable
`feature/remote-ai` at commit `73af95a`).
