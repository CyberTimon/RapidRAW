# RapidRAW MCP

A local, nondestructive interface to RapidRAW's native processing engine. It supports an agent's full editing loop: inspect a RAW photo, make reversible global and selective edits, inspect previews and native detail, manage models/presets/LUTs, save editable state and verify delivery exports. It does not contain a separate renderer or invoke the legacy export CLI.

This npm package is ONLY the Node stdio MCP host. It does not contain, install, or download the RapidRAW native application or any model weights.

Run the pinned host directly from the registry without cloning the repository:

```sh
npx -y @sheldonxxxx/rapidraw-mcp@0.2.0 --binary /absolute/path/to/rapidraw-mcp --workspace /absolute/path/to/workspace
```

Or install the pinned package once and run it by name:

```sh
npm install -g @sheldonxxxx/rapidraw-mcp@0.2.0
rapidraw-mcp --binary /absolute/path/to/rapidraw-mcp --workspace /absolute/path/to/workspace
```

Both `--binary` and `--workspace` must be absolute paths; there is no automatic native-binary discovery. On macOS, the installed executable is for example `/Applications/RapidRAW MCP.app/Contents/MacOS/rapidraw-mcp`; quote this path when using it in a shell. On Windows select `rapidraw-mcp.exe` inside the installation directory. On Linux use the installed `rapidraw-mcp` executable from a DEB/RPM package.

## Normal setup

