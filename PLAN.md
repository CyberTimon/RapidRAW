# PLAN — HDR (PQ/HLG) AVIF + JXL export

## Architecture decision (why dual-pipeline, CPU PQ)

1. **Keep SDR byte-identical.** The brief forbids altering SDR output without asking. The 8-bit
   storage texture's HW quantization can't be byte-reproduced after an f16 round-trip, so instead
   of converting the single pipeline I add a **separate, lazily-created HDR pipeline + textures +
   BGL** (Rgba16Float). The existing rgba8unorm path is left completely untouched and is used for
   every SDR format and the interactive display.

2. **Color science lives on the CPU, in one testable function.** The GPU HDR variant outputs the
   *same look* as SDR (curves/LUT/grain run in the same sRGB space) but encoded with the
   *extended* sRGB OETF (no upper clamp) and no dither. On readback we invert that
   (`srgb_to_linear`) to get linear scene-referred light with headroom, as `ImageRgba32F`. The
   PQ/HLG OETF + primaries matrix + quantization happen in Rust where the harness can unit-test
   them against pinned ST.2084 constants. This keeps the GPU change minimal and the math verifiable.

## Edit list (commit per item)

### C-1 Verification harness FIRST (gate) — `src-tauri/tests/hdr_export.rs` + helpers
- New module `src-tauri/src/hdr.rs` (pub) holding the pure color-science fns so both the encoder
  and the test use ONE implementation:
  - `pq_inverse_eotf(l_norm: f32) -> f32` (ST.2084 constants pinned from brief).
  - `srgb_extended_to_linear(c: f32) -> f32` (exact inverse of shader `linear_to_srgb_extended`).
  - `rec709_to_rec2020_linear([f32;3]) -> [f32;3]` (Bradford-adapted matrix, white-preserving).
  - `REFERENCE_WHITE_NITS = 203.0`, `PQ_MAX_NITS = 10000.0`.
- Integration test asserts, exiting non-zero on failure:
  1. **Tags:** parse the raw ISOBMFF `colr`/`nclx` box from the AVIF bytes →
     primaries==9, transfer==16 (and a 18/HLG variant), matrix==9, full_range==1. JXL: decode and
     read reported primaries/transfer.
  2. **Bit depth** == 10, repeat == 12.
  3. **Reference white:** linear 1.0 patch → decoded PQ code ≈ 0.5797·1023 = **593** (±2).
  4. **Headroom:** linear 2.0 and 4.0 patches → strictly-increasing distinct codes above the
     diffuse-white code (and below full scale).
- Synthetic input built in `hdr.rs` (`fn synthetic_linear_image() -> ImageBuffer<Rgba<f32>>`):
  203-nit/diffuse-white flat patch (=1.0), 0→1 ramp, patches at 2.0 and 4.0.
- A pure-math unit test pins `pq_inverse_eotf(0.0203) ≈ 0.580` independent of any encoder.

### C-2 Encoder deps + HDR encode functions — `src-tauri/Cargo.toml`, `export_processing.rs`
- Add encoder crates per the spike verdict (expected: `rav1e` + `avif-serialize` for AVIF — pure
  Rust, no C dep; `jpegxl-rs` + system `libjxl` (brew `jpeg-xl`) for JXL). Confirm before adding.
- `hdr.rs`: `encode_avif_hdr(img: &Rgba32FImage, bit_depth, transfer, primaries) -> Vec<u8>` and
  `encode_jxl_hdr(...)`. These do: (optional) 709→2020, PQ/HLG OETF, quantize, encode + tag CICP.
- `encode_image_to_bytes` gains an `&ExportSettings`-derived color config; avif/jxl arms branch to
  the HDR encoders when `bit_depth > 8` / `transfer != sRGB`. SDR arms unchanged.

### C-3 GPU HDR output path — `gpu_processing.rs`, `shader.wgsl` (via runtime string-substitution)
- Build HDR shader source at runtime: `include_str!("shaders/shader.wgsl")` then
  `.replace("rgba8unorm, write>", "rgba16float, write>")`,
  `.replace("linear_to_srgb(composite_rgb_linear)", "linear_to_srgb_extended(composite_rgb_linear)")`
  (hits L1668+L1675), `.replace("clamp(final_rgb, vec3<f32>(0.0), vec3<f32>(1.0))",
  "max(final_rgb, vec3<f32>(0.0))")`, `.replace("let dither_amount = 1.0 / 255.0;",
  "let dither_amount = 0.0;")`.
- `GpuProcessor` gains `hdr: Option<HdrResources>` (BGL with Rgba16Float storage binding, pipeline,
  `tile_output_texture` Rgba16Float), created lazily on first HDR export.
- `read_texture_data_roi` + the tile-assembly in `run()` parameterized by `bytes_per_pixel`
  (4 for SDR, 8 for HDR f16). `run()` gains an output-mode arg; HDR returns the raw f16 bytes.
- `process_and_get_dynamic_image[_inner]` gains an HDR flag; for HDR, decode f16→f32, apply
  `srgb_to_linear` per channel → `DynamicImage::ImageRgba32F`. Existing callers default to SDR.

### C-4 Settings + command plumbing + UI — `export_processing.rs`, frontend
- `ExportSettings`: add `bit_depth: u8` (8/10/12), `transfer_function: enum {Srgb,Pq,Hlg}`,
  `primaries: enum {Srgb,Bt2020}` (serde camelCase, `#[serde(default)]` for back-compat).
- Thread through the export Tauri command → `process_image_for_export_pipeline` (HDR GPU path)
  → `encode_image_to_bytes` (HDR encoders).
- React/TS export panel: add Bit Depth + Transfer + Primaries controls, shown for AVIF/JXL.
  Follow existing export-settings component patterns.

## Open questions / risks
- **Encoder libs**: pending spike. If `jpegxl-rs` can't cleanly set PQ/Rec2020 on this platform,
  document the gap and ship AVIF-HDR first (brief explicitly allows documenting a JXL gap).
- **matrix_coefficients=9 (YCbCr)** vs 0 (identity/RGB): targeting 9 + 4:4:4 full-range for HDR
  compatibility (Apple/Chrome). Harness decodes to RGB; neutral patches are matrix-invariant so
  the 593 target holds regardless.
- **Primaries**: tagging BT.2020 while pixels are Rec.709 would mis-saturate real images, so we
  apply the 709→2020 matrix. Neutral harness patches are unchanged by it, so PQ-code asserts hold.
- **Tiling for very large HDR images**: run()'s tile path will be parameterized; if any subtlety
  surfaces for multi-tile HDR it'll be flagged rather than silently capped.
- **Perceptual on-display correctness is explicitly OUT OF SCOPE** (human checkpoint).
</content>
