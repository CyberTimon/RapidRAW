# Color Harmonizer

Color → Color Harmonizer pulls existing colors toward a selected palette in
OKLab/OKLCH. It complements the fixed hue bands in Color Mixer and the tonal
controls in Color Grading. The initial adjustment is neutral: strength is zero
and node saturation is 100%.

## Using the tool

1. Expand Color Harmonizer. The source histogram is calculated when the panel
   opens, and reused when switching between global and mask controls.
2. Choose Monochromatic, Analogous, Analogous + Complementary, Complementary,
   Split Complementary, Dyad, Triad, Tetrad, Square, or Custom.
3. Drag a node to rotate a linked palette. Custom offers two to four independent
   nodes. Drag the wheel center to rotate the entire palette.
4. Increase Strength, then adjust Pull Width, Neutral Protection and optional
   per-node saturation. The controls use RapidRAW's standard sliders and reset
   behavior. The subsection eye bypasses the adjustment.
5. Match Dominant Hues rotates linked presets toward the strongest detected hue.
   In Custom it positions each node at a different detected hue, strongest first.
   If fewer distinct hues exist, unmatched nodes retain their positions.

The wheel displays a cached **source-preview histogram**, rather than a live
post-adjustment vectorscope. Grayscale images may have no dominant hue to match.

## Processing and performance

- Global and mask settings use the same component and nondestructive metadata.
- A 64-byte Rust/WGSL block stores up to four hues, node saturation and the pull
  parameters. The shader preserves OKLab lightness, applies Gaussian attraction
  to the nearest hue, and protects low-chroma pixels. The nearest node is found
  before evaluating the Gaussian, requiring one exponential per affected pixel.
- The GPU specialization bit stays off when all settings are neutral. The shader
  also bypasses inactive adjustments on the generic processing path.
- Pull Width adapts to the largest gap between nodes, keeping the slider useful
  for both evenly spaced and clustered palettes. Existing larger saved widths
  are preserved.
- Histogram analysis runs on a blocking worker using a bounded sample of the
  cached source preview. It does not trigger a render or GPU readback. A 48-entry
  frontend LRU and shared in-flight requests avoid repeated analysis; palette
  changes do not resample the image.
- The chroma-weighted histogram has 72 circular bins. Smoothing and 30° peak
  separation prevent adjacent shades from occupying several Custom nodes.
- Neutral palette changes save metadata without regenerating an identical
  thumbnail. Global and mask changes participate in the existing history,
  copy/paste, save/reload, preview and export paths.

English and German labels are supplied; other locales use the existing fallback.
Monochrome processing bypasses the Harmonizer. Spatial color smoothing and live
post-adjustment analysis are outside this feature's scope.

## Validation

```bash
npm run typecheck
npm run build
npm run i18n:runtime-check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

Additional behavior checks and WGSL validation live on the fork's
`test/color-harmonizer-v1.7.0` branch. They cover adaptive width, circular hues,
distinct peaks, neutral histograms, both output formats and the 64-byte
ColorHarmony layout. Validation tooling is separate from the feature commit.

The photographer tested the v1.7.0 integration on Ubuntu 26.04 with Intel Iris Xe
and confirmed that the Harmonizer workflow and responsiveness work well with
Furka. This port targets release **v1.7.0** (`00379017`). Further review of RAW
color accuracy, mask/history/export parity and other GPU backends is welcome;
automated checks do not replace that coverage.

Suggested review: neutral identity, all presets, independent Custom nodes,
0°/360° wraparound, per-node saturation, masked edits, undo/redo, image switching,
source histogram loading, sidecar reload and 8/16-bit exports.

## Attribution

Palette rules and Gaussian hue attraction were informed by darktable's
[Color Harmonizer documentation](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/color-harmonizer/)
and [implementation](https://github.com/darktable-org/darktable/blob/master/src/iop/colorharmonizer.c).
RapidRAW's implementation uses OKLab/OKLCH rather than darktable's UCS/JCH and
RYB coordinates; it is not pixel-equivalent. The WGSL code was written for
RapidRAW's pipeline rather than copied from darktable's C implementation.

The photographer defined and tested the workflow. ChatGPT produced and revised
much of the implementation and documentation under the photographer's direction.