For installation, client registration, and connection verification, follow the canonical [agent setup guide](https://github.com/sheldonxxxx/RapidRAW/blob/main/AGENT_SETUP.md): install the matching fork native package from this fork's releases (upstream packages do not include this fork's MCP bridge), configure the pinned npm host above in your MCP client, then verify with `rapidraw_capabilities` and `rapidraw_models`. The host package reports `0.2.0`, while the native bridge reports `1.2.0`; these component versions are independent of the app release version. The fork's new application identifier separates preferences and model storage from upstream; it does not migrate them automatically.

The [RapidRAW MCP skill](https://github.com/sheldonxxxx/RapidRAW/blob/main/skills/rapidraw-mcp/SKILL.md) provides agent guidance for editing, mask coordinates, derived sessions, recovery, and verified exports. Install it with `npx skills add sheldonxxxx/RapidRAW --skill rapidraw-mcp`. Pair it with your own brief or [Lightweft](https://github.com/sheldonxxxx/lightweft) for photographic direction, shared review and personal style exploration.

## Runtime contract

The MCP server uses the official TypeScript SDK v2 and stdio. Stdout carries only MCP protocol traffic; diagnostics go to stderr. One connection owns each workspace at a time through an exclusive native lock; use separate workspaces for simultaneous agents. It owns one persistent native bridge process; image processing and validation remain in Rust.

Options (flags or equivalent environment variables):

| Flag                          | Environment           | Meaning                                                     |
| ----------------------------- | --------------------- | ----------------------------------------------------------- |
| `--binary <absolute path>`    | `RAPIDRAW_BINARY`     | Native engine executable. Required, absolute, no discovery. |
| `--workspace <absolute path>` | `RAPIDRAW_WORKSPACE`  | Isolated editing authority. Required, absolute.             |
| `--timeout-ms <ms>`           | `RAPIDRAW_TIMEOUT_MS` | Default native-operation timeout (300000 ms).               |

Model installation, merge and batch export have a 30-minute maximum; configure the host's tool timeout accordingly. `RAPIDRAW_MODEL_CACHE` selects an absolute shared model-cache directory; omit it to use the application default. Optional `workspace/engine-settings.json` overrides bridge defaults using the native **camelCase** keys returned by `rapidraw_get_engine_settings`; restart the connection after changing it. The bridge never migrates or writes the installed GUI application's preferences. Generative retouch providers are configured explicitly; image content is sent only when generative mode is selected, and provider tokens never belong in the settings file.

Missing models do not prevent basic adjustments and geometric masks, but AI operations need their assets: call `install_model` for each required model group and verify with `rapidraw_models` before running dependent tools. Models are not bundled with the npm host or the native installer. Masking, denoise, and inpainting default to CPU on every platform unless explicitly configured; see the [ONNX CUDA guide](https://github.com/sheldonxxxx/RapidRAW/blob/main/docs/mcp/onnx-cuda.md) and the [remote SSH guide](https://github.com/sheldonxxxx/RapidRAW/blob/main/docs/mcp/remote-ssh.md) for the opt-in Linux GPU paths.

## Capabilities

Every tool starts with `rapidraw_`; the table shows the suffixes available in this source checkout. The pinned npm `0.2.0` host above predates `mask_duplicate` and targeted `mask_generate`. Check the connected MCP host's tool list and the native engine's `rapidraw_capabilities` response before using a new operation. For interactive editing, begin with `rapidraw_capabilities({"detail":"overview"})`, then request exact schema branches as needed. Unknown schema paths are errors.

| Area                        | Tools                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery and state         | `capabilities`, `list_images`, `open_photo`, `list_sessions`, `get_session`, `close_session`                                                                                       |
| Editing and review          | `set_adjustments`, `render`, `render_compare`, `inspect_adjustments`, `analyze`, `auto_adjust`, `map_coordinates`, `preflight`, `sample_region`                                    |
| Selective edits             | `mask_create`, `mask_duplicate`, `mask_update`, `mask_remove`, `mask_generate`, `generate_depth`                                                                                   |
| Background processing       | `start_denoise`, `get_job`, `list_jobs`, `cancel_job`, `resume_job`, `start_operation`, `get_operation_job`, `list_operation_jobs`, `cancel_operation_job`, `resume_operation_job` |
| Local masks and enhancement | `enhancement_models`, `install_enhancement_model`, `enhance`                                                                                                                       |
| Detail and corrections      | `retouch`, `denoise`, `lens_profile`, `negative_convert`                                                                                                                           |
| History and persistence     | `history`, `undo`, `redo`, `save_version`, `list_versions`, `restore_version`, `save_session`, `load_recipe`, `save_recipe`                                                        |
| Presets and assets          | `list_presets`, `apply_preset`, `list_luts`, `apply_lut`, `manage_presets`, `manage_luts`, `models`, `install_model`                                                               |
| Delivery and composition    | `export`, `batch_export`, `merge`                                                                                                                                                  |
| Portable editing            | `fork_session`, `export_session_bundle`, `import_session_bundle`, `diff_versions`, `copy_adjustments`                                                                              |
| Metadata and configuration  | `get_metadata`, `set_metadata`, `get_engine_settings`                                                                                                                              |

Resources: `rapidraw://workflow` (editing/review/delivery workflow), `rapidraw://adjustment-schema` (native schemas and units), `rapidraw://sessions/{session_id}` (current editing state with read-only asset descriptors). The `pro_photo_edit` prompt accepts `path` and optional `intent`; the server does not itself run or pay for a language model.

Current reference guides live under [`docs/mcp/`](https://github.com/sheldonxxxx/RapidRAW/blob/main/docs/mcp/README.md): remote SSH, ONNX CUDA, geometry/review, portable sessions, subject refinement, testing and evidence, and npm-host releasing. Dated acceptance evidence is archived under [`docs/mcp/history/`](https://github.com/sheldonxxxx/RapidRAW/blob/main/docs/mcp/README.md#historical-evidence) and is not the live tool inventory.

This source checkout also supports [native mask composition](../docs/mcp/README.md#mask-composition): duplicate a parent with fresh IDs, or add a generated AI component to an existing parent. These changes are not part of the pinned npm `0.2.0` host above; check both the host's tool list and the native capability response.

## Example editing loop

Call `rapidraw_capabilities` with the needed schema paths, then use the actual returned session ID and revision (not the illustrative values below):

```json
{"tool":"rapidraw_open_photo","arguments":{"path":"/photos/example.cr3"}}
{"tool":"rapidraw_render","arguments":{"session_id":"RETURNED_ID","long_edge":1600}}
{"tool":"rapidraw_set_adjustments","arguments":{"session_id":"RETURNED_ID","expected_revision":0,"patch":{"exposure":0.25,"highlights":-18,"shadows":12}}}
{"tool":"rapidraw_render","arguments":{"session_id":"RETURNED_ID","long_edge":1600}}
```

`open_photo` inherits an existing sidecar by default; use `inherit_sidecar: false` for a fresh treatment. Render/analyze regions use full-resolution rendered coordinates after user crop and geometry; mask geometry and AI subject regions use the corrected canvas before crop (`map_coordinates` space `mask`). For native detail review, first inspect rendered dimensions, then call `render` with an integer pixel `region`. If a call fails, choose recovery by the returned error: `RESPONSE_TOO_LARGE` keeps the connection (request a smaller response; the edit may already have completed — do not replay it); `REVISION_CONFLICT` requires rereading the session and reconciling the patch; after a transport failure, timeout, crash or native cancellation, reconnect and inspect saved state before retrying. A successful preview or export alone does not prove a professional-quality edit.

Save and deliver after visual review with `save_session`, `save_recipe`, and `export` into the workspace's `exports`/`recipes` directories; inspect the exported image and returned output metadata.

## Preservation and error behavior

Source images and their sidecars are read-only to the workflow. `open_photo` creates an isolated working copy under `workspace/sessions/<id>`; edits, retouch intermediates and native `.rrdata` state stay with that copy. Exports must remain under `workspace/exports`, and recipes under `workspace/recipes`; relative output paths resolve inside their respective category. Exporting over a source is prohibited, and replacing an existing export requires `overwrite: true`. Recipe saves never overwrite an existing file. GPS stripping defaults on. Metadata edits affect the isolated session and its exports.

Tool inputs reject unknown top-level fields, and mutations accept `expected_revision` to reject stale changes. Success returns `structuredContent`; previews also return native MCP image blocks without repeating their base64 in the JSON/text result. Engine failures return `isError: true` with a stable code and actionable message. The server caps serialized MCP responses at **8 MiB**; oversized images or state return `RESPONSE_TOO_LARGE` while keeping the connection usable — retry with an explicitly smaller `long_edge`, a bounded native `region`, JPEG encoding, or `get_session(include_adjustments:false)`.

Tool and session-resource responses replace opaque mask bitmaps, refinement tensors, retouch pixels, depth maps and embedded LUT data with descriptors containing a SHA-256 identity. **A summarized adjustment object is not a replacement recipe:** the server rejects asset descriptors in edit requests. Use targeted merge/mask operations or native saved-state/bundle operations. Programmatic validators that need inline native assets can explicitly request `get_session(include_adjustments:true, include_assets:true)` within the same response-size budget. The server never automatically retries a mutation.

The MCP process runs with your local account's filesystem permissions. Use it only with trusted local hosts. It is stdio-only: no network listener or authentication service is installed.

## Build and connect

Source builds are a developer fallback for when no compatible packaged release exists for the target, or for fork development. Follow the [native integration guide](https://github.com/sheldonxxxx/RapidRAW/blob/main/MCP.md#build-and-verify) to build the fork with the `mcp` Cargo feature, then configure your client with the resulting absolute `mcp/dist/index.js` and native executable paths.

## Verification

Protocol transport tests use the real official MCP client with an intentionally fake native subprocess:

```sh
npm test --prefix mcp
```

These verify protocol transport, schemas, native image blocks, error propagation, serialization, cancellation and subprocess lifecycle. They do not claim image-processing correctness. For real-engine acceptance and photographic evidence procedures, see [testing and evidence](https://github.com/sheldonxxxx/RapidRAW/blob/main/docs/mcp/testing.md) and the [historical verification snapshot](https://github.com/sheldonxxxx/RapidRAW/blob/main/docs/mcp/history/verification-2026-09.md).
