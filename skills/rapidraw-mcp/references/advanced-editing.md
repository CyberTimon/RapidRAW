# Selective and advanced editing

Read only the sections needed for the task. Tool names below include the server's `rapidraw_` prefix; use the host's actual exposed name. Read live schemas for parameter details rather than extending these examples by guesswork.

## Coordinates and masks

For choosing a starting selection, manual repairs and the stop condition, follow [guided masking](guided-masking.md).

When available, use `map_coordinates` to translate displayed points/regions/strokes between `preview`, `rendered`, `mask` and `oriented_source`. Supply the actual preview dimensions and region. Read returned validity; geometry can map outside the source, and a box crossing a nonlinear warp is an approximation. `preflight` checks actual resource limits before expensive work.

Use `sample_region` on an inspected neutral area to measure rendered sRGB, clipping and linear luminance before preview resizing. The region is limited to 4 megapixels. Its white-balance suggestion assumes that the chosen area should be neutral; compare a temporary variant before applying it. `stage: "original"` bypasses user geometry and crop, so use that stage's coordinates; suggestions require `stage: "edited"`. `clipping_overlay: true` adds a preview diagnostic. Ordinary previews follow saved `showClipping` by default; explicit false produces a clean view, and exports remain clean.

`mask_update(submask_operations: [...])` accepts 1–100 atomic operations with `operation: "add"`, `"edit"`, `"remove"`, `"duplicate"` or `"reorder"`. Keep IDs from the response; add and duplicate generate new IDs. Render the combined selection after changes; composition order and subtract/intersect modes affect what remains selected.

| Operation                           | Coordinate space                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `render.region`, `analyze.region`   | Full-resolution rendered pixels after crop and geometry, before preview resizing; integer bounds                                 |
| Mask geometry, AI subject `region`  | `mask`: full-resolution canvas after current geometric correction, user orientation, flips and rotation, before user crop        |
| `map_coordinates` `oriented_source` | Loaded source after EXIF decoding orientation, before all user geometry                                                          |
| Adjustment `crop`                   | Full-resolution pixels after geometric correction, orientation, flips, and rotation; inside the transformed canvas; `unit: "px"` |

Read `rendered_width`, `rendered_height`, `region`, and `coordinates` from a render. The response gives the preview-to-rendered mapping:

```text
rendered_x = region.x + (preview_x + 0.5) * coordinates.preview_to_rendered_scale.x - 0.5
rendered_y = region.y + (preview_y + 0.5) * coordinates.preview_to_rendered_scale.y - 0.5
```

Coordinates identify pixel centers: the top-left pixel is `(0, 0)`. Round/clamp a detail rectangle within rendered bounds. For mask placement, use `map_coordinates` with `to: "mask"`; use `to: "oriented_source"` only when the destination needs the source before user geometry. Region boundaries use 128 samples and return approximate bounds under nonlinear warps; inspect unmappable samples. Requests accept at most 4096 points including stroke points and region-boundary samples.

Choose geometric masks with `rapidraw_mask_create` (`radial`, `linear`, `brush`, `flow`), sampled range masks (`color`, `luminance`), or `all`. AI selections use `rapidraw_mask_generate` (`subject`, `foreground`, `sky`, `depth`); subject `region` is a rectangle around the intended subject. `rapidraw_generate_depth` produces built-in depth and optionally enables blur. Check local model availability for built-in inference. The optional [Marigold depth-mask provider](marigold-depth.md) uses the existing connector, separate readiness checks and saved reusable maps; it does not change lens blur.

