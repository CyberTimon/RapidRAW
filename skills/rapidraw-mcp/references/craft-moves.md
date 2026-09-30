# Craft moves in RapidRAW

How to carry out the light-shaping moves a direction skill (such as Lightweft's `photo-edit-master`) asks for. The numbers are starting points in RapidRAW's native units (exposure in EV; most other sliders −100 to 100). Judge every result on the rendered pixels.

## Recommended order

1. **Denoise first** when the file is noisy (for example ISO ≥ 1600 on APS-C at dusk): `start_denoise` with `method: "nonlocal"`, then continue in the returned `result_session_id`. Use `intensity: 100` for smooth backgrounds and action. For feather, fur and skin close-ups, compare `intensity: 50–70`, or add fine grain afterwards (`grainAmount` 5–10, `grainSize` 10–20) so the texture doesn't look waxy.
2. **Geometry and base in one merge:** `set_adjustments` with `crop` (`unit: "px"`, full-resolution pixels after rotation), `aspectRatio`, `rotation`, then `temperature`, `tint`, `contrast`, `highlights`, `whites`, `blacks`, `vibrance`, and the vignette fields.
3. **Subject/environment pair:**
   ```json
   {"tool":"mask_generate","arguments":{"session_id":"…","expected_revision":1,"kind":"subject","name":"Subject",
     "region":{"x":…,"y":…,"width":…,"height":…},
     "adjustments":{"exposure":0.35,"shadows":15,"clarity":10,"structure":10,"temperature":6}}}
   {"tool":"mask_duplicate","arguments":{"session_id":"…","expected_revision":2,"mask_id":"SUBJECT_MASK_ID","name":"Environment","invert":true}}
   {"tool":"mask_update","arguments":{"session_id":"…","expected_revision":3,"mask_id":"ENV_MASK_ID",
     "patch":{"adjustments":{"exposure":-0.5,"saturation":-20,"clarity":-15,"temperature":-6}}}}
   ```
   Render the subject mask (`render(mask_id, mask_mode: "grayscale")`) before duplicating it. If it misses high-contrast parts (white patches on dark plumage, beak, eye, prey), refine it with `mask_generate(kind: "subject", refine: {mask_id}, include_points: [...])` in pre-crop coordinates. A duplicate isn't linked to its source: after refining, `mask_remove` the old environment mask and duplicate again.
   `mask_generate` accepts `adjustments` directly. `region` is in pre-crop full-resolution pixels and should box the whole animal, including anything it's holding. `mask_duplicate` clears the copy's adjustments by default, so set them with `mask_update`.
4. **Burns and dodges:** `mask_create` with `type: "linear"` for sky, foreground or bright strips (the start→end line is the boundary; left→right selects above it). Use `type: "radial"` with `feather` 0.7–0.9 for an eye dodge or corner burns.
5. **Vignette:** `vignetteAmount` −15 to −35, `vignetteMidpoint` 30–50, `vignetteFeather` 50–80. It applies to the cropped frame.
6. **Finish:** `sharpness` 15–30 globally at most; subject detail via `structure` or `clarity` inside the subject mask.

## Gaps inside the subject

AI subject masks fill small openings: background seen through an open beak, between legs or between wing feathers is treated as subject and lifted, while the background around it is darkened. Don't hand-paint the gap with scanline or single brush strokes; they leave staircase edges or bars. Create a small correction parent instead: a generous `brush` over the opening, then a `color` submask in `intersect` mode sampled on the background inside the gap (`tolerance` 12–20, `feather` 10–20). Give it roughly the environment adjustment minus the subject adjustment, then use `sample_region` to match the gap's brightness to the nearby open background. Check that the colour sample isn't on the subject (an orange beak, a pale fish), or the intersect will select the subject instead.

Masks can also end at a strong highlight inside the subject, such as the pale edge of a mandible, leaving the part beyond it in the environment mask. Compare local ratios (for example upper vs lower beak) between `stage: "original"` and `stage: "edited"`. If one side has darkened relative to the other, refine the subject with `include_points` on the missed part, then rebuild the inverted environment mask.

## Halos and edges

A strong environment darkening next to a soft subject mask can leave a pale rim hugging the subject. Check with `render(region)` at 100% along the subject's edge, and with `render(mask_id, mask_mode: "overlay")`.

- Keep the environment exposure moderate (−0.3 to −0.6) and add depth with a gradient or vignette rather than one heavy inverse mask.
- A thin rim that follows real light (backlight, sky reflection on feathers) is fine. An even glow all the way round is not.
- If a rim remains, set the same `grow` (about −10) and a low `feather` (about 4) on the AI submask of **both** the subject and the environment parent, so the transition sits just inside the subject. Around −20 and beyond, a dark line appears along bright edges such as beaks. Then re-render both overlays.
- To measure a halo, sample small boxes stepping away from the edge and divide `edited` by `original` at each step. A flat ratio means no halo; a ratio that rises toward the subject means a halo. `stage: "original"` ignores the crop, so add the crop offset to the original-stage coordinates.
- Pass `cache: false` to `render` when checking a mask or edge change you just made.

## Measure before delivering

Use `sample_region` (`stage: "edited"`, rendered coordinates after crop) to check the hierarchy the direction skill asks for:

- the subject vs. a band of background around it (a ratio of about 1.3× or more in either direction, or a clear warm/cool difference);
- the four corners vs. the frame average (a corner containing the subject or a high-key field is an expected exception);
- the bright-white fraction before and after (a large drop means highlight recovery or a mask miss has greyed the whites);
- `stage: "original"` vs. `"edited"` means over the whole frame, so dusk and blue-hour scenes aren't lifted into daylight by accident.

Record the measurements next to the export so a reviewer can see why the candidate passed.
