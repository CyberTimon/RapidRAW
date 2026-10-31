# Color Harmonizer

A proposed **Color → Color Harmonizer** adjustment for RapidRAW.

## Why this is useful

A strong photograph often has several recognizable colors that could be made
more harmonious without flattening every color into the same hue. Color
Harmonizer lets the photographer choose a palette and gently pull existing
colors toward it, with explicit control over the amount of attraction and
per-color saturation.

It complements RapidRAW's existing Color Mixer and Color Grading tools:
instead of correcting one fixed hue band or applying a global tint, it can
shape the _relationship_ between colors in a photograph. The initial state
is intentionally neutral, so simply opening the adjustment does not change
an image.

## Workflow

1. Open **Color → Color Harmonizer**. The panel is initially collapsed and
   its histogram is only calculated when opened.
2. Choose a harmony: **Monochromatic**, **Analogous**,
   **Analogous + Complementary**, **Complementary**, **Split Complementary**,
   **Dyad**, **Triad**, **Tetrad**, **Square**, or **Custom**.
3. Rotate a linked pattern using the wheel. Select **Custom** to move
   individual nodes independently; two custom hues are not forced to be
   complementary. Custom offers two, three or four independent nodes.
4. Set **Strength**, **Pull Width**, **Neutral Protection**, and optional
   **per-node Saturation**. Strength defaults to zero; the native sliders
   support keyboard input and double-click or touch double-tap to reset.
5. Choose **Match Dominant Hues** to suggest positions from the photo:
   linked schemes rotate toward the strongest color, whereas Custom places
   each node at a different dominant hue, strongest first.

The source-color histogram is displayed around the wheel. Its bins are
**not** a live post-adjustment vectorscope: they describe the cached source
preview. This distinction avoids implying an accuracy that the prototype
does not currently provide.

### Adaptive Pull Width

Different patterns need different attraction ranges. The slider's maximum
depends on the largest angular gap between active nodes; evenly spaced
palettes have a shorter meaningful range, while clustered nodes allow a
wider pull. The wheel wedges expand throughout the offered range instead
of visibly stopping while the slider continues. Previously saved width
values are not silently rewritten.

### Matching separate dominant hues

A chroma-weighted 72-bin OKLCH histogram is circularly smoothed and its
strongest distinct peaks are selected. A 30° separation rule avoids treating
adjacent shades of the same dominant color as several independent colors.
In Custom, node 1 uses the strongest detected peak, node 2 the next, and so
on. Missing peaks leave remaining nodes in place rather than inventing
colors absent from the picture. **Monochromatic** takes the strongest peak;
linked multi-node presets preserve their geometric relationships.

## Processing and integration

- The React component shares the existing adjustment and mask-panel
  machinery. Settings are stored in nondestructive adjustment metadata.
- Rust validates and clamps the settings into a 64-byte `ColorHarmonyGpu`
  block mirrored by WGSL.
- The shader works in **OKLab/OKLCH**: convert linear RGB to a perceptual
  color model, select the nearest harmony node, apply Gaussian angular
  attraction with chroma-dependent protection, adjust the winning node's
  saturation, and convert back to linear RGB.
- The normal effect is neutral when strength is zero and per-node
  saturation is 100%. The GPU feature flag avoids invoking the harmonizer
  on the standard processing path when it cannot alter any pixels.
- The source histogram samples a bounded preview only when the subsection
  is open. Analysis results are cached per image (48-entry LRU), including
  in-flight request deduplication. Slider and wheel movements do **not**
  resample the image.
- Both global and mask adjustments use the same UI component and settings;
  native drag-state hooks allow the existing interactive-render path.

The first version does **not** add darktable-like spatial smoothing, a live
stage-correct vectorscope, or automatic best-pattern selection. These are
possible follow-ups, but should be judged on performance and visual value.

## Inspiration and license notes

The general color-harmony concept, palette rules and Gaussian attraction
principle were informed by darktable's Color Harmonizer:

- https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/color-harmonizer/
- https://github.com/darktable-org/darktable/blob/master/src/iop/colorharmonizer.c

This implementation uses **OKLab/OKLCH**, not darktable's UCS/JCH + RYB
coordinates, so the two tools are not pixel-equivalent. The WGSL color
processing code was written for RapidRAW's rendering pipeline rather than
copied from darktable's C implementation. Reviewers should still assess
provenance, technical correctness and AGPL compatibility before merging.

## Testing

Automated checks on the feature branch:

- Behavior tests for node-dependent width and independent dominant peaks:
  **passed** (`node scripts/test-color-harmony.mjs`).
- Frontend Vite production build: **passed**.
- TypeScript and ESLint compared with the unchanged fork baseline:
  **no new diagnostics**.
- Prettier formatting: **passed**.
- Rust format and `cargo check --locked`: **passed**.

Reference CI: https://github.com/Sebluu/RapidRAW/actions/runs/41216961931

Human review: the UI, palette switching and visual color interactions were
tested in the Ubuntu development build and found useful. This does **not**
replace a broader test matrix, particularly shader runtime validation,
RAW/export color accuracy, multi-mask undo/redo and non-Linux platforms.

### Suggested maintainer QA

- All presets, 0°/360° wraparound, custom node independence.
- Dominant-hue sampling on single-color, mixed-color and near-neutral images.
- Width range versus wheel display, default neutral state, slider resets.
- RGB and monochrome RAWs, gamut boundaries, dark/neutral pixels.
- Global and mask edits, save/reload, history/undo, export, performance.
- Mouse, touch and accessibility; language fallbacks.

Only English and German labels are currently supplied; adding translations
for other shipped locales would be a welcome follow-up.

## Development and acknowledgments

This feature was developed through an **AI-assisted, user-directed workflow**.
The photographer proposed the experience, refined its behavior and exercised
the UI. ChatGPT produced and revised much of the implementation and
documentation. Maintainer code review, shader-runtime validation and
broader hardware testing are encouraged.

Color Harmonizer is intentionally isolated from the Targeted Curves eyedropper
and the separate experimental effects branch.
