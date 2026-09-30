# External Control / MCP

Local automation API for RapidRAW. Used by the companion [`rapidraw-mcp`](https://github.com/1tuz/rapidraw-mcp) stdio server (Cursor, Claude Desktop, Codex, and other MCP clients).

## Architecture

```
MCP client  --stdio-->  rapidraw-mcp  --HTTP Bearer-->  RapidRAW External Control
                                                      (127.0.0.1:{port}/v1)
                                                              |
                              +-------------------------------+-------------------------------+
                              |                               |                               |
                     session mirror                    bridge actions                    rust-side ops
                     (push every ~500ms)               (UI store / navigate)             (preview, list,
                                                                                        rating, export, …)
```

| Layer | Role |
| --- | --- |
| **HTTP server** (`src-tauri/src/external_control/`) | Axum on `127.0.0.1` only. Off unless enabled. Validates bearer token, paths, body size. |
| **Session mirror** | Frontend pushes current image, adjustments, selection, folder via `external_control_push_session`. |
| **Bridge** | For UI-bound ops: Rust emits Tauri event `external-control-command`; React hook fulfills with `external_control_fulfill_request` (30s timeout). |
| **rapidraw-mcp** | Thin MCP ↔ HTTP client. No knowledge of React/Zustand/WGPU. |

Protocol version: **1.0.0**. Default port: **17355**.

## Enable in Settings

1. Open RapidRAW → **Settings** → **External Control / MCP**.
2. Check **Enable external control (localhost)**.
3. Optionally set **Port** (default `17355`).
4. Enabling auto-generates a bearer token if none exists; click **Copy token** (plaintext shown once; only SHA-256 hash is stored). A token is **required** — the server will not listen without one.
5. Keep RapidRAW running with a window open (bridge needs the UI).
6. Point MCP client at `rapidraw-mcp` with:
   - `RAPIDRAW_API_URL=http://127.0.0.1:17355` (or your port)
   - `RAPIDRAW_API_TOKEN=<copied token>`

Status labels: **Disabled** → **Enabled** / **Starting…** → **Connected** (when a client is active).

See also: [mcp-tools.md](./mcp-tools.md), [mcp-client-examples/](./mcp-client-examples/).

## Security

- **Loopback only** — bind address is always `127.0.0.1`, never `0.0.0.0`.
- **Disabled by default** — `externalControlEnabled` defaults to `false`.
- **Bearer token** — `Authorization: Bearer <token>`. Hash stored in app settings; regenerating invalidates the previous token.
- **Path allowlist** — file paths must be absolute, canonicalize successfully, and lie under configured library roots (`rootFolders` / `lastRootPath`). Otherwise home-directory-only fallback. Blocks traversal / out-of-library access.
- **Body limit** — 2 MiB request bodies.
- **Preview caps** — max edge 2048 (default 1024); JPEG payload rejected above ~4 MiB.
- **No remote network** — API does not proxy arbitrary URLs or run shell commands from the model.
- **Disable anytime** — uncheck Enable; server shuts down.

## Auth and responses

All `/v1/*` routes require a valid bearer token. The server refuses to start if External Control is enabled without a configured token.

Success:

```json
{ "ok": true, "data": { ... } }
```

Error:

```json
{ "ok": false, "error": { "code": "unauthorized", "message": "...", "details": null } }
```

Common codes: `unauthorized`, `path_forbidden`, `path_not_found`, `invalid_path`, `bridge_timeout`, `frontend_unavailable`, `no_image`, `not_found`.

## `/v1` endpoints

| Method | Path | Execution | Notes |
| --- | --- | --- | --- |
| GET | `/v1/status` | rust | Protocol version, enabled, port, session snapshot |
| GET | `/v1/adjustments/schema` | rust | Known adjustment keys / UI ranges |
| GET | `/v1/current-image` | rust | Mirrored current path + ready flag |
| GET | `/v1/adjustments` | bridge | Live editor adjustments |
| POST | `/v1/adjustments/set` | bridge | Body: `{ "key", "value" }` (dot keys OK) |
| POST | `/v1/adjustments/adjust` | bridge | Body: `{ "key", "delta" }` |
| POST | `/v1/adjustments/reset` | bridge | Reset to defaults |
| POST | `/v1/undo` | bridge | |
| POST | `/v1/redo` | bridge | |
| GET | `/v1/selection` | rust | Selected paths + current folder (mirror) |
| GET | `/v1/preview` | rust | Query: `maxEdge`, optional `path`. JPEG base64 |
| GET | `/v1/images` | rust | Query: `folder`, `recursive` |
| POST | `/v1/images/open` | bridge | Body: `{ "path" }` |
| POST | `/v1/images/next` | bridge | |
| POST | `/v1/images/previous` | bridge | |
| GET | `/v1/images/metadata` | rust | Query: `path` |
| GET | `/v1/presets` | bridge | |
| POST | `/v1/presets/apply` | bridge | Body: `{ "name" }` |
| POST | `/v1/presets/save` | bridge | May return `not_implemented` (use UI for full save) |
| POST | `/v1/rating` | rust | Body: `{ "path"?, "rating" }` (0–5) |
| POST | `/v1/color-label` | rust | Body: `{ "path"?, "label" }` |
| POST | `/v1/adjustments/copy` | bridge | |
| POST | `/v1/adjustments/paste` | bridge | |
| POST | `/v1/adjustments/apply-to` | bridge | Body: `{ "paths" }` |
| POST | `/v1/export` | rust | Body: `{ "path"?, "outputPath", "format"?, "quality"? }` |
| POST | `/v1/export/batch` | rust | Body: `{ "paths", "outputFolder", "format"?, "quality"? }` |

JSON fields use **camelCase**.

## Bridge actions

Frontend handler: `src/hooks/useExternalControlBridge.ts`.

Supported `action` values: `get_adjustments`, `set_adjustment`, `adjust_parameter`, `reset_adjustments`, `undo`, `redo`, `open_image`, `next_image`, `previous_image`, `list_presets`, `apply_preset`, `save_preset`, `copy_adjustments`, `paste_adjustments`, `apply_adjustments_to_images`.

## Limitations

- App window must be running for bridge operations.
- `save_preset` may be UI-only until fully implemented.
- Export uses library path validation for destinations; keep output under allowed roots.
- Preview is a downscaled JPEG, not the original RAW.
