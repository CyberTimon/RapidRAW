# Experimental GPU RAW denoising

Process Bayer RAW photographs with a noise-conditioned denoiser, and test improvements using reproducible experiments. RapidRAW's production Nonlocal path runs **in-process through native ONNX Runtime** (CPU or Linux CUDA) or **directly through CoreML.framework on macOS** from a pinned FP32 bundle — no Python, PyTorch, NumPy or SciPy in production. This optional Python package remains as research/export/benchmark tooling: model export and validation, reference inference, and the study CLI. The editor's existing NIND AI denoiser remains the lightweight option.

The GPU path combines the [2026 learned nonlocal model](https://github.com/MIA-UIB/nonlocal-matchfilter) with per-channel blind noise estimation and bounded-memory tiling. Native MCP jobs produce a **Bayer DNG** for RapidRAW's normal demosaic and colour pipeline. The research CLI produces a 16-bit sRGB TIFF, review renders, a floating-point packed RAW tensor and a provenance manifest. Both preserve the original photograph. Commercial parity and state-of-the-art performance have **not** been established.

## Native runtime bundle (production)

Production inference reads an ONNX bundle directory containing `model.onnx` + `manifest.json`. The accepted bundle is identified by model SHA-256 `ba788a97f247058ea03d14bbf2f289adc8f4666039f27d0d530e6f67d23dd73c`, source checkpoint lineage `c16747d852b93a95908792cdbac901f89cca98e35b91ea7db6214de42fbd3cad`, tile 320 / halo 40 / retained core 240 / FP32 / RGBG. The native backend validates this contract fail-closed before inference and rejects any other model hash or tiling. Produce or re-validate bundles with this package's export tooling (`rapidraw_denoise.onnx_export`, `rapidraw_denoise.onnx_rewrite`, `rapidraw_denoise.onnx_validate`); the Python environment below is only needed for that tooling, never for production inference.

Normal setup needs no bundle path: call `install_model` with `kind: "nonlocal"` (selects the bundle for `RAPIDRAW_NONLOCAL_PROVIDER`, default `cuda` on Linux, `coreml` on macOS, and `cpu` on other platforms) and the pinned runtime downloads from the [public model repo](https://huggingface.co/sheldonxxxx/RapidRAW-Nonlocal-Denoise) at a pinned commit with every hash verified. `RAPIDRAW_NONLOCAL_BUNDLE` remains an explicit developer override when set:

```sh
export RAPIDRAW_NONLOCAL_BUNDLE=/path/to/bundle-packed-320-fp32
export RAPIDRAW_NONLOCAL_PROVIDER=cpu
```

Use `cpu`, or `cuda` on a Linux x86_64 host with the pinned NVIDIA runtime pack (recommended — see [ONNX CUDA setup](../docs/mcp/onnx-cuda.md#install-the-pinned-runtime-pack), no `ORT_DYLIB_PATH` needed) or, advanced only, a manual CUDA runtime via `ORT_DYLIB_PATH`. On macOS, `coreml` selects direct native CoreML.framework inference from a pinned `.mlpackage` bundle (see below). There is no provider fallback: `cuda` on an unsupported platform, `coreml` off macOS, or a failing execution provider fails the job explicitly, and CPU never silently substitutes. Graph optimization stays off and CUDA TF32 stays off under the accepted strict policy. Results are cached under the workspace's `nonlocal-onnx-cache`, keyed by backend generation, bundle and checkpoint hashes, provider, ORT build identity and inference configuration; legacy Python-worker cache entries are never reused.

### How the ONNX bundle is derived

The published ONNX model is the FP32 export of the pinned upstream checkpoint with its graph rewritten by `rapidraw_denoise.onnx_rewrite` for faster execution. The rewrite drops the all-zero convolution biases the exporter materialises and runs every dense and grouped 1×1 convolution with at least 256 input channels as a matrix multiplication. It keeps every weight and FP32 arithmetic, and the runtime keeps graph optimization and TF32 off. The rewritten model's manifest records the source export hash and rewrite counts. On an RTX 5060 Ti with the strict policy (no TF32, no graph optimization, cuDNN heuristic search), a 320×320 tile takes about 153 ms instead of 370 ms. The rewritten graph passes the same frozen fixture gates as the unrewritten export on all 18 fixture tiles, on CUDA and on CPU (elementwise |difference| ≤ 1e-4 + 1e-4·|reference|, mean absolute error ≤ 1e-5, 99th-percentile absolute error ≤ 1e-4). CPU was not timed, and CoreML uses a separate model.

To reproduce the bundle, first build the unrewritten source bundle with `rapidraw_denoise.onnx_export` (it needs `--checkpoint`, `--fixtures` and `--output`; its `model.onnx` must hash to `df7f21ddbdfecd0984896a902623f75aa883d25b5f862c49d8c2b3f63a7dd2d9`) or take it from the earlier model-repository revision. Then install the two packages the rewrite needs (the model hash assumes `onnx` 1.23.1; other versions may serialise differently and give a different hash, which the runtime rejects) and derive the bundle. The tool never overwrites an existing output directory, and `--fixtures` adds a first-tile CPU check against the source graph:

```sh
uv pip install --python .venv/bin/python onnx==1.23.1 onnxruntime
.venv/bin/python -m rapidraw_denoise.onnx_rewrite \
  --bundle /path/to/unrewritten-bundle \
  --output /path/to/bundle-packed-gemm-halo40-320-fp32 \
  --fixtures /path/to/fixtures
```

Validate the output before use:

```sh
.venv/bin/python -m rapidraw_denoise.onnx_validate \
  --bundle /path/to/bundle-packed-gemm-halo40-320-fp32 \
  --fixtures /path/to/fixtures --provider cpu --report /path/to/validate-cpu.json
```

[`tests/test_onnx_rewrite.py`](tests/test_onnx_rewrite.py) covers the rewrite.

### Direct CoreML bundle (macOS production)

On macOS, production CoreML inference is native: it uses CoreML.framework directly and does not require Python, coremltools, PyTorch or ONNX Runtime. Prefer `install_model kind="nonlocal"` with `RAPIDRAW_NONLOCAL_PROVIDER=coreml`; to use a manual bundle instead, point `RAPIDRAW_NONLOCAL_BUNDLE` at a directory containing `packed.mlpackage` + `manifest.json`:

```sh
export RAPIDRAW_NONLOCAL_BUNDLE=/path/to/bundle-packed-coreml-fp32
export RAPIDRAW_NONLOCAL_PROVIDER=coreml
```

The accepted bundle is identified by package SHA-256 `ecf8f41b72b8e79a7210f61b13b3a21ad2ddbc79c475039be367fc011a98f5d3`, source checkpoint lineage `c16747d852b93a95908792cdbac901f89cca98e35b91ea7db6214de42fbd3cad`, direct TorchScript conversion (`coremltools-direct-torchscript`, FLOAT32, static-packed sampler), tile 320 / halo 40 / RGBG with `raw_with_noise` [1,8,320,320] input and `denoised_raw` [1,4,320,320] output. The native backend validates this contract fail-closed — including the package digest and a runtime tree hash — before compiling the package to `.mlmodelc` and loading one `MLModel` per job (all compute units, no low-precision GPU accumulation). The Python converter (`rapidraw_denoise` tooling / `denoise/scripts/convert_coreml_direct.py`) remains developer-only artifact tooling, never a production dependency. CoreML predictions are cached under the workspace's `nonlocal-coreml-cache` (protocol 3) and cannot collide with ONNX or legacy worker caches; jobs that predate the native runtimes, and cross-family ONNX↔CoreML resumes, are rejected — start a new denoise job instead.

## Research export environment (not production)

Model export, validation, benchmarking and the study CLI below use Python 3.11+ and a CUDA-enabled PyTorch build compatible with the host GPU. Python 3.13, PyTorch 2.12.0/CUDA 13.0 and an RTX 5060 Ti were used during development. Create a separate environment; do not change another application's environment.

From this directory:

```sh
uv venv --python 3.13
uv pip install --python .venv/bin/python torch==2.12.0 \
  --index-url https://download.pytorch.org/whl/cu130
uv pip install --python .venv/bin/python -e '.[test,download]'
.venv/bin/python -m rapidraw_denoise.fetch_model /path/to/model-cache
```

Paths beginning with `/path/to/` in this guide are placeholders. Model downloading verifies the pinned upstream release checksum, permits only the known metadata classes during conversion, and saves a tensor-only checkpoint for inference. The upstream MIT license and attribution are retained in [vendor/nonlocalmf](rapidraw_denoise/vendor/nonlocalmf/).

The default reference sampler requires no compiler. For faster export-time NVIDIA inference experiments, install the authors' sampling extension in the same environment:

```sh
git clone --branch v0.1.1 --depth 1 \
  https://github.com/MIA-UIB/deform-neighbourhood-sampling.git \
  /path/to/deform-neighbourhood-sampling
CUDA_HOME=/path/to/cuda TORCH_CUDA_ARCH_LIST=12.0 MAX_JOBS=2 \
  uv pip install --python .venv/bin/python --no-build-isolation \
  /path/to/deform-neighbourhood-sampling
```

Set `TORCH_CUDA_ARCH_LIST` for your GPU; `12.0` is the tested Blackwell configuration. The CUDA toolkit must be compatible with the installed PyTorch build. Select the compiled operator with `RAPIDRAW_DENOISE_SAMPLER=cuda`. The reference and CUDA paths should pass the numerical comparison in the test suite before use on another platform. Sampler choice is baked into an exported bundle; production never selects a sampler at runtime.

## Native RAW denoise through MCP

Build RapidRAW with the `mcp` feature and rebuild its MCP server as described in [MCP setup](../mcp/README.md). Select the provider with `RAPIDRAW_NONLOCAL_PROVIDER` in the environment that launches the server if needed (unset defaults to `cuda` on Linux, `coreml` on macOS, and `cpu` on other platforms; see the previous section), then call `rapidraw_install_model` once with `kind: "nonlocal"` to install the verified pinned bundle. `RAPIDRAW_NONLOCAL_BUNDLE` remains an optional developer override pointing at a manual bundle directory. `rapidraw_models` reports bundle and provider configuration separately from runtime execution-provider availability, which is checked when a job starts. macOS CoreML uses the direct CoreML.framework backend; the ORT CoreML execution provider is not used. `start_denoise` never downloads; a missing bundle fails with install guidance.

Open a Bayer RAW on that host, then call:

```json
{
  "session_id": "<opened-session-uuid>",
  "expected_revision": 0,
  "method": "nonlocal",
  "intensity": 100
}
```

Supply the current revision to `rapidraw_start_denoise`. Poll `rapidraw_get_job` with its `job_id`, then continue editing the completed `result_session_id`. The new session contains the source edits captured at submission; later parent edits do not change the job. The original session and original RAW remain intact. Nonlocal cancellation is cooperative at tile boundaries and cannot abort an active ORT or CoreML call; the editing engine remains alive. `resume_job` restarts an interrupted, cancelled or failed job from the captured input; partial tiles are not checkpoints. Cross-family ONNX↔CoreML resume is rejected; legacy worker jobs cannot resume.

- **Intensity**: blend the full prediction with the sensor input, from 0 to 100. Zero writes an identity DNG without inference. Nonlocal defaults to 100; existing NIND/BM3D defaults remain 50.

Predictions are cached under the workspace's `nonlocal-onnx-cache`, keyed by backend generation, bundle and checkpoint hashes, provider, ORT build identity and inference configuration; legacy Python-worker cache entries are never reused. macOS CoreML predictions use the separate `nonlocal-coreml-cache` (protocol 3), keyed by package/tree/checkpoint hashes, compute policy and OS identity. Changing intensity reuses the full prediction. Every cache read verifies the result manifest, dimensions and checksum. Corrupt entries fail explicitly. Completed DNG sessions are independent of this cache; verified prediction directories may be removed while no job is active to reclaim space. There is no automatic cache eviction.

The native path uses fixed 320×320 packed tiles with a 40-pixel halo (240-pixel retained core), one inference pass per tile; a 32.5 MP photograph takes 150 tiles. Sensor planes stay in host RAM, so total RAM still scales with photograph size. Output is uncompressed float32 Bayer DNG to avoid integer requantization, approximately 130 MB for a 32.5 MP active sensor. The session and export copies, prediction cache and temporary buffers require additional storage. Jobs reserve 20 GiB plus estimated working space. Inactive sensor borders are removed with CFA/black-level/crop coordinates adjusted; the normal rendered crop and orientation are retained. Signed samples feed noise estimation, and sensor values above white remain unchanged by the prediction blend.

This first integration is an MCP feature on a configured host. The desktop denoise dialog continues to offer its existing methods. A Mac can open the resulting DNG; automatic desktop-to-server submission, transfer and local Metal inference are not included.

For a native integration check with a real Bayer fixture and a fresh workspace:

```sh
RAPIDRAW_BINARY=/path/to/RapidRAW \
RAPIDRAW_TEST_RAW=/path/to/photo.CR3 \
RAPIDRAW_WORKSPACE=/path/to/new-test-workspace \
node ../mcp/scripts/nonlocal-e2e.mjs
```

Run inside the server's usual headless display environment on Linux. The check exercises native DNG rendering, cancellation/resume, captured edits, cache reuse, standalone DNG opening and reconnect persistence. Review its overview and native-detail PNGs before accepting photographic quality. For decoder transport checks, run the `raw_denoise::tests` Rust tests with the `mcp` feature; the ignored `real_raw_identity_uses_native_developer` test accepts `RAPIDRAW_TEST_RAW` and compares the native floating-point renders.

## Research CLI

```sh
.venv/bin/rapidraw-denoise \
  /path/to/photo.CR3 \
  --checkpoint /path/to/model-cache/nonlocal-raw-weights.pt \
  --output /path/to/results/photo-v1 --tile 320 --halo 40
```

The command works with the default reference sampler. After installing and verifying the optional extension, prefix it with `RAPIDRAW_DENOISE_SAMPLER=cuda` for the faster path. The output directory must be new. The command requires at least 20 GiB free space beyond its estimated outputs. Inference defaults to CUDA and fails if it is unavailable; CPU diagnostic runs require `--device cpu`. Full-resolution arrays stay in host RAM and tiles bound GPU memory. Select smaller tiles if other applications need VRAM. A 320-pixel tile means 640 sensor pixels across, since Bayer channels are packed at half resolution.

`--noise-scale` scales the estimated noise standard deviation; it is not a blend with the original. `--noise-profile` accepts a JSON `NoiseProfile` with four `shot` and four `read` values in RGBG order, where `read` is variance in black-subtracted, white-normalized RAW units. Poorly identified estimates are recorded in the manifest; severely clipped inputs can require a measured profile.

Inspect `original.png` and `denoised.png` at the same native magnification. Open `denoised.tiff` as a new photograph in RapidRAW for further editing. For agent editing, use the existing `rapidraw_open_photo` workflow with the returned TIFF path. The new file has denoising and demosaicing baked in; the original RAW and sidecar remain the authoritative source. Existing RAW adjustments are not copied onto the TIFF.

If RapidRAW runs on a different computer, first copy the TIFF and its manifest to that computer, or use a mounted share. Supply a path accessible to the **RapidRAW host**. This package does not provide automatic remote submission or file transfer.

Both renders use the same LibRaw demosaicing, camera white balance, linear sRGB conversion and explicit sRGB transfer function. TIFFs contain an sRGB ICC profile. The packed `.npy` is scientific sensor data, not a DNG; its CFA layout and black/white levels are recorded in `manifest.json`.

## Evaluate and train

The [research notes](RESEARCH.md) define the hypotheses, experimental limits and promotion criteria. The supplied development manifest uses public RawNIND photographs with published checksums and scene-separated adaptation splits. Preserve its licensing and attribution when sharing data or derived images.

Dataset: [RawNIND, Benoit Brummer and Christophe De Vleeschouwer](https://doi.org/10.14428/DVN/DEQCIM), distributed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) according to the source dataset metadata. Retain the manifest and check any per-file attribution when distributing derivatives.

```sh
.venv/bin/python -m rapidraw_denoise.datasets \
  configs/rawnind-development.json /path/to/data
.venv/bin/python -m rapidraw_denoise.benchmark \
  --manifest configs/rawnind-development.json --data /path/to/data \
  --checkpoint /path/to/model-cache/nonlocal-raw-weights.pt \
  --output /path/to/evaluation --ablations
.venv/bin/python -m rapidraw_denoise.train \
  --manifest configs/rawnind-development.json --data /path/to/data \
  --checkpoint /path/to/model-cache/nonlocal-raw-weights.pt \
  --output /path/to/training --structured --steps 400
.venv/bin/python -m rapidraw_denoise.paired \
  --manifest configs/rawnind-development.json --data /path/to/data \
  --checkpoint /path/to/model-cache/nonlocal-raw-weights.pt \
  --output /path/to/real-pair-evaluation --split test
.venv/bin/python -m pytest tests -q
```

Training keeps initialization as a candidate and only replaces `best.pt` when the validation mean improves without a per-crop regression above 0.20 dB. This narrow metric gate does not establish photographic acceptance. The test split is excluded from training and checkpoint selection. Overlap with upstream pretraining is unknown, so these experiments are not an independent benchmark or a reproduction of the authors' published score.

The real-pair diagnostic registers the input with its low-ISO reference on the packed sensor grid. It freezes an exposure/offset fit from the noisy input and reuses it for output scoring. Fractional residual motion, reference noise and photometric fit error are recorded limitations. It rejects large shifts and poorly constrained exposure fits; its scores are not official RawNIND benchmark results.

The [expanded GPU quality study](STUDY.md) supplies a fixed 40-scene manifest, content-selected crops, two matched fine-tuning experiments and a frozen-selection held-out evaluator. Use it for broader investigation after the small development run.

## Current boundaries

- Bayer RAW input only. X-Trans, monochrome, linear DNG, RGB images and burst fusion need separate backends; use the existing editor options where supported.
- Noise estimation models shot/read noise. Strong banding, hot pixels, spatially varying black offsets and clipping need separate validation. Pilot conditioning and row correction are research ablations, not default quality improvements.
- This backend denoises before conventional demosaicing. Joint learned demosaicing and lens-specific correction remain research directions.
- Native rendered quality, colour and tile seams must be checked on each camera and scene family. Successful execution alone is insufficient.
- Commercial matching requires exports from the same RAWs, comparable processing and blind native-detail review. No such comparison is bundled or claimed.
