# HDR Export — Worklog

Running log for the `feat/hdr-export` branch: add true HDR (PQ/HLG) AVIF + JXL export,
BT.2020-tagged, with highlight headroom preserved.

## Phase 0 — Fork, clone, baseline build ✅
- Forked `CyberTimon/RapidRAW` → `KaiserRuben/RapidRAW`, cloned, branch `feat/hdr-export`.
- Toolchain installed on macOS arm64: rustup → rustc/cargo **1.96.0** (edition 2024 OK,
  repo pins rust-version 1.95). `cmake 4.3.3`, `nasm 3.01` (for C encoder deps) via brew.
- License: **AGPL-3.0** — kept intact; new files carry no license-stripping.
- `build.rs` auto-downloads `libonnxruntime.dylib` (macos-aarch64, 33M) from HuggingFace and
  sha256-verifies it at build time — so the `ort` `load-dynamic` runtime lib is handled by the
  build itself (no manual ONNX setup needed).
- **Baseline `cargo build` (debug): PASS** in 5m12s, 17 warnings, 0 errors. `npm install`: OK.

## Phase 1 — Recon (confirmed against checkout) ✅
The 8-bit ceiling is exactly where the brief said, and the headroom is clipped *earlier* than
the final store. Confirmed line numbers:

**`src-tauri/src/shaders/shader.wgsl`**
- L198: `output_texture: texture_storage_2d<rgba8unorm, write>` — 8-bit storage output.
- L1668 / L1675: `linear_to_srgb(composite_rgb_linear)` — the **clamping** sRGB encode
  (`linear_to_srgb` clamps input to [0,1] at L229). **This is the real headroom killer** —
  values above diffuse white (linear > 1.0) are clamped to 1.0 here, *before* the final store.
- L1732: `+ dither(id.xy) * (1.0/255.0)` — 8-bit dither (would add PQ-code noise; skip for HDR).
- L1734: `clamp(final_rgb, 0.0, 1.0)` then `textureStore` — second clamp at the store.
- Internals are linear; `srgb_to_linear` (L220) is the exact inverse of `linear_to_srgb_extended`
  (L237) for c≥0. So: encode with `_extended`, read back, `srgb_to_linear` on CPU → recover
  linear light with headroom.

**`src-tauri/src/gpu_processing.rs`**
- Pipeline is f16 end-to-end except the final texture: input upload `to_rgba_f16` (L484);
  intermediates `Rgba16Float` (L582…L1762); **`blur.wgsl`/`flare.wgsl` already use
  `texture_storage_2d<rgba16float, write>`** → rgba16float storage write is proven on this Metal
  backend (de-risks the format change).
- `GpuProcessor.tile_output_texture` (created L997, fmt `Rgba8Unorm` L1003) and `output_texture`
  (L1026/L1032) — both bound to shader.wgsl's storage output. `main_bgl` hardcodes the storage
  binding format `Rgba8Unorm` at **L796**.
- `main_pipeline` (L910) from `shader.wgsl` (L777).
- `run()` (L1076) ALWAYS tiles; main compute writes to `tile_output_texture`; `read_texture_data_roi`
  (L414, hardcodes `4 * width` bytes/row) reads it back; assembled into `final_pixels: Vec<u8>`
  (`* 4` at L1558/1562) → `processed_pixels` → `DynamicImage::ImageRgba8` (L2016).

**`src-tauri/src/export_processing.rs`**
- `ExportSettings` struct (L58) — serde camelCase; needs new HDR fields.
- `encode_image_to_bytes` (L388): jxl → `jxl_encoder` hardwired Rgb8/Rgba8; avif →
  `image::ImageFormat::Avif` (ravif, 8-bit, no CICP); png/tiff → `to_rgb16()` on 8-bit data.
- `save_image_with_metadata` (L283) calls `encode_image_to_bytes(image, &extension, jpeg_quality)`.
- `process_image_for_export_pipeline` (L214) → `process_and_get_dynamic_image` (GPU).

## Data contract decided
- **GPU/readback (HDR path):** HDR shader variant (string-substituted from `shader.wgsl`):
  `rgba8unorm`→`rgba16float`, `linear_to_srgb`→`linear_to_srgb_extended`, drop the [0,1] store
  clamp (keep `max(·,0)`), zero the dither. Read back rgba16float (8 B/px), f16→f32, then
  `srgb_to_linear` on CPU → `DynamicImage::ImageRgba32F` in **LINEAR scene-referred light,
  diffuse white = 1.0, headroom > 1.0 preserved**. SDR path is byte-for-byte UNTOUCHED (separate,
  lazily-created HDR pipeline + textures + BGL).
- **Encoder (HDR path):** takes linear ImageRgba32F → optional Rec.709→Rec.2020 primaries matrix
  → PQ inverse-EOTF with **203-nit anchor** (`L = linear * 203/10000`) → quantize to 10/12-bit
  full-range → AVIF/JXL with CICP primaries=9, transfer=16(PQ)/18(HLG), matrix=9, full_range=1.

## Phase 1.5 — Verification harness (gate) ✅
`src-tauri/tests/hdr_export.rs` + `hdr.rs` unit tests. Tags + bit depth parsed from raw bytes;
AVIF pixels decoded by `avifdec` (independent of the encoder), JXL by jxl-oxide. Assertions use
**independent** ST.2084 ground-truth literals (de-circularized after an audit caught the original
expected-values being derived from the encoder under test).

## Phase 2 — Implementation ✅
- Encoder spike: **GO** for both. AVIF via pure-Rust `rav1e` + `avif-serialize` (no C deps);
  JXL via `jpegxl-rs` + system libjxl (optional `hdr_jxl` feature).
- 2.1/2.2 GPU: separate lazily-built rgba16float pipeline (SDR untouched). Headroom fix needed
  **five** shader substitutions, not two — an audit-driven GPU end-to-end test revealed the
  tone-curve stage was *still* clamping to [0,1] (the deeper half of the bug the brief warned
  about). With the curve fixes, the GPU recovers linear 3.997 (~4.0) end-to-end.
- 2.3 encoders + 2.4 settings/command/UI wired through `encode_image_to_bytes` and the export panel.

## Result
Gate GREEN: AVIF 10/12-bit + JXL, all four criteria with exact codes (594/669/746, 2378/2679/2986,
JXL 0.5807). Full details, limitations, human-sign-off list, and build commands in **HDR_REPORT.md**.
</content>
</invoke>
