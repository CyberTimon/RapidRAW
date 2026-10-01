# Reproduce the expanded GPU quality study

Use this study to decide whether a change improves RAW reconstruction across scenes before adopting it. It compares noise conditioning, transform averaging, sampling-grid sensitivity and two controlled fine-tuning losses. The desktop denoiser is unaffected, and ONNX conversion is outside this workflow.

## Data and separation

The [quality-study manifest](configs/rawnind-quality-study.json) fixes 40 RawNIND scenes: 16 for adaptation, 12 for validation and 12 for held-out testing. Downloads total about 2.42 GiB and are verified against the published checksums. The training scenes are from a Sony A7C; validation and test include other cameras, but this is **not camera-disjoint training**. Upstream pretraining overlap is unknown.

Each evaluation scene contributes four content-selected regions: texture, shadow, flat area and centre. Three fixed synthetic noise levels give 144 cases per evaluation split. Real pairs are retained only after registration and exposure-fit checks; fractional residual shifts above 0.25 packed pixels are excluded. The current data preparation retains eight real pairs per split, adding 32 cases. The fixed centre can coincide with a content-selected region; inspect recorded origins and distinguish case counts from unique locations. Low-ISO references retain noise and registration error, so these are research diagnostics, not official benchmark scores.

Crops contain 384 × 384 packed RAW pixels; scoring uses the central 256 × 256 with a 64-pixel context border. Metrics include RAW and edge PSNR, flat-region error, channel bias and high-frequency error. Scene means receive equal weight; confidence intervals resample scenes, not individual pixels. The gamma-domain metric measures transformed sensor planes, not a rendered perceptual score.

## Prepare an isolated workspace

Install the package and verified CUDA sampler as described in the [installation guide](README.md). From the `denoise` directory, use a new experiment workspace on the GPU host:

```sh
export RAPIDRAW_DENOISE_STUDY_ROOT=/path/to/denoise-study
export RAPIDRAW_DENOISE_SAMPLER=cuda
export OPENBLAS_NUM_THREADS=4
mkdir -p "$RAPIDRAW_DENOISE_STUDY_ROOT/quality-study"
cp configs/rawnind-quality-study.json \
  "$RAPIDRAW_DENOISE_STUDY_ROOT/quality-study/dataset-manifest.json"
.venv/bin/python -m rapidraw_denoise.fetch_model \
  "$RAPIDRAW_DENOISE_STUDY_ROOT/models"
.venv/bin/python -m rapidraw_denoise.datasets \
  configs/rawnind-quality-study.json "$RAPIDRAW_DENOISE_STUDY_ROOT/data"
.venv/bin/python -m rapidraw_denoise.study.prepare --split train
.venv/bin/python -m rapidraw_denoise.study.prepare --split validation
.venv/bin/python -m rapidraw_denoise.study.prepare --split test
```

Keep at least 20 GiB free beyond planned inputs and outputs. Allow another 10 GiB for patches, predictions and checkpoints; full-resolution photo comparisons need separate space. Reuse verified source/model caches where available. `prepare --resume` skips completed scenes in its existing manifest. Other output directories must be new. Do not delete prior experiment evidence to reuse a name.

