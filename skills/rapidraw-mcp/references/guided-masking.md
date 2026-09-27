# Guided masking

Build the selection needed for the photograph's intended local edit. Start with a useful AI selection when it follows the subject, or create a manual selection when the intended lighting or area is simpler. Inspect, correct and compare as an editor would; choosing brush positions from the photograph is part of the agent's work.

## Choose the starting selection

| Intended edit                                                | Useful starting point                                                                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Lift a complete subject against an irregular background      | AI subject with an inspected bounding region; foreground when its broader coverage fits the intent               |
| Change the sky across an irregular skyline                   | AI sky, then inspect foreground spill and openings                                                               |
| Separate foreground, middle distance or background           | Depth range; use [optional Marigold](marigold-depth.md) when configured and useful, then inspect the actual band |
| Dodge part of a face, breast, garment or other local surface | Soft brush or radial mask kept within the intended surface; an exact subject silhouette is unnecessary           |
| Continuous lighting transition                               | Linear gradient, with its fade judged across the photograph                                                      |
| Select a color or brightness band                            | Sampled color/luminance, constrained spatially when similar values occur elsewhere                               |

These are choices, not a required sequence. Use the user's preferred starting mask if it is adequate. Do not replace a useful mask merely because automatic segmentation misses individual hairs. Recoloring, strong exposure changes and extraction can reveal errors that are invisible in a restrained tonal lift.

## Complementary subject and environment selections

For a wildlife portrait that needs subject definition and a quieter background, generate one AI-subject selection in a measured region around the animal. Keep it in a direct parent for subject-only detail, highlight or light control. If the surroundings need a different adjustment, copy that selection into a separate parent and invert the **parent**, so the two treatments start from the same boundary. When the connected bridge advertises `mask_duplicate`, call it with the subject `mask_id` and `invert:true`; it creates fresh parent and submask IDs and clears the copy's local adjustments by default. Older MCP builds need a verified asset-preserving whole-state copy or a separately inspected environment selection; do not claim an exact complement without one. Never hand-edit an opaque bitmap or sidecar. Cloned parents are not linked after creation. Render both mask overlays after the copy and recheck both whenever either composition changes.

Adjust subject and environment separately. A direct mask may support feather detail while the inverse controls background exposure, saturation or clarity; choose direction and strength from the new photograph rather than copying any previous slider values. If a branch, feather gap, snow edge or perch crosses the selection, correct the relevant parent with an additive or subtractive brush and re-render both sides. On the inverted parent, inversion happens after submask composition: an additive brush can **protect** its painted area from the background grade, while a subtractive brush can **include** it. Judge the final coverage and actual grade, not the brush mode name. Reuse an adequate existing subject selection before generating another. Depth intersections, surface selections, gradients and standalone brushes are better when the intended region follows scene planes or a light path rather than an animal silhouette.

## Combine depth with other selections

When scene depth helps separate the intended region but cannot describe its whole boundary, use a Marigold depth band as one component of a parent mask, then combine it with selectors that answer a different question. Intersect with an AI-subject selection to keep only the subject within that depth band. Subtract sampled colors or brush areas that share the depth but should remain untouched. Add subject coverage or brush repairs where the depth band misses part of the intended region. A different photograph may call for the opposite near/far band or an inverted parent. Choose the composition from the image and local adjustment, not a saved depth threshold.

Component order and mode change the result: an intersection constrains earlier coverage; a later additive component can restore pixels outside that intersection. Inspect each component, the final parent overlay, and the graded photograph at native boundaries and overview size. A depth estimate is a useful spatial constraint, not an exact object matte. When advertised by the connected bridge, `mask_generate` with `target_mask_id` and explicit `mode` adds a new AI subject or Marigold depth component to an existing parent. It returns the parent `mask_id`, new `sub_mask_id`, and revision. `mask_update` adds supplied color and brush components. Older builds may require a validated complete asset-preserving round trip; do not claim the stack was built through MCP unless the final parent mask renders as intended.

## Inspect and repair

