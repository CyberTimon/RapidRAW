# Local People recognition

On desktop, open **People** above the library and choose **Scan people**.
The primary action scans selected photos, or the displayed filtered results when
nothing is selected. The adjacent menu exposes current results, the entire current
source, all configured roots, and forced rescanning of the selection/results.
Changing folders never starts a People scan. Model downloads occur on the first scan.

Click a person's face to open their photos in the normal library. Click their name
to rename them or review individual faces. Select people to merge them; select faces
in review to move them into a new/existing person, ignore detections, or choose a cover.
Corrections are available after a scan finishes or is cancelled.

One image can appear in several people buckets. Faces remain individual records;
each bucket counts distinct physical images. Virtual copies share source analysis.
Names are global across roots. Face grouping is approximate and can need correction.

## Storage and inference

The desktop app-data directory contains `people-v1.sqlite3`. Embeddings, names,
boxes, and landmarks are never stored in photo sidecars or XMP. Representative face
crops use `people-faces-v1` in app cache. A two-image memory cache avoids repeated
decoding. Clear people data removes the index and crops while retaining model files.

Source-oriented previews are capped at 1280 pixels, independent of edits/crops.
YuNet uses overlapping 640-pixel tiles; detections below 0.85 confidence or 40 pixels
are excluded. SFace embeddings are normalized; a unique centroid match at 0.50 or
above joins a bucket. Conflicting candidates stay separate. New detections in the
same image do not automatically join the same person. Explicit user merges are retained.

Scans use two decode workers and one inference consumer. Cancellation stops further
commits and drains outstanding decoding. Completed image transactions survive restart.
File fingerprints and model version avoid repeat inference; rescan preserves overlapping
face IDs and user corrections. Unavailable folders are retained for disconnected drives.
Processing uses local files and ONNX only; network access is limited to model downloads.

## Verification

Run focused backend tests with `cargo +1.98 test --manifest-path src-tauri/Cargo.toml people:: --lib`.
Bundle `src/people/scopes.test.ts` using esbuild's Node target and execute with `node --test`.
The ignored `people::tests::local_model_smoke` test never downloads models. Supply
`RAPIDRAW_PEOPLE_MODELS`, `RAPIDRAW_PEOPLE_PHOTO`, `RAPIDRAW_PEOPLE_FACE_COUNT`, and
`ORT_DYLIB_PATH` to test local model files against a real photograph. It also checks
empty imagery and repeated face-to-bucket assignment. On macOS it enables RapidRAW's
existing native shutdown handler after assertions; the bundled ONNX runtime may emit
a shutdown diagnostic despite successful inference.

Full interactive desktop validation and Windows/Linux runtime checks remain separate
from these unit/model checks. No biometric metadata is encrypted beyond OS file protection.