Preparation may construct test crops before selection; do not inspect their outputs or use them to tune the model. The scripts record input hashes, synthetic-noise seeds and pair exclusions. See [RawNIND attribution and licensing](README.md#evaluate-and-train) before distributing images or derived data.

## Run validation and controlled adaptation

Run GPU jobs sequentially to avoid competing for VRAM:

```sh
.venv/bin/python -m rapidraw_denoise.study.evaluate \
  --split validation --mode screen --output validation-screen
.venv/bin/python -m rapidraw_denoise.study.phase
.venv/bin/python -m rapidraw_denoise.study.train --output train-control
.venv/bin/python -m rapidraw_denoise.study.train --detail 0.15 --output train-detail
.venv/bin/python -m rapidraw_denoise.study.candidates
.venv/bin/python -m rapidraw_denoise.study.context
.venv/bin/python -m rapidraw_denoise.study.summarize \
  "$RAPIDRAW_DENOISE_STUDY_ROOT/quality-study/validation-candidates/results.json"
```

Both adaptation runs start from identical weights and random seeds. They use 1,600 steps, batch size two, 128-pixel packed crops, exposure variation, Poisson-Gaussian noise and 10% lognormal noise-map jitter. AdamW uses a cosine learning rate from 3e-6 to 3e-7. The control minimizes RAW L1; the second adds a spatial-gradient L1 term with weight 0.15. Neither uses perceptual or adversarial losses.

Checkpoint selection uses 24 fixed validation crops. Initialization remains eligible; a new checkpoint must improve mean PSNR without a crop regression exceeding 0.20 dB. Full validation follows this preliminary gate. If a run keeps the initial weights, the candidate evaluator verifies tensor equality and reuses the corresponding baseline metrics.

The phase experiment uses shifted patch predictions only within their valid interior. It is an ablation, not a production wrapping operation. The green-plane swap experiment is also an ablation, not a physically exact rotation of a Bayer mosaic. The context experiment checks tile convergence against a larger direct prediction; that prediction is a numerical reference, not clean ground truth.

## Optional camera-diversity follow-up

The [camera supplement](configs/rawnind-camera-supplement.json) adds eight training scenes (about 144 MiB). Combined with the initial scenes, it provides 24 training scenes across five identified camera models and one unidentified CRW group. Validation and test scenes remain unchanged. This follow-up tests camera coverage after a Sony-only adaptation regresses; it does not establish camera-disjoint generalization.

```sh
cp configs/rawnind-camera-supplement.json \
  "$RAPIDRAW_DENOISE_STUDY_ROOT/quality-study/supplement-manifest.json"
.venv/bin/python -m rapidraw_denoise.datasets \
  configs/rawnind-camera-supplement.json "$RAPIDRAW_DENOISE_STUDY_ROOT/data"
.venv/bin/python -m rapidraw_denoise.study.supplement
.venv/bin/python -m rapidraw_denoise.study.train --output train-balanced \
  --training-directory "$RAPIDRAW_DENOISE_STUDY_ROOT/quality-study/patches-camera" \
  --camera-balanced
.venv/bin/python -m rapidraw_denoise.study.candidates \
  --names balanced --output validation-balanced
```

This arm samples camera groups uniformly, then samples a crop within that group. Its seed, loss, noise synthesis, step budget and optimizer match the control. Run it before freezing selection or viewing held-out model results. The supplement reuses the original training patches and retains its own manifest.

## Freeze selection before held-out evaluation

Choose a checkpoint and ensemble using validation only. Require positive mean RAW and edge PSNR changes, examine scene regressions and flat-region error, and inspect native renderings before product adoption. Record the rationale and actual checkpoint SHA-256 in `quality-study/selection.json`:

```json
{
  "frozen": true,
  "checkpoint": "/path/to/denoise-study/models/nonlocal-raw-weights.pt",
  "checkpoint_sha256": "REPLACE_WITH_ACTUAL_SHA256",
  "ensemble": 4,
  "tile": 320,
  "halo": 40,
  "reason": "Replace with the measured validation decision"
}
```

Then run the held-out evaluation once:

```sh
.venv/bin/python -m rapidraw_denoise.study.test
.venv/bin/python -m rapidraw_denoise.study.summarize \
  "$RAPIDRAW_DENOISE_STUDY_ROOT/quality-study/held-out/results.json"
```

The evaluator verifies the selected checkpoint hash and records the selection-file hash. It runs direct predictions on the specified patches: `tile` and `halo` record the intended full-frame CLI settings and are not exercised by this patch test. Validate those settings separately with the context experiment and full-resolution renders. Further tuning after seeing test results requires a new held-out set. Patch metrics do not validate full-image tiling, memory use or photographic quality: render untouched RAWs through the production CLI, compare with matched processing at native resolution, and inspect texture, shadows, colour, highlights and seams. No commercial parity claim follows from passing these checks.

## Observed patch-study outcome

In the completed expanded study, the selected configuration retained the released checkpoint, noise scale 1.0 and four-rotation averaging. Neither the RAW-L1 run, the gradient-loss run nor the camera-balanced run passed the checkpoint replacement gate after 1,600 steps each. This is evidence against adopting those adaptations, not evidence that further training cannot help.

Held-out scene-balanced RAW PSNR (dB), compared with a single prediction:

| Conditions      | One pass | Four rotations | Change | 95% scene-bootstrap interval |
| --------------- | -------: | -------------: | -----: | ---------------------------: |
| Synthetic noise |   54.644 |         54.706 | +0.063 |             [+0.045, +0.087] |
| Real pairs      |   51.648 |         51.689 | +0.041 |             [+0.025, +0.063] |

Every held-out scene mean improved; individual crops did not all improve. The worst crop changes were -0.130 dB for synthetic noise and -0.041 dB for real pairs. Removing the exact duplicate real-pair crop gives a +0.041 dB scene-balanced change, consistent with the primary result. Edge PSNR also improves on average. These are small gains and do not establish a visibly transformative result or commercial parity.

Eight-transform averaging did not materially improve validation over four rotations. Lowering noise conditioning damaged reconstruction accuracy, and larger tile context changed mean validation PSNR by about 0.00001 dB. These results supported the original 320/64 tile/halo settings. Production has since moved to a 40-pixel halo (see the [README](README.md)) and no longer offers four-rotation averaging, which remains available only to this research study. Full-resolution photographic inspection remains a separate acceptance step; ONNX conversion has not been performed.
