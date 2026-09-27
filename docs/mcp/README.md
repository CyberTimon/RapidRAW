# RapidRAW MCP documentation

The live tool inventory is `rapidraw_capabilities`, not any static matrix. For installation and connection, start with the [agent setup guide](../../AGENT_SETUP.md); for the npm package runtime contract, see [mcp/README.md](../../mcp/README.md).

## Current guides

| Guide                                       | Use it for                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| [Remote SSH](remote-ssh.md)                 | Running the Node host and native engine on a Linux GPU server over SSH        |
| [ONNX CUDA](onnx-cuda.md)                   | Opt-in CUDA inference for supported mask/depth/denoise models on Linux        |
| [Geometry and review](geometry-review.md)   | Coordinate mapping, native detail and diagnostic previews                     |
| [Portable sessions](portable-sessions.md)   | Independent alternatives, reusable looks and moving edits                     |
| [Subject refinement](subject-refinement.md) | Point-guided AI subject mask refinement                                       |
| [Testing and evidence](testing.md)          | Reproducing protocol, native and photographic checks                          |
| [Releasing the npm host](releasing.md)      | Independently versioned `mcp-vX.Y.Z` npm releases via OIDC Trusted Publishing |

## Mask composition

This checkout adds `mask_duplicate` to copy a parent selection into an independent mask with fresh IDs. By default it clears the copied mask's local adjustments; `invert: true` toggles the copied parent's selection. `mask_generate` accepts `target_mask_id` and `mode` to add a generated AI component to an existing parent. These calls support a subject mask paired with its inverse and a generated depth band intersected with another selection. Native acceptance exercised the built-in depth path; Marigold uses the same composition path after remote inference, but that provider was not exercised in this check. `mask_update` continues to add supplied brush and color components. Inspect the rendered parent after every composition change.

Use `rapidraw_capabilities` to confirm that the connected native bridge advertises these methods. The independently versioned npm host and packaged native app must both contain the matching changes; the pinned `0.2.0` host in the current setup guide predates these operations.

## Photo-editing coverage in this checkout

| Editing family                                                                     | MCP operations                                                                                                                   |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Global adjustments, geometry, color, curves, lens corrections, film looks and blur | `set_adjustments`, `auto_adjust`, `lens_profile`, `negative_convert`                                                             |
| Manual and AI selections, local grades, depth and mask composition                 | `mask_create`, `mask_update`, `mask_remove`, `mask_duplicate`, `mask_generate`, `generate_depth`, `enhance`                      |
| Retouch, removal, denoise, HDR, focus and panorama                                 | `retouch`, `denoise`, `start_denoise`, `merge`                                                                                   |
| Review, history, portable edits, presets and delivery                              | `render`, `render_compare`, `analyze`, `history`, `undo`, `redo`, session/bundle/preset/LUT operations, `export`, `batch_export` |

The [method parity test](../../mcp/test/method-parity.test.mjs) checks that every native bridge method has a Node MCP tool; the Node host also has five job-management tools. This establishes API exposure, not photographic quality or proof that every parameter combination has been exercised. Use the [testing guide](testing.md) for native and rendered-output checks. Desktop catalog navigation, tethering, and interface preferences are outside this photo-editing inventory.

## Historical evidence

Dated September 2026 snapshots. They preserve the measurements and claims recorded at the time; they are not the live tool inventory or current support matrix.

| Snapshot                                                  | Records                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| [Capability matrix](history/capability-matrix-2026-09.md) | Application/MCP/test-coverage inventory from the 62-tool-era build |
| [Verification record](history/verification-2026-09.md)    | Executed acceptance runs, build boundaries and fixtures            |
| [Gap assessment](history/gap-assessment-2026-09.md)       | Remaining priorities and acceptance boundaries as assessed then    |
