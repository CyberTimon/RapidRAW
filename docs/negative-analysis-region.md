# Negative conversion analysis region

Enable **Convert negative** in the Details adjustments, then turn on **Analysis region**.
The editor shows the uncropped adjusted source so an output crop cannot hide the area
being sampled. Drag the rectangle to move it, drag a corner to resize it, or drag outside
the rectangle on the image to draw a replacement. Only one rectangle is shown. Focus the
rectangle or a corner and use the arrow keys for small changes (Shift for larger changes).
The selection follows the existing orientation, flips, rotation, and perspective transforms.
Analysis does not change output crop or any conversion slider.

Conversion recalculates after releasing a drag. Pointer cancellation discards the draft.
Hiding the overlay retains the region and restores the ordinary preview with its existing
zoom and pan controls. Enter accepts an active drag and hides the rectangle; Escape
discards an active drag and hides it, keeping the last applied region. Both shortcuts
work while the overlay is shown, without needing to focus the rectangle.
**Reset region** restores the central 76% (12% excluded on each edge)
and recalculates conversion. Each image uses its own density percentiles from that region;
there is no additional inset inside a custom rectangle.

## Saved image adjustments

The applied region is stored per image in the `.rrdata` sidecar under
`adjustments.negativeAnalysisRegion`, alongside the negative-conversion settings:

```json
"negativeAnalysisRegion": { "x": 0.12, "y": 0.12, "width": 0.76, "height": 0.76 }
```

Coordinates and dimensions are normalized to the source image. Old sidecars without
this setting use the central 76% default. Negative conversion reads the region before
calculating the image's density percentiles; output cropping remains independent.
Preview, thumbnails, white-balance sampling, and export use the saved image adjustments.

Releasing a drag or accepting it with Enter updates the image adjustments through the
normal autosave flow and adds an undo step. Reset region is also saved. Only overlay
visibility and unfinished drags live in `useNegativeAnalysisStore`. Returning to the
gallery hides the overlay and discards an unfinished drag. Switching images cancels
an unfinished drag and uses the newly selected image's own saved region. Going home
or restarting the app does not erase saved regions.

Copy/paste and batch synchronization include the region with the negative-conversion
settings. Batch export uses each source's saved rectangle; copying the settings first
applies the same normalized rectangle to those sources. Each source is analyzed
independently at the existing 1080-pixel reference size.

## Verification

- `npm run test:negative-analysis` covers committed versus draft edits, overlay visibility,
  cancellation, reset, actual editor view transitions, per-image regions, slider
  preservation, undo/redo, sidecar adjustment reload, and render payload consistency.
- `cargo +1.98 test --release --manifest-path src-tauri/Cargo.toml negative_conversion::tests --offline --lib`
  covers distracting borders, default compatibility, invalid/tiny regions, proportional
  sampling, independent image analysis, and conversion across the entire image.
- The user confirmed completion of the live visual check on 2026-10-23.
  The manual acceptance checklist includes zoom/pan, quarter-turn orientation, flips, arbitrary
  rotation, perspective, and an existing output crop, then compare preview and export.
  Also export two negatives with different saved regions together and compare each
  result with its individual export. Check the analysis switch and labels in English
  and German.

## AI assistance

GPT 6.1 Sol assisted with code generation. The solution received substantial manual
testing by the contributor, alongside automated regression tests.