1. **Inspect the source and choose the effect.** Identify what should change and what should remain stable. Render an overview and native detail at likely trouble spots: subject contact points, gaps, intersecting objects and high-contrast edges. Set geometry first. Map displayed points into the full pre-crop `mask` canvas using the actual render dimensions; see [coordinates](advanced-editing.md#coordinates-and-masks).
2. **Preserve the starting selection.** Keep its mask/submask IDs and current revision. Save a named version, or fork a candidate when comparing alternatives. Render the photograph, overlay and grayscale mask. Check both missing coverage and unrelated selected objects.
3. **Choose the smallest useful correction.** For an AI-subject omission or unwanted object, `mask_generate(kind:"subject", refine:{mask_id,sub_mask_id}, expected_revision, include_points, exclude_points)` can refine the existing AI submask; use measured include/exclude points and a region when needed to anchor the subject. Previous point arrays are not replayed automatically. Inspect the whole subject after every refinement. If it disappears, changes identity or loses valued coverage, undo or restore the reference and change approach. A nonempty response does not establish an improvement. Point refinement is optional: go directly to manual repairs when they are more controllable.
4. **Paint named corrections.** Inspect parent/submask inversion when resuming a selection. For a non-inverted parent, add brush submasks to the existing mask: `mode:"additive"` restores missing coverage; `mode:"subtractive"` removes spill. Use `tool:"brush"` inside either mode. An `eraser` line erases earlier strokes only inside its own brush submask; it does not erase the AI sibling. Use broad soft interior strokes for a tonal region, smaller strokes at boundaries, and edge softness that suits the recorded source. Keep each correction identifiable and preserve the AI submask. Use separate lines across disconnected parts; consecutive points paint a continuous stroke, including across any intervening gap.
5. **Judge the actual adjustment.** Compare the same local grade on the starting and corrected masks, and compare with the mask disabled. Inspect the whole frame at delivery size and matched native crops at changed boundaries. Verify that the intended subject gains light/color without a conspicuous halo, band, missing strip or altered apparent shape. Inspect combined masks when edits overlap; a correct individual mask can still contribute to an unnatural combined result.
6. **Stop when the edit is sufficient.** Keep repairs that visibly improve the requested result. A subtle tonal mask need not be a perfect extraction matte. If remaining errors matter, repair coverage, soften an overly abrupt transition or reconsider the adjustment strength against the brief. Do not hide an ineffective edit by reducing it to invisibility. Save the chosen session and inspect its exported result when export is requested. Keep known limits separate from user approval.

For a manual mask from scratch, use `mask_create(type:"brush", parameters:{lines:[...]})` or the suitable geometric/range type, then follow the same inspection and effect comparison. A soft interior dodge intentionally covers part of the subject; it is not evidence of a complete object selection. Manual creation is a normal option when it meets the intended edit more simply.

## Select for the rendered change

After retouching, check that a new selection follows the scene now being graded. A mask can retain the silhouette of an object removed by an earlier patch; compare the aligned mask with the current photograph before attributing the mismatch to feathering or model quality. Different selectors may use different inference inputs in the installed build. Do not assume a successful call proves that every selector includes visible retouch patches.

Inspect narrow background openings as well as the outer subject contour. A bird-shaped selection may bridge the sky between primaries; its inverse can then leave pale wedges inside an otherwise darkened sky. Inspect both the protected feather and the opening at native scale. Place manual corrections from the actual local image, with continuous coverage and an edge width suitable for that region; sparse dots or estimated widening strokes can introduce beads, hard wedges or spill onto feather shafts.

If refinements repeatedly trade missed gaps for damaged edges, reconsider the treatment instead of accumulating corrective masks. For a restrained tonal change, test a broad photographic gradient or selective colour adjustment and judge its effect on the subject as well as the surroundings. This is a different treatment, not proof of an accurate background extraction. Keep stronger recolouring or reconstruction confined to a sufficiently precise selection. Retain rejected experiments in history or a version, disable or remove their effects from the selected working recipe, and compare the final combined grade with the valued reference.

## Native brush contract

`brushSize` is a diameter in full mask-canvas pixels. Put `feather` (0–1) on each line. Parent/submask `opacity` is 0–100. Sample coordinates below illustrate the request shape only; replace them with measurements from the actual photograph.

```json
{
  "tool": "rapidraw_mask_update",
  "arguments": {
    "session_id": "SESSION_ID",
    "expected_revision": 7,
    "mask_id": "MASK_ID",
    "submask_operations": [
      {
        "operation": "add",
        "submask": {
          "type": "brush",
          "name": "Remove background spill",
          "mode": "subtractive",
          "parameters": {
            "lines": [
              {
                "tool": "brush",
                "brushSize": 18,
                "feather": 0.35,
                "points": [
                  { "x": 420, "y": 280 },
                  { "x": 445, "y": 291 }
                ]
              }
            ]
          }
        }
      }
    ]
  }
}
```

Use the returned revision for the next mutation and retain the generated submask IDs. For long strokes, submit a request file through the [persistent client](connection.md#persistent-fallback-client). To revise a correction, use atomic `submask_operations` to edit or remove that submask. Arrays such as `lines` replace their existing contents; do not accidentally discard earlier strokes. Never replace an opaque AI bitmap by hand.

Parent inversion applies after composition and reverses the visible effect of add/subtract; inspect the rendered result if it is enabled. Composition order matters: additive takes the maximum coverage, subtractive removes coverage down to zero, and intersect takes the minimum. An additive correction placed after a subtractive one can restore the removed area. Render the combined mask after changing order. Global grow/feather cannot selectively repair an omitted toe while excluding a neighboring branch; use local corrections for local defects.

Sampled color/luminance masks match values across the image, not a connected object. An intersection can constrain a spatial selection, but it can also remove useful coverage; inspect both target and protected areas. Check sampling placement after transformed geometry instead of assuming a preview sample automatically uses the right source coordinates.

## What the tested workflow establishes

The verified photographic workflow combines an AI subject selection with additive and subtractive brush repairs, then compares the same exposure/shadow adjustment before and after correction. A separate brush-only mask verifies a soft interior tonal lift from scratch. Native probes establish selected-area changes and protected-area stability; saved state and rendered pixels survive undo/redo and reopening. These tests support the editing loop on an inspected photograph, with usefulness judged from the actual grade and its limits.

Earlier point-refinement tests cover correction prompts, preserved IDs/edits and saved state; photographic probes show selected omissions and unwanted objects can be corrected. Refinement can also worsen a selection, so it is an optional branch with visual review and rollback. Use the workflow above to judge each new photograph rather than treating API success or previous examples as a guarantee of mask quality.
