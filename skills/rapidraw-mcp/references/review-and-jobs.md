# Comparisons, mask diagnostics and background jobs

Read capabilities first. These tools require a matching native build; do not emulate them by repeatedly committing and undoing candidate edits.

## Keep the valued reference

`save_version(session_id, label, expected_revision)` captures immutable adjustments and metadata without changing the revision. Retain its `version_id`; labels need not be unique. `list_versions` survives restart and the bounded undo history. `restore_version(session_id, version_id, expected_revision)` creates a new undoable revision; it does not rewind the revision counter or overwrite the reference.

Use `render_compare` to compare 2–4 labeled variants. Each begins with the current edit, or its own `version_id`, then applies an optional adjustment `patch` and `disabled_masks`. One integer `region` and `long_edge` apply to all variants. The region uses rendered coordinates after geometry. Default long edge is 1200, maximum 2048; request a bounded region and sufficient long edge for native detail. Different crops/warps are rejected rather than silently misaligned. These renders do not modify session state, history, revision or sidecar.

```json
{
  "session_id": "SESSION_ID",
  "long_edge": 1200,
  "variants": [
    { "label": "Valued reference", "version_id": "VERSION_UUID" },
    { "label": "Cooler", "patch": { "temperature": -15 } },
    { "label": "Warmer", "patch": { "temperature": -5 } },
    { "label": "Horizon mask off", "disabled_masks": ["MASK_ID"] }
  ]
}
```

Replace these illustrative values with the actual reference and source-specific alternatives. Patches contain absolute native slider values, not deltas. Review whole-frame relationships as well as the named defect. Only after choosing a candidate should its patch become a real edit.

The response carries multiple MCP image blocks. `images[].label` and `content_index` identify them; structured text does not contain image bytes. Preserve the order and labels in side-by-side or slider review. Version references belong to one session/source; this tool does not align different source frames or denoise sessions.

## Revise from user feedback

Preserve the reviewed candidate and compare the revision with both it and the source reference. Choose controls from the actual defect; do not reuse a successful photo's settings as a genre recipe.

- **Lost colour:** isolate colour balance, saturation and highlight changes before increasing saturation globally. Check whether reverting the grade restores the valued colour while retaining useful denoising or cleanup.
- **Flat subject:** compare subject and background together. A global exposure lift may brighten both without improving separation. Test a targeted tonal change, inspect its mask coverage and native boundaries, and reject spill or a visible spotlight.
- **Unreadable lower frame:** if the upper light already works, test a local shadow lift. Check its effect at delivery size, then inspect native shadow noise, colour, the transition and any affected rim light. Choose the extent from the visible result.

Keep prior review comments tied to their candidate path or hash. A replacement candidate starts awaiting review; retain the old decision as history. General feedback such as “better” records improvement without implying acceptance of every image or resolving every remaining limit.

## Inspect combined masks

Call `inspect_adjustments` with a session and optional region. By default its before view disables all enabled masks; supply `disabled_masks` to isolate particular contributors. It returns:

- Matched before and current-edit images.
- Absolute rendered RGB difference, amplified by `difference_gain` (default 4). This includes the disabled masks' tonal and colour effects.
- Combined local exposure influence: native exposure contributions weighted by the actual mask bitmaps, including opacity, inversion and basic-section visibility. Blue is negative EV, neutral gray is zero and red positive EV. `exposure_range` controls the legend (default ±2 EV).

The EV statistics and row profile describe the selected full-resolution region. Global exposure is reported separately; shadows, contrast, curves and other controls are excluded from this map. A zero exposure map does **not** mean the masks have no visible effect. Use the actual difference image and the photograph to establish cause. A dark row is evidence to inspect, not an automatic defect: the scene may contain a real dark feature. `disabled_masks: []` produces an unchanged before view as a diagnostic control.

## Background denoise

1. Inspect `models` for AI and `models.groups.nonlocal` for the GPU backend; install missing assets only when needed and authorized. Call `start_denoise` with parent session, latest revision, `method: "ai"`, `"bm3d"`, or `"nonlocal"`, and intensity. Nonlocal requires Bayer RAW and a pinned native bundle installed once via `install_model kind="nonlocal"` for the selected provider (`cpu`, Linux CUDA, or macOS CoreML); `RAPIDRAW_NONLOCAL_BUNDLE` is an explicit manual-bundle override. Source capture and asset verification precede the job response; Nonlocal inference runs in-process through native ONNX Runtime or directly through CoreML.framework.
2. Keep `job_id`. Poll `get_job` at a reasonable interval; the session remains available for editing and rendering. One denoise job runs per workspace. `progress_percent` covers processing and result publication; 100 means the result was saved.
3. Success returns a separate `result_session_id`. Inspect it and matching parent detail. Its source pixels, RAW interpretation and inherited edits come from the captured input, even if the parent was edited while filtering ran. Save that session before delivery.
4. To stop, call `cancel_job`, then poll until terminal. Cancellation is cooperative between BM3D patches/NIND tiles; Nonlocal cancellation lands on tile boundaries and cannot abort an active ORT or CoreML call. It does not kill the editing engine. If completion won the race, use the returned completed status.
5. After disconnection/restart, inspect `list_jobs`/`get_job` before starting anything else. Completed results are durable without polling. A running job interrupted by engine exit becomes `interrupted`. `resume_job` keeps its ID, increments its attempt and starts again from the captured input. It does not continue from a saved tile checkpoint. Failed/cancelled jobs can also be restarted explicitly.

Do not judge star preservation or denoise quality from status, progress or reduced noise alone. Inspect faint stars, dust lanes and foreground detail. Intensity zero skips filtering but still creates a derived session in the background API. The synchronous compatibility `denoise` tool retains its zero-intensity no-op behavior and its existing active-request timeout/cancellation semantics.
