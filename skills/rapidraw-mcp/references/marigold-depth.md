# Optional Marigold depth

Use Marigold V2 for a depth-based local adjustment when its finer scene or subject boundaries justify remote inference. It is an optional **depth-mask provider** on the existing AI connector and ComfyUI instance. Built-in depth remains the default; configuring the connector does not hide local depth. Subject/sky selectors and generative profiles retain their existing choices.

## Select and generate

1. Check the live `mask_generate` schema for `depth_provider`. Older servers may not expose it. Marigold requires `marigoldDepthEnabled: true` and the existing `aiConnectorAddress` in the engine workspace's settings, plus the connector's optional Marigold setup. Do not infer readiness from local ONNX model availability or the generic connector health check. `/depth/capabilities` checks the optional nodes, pinned weights and offloading compatibility.
2. Set lens distortion and perspective corrections before inference. Marigold analyzes the geometry-corrected full frame before rotation and crop; analysis is reduced to a 1024-pixel long edge and the fixed workflow uses 0.67 Comfy MP. Crop coordinates are not input coordinates for the depth map.
3. Call `rapidraw_mask_generate` with `kind: "depth"`, `depth_provider: "marigold"`, the live session/revision and a useful depth band. Omitting the provider selects built-in depth. `depth_provider: "marigold"` is valid only for depth masks.

```json
{
  "session_id": "SESSION_ID",
  "expected_revision": 0,
  "kind": "depth",
  "depth_provider": "marigold",
  "parameters": {
    "minDepth": 45,
    "maxDepth": 100,
    "minFade": 10,
    "maxFade": 0,
    "feather": 0
  }
}
```

This band is an example, not a subject-selection preset. Use the returned mask/submask IDs and revision. For background execution, `rapidraw_start_operation` with operation `mask_generate` follows the existing operation-job lifecycle; inspect its resulting independent session before continuing.

## Inspect and reuse

- Near is bright and far is dark. Values are per-image normalized **relative log depth**, not metres or a calibrated alpha matte. Reconsider the band when changing depth providers; equal numeric thresholds need not isolate the same physical region.
- Render the resulting mask with `mask_mode: "overlay"` and inspect the photograph, selection and native boundary crops. Check hair/fur, feather gaps, thin wires, feet/perches and foreground/background transitions. Judge the intended grade as well as the map; repair important misses with the [guided masking loop](guided-masking.md).
- When depth alone includes the wrong object or misses part of the target, [combine the depth band with subject, color, and brush components](guided-masking.md#combine-depth-with-other-selections). Intersection can limit a depth band to the subject; subtraction protects similar-depth colors or areas; additive components restore missing coverage. Check component order and the final rendered mask. If the connected bridge advertises targeted `mask_generate`, pass the depth parent as `target_mask_id` with the intended `mode`; older builds need the fallback in that guide.
- Desktop users can choose **Visualize depth** in a saved depth component's properties. It shows the full map before rotation/crop, provider, dimensions, far-to-near legend, Fit, 100% and zoom controls. It reads built-in or Marigold maps without inference or edit changes. This is a desktop viewer, not an additional MCP tool; use native mask renders for MCP review.
- Change range/fade parameters through targeted mask updates to reuse the saved map. Marigold bands have full selection strength inside the range; built-in masks retain their older depth-brightness weighting. Do not mistake that difference for a model-accuracy improvement.
- The engine owns the 16-bit PNG and `depthArtifact` provenance. Tool responses may expose only opaque-asset descriptors. Never copy a descriptor into an adjustment or reconstruct the bitmap from it. Native save, fork and portable-bundle operations preserve the complete map.
- Saved maps render offline and with Marigold disabled. Rotation, flips and crop reuse a Marigold map. Changing lens distortion or perspective requires regenerating it. Inspect alignment after geometry changes.

## Shared GPU and recovery

Depth and generative requests use one connector queue and the same ComfyUI. Switching workflows unloads previous models; another client's queued/running Comfy job can temporarily prevent a switch. Keep the request/job identifier and reconcile a timeout before retrying. Do not restart the server, cancel unrelated jobs or create a second connector to work around a busy queue.

The bundled Q4 sampler targets roughly 7 GiB through CPU offloading during Marigold sampling only. It is not a hard allocation limit or a configurable 4 GiB setting. Do not apply a global Comfy memory reservation to a shared server merely to run depth. A new memory target requires a separately measured profile and generative regression checks.

Discarding a desktop result prevents its application; the shared GPU job may still finish. A late result is also rejected after a photo or analysis-geometry change. If optional setup fails, report that failure and keep the existing edit; use built-in depth only when appropriate to the user's request.

## Lens blur boundary

`rapidraw_generate_depth` and ordinary lens blur still use built-in depth. A Marigold mask does not switch lens blur automatically, and there is no Marigold lens-blur selector. A six-scene comparison through the existing native renderer found useful improvements in some fur/feather and scene boundaries, with slower map generation and remaining strong-blur halos. Treat it as experimental evidence for a future optional mode. Do not promise better blur on every photograph or manually transfer opaque depth assets to simulate an integrated feature.