Subject point refinement is available through `mask_generate(kind: "subject", include_points, exclude_points, refine: {mask_id, sub_mask_id})`. Use `mask` coordinates and at most 64 points combined. Refinement requires the inspected `expected_revision` and preserves IDs, sibling corrections and grade. Only AI-subject submasks are eligible. A new point-guided selection needs a region or positive point; exclude-only is valid with a prior. An optional region is an explicit box for this call; previous point arrays are not automatically replayed. Inspect `refinement.prior_mode`: old masks use an explicitly approximate coverage-to-logit seed without baking in preserved grow/feather, opacity or inversion, while new selections retain native SAM logits. Do not edit opaque `samRefinement` data. Source/full-canvas geometry or patch changes, and changes to a generated submask's own placement, require a new selection or restoring saved state; crop and grade edits remain compatible. Visible retouch patches are included in the inference canvas before RAW display conversion and geometry. Hidden/zero-opacity parents can have empty combined statistics despite a valid refined submask, so inspect `generated_submask_statistics` separately. Review tail/hair coverage and background spill before accepting the result.

Example for a measured subject near the center of an uncropped 640 × 480 image. Replace the geometry, session, and revision for the actual photo:

```json
{
  "tool": "rapidraw_mask_create",
  "arguments": {
    "session_id": "SESSION_ID",
    "expected_revision": 1,
    "type": "radial",
    "name": "Subject lift",
    "parameters": { "centerX": 320, "centerY": 240, "radiusX": 140, "radiusY": 180, "rotation": 0, "feather": 0.8 },
    "adjustments": { "exposure": 0.18, "shadows": 8 }
  }
}
```

`feather` is 0–1 for this geometry; mask `opacity` is 0–100. Keep the returned `mask_id`. Render it with `rapidraw_render` using `mask_id`, inspect coverage/edges, then render normally to judge the effect. Mask previews require an enabled mask; inspect its grayscale coverage before disabling it for a visual comparison. Empty coverage is a failed selection, even if a mask record exists. A geometric approximation is not an AI subject selection.

Refine with `rapidraw_mask_update`; local adjustments go under `patch.adjustments`, and mask opacity under `patch.opacity`. If replacing `subMasks`, read the complete existing composition first; arrays replace the existing array. When reusing geometry in another mask, assign fresh submask IDs; IDs must be unique across the session to prevent cached bitmap collisions. Remove a mask with `rapidraw_mask_remove` or undo the edit. Within one mask, additive submasks use the per-pixel maximum after each submask's inversion and opacity, so overlapping low-opacity submasks do not sum to full strength.

### Diagnose an edit before compensating for it

For a new band, halo, or changed apparent shape, locate it in the source and current render at matching coordinates. Compare the same grade with the suspected mask or adjustment disabled, then restore or deliberately revise it using live revisions. For overlapping masks, inspect the combined result as well as each grayscale mask. A numerical exposure dip can explain one contribution; its removal alone does not prove that global contrast, colour, or the remaining fade is visually sound. Prefer removing or simplifying the offending adjustment over accumulating corrective masks.

For temperature comparisons, hold tone and geometry fixed while comparing a small set of useful alternatives. If a later candidate also changes masking or contrast, describe it as a combined revision; do not attribute the improvement to temperature alone. Preserve the strongest previous comparison instead of rebuilding an already successful grade.

### When an automatic selection fails

An almost black mask or a thin border response can be a semantic failure despite a successful tool response. Distinguish an unavailable tool from a failed selection on this image. If useful, test a clear control image before attributing failure to the engine. The dedicated sky selector and the guided subject selector use different models: `mask_generate(kind: "subject", region: ...)` can select a bounded sky region when `kind: "sky"` misses it. Inspect the actual skyline and gaps between branches; the rectangle is a prompt, not a guarantee of coverage. Growing a coarse selection can move a fringe without selecting those gaps. Where appropriate, combine it with a sampled colour/luminance selection, then check both edge continuity and spill onto similarly coloured foreground. Inverting a foreground selection is useful only if that selection excludes the sky and celestial structure.

