# Local People recognition

On desktop, open **People** above the library and choose **Scan people**. The
primary action scans selected photos, or displayed filtered results when nothing
is selected. The scan menu includes the entire current source, configured roots,
forced rescanning, and **Find more faces**. Changing folders never starts a scan.
Model downloads occur on the first scan; inference and person information stay local.

## Person albums and corrections

Strong matches group automatically during scanning and a final organization pass.
**Organize existing faces** also processes the stored index without decoding photos.
Existing version-one assignments remain protected during ordinary scans until you
explicitly organize them. Names and manual assignments take priority. Two protected
people are never automatically merged; review their suggested match instead.

Open a face to view that person's photos in the library. **Edit person** exposes
naming, face selection, moving into an existing/new person, ignoring detections,
and choosing a cover. The destination picker searches names and shows faces.
Drag one person album onto another to merge into the destination. In **Edit person**,
drag a face or selected faces onto a person in the destination picker. Choose
**Shortcuts** on the album grid to assign one letter or number to a person; pressing
that key moves selected faces while editing. Assignments are scoped to the active
album, active folder, or the global library when neither is active.
**Hidden faces** lets you restore detections even if their whole album was hidden.
Select people to merge or export them; the merge name picker chooses the survivor.
**Review matches** presents up to 200 highest-ranked uncertain pairs at a time.
Choose **Same person** or **Different people**. If both have names, choose which
name to retain. Suggestions refresh after each decision.

Corrections are available after the active People job finishes or is cancelled.
**Undo** restores the last correction or organization pass, including names,
assignments, ignored state, covers, rejected matches, and shortcuts. The last 20 operations
survive restart. Starting a scan resets this undo history because detections may
change; corrections themselves remain attached to overlapping face IDs.

## Matching and storage

The desktop app-data directory contains `people-v1.sqlite3`, migrated in place to
schema version 3. Embeddings and identity metadata are not written to sidecars or
XMP. Each face records automatic, legacy, or manual assignment provenance.
Face-pair exclusions retain “different people” and move/split corrections through
later regrouping. Explicit merges can override those exclusions. Confirmed faces
are prioritized as reference examples; this does not retrain the neural model.

The pinned YuNet and SFace models are unchanged. Standard source-oriented previews
are capped at 1280 pixels; **Find more faces** uses 2560 pixels with overlapping
640-pixel tiles. Detection confidence remains 0.85 with a 40-pixel minimum face.
The larger preview can expose smaller faces at greater processing cost. Detection
settings are cached separately: a detailed pass is never skipped because only a
standard pass exists; ordinary scans do not downgrade detailed results.

Matching version `representatives-v2` uses up to eight diverse, quality-ordered
references per person. The strong threshold is 0.50, review floor 0.36, and
next-candidate margin 0.08. Automatic group merges require mutual best matches,
margin clearance, and support across all retained references. Mutually consistent
near-best groups can also combine when every pair is strong and all outside
candidates are weaker. Same-photo conflicts and recorded exclusions prevent
automatic merging. Weak bridge chains remain
separate. Candidates use linear memory and review results are bounded; comparison
time still grows quadratically with the number of people.

A photo can appear in multiple person albums. Counts and export lists deduplicate
physical images within each person. Virtual copies share source analysis. Names
are global across roots; disconnected folders remain indexed.

## Loading and jobs

Scans use two decode workers and one inference consumer. Crops are written to
`people-faces-v1` while decoded pixels are available. Existing album covers warm
from native background work; on-demand thumbnail generation has two worker slots
and releases the maintenance lock before decoding. The frontend deduplicates
requests, limits concurrency to two, and caches 128 successful thumbnails with LRU
eviction. Failures show **Retry**. Nearby faces prefetch as review opens.

The index publishes incremental updates at most every 750 ms plus a final update.
Focus/visibility reconciliation fetches backend status and index state. Compact
stages distinguish preparing, scanning, organizing, exporting, and completion.
Backend progress exposes elapsed scan time. Processing does not depend on browser
animation or intersection callbacks. No App Nap override is installed: desktop
focus/minimize measurements remain required before changing power policy.

Cancellation retains completed image transactions and drains decoding workers;
organization rolls back its uncommitted pass. Clearing People data removes the
index and cached crops, retaining downloaded models.

## Person export

**Export person** copies originals or renders edited photos through the existing
export pipeline, with a format and optional saved export preset. Each selected
person gets a newly reserved named subfolder. Folder names are sanitized; existing
folders and duplicate filenames receive suffixes instead of being overwritten.
Source photos are never moved. Group photos are included in each selected person's
folder. Edited export uses sidecars and the current open photo's adjustments.
Virtual copies are not exported as additional person-album photos.

Progress and cancellation use the People toolbar. Missing/cloud-only sources are
reported as failures without hydration. Original copies are chunked and remove
partial output on cancellation/failure. Completed outputs remain. Edited exports
use the existing renderer's cancellation and file-writing behavior. The final
report lists successes, failures, and cancellation; output files are not covered
by assignment undo.

## Verification

Run focused backend tests:
`cargo +1.98 test --manifest-path 'src-tauri/Cargo.toml' people:: --lib`.
Run `npx vitest run src/people/shortcutScope.test.ts` and bundle
`src/people/thumbnailCache.test.ts` using esbuild's Node target for `node --test`.
Lint only changed frontend
files. `npm run build` validates bundling without a repository-wide type-check.

Ignored checks require explicitly supplied local fixtures and never download:

- `people::tests::local_model_smoke`: set `RAPIDRAW_PEOPLE_MODELS`,
  `RAPIDRAW_PEOPLE_PHOTO`, `RAPIDRAW_PEOPLE_FACE_COUNT`, and `ORT_DYLIB_PATH`.
  Tests real detection, blank imagery, and repeated image assignment. The bundled
  macOS ONNX runtime may emit a shutdown diagnostic after successful assertions.
- `people::local_validation::local_index_regroup`: set `RAPIDRAW_PEOPLE_INDEX` to a
  consistent SQLite snapshot. It copies the index before migration/regrouping and
  checks repeat-run stability. Optional `RAPIDRAW_PEOPLE_VALIDATION_OUTPUT` writes
  the resulting test index; `RAPIDRAW_PEOPLE_REVIEW_IMAGE` writes a crop contact sheet.

A local 563-face/353-person snapshot grouped into 314 people with 200 review
suggestions; repeated organization was stable. This is functional evidence, not a
labeled accuracy benchmark. A real four-face photograph passed the model smoke
check. A headless render of a real local photo also produced a valid JPEG through
the existing export pipeline. Desktop automation timed out during implementation,
so interactive focus/minimize completion, end-to-end person exports, and Windows/Linux runtime
behavior remain unverified. No biometric metadata is encrypted beyond OS file
protection.
