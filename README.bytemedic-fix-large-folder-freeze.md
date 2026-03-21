# Branch Summary: `bytemedic-fix-large-folder-freeze`

## Goal

This branch investigates and mitigates a severe desktop freeze that happened when RapidRAW opened photo folders, especially folders containing many RAW files and large JPEGs.

The work was intentionally kept incremental and low-risk:

- no large refactor
- no architecture rewrite
- no changes to the `src-tauri/rawler` vendor subtree
- focused patches only in the hot paths that were actually involved in folder opening, thumbnail generation, and startup restore

## Initial Problem

Opening a photo folder could trigger a large burst of work across several layers at once:

- eager thumbnail requests for many images
- expensive RAW thumbnail generation
- heavy JPEG decode paths
- large IPC payloads
- extra folder-tree and listing work during startup
- early GPU initialization during gallery thumbnail work

On the affected machine, this could escalate from a slow app to a full system freeze.

## Commit-by-Commit Breakdown

### `0b7e1b58` `Reduce thumbnail pressure for large folders`

This first patch reduced the raw amount of work done when thumbnails started loading.

- lowered thumbnail width to reduce encode, memory, and IPC cost
- reduced gallery thumbnail concurrency
- reduced progress-event chatter
- batched frontend thumbnail state updates to avoid thousands of individual React writes

Why it mattered:
This cut the initial thumbnail burst without changing the overall architecture.

### `f017fb92` `Request thumbnails only for visible library rows`

This moved thumbnail requests from "whole folder" to "currently visible rows plus overscan" in the main library.

- wired visible library rows from the virtualized grid back to `useThumbnails`
- stopped requesting thumbnails for the entire image list up front

Why it mattered:
This was the first asymptotic improvement. The library could stop behaving like "load everything immediately".

### `4926e017` `Reduce editor thumbnail work and avoid base64 IPC`

This applied the same visible-range idea to the editor filmstrip and reduced thumbnail transport overhead.

- limited filmstrip thumbnail requests to the visible range
- replaced base64 thumbnail IPC payloads with cached thumbnail file paths
- switched the frontend to asset URLs for cached thumbnails

Why it mattered:
This removed a large amount of string allocation, copying, and IPC overhead from thumbnail delivery.

### `bb6748b1` `Enable cached thumbnail asset protocol`

This was the compatibility follow-up for the previous commit.

- enabled the Tauri asset protocol and related configuration needed to load cached thumbnails correctly

Why it mattered:
Without this, the cache-path transport change would not reliably display thumbnails.

### `80ed937e` `Reduce gallery startup burst for large folders`

This patch reduced the amount of work triggered right at gallery startup.

- chunked visible thumbnail requests into smaller batches
- reduced library overscan
- skipped XMP sync work during listing for larger folders

Why it mattered:
The goal here was not just to reduce total work, but to smooth the startup spike that was more dangerous than steady-state work.

### `52bc0d21` `Use embedded RAW previews and trim large folder listing work`

This patch attacked two different hot spots with a single localized backend change.

- for supported unedited RAW files, tried to use embedded RAW previews before falling back to the full RAW path
- trimmed sidecar-derived metadata work during listing for large folders

Why it mattered:
Using embedded previews is much cheaper than fully developing a RAW just to show a gallery thumbnail.

### `c0a3221b` `Skip folder image counting when disabled`

This fixed a mismatch between settings and actual backend behavior.

- stopped recursive folder image counting when `enableFolderImageCounts` was disabled

Why it mattered:
This removed unnecessary tree-scan work during folder loading and startup restore.

### `d2cc9d02` `Defer GPU initialization for gallery thumbnails`

This patch delayed GPU startup until it was actually needed.

- removed eager GPU initialization from gallery thumbnail flows
- only initialized GPU late when a thumbnail path truly required visual adjustment processing

Why it mattered:
This was important because the freezes were severe enough to look like driver-level or system-level overload, not just slow UI work.

### `38efaf0d` `Refine startup thumbnail paths and add GPU diagnostics`

This was the final investigation and stabilization commit.

- made thumbnail adjustment detection more selective so "neutral" sidecar content would not force heavier paths
- added a lighter JPEG thumbnail path
- stopped startup restore from blocking on folder-tree loading
- added targeted GPU timing and lifecycle diagnostics to confirm where the hot path really was

Why it mattered:
This commit helped confirm that the remaining freezes were not caused by a single issue, but by overlapping startup work. It also provided the last improvements that made the tested startup path stable.

## Result

On the tested setup, the branch significantly improved folder opening behavior and removed the full-system freeze that originally happened during startup and gallery loading.

The final result came from combining several small changes rather than one large rewrite:

- less eager work
- fewer thumbnails requested
- lighter thumbnail transport
- less folder-tree and listing overhead
- deferred GPU work
- lighter JPEG and RAW thumbnail paths

## What This Branch Does Not Intentionally Solve

These items were investigated but left out of scope for this branch because they were not primary causes of the freeze:

- the `save_settings` frontend/backend payload warning
- the `Decoder has no thumbnail/preview image support` warnings emitted by `rawler` fallbacks

They may still be worth cleaning up later, but they were not treated as blockers for the freeze investigation.

## Validation Notes

During the investigation, changes were repeatedly validated with:

- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run build`
- `npm run start`

The branch was kept intentionally surgical so each commit could be reviewed, reverted, or cherry-picked independently.
