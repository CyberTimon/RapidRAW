# AI model bundle used by RapidRAW

RapidRAW downloads its AI model files into the application's data directory on first AI use. These files are deliberately **not bundled into the executable** so the installed app can stay small.

## Active models

| Feature | Model / export | Approximate weight size | Runtime |
|---|---|---:|---|
| Subject, foreground, and sky masks | SAM 3 image encoder, text encoder, and geometry/mask decoder, Q4F16 ONNX exports | 590 MB combined | ONNX Runtime from Rust |
| Depth masks | Depth Anything 3 Small ONNX | 101 MB | ONNX Runtime from Rust |

The chosen SAM 3 ONNX files come from the [SAM 3 ONNX export release](https://github.com/jamjamjon/assets/releases/tag/sam3). Their SHA-256 digests are pinned in `src-tauri/src/ai_processing.rs`. The Depth Anything 3 Small ONNX file is fetched from [zerochocobo/DepthAnything3_ONNX](https://huggingface.co/zerochocobo/DepthAnything3_ONNX/blob/main/da3_small.onnx) and checksum-verified before use.

## Hardware behavior

- Inference is local and uses the CPU execution provider by default, so it does not require an NVIDIA GPU or CUDA installation. An integrated GPU is not required for model inference.
- WGPU remains the independent interactive-preview renderer. This model change does not remove or bypass it.
- Each SAM 3 call processes one image, caches the image embeddings, and only upsamples the winning mask. That keeps peak memory lower than upscaling every SAM 3 proposal.
- SAM 3 is still a large model. Its Q4F16 exports reduce disk/RAM requirements, but first use downloads roughly 700 MB of assets and larger photographs consume additional activation memory. 16 GB RAM is a practical target, not a guarantee for every driver, OS, and source image.
- Downloads are lazy and feature-specific: segmentation downloads roughly 590 MB of SAM 3 ONNX weights, while depth estimation downloads the separate ~101 MB DA3 Small file. Using only one feature does not download the other model family.
- When the replacement model has loaded successfully, known obsolete model files (SAM 2, U²-Net/skyseg, Depth Anything V2) are deleted from RapidRAW's private model cache to avoid wasting disk space. User images and other files are not touched.
- The main app binary size and model-download size are separate budgets. A 20 MB app target does not mean a 20 MB AI model.

## Licensing

Review the upstream license terms for each model before redistributing or using it commercially: [Meta SAM 3](https://github.com/facebookresearch/sam3) and [Depth Anything 3](https://github.com/ByteDance-Seed/Depth-Anything-3). The selected Depth Anything 3 Small model is listed upstream as Apache-2.0. Model weights and ONNX exports are fetched separately from the application code.
