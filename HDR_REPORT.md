# HDR (PQ/HLG) AVIF + JPEG XL export — final report

Branch `feat/hdr-export` on fork `KaiserRuben/RapidRAW`. Platform verified: **macOS arm64**,
rustc/cargo 1.96.0. License unchanged (**AGPL-3.0**; the new GPL-3.0 JXL bindings are
copyleft-compatible with AGPL-3.0).

## Status: gate GREEN

The automated harness asserts all four "definition of done" criteria and passes with **exact**
numbers for AVIF (10 & 12 bit) and JPEG XL, plus a GPU end-to-end headroom test:

| check | AVIF 10-bit | AVIF 12-bit | JXL (PQ) |
|---|---|---|---|
| (1) CICP tags | primaries **9**, transfer **16** (PQ) / **18** (HLG), matrix **0**, full-range **1** | same | primaries Rec.2100, transfer **PQ** |
| (2) bit depth (from av1C / codestream) | **10** | **12** | 32-bit float (≥10) |
| (3) 203-nit reference white | code **594** (exp 594, ±2) | **2378** | **0.58069** |
| (4) headroom (406 / 812 nit) | **669 / 746** (strictly increasing) | **2679 / 2986** | **0.6542 / 0.7291** |

GPU end-to-end (real pipeline, white at +2 stops → linear 4.0): SDR path clamps to byte 255;
HDR path recovers linear **3.997** — headroom preserved through the *entire* look stage.

## How it works (data flow)

`linear scene-referred (diffuse white = 1.0, headroom > 1.0)` →
**GPU HDR pipeline** (rgba16float, headroom-preserving) → readback f16 → invert extended sRGB →
`DynamicImage::ImageRgba32F (linear)` → **encoder**: Rec.709→Rec.2020 matrix → PQ/HLG OETF with
the 203-nit anchor (`L = linear·203/10000`) → quantize 10/12-bit full-range → AVIF/JXL + CICP tags.

The 8-bit SDR path is **completely untouched** — HDR uses a *separate, lazily-built* rgba16float
pipeline + textures, so SDR output is byte-for-byte unchanged and SDR-only sessions allocate
nothing extra.

## Files changed and why

**Backend (`src-tauri/`):**
- `Cargo.toml` — add `rav1e 0.8.1` + `avif-serialize 0.8.9` (AVIF, always on); `jpegxl-rs 0.14` +
  `jpegxl-sys 0.12` behind optional `hdr_jxl` feature (JXL). New `[features] hdr_jxl`.
- `src/hdr.rs` *(new)* — single source of the color science: pinned ST.2084 PQ inverse-EOTF/EOTF,
  BT.2100 HLG OETF, extended-sRGB↔linear (exact inverse of the shader), BT.2087 709→2020 matrix,
  CICP mapping, full-range quantization, synthetic test image, `encode_avif_hdr`, `encode_jxl_hdr`,
  and unit tests pinning the math.