Current AI inference uses source pixels with default RAW processing and the current geometric warp. The current tonal grade is not applied to that inference image, so exposure or white-balance edits in the same session do not change it. A rendered-copy test can diagnose this distinction, but its AI bitmap retains the copy's pixel dimensions: a reduced preview mask does not automatically scale to the full-resolution master. Generate on the master when possible; do not transplant a mismatched bitmap or fabricate its contents.

## Gradient transitions

When supported by the live linear-mask schema, choose `falloff: "linear"`, `"smoothstep"`, or `"smootherstep"`. The latter curves ease into both endpoints. Set `fadeBefore` (distance to zero coverage) and `fadeAfter` (distance to full coverage) independently in source pixels; an omitted side uses `range`. For a left-to-right horizontal boundary at y=250, `fadeBefore: 100, fadeAfter: 200` reaches black at y=350 and white at y=50. Reversing the endpoints reverses the sides. The boundary is not necessarily half strength with asymmetric distances. Old recipes retain the original linear, symmetric `range` behavior.

Use these controls to place a continuous transition deliberately; smoother curves do not prevent two opposing masks from producing a trough. Read [combined diagnostics and temporary comparisons](review-and-jobs.md) to inspect the result.

## Two easy mistakes

**Linear masks:** in this native engine, `startX/startY` and `endX/endY` define the boundary line, not the fade direction. The fade is perpendicular. A line from left to right selects above it; reverse the endpoints to select below. A vertical line selects a side of the photo. `range` is the half-width of the transition in source pixels; making the line longer does not soften it. Use a fade width appropriate to the full-resolution image. Older MCP builds incorrectly cap this field at 100; check live capabilities and use a corrected bridge for wider gradients.

For an uncropped 1200 × 800 image with a flat horizon at y=250, this selects the sky: white above y=200, black below y=300, half strength on y=250.

```json
{
  "tool": "rapidraw_mask_create",
  "arguments": {
    "session_id": "SESSION_ID",
    "expected_revision": 1,
    "type": "linear",
    "name": "Sky",
    "parameters": { "startX": 0, "startY": 250, "endX": 1200, "endY": 250, "range": 50 },
    "adjustments": { "highlights": -12 }
  }
}
```

Render the mask before trusting it. When opposing gradients overlap, inspect their combined tonal effect: individually smooth ramps can create a dark trough or bright belt when their starts and strengths differ. Try consolidating them into one continuous adjustment before adding a compensating mask. A gradient deliberately crosses scene boundaries; use it for a continuous tonal transition, not as a claim of precise sky selection. Set its width and direction so the effect fades through the intended air and foreground without producing a belt or flattening the celestial band. Use an AI selection when tracing an irregular skyline is actually needed. A mostly uniform gray frame is not a successful selective mask just because its coverage is nonzero.

**Brush masks:** `brushSize` is a diameter in source pixels. Put `feather` on **each line**; the native brush renderer reads the line value. Overlap interior strokes to fill the fabric rather than draw disconnected stripes; keep smaller edge strokes inside the garment. Native detail is necessary because an overview can conceal spill onto arms, backpack or scenery. Do not call a hand-painted approximation an AI subject selection.

## Recolor neutral clothing

A gray shirt has little hue to rotate. Raising temperature often makes it beige without creating the requested accent. Choose the target color, measure the garment mask, then use local RGB point curves or color grading to introduce color while retaining folds. Exclude skin, hair, backpack and background. A warm-accent curve example for an **already verified mask**:

```json
{
  "tool": "rapidraw_mask_update",
  "arguments": {
    "session_id": "SESSION_ID",
    "expected_revision": 2,
    "mask_id": "MASK_ID",
    "patch": {
      "opacity": 70,
      "adjustments": {
        "pointCurves": {
          "red": [
            { "x": 0, "y": 0 },
            { "x": 80, "y": 155 },
            { "x": 160, "y": 220 },
            { "x": 255, "y": 255 }
          ],
          "green": [
            { "x": 0, "y": 0 },
            { "x": 80, "y": 62 },
            { "x": 160, "y": 142 },
            { "x": 255, "y": 255 }
          ],
          "blue": [
            { "x": 0, "y": 0 },
            { "x": 80, "y": 30 },
            { "x": 160, "y": 85 },
            { "x": 255, "y": 235 }
          ]
        }
      }
    }
  }
}
```

