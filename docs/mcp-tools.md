# MCP tools (`rapidraw-mcp`)

Tools exposed by the companion [rapidraw-mcp](https://github.com/1tuz/rapidraw-mcp) server over stdio. Each tool maps to one RapidRAW External Control `/v1` call. See [external-control.md](./external-control.md).

Env for the MCP process:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RAPIDRAW_API_URL` | `http://127.0.0.1:17355` | Base URL (no trailing `/v1`) |
| `RAPIDRAW_API_TOKEN` | _(empty)_ | Bearer token from Settings |
| `RAPIDRAW_TIMEOUT_SECS` | `30` | HTTP timeout |

## Information

| Tool | HTTP | Arguments | Description |
| --- | --- | --- | --- |
| `rapidraw_get_status` | `GET /v1/status` | — | Protocol version, enabled flag, port, session mirror |
| `rapidraw_get_current_image` | `GET /v1/current-image` | — | Current image path and ready flag |
| `rapidraw_get_image_metadata` | `GET /v1/images/metadata` | `path` | Sidecar metadata / adjustments for a library path |
| `rapidraw_get_adjustments` | `GET /v1/adjustments` | — | Live editor adjustments |
| `rapidraw_get_selection` | `GET /v1/selection` | — | Multi-selected paths and current folder |

Schema helper (same API; may be used internally or via status workflows): `GET /v1/adjustments/schema`.

## Preview

| Tool | HTTP | Arguments | Description |
| --- | --- | --- | --- |
| `rapidraw_get_preview` | `GET /v1/preview` | `maxEdge?`, `path?` | Processed JPEG preview (base64 / MCP image content). Caps edge length; omits `path` → current image |

Typical agent loop: preview → read adjustments → set/adjust → preview again.

## Adjustments

| Tool | HTTP | Arguments | Description |
| --- | --- | --- | --- |
| `rapidraw_set_adjustment` | `POST /v1/adjustments/set` | `key`, `value` | Absolute set (dot keys for nested, e.g. `hsl.red.hue`) |
| `rapidraw_adjust_parameter` | `POST /v1/adjustments/adjust` | `key`, `delta` | Relative change (e.g. exposure `+0.25`) |
| `rapidraw_reset_adjustments` | `POST /v1/adjustments/reset` | — | Reset to defaults |
| `rapidraw_copy_adjustments` | `POST /v1/adjustments/copy` | — | Copy current adjustments to app clipboard |
| `rapidraw_paste_adjustments` | `POST /v1/adjustments/paste` | — | Paste copied adjustments |
| `rapidraw_apply_adjustments_to_images` | `POST /v1/adjustments/apply-to` | `paths[]` | Apply current editor adjustments to paths |

Common scalar keys include: `exposure`, `contrast`, `highlights`, `shadows`, `whites`, `blacks`, `temperature`, `tint`, `saturation`, `vibrance`, `clarity`, `structure`, `dehaze`, sharpening / NR / vignette fields. Nested: `hsl`, `curves`, `crop`, `masks`, etc. Prefer schema / live adjustments over inventing keys.

## History

| Tool | HTTP | Arguments | Description |
| --- | --- | --- | --- |
| `rapidraw_undo` | `POST /v1/undo` | — | Undo last edit |
| `rapidraw_redo` | `POST /v1/redo` | — | Redo |

## Presets

| Tool | HTTP | Arguments | Description |
| --- | --- | --- | --- |
| `rapidraw_list_presets` | `GET /v1/presets` | — | Preset names |
| `rapidraw_apply_preset` | `POST /v1/presets/apply` | `name` | Apply named preset to current image |
| `rapidraw_save_preset` | `POST /v1/presets/save` | `name` | Save current as preset (may be UI-limited) |
| `rapidraw_import_presets` | `POST /v1/presets/import` | `paths?[]`, `url?` | Import from local files and/or http(s) URL |
| `rapidraw_list_community_presets` | `GET /v1/presets/community` | — | List official community presets (GitHub) |
| `rapidraw_import_community_preset` | `POST /v1/presets/community/import` | `name` | Install one community preset into the app |

## Navigation

| Tool | HTTP | Arguments | Description |
| --- | --- | --- | --- |
| `rapidraw_list_images` | `GET /v1/images` | `folder`, `recursive?` | List images under a library folder |
| `rapidraw_open_image` | `POST /v1/images/open` | `path` | Open image in editor |
| `rapidraw_next_image` | `POST /v1/images/next` | — | Next image in current list |
| `rapidraw_previous_image` | `POST /v1/images/previous` | — | Previous image |

## Culling

| Tool | HTTP | Arguments | Description |
| --- | --- | --- | --- |
| `rapidraw_rate_image` | `POST /v1/rating` | `rating`, `path?` | Star rating 0–5 (selection if no path) |
| `rapidraw_set_color_label` | `POST /v1/color-label` | `label`, `path?` | Color label (empty clears) |

## AI masks, erase, denoise

| Tool | HTTP | Arguments | Description |
| --- | --- | --- | --- |
| `rapidraw_create_ai_mask` | `POST /v1/masks/ai` | `type` (`sky`\|`foreground`\|`subject`\|`depth`), `box?` | Create AI mask on current image. `subject` needs normalized `{x,y,w,h}` box |
| `rapidraw_adjust_mask` | `POST /v1/masks/adjust` | `adjustments`, `maskId?` | Local adjustments on active/named mask (e.g. darken sky) |
| `rapidraw_ai_erase` | `POST /v1/ai/erase` | `mode` (`quick`\|`generative`), `maskId?`, `prompt?` | Remove content under mask. `quick` = local LaMa; `generative` needs Cloud/Connector |
| `rapidraw_ai_status` | `GET /v1/ai/status` | — | ONNX models / connector / provider readiness |
| `rapidraw_ai_denoise` | `POST /v1/ai/denoise` | `method?`, `intensity?` | Denoise current image |

Typical remove-object loop: `create_ai_mask` (subject/foreground) → `get_preview` → `ai_erase` (`quick`) → `get_preview`.  
Sky grade loop: `create_ai_mask` (`sky`) → `adjust_mask` (`{ exposure: -0.5, highlights: -30 }`) → `get_preview`.

## Export

| Tool | HTTP | Arguments | Description |
| --- | --- | --- | --- |
| `rapidraw_export_image` | `POST /v1/export` | `outputPath`, `path?`, `format?`, `quality?` | Export one image (current if no path) |
| `rapidraw_export_batch` | `POST /v1/export/batch` | `paths[]`, `outputFolder`, `format?`, `quality?` | Batch export into a folder |

Formats follow RapidRAW export (e.g. `jpeg`). Paths must stay inside allowed library roots.

## Tool count

**25** tools (`rapidraw_*` names above).