- `src/lib.rs` — `pub mod hdr;`.
- `src/gpu_processing.rs` — the 8-bit ceiling fix. Extracted `build_main_bgl(device, format)`
  (shared by SDR/HDR so the layouts can't drift); `hdr_shader_source()` derives the HDR shader
  from `shader.wgsl` at runtime via targeted substitutions (storage rgba8unorm→rgba16float;
  clamping→extended sRGB encode; drop the store clamp; disable dither; **+3 curve-stage fixes** so
  the tone curves don't re-clip headroom to [0,1]); lazily-built `HdrResources`; `run()` gains
  `output_hdr` and selects pipeline/textures/bytes-per-pixel; `read_texture_data_roi` parameterized;
  `process_and_get_dynamic_image_hdr` returns linear `ImageRgba32F`. Tests: shader-substitution
  guard + GPU end-to-end headroom.
- `src/export_processing.rs` — `ExportSettings` gains `bit_depth`/`transfer_function`/`primaries`
  (+ `hdr_enabled()`/`export_bit_depth()`); `encode_image_to_bytes` routes avif/jxl to the HDR
  encoders when HDR is requested; `process_image_for_export[_pipeline]` thread `output_hdr` to the
  HDR GPU path.
- `tests/hdr_export.rs` *(new)* — the gate. Parses nclx + av1C **from the file bytes** (independent
  of the encoder), decodes AVIF with `avifdec` (libavif) and JXL with jxl-oxide, asserts (1)–(4)
  against **independent** ST.2084 ground-truth literals (not encoder-derived — see Limitations).

**Frontend (`src/`):** `hooks/useExportSettings.ts`, `components/ui/ExportImportProperties.tsx`,
`components/panel/right/ExportPanel.tsx` (Bit Depth / Transfer / Primaries controls for AVIF/JXL),
`i18n/locales/en.json`.

**Docs:** `PLAN.md`, `HDR_WORKLOG.md`, this report.

## New dependencies + system libs

- **AVIF (always on, pure Rust):** `rav1e` + `avif-serialize`. No runtime system libs. Build-time:
  **`nasm`** is required by rav1e's `asm` feature (`brew install nasm`). To build without nasm, drop
  the `asm` feature in `Cargo.toml` (slower encode, pure Rust).
- **JPEG XL (optional `hdr_jxl` feature):** `jpegxl-rs` + `jpegxl-sys` link **system libjxl**.
  `brew install jpeg-xl`, and because it is keg-only, set
  `PKG_CONFIG_PATH="$(brew --prefix jpeg-xl)/lib/pkgconfig:$PKG_CONFIG_PATH"` at build time.
  For distribution the libjxl dylibs must be bundled (or build jpegxl-sys `vendored`, which compiles
  libjxl from source via cmake). Default builds do **not** require libjxl.

## Run the verification harness

```sh
cd src-tauri
# AVIF only (needs libavif's `avifdec` on PATH for the pixel checks: `brew install libavif`):
cargo test --test hdr_export
# Everything incl. JXL + GPU end-to-end + pinned math:
PKG_CONFIG_PATH="$(brew --prefix jpeg-xl)/lib/pkgconfig:$PKG_CONFIG_PATH" cargo test --features hdr_jxl
```
The harness exits non-zero on any failure. The GPU end-to-end test skips gracefully if no GPU
adapter is available (headless CI).

## Known limitations / uncertainty (read before trusting the look)

1. **Headroom-through-curves is preserved by a deliberate, not perceptually-validated, choice.**
   RapidRAW's look pipeline is display-referred; the tone curves clamp to [0,1]. The HDR shader
   substitutions make curves pass values *above the top control point* through linearly and disable
   the >1.0 renormalization. For default/identity curves this is exactly right (verified: linear
   4.0 survives). For a user-set tone/RGB curve the behaviour above diffuse white is a reasonable
   extrapolation but **has not been visually checked** — flagging loudly as the brief requested.
2. **AVIF matrix is now user-selectable** (Identity/RGB *or* YCbCr BT.2020-NCL / BT.709-NCL),
   alongside chroma subsampling (4:4:4/4:2:2/4:2:0), full/limited range, primaries (sRGB / Display-P3
   / Rec.2020), reference-white nits, HLG peak, and MaxCLL/MaxFALL mastering metadata — exposed in
   the export panel via friendly presets + an Advanced section. The YCbCr/subsampling/range/primaries
   paths are covered by **colored-pixel** round-trip tests (not just neutral), so the matrix/chroma
   math is numerically verified, not just assumed. `HdrEncodeConfig::default()` is still Identity/
   4:4:4/full so the originally-verified path is byte-identical.
3. **HLG is tag- and monotonicity-verified only.** HLG is relative/scene-referred, so there is no
   single absolute-nit anchor check; `HLG_PEAK_RATIO = 12` is a reasonable default, not tuned.
4. **Watermarking an HDR export clamps the watermarked pixels to SDR** (the overlay runs in 8-bit).
   HDR export *without* a watermark is unaffected.
5. **No EXIF in AVIF/JXL** — the metadata writer only handles JPEG/PNG/TIFF (pre-existing); HDR
   files carry CICP tags but not EXIF.
6. **Tiling**: the HDR path reuses the SDR tiling logic (parameterized), exercised on small images
   in the harness; very large multi-tile HDR images use the same code but weren't size-stressed.

## Needs a human + real HDR display (out of scope for automated checks)

- View exported PQ AVIF/JXL on a true HDR display (Apple XDR, HDR monitor): confirm diffuse white
  sits ~203 nits, highlights extend above it without banding/clipping, and there is no color cast.
- Sign off on the **above-diffuse-white look** (limitation #1) for real edits with curves/grading.
- Confirm matrix=0 (identity) AVIF decodes correctly in the target viewers (macOS Preview/Photos,
  Chrome, Safari); decide whether matrix=9 is needed (limitation #2).
- Check HLG output on an HLG display.
- Run real RAW files with genuine sensor highlight headroom (not just the synthetic patches).

## Build the HDR-capable binary

```sh
npm install

# AVIF HDR (always available; needs nasm at build time):
npm run tauri build

# + JPEG XL HDR (needs system libjxl):
brew install jpeg-xl
PKG_CONFIG_PATH="$(brew --prefix jpeg-xl)/lib/pkgconfig:$PKG_CONFIG_PATH" \
  npm run tauri build -- --features hdr_jxl
```
