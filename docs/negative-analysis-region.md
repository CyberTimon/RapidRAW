# Negative conversion analysis region

Enable **Convert negative** in the Details adjustments, then turn on **Analysis region**.
The editor shows the uncropped adjusted source so an output crop cannot hide the area
being sampled. Drag the rectangle to move it, or drag a corner to resize it. Focus the
rectangle or a corner and use the arrow keys for small changes (Shift for larger changes).
The selection follows the existing orientation, flips, rotation, and perspective transforms.
Analysis does not change output crop or any conversion slider.

Conversion recalculates after releasing a drag. Pointer cancellation discards the draft.
Hiding the overlay retains the region and restores the ordinary preview with its existing
zoom and pan controls. **Reset region** restores the central 76% (12% excluded on each edge)
and recalculates conversion. Each image uses its own density percentiles from that region;
there is no additional inset inside a custom rectangle.

## Workspace session

A workspace session begins when the existing app navigation enters the editor view and
ends when `useUIStore.setUI` leaves that view (for example, returning to the library).
Switching images, adjustment panels, or the overlay within that editor session retains
one shared source-proportional region. Disabling/re-enabling conversion also retains it.
Re-entering the editor starts with the default rectangle. A cancelled drag or a closed
workspace cannot commit its old draft, and preview results for an earlier region are ignored.

The region lives in `useNegativeAnalysisStore`, separate from persistent adjustments,
undo history, sidecars, and reusable presets. Render payloads, white-balance sampling,
and export payloads receive the session region. A batch export applies the same normalized
rectangle to each selected source; each source is analyzed independently, at the same
1080-pixel reference size and with the existing conversion method. Persistent batch
adjustment copying continues to copy conversion slider settings. The session's shared
region automatically applies when any of those images is previewed/exported during that
session. After leaving the editor, exports use the default analysis region.

## Verification

- `npm run test:negative-analysis` covers committed versus draft edits, overlay visibility,
  cancellation, reset, actual editor view transitions, shared batch proportions, slider
  preservation, and render payload isolation from persistent adjustments.
- `cargo +1.98 test --release --manifest-path src-tauri/Cargo.toml negative_conversion::tests --offline --lib`
  covers distracting borders, default compatibility, invalid/tiny regions, proportional
  sampling, independent image analysis, and conversion across the entire image.
- Live Tauri canvas alignment has not been visually verified in the current environment.
  Manual acceptance should include zoom/pan, quarter-turn orientation, flips, arbitrary
  rotation, perspective, and an existing output crop, then compare preview and export.