These values are an illustrative coral treatment, not a default clothing preset. Check the resulting hue and strength on this photo. Recoloring passes only when the accent is visible at overview/delivery size **and** the native detail preserves folds with no colored halo or untouched strips. If the mask is wrong, fix coverage before increasing color strength.

## Retouch and models

For remote generative edits, profile choice, fair seed comparisons and high-resolution placement, follow [generative editing workflows](generative-editing.md).

Assess distractions and remove those that weaken the photograph as part of the edit; the user does not need to request cleanup or name each object. Prefer the established generative connector whenever suitable and available. Use local inpainting as a carefully inspected fallback, following [local inpaint review](generative-editing.md#local-inpaint-fallback). Clone/heal remains useful for tiny defects with a verified matching donor. Inspect repaired texture and retained subject boundaries at native resolution before accepting any method.

`rapidraw_retouch` requires native `sub_masks`, each with `id`, `type`, `visible`, `mode` (`additive`, `subtractive`, `intersect`), and `parameters`. Read the native submask schema; do not pass a plain rectangle or a mask ID as a replacement for this structure. Brush lines have a `tool`, `brushSize`, and point coordinates. Clone/heal can use `source_point`. Generated bitmap/patch fields belong to the engine.

`rapidraw_models` reports installation status. `rapidraw_install_model` accepts `kind: "masks"`, `"inpaint"`, `"denoise"`, or `"nonlocal"`. Install missing assets when authorized and necessary. If a suitable geometric or non-AI operation meets the request, it may avoid the download; explain any reduced capability accurately. For Nonlocal Bayer denoise, `kind: "nonlocal"` installs the pinned runtime bundle matching `RAPIDRAW_NONLOCAL_PROVIDER` (unset defaults to CUDA on Linux, direct CoreML on macOS, and CPU on other platforms) from the pinned Hugging Face revision — no manual bundle path needed, though `RAPIDRAW_NONLOCAL_BUNDLE` remains an explicit override.

Read `rapidraw_get_engine_settings` to identify the established processing provider. Generative mode uses that connector or a request-scoped cloud token; do not silently route photographs to an unrelated provider. Keep tokens out of recipes, durable notes, and settings files. Connection setup is described in [connection.md](connection.md).

## Dedicated denoising

Use this path when noise is a consequential obstacle to the chosen edit. `colorNoiseReduction` and `lumaNoiseReduction` are rendering controls; `rapidraw_start_denoise` runs a separate background AI, BM3D or configured Bayer Nonlocal filter (`rapidraw_denoise` remains synchronous for compatibility) on the decoded source. Choose from available methods and inspect the result rather than assuming one is superior. AI requires the verified denoise model and runtime; BM3D does not require AI assets.

### Recommended method selection

- **Configured native host (ONNX CPU or Linux CUDA, or macOS CoreML) + Bayer RAW:** use `method: "nonlocal"`. Start with `intensity: 100` for general high-ISO stills, and compare `intensity: 50` when faint stars or fine texture may be softened.
- **Local Mac, CPU, or quick low-resource work:** use `method: "ai"` (NIND), the lightweight option. It can use the existing configured ONNX path where available.
- **CPU reference or no AI assets:** use `method: "bm3d"` as a conventional baseline.

For fair comparisons, derive every candidate from the same undenoised parent and hold the crop, grade and review regions constant. Nonlocal is Bayer RAW-only and runs in-process on the configured native ONNX host; there is no automatic Mac-to-server offload. Inspect the returned session at overview and native detail before accepting any method.

On a configured native host, `start_denoise` also accepts `method: "nonlocal"` for Bayer RAW. Inspect `models.groups.nonlocal`: bundle/provider verification does not guarantee CUDA availability until the job starts. On macOS, `RAPIDRAW_NONLOCAL_PROVIDER=coreml` with the pinned `.mlpackage` bundle runs direct CoreML.framework inference with no Python/coremltools dependency. Nonlocal has no quality setting; do not pass `quality`. Model time scales with photograph size (about 23 s for 32.5 MP on an RTX 5060 Ti, estimated), so poll the job. Intensity defaults to 100 and blends in sensor space; cached full-strength predictions can be reused for other intensities. The result is a float Bayer DNG using RapidRAW's native demosaic/colour pipeline and captured edits in a new session. Open its DNG independently for normal RAW development, or continue the returned session to retain its exact edits. This is a background MCP option, not the desktop denoise dialog or automatic Mac-to-server offload. See [GPU setup](../../../denoise/README.md#native-raw-denoise-through-mcp). Do not route Nonlocal through the synchronous `denoise` compatibility tool.

For a method or strength comparison, derive each candidate from the same undenoised parent and hold the grading and geometry constant. Denoising an already derived candidate compounds the filtering. AI intensity blends the filtered result with the source; BM3D intensity also changes filter parameters, so equal percentages are not equal treatments. Zero disables filtering; the synchronous tool is a no-op, while a background job produces a separate unchanged-source session. NIND uses CPU inference by default; a configured Linux deployment can use the [optional CUDA path](https://github.com/sheldonxxxx/RapidRAW/blob/main/docs/mcp/onnx-cuda.md). Inspect `models.onnx_execution` for the selected provider. Lowering nonzero AI intensity does not reduce the inference workload. Full-resolution processing can be slow. Prefer [background jobs](review-and-jobs.md#background-denoise) so polling, editing and cancellation remain available. For an older synchronous engine, the fallback client's native timeout and request wait are separate, as explained in [connection and recovery](connection.md#persistent-fallback-client).

Keep the job ID, parent/derived IDs, method, intensity, dimensions, and captured revision. A background job returns `result_session_id` when it succeeds and inherits the edits captured when it started, not later parent changes. Continue editing the returned session. `original: true` in a derived session shows its own source, which is already denoised; use the parent session for the untouched comparison. Review the same regions at native scale and the intended delivery size before stronger contrast or sharpening makes the comparison harder to interpret.

A native 16-bit export at the intended delivery size can make an exploratory comparison practical when full-resolution inference is too slow. It bakes the current rendering and changes both resolution and processing domain: label that experiment separately, preserve its own untouched baseline, and compare matching output pixels. It does not establish full-resolution RAW denoising quality. A timeout is an execution outcome, not an aesthetic rejection; inspect persisted state before choosing a longer run or a different processing path.

For star photographs, inspect faint as well as bright stars, their recorded shapes, inter-star texture, broad colour transitions, and fine foreground edges. A smooth sky can still lose stars or retain distracting mottling. Judge noise cleanup separately from the subsequent gain in celestial structure. Reduce or reject a candidate when its cost exceeds its gain; distinguish an unsuccessful tested treatment from an untested capability or a demonstrated source limit. Generic HDR/focus/panorama merge is not a verified star-aligned stacking workflow, and repeated copies of one capture add no independent evidence.

Save the derived session and retain its source asset as well as the adjustments. An adjustment recipe alone does not recreate denoising.

## Derived sessions, corrections, and assets

| Task                 | Tool and behavior that matters                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Denoise              | Prefer `rapidraw_start_denoise`, then `rapidraw_get_job`. AI, BM3D, or configured Bayer Nonlocal; intensity 0–100. Success returns a separate session with captured edits. The older `rapidraw_denoise` blocks and supports AI/BM3D only. Inspect native texture before accepting.                                                                                                              |
| Lens correction      | `rapidraw_lens_profile` with `mode: "lookup"` inspects; `mode: "auto"` applies. Review geometry and edges after applying.                                                                                                                                                                                                                                                                       |
| Film negative        | `rapidraw_negative_convert` returns a derived session without inherited adjustments. Use its `parameters`, not obsolete negative-conversion adjustment keys.                                                                                                                                                                                                                                    |
| HDR, focus, panorama | `rapidraw_merge` with `kind: "hdr"`, `"focus"`, or `"panorama"` takes at least two source paths and returns a new session. MCP panorama requires every input in one connected group; otherwise it returns an error. Inspect alignment, ghosting, seams and useful new scene coverage at overview and native detail. Save, reconnect and confirm matching native detail in the returned session. |
| Preset               | Discover with `rapidraw_list_presets`, then `rapidraw_apply_preset` with returned `preset_id` and optional intensity. Inspect warnings for legacy field migration.                                                                                                                                                                                                                              |
| LUT                  | Discover with `rapidraw_list_luts`, then `rapidraw_apply_lut` with the actual local path. The session retains its own LUT asset.                                                                                                                                                                                                                                                                |
| Recipe               | `rapidraw_load_recipe` accepts merge or replace; choose deliberately. A CUBE LUT represents global color, not crop, masks, or other spatial edits; keep a recipe for those.                                                                                                                                                                                                                     |
| Metadata             | `rapidraw_get_metadata`, then `rapidraw_set_metadata` for rating, tags, or EXIF. Save/export to persist and inspect the output metadata.                                                                                                                                                                                                                                                        |

Save a NIND/BM3D RAW-derived session through MCP to retain its linear TIFF interpretation. Opening that derived TIFF directly in the GUI cannot recover the same interpretation from `.rrdata` alone; use an MCP export for a portable display image. Nonlocal produces Bayer DNG instead; the DNG retains RAW development, while its session or saved sidecar carries the adjustments. Original RAW working copies and their saved sidecars can be continued in the GUI.

## Delivery options

For a short-edge target, use this shape instead of `long_edge`:

```json
{
  "tool": "rapidraw_export",
  "arguments": {
    "session_id": "SESSION_ID",
    "path": "short-edge.jpg",
    "format": "jpeg",
    "quality": 92,
    "resize": { "mode": "shortEdge", "value": 1080, "dont_enlarge": true }
  }
}
```

Other resize modes are `longEdge`, `width`, and `height`. `export_masks`, watermark configuration, metadata preservation, timestamps, and 16-bit PNG/TIFF are available in the current tool schema; use only what the delivery requires. Inspect actual output properties rather than inferring precision from the filename.

`rapidraw_batch_export` takes `items: [{session_id, path}, ...]` and shared `options` with export settings. Export names still resolve under the workspace's `exports` directory. A partially failed batch can already have written successful files; inspect each item before any retry.

## Local learned masks and restoration

Discover `enhancement_models` before using `enhance`; install only the model needed for the chosen operation. See the [local enhancement guide](https://github.com/sheldonxxxx/RapidRAW/blob/main/docs/local-enhancement.md) for supported models, profiles, coordinates and hardware behavior. Use `refine_mask` for a specific mask component, `semantic_mask` for supported scene or portrait categories, and inspect coverage and protected regions before applying a grade. Read `enhancement.warnings`, `inferred_tiles` and `coarse_fallback_tiles`; partial refinement can retain the coarse selection where context is insufficient.

Deblur is experimental and most suitable for mild motion blur after noise correction. Upscale reconstructs a conservative 2× image. Both bake the current rendered sRGB edits into a separate session; keep the RAW parent. Prefer a small region for a native-detail trial, then inspect ringing, texture, noise and tile boundaries before whole-photo work. A successful call or numerical model parity does not establish image quality. Use `start_operation` with operation `enhance` for cancellable captured work, supplying the current `expected_revision`.
