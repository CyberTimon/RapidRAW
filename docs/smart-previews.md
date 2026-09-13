# Gallery previews

Gallery selection reads metadata without creating an editor session. Editing panels provide an explicit Edit Image action. The editor and exports continue to use the original.

Comparison views display the existing disk thumbnail, then the configured medium preview. Original detail is requested only after zoom exceeds the preview's pixel capacity; fit view never requests original detail, including on Retina displays. Detail requests are debounced, serialized, and discarded after navigation. Returning to fit releases the detail image. A failed detail render leaves the saved preview visible.

Visible images have queue priority. Adjacent rows and comparison neighbors prefetch in the background, and idle folder warming pauses during interaction. Folder changes invalidate queued request generations. A size upgrade waits for an existing render of the same path, then checks the cache again.

Cache identity includes source path, size, nanosecond modification time, adjustments, render settings, thumbnail sizes, and renderer version. Virtual copies have separate keys. Disk revisions remain stable on cache hits. Writes are atomic, corrupt JPEGs are regenerated, and stale renders are rejected when source/settings/adjustments change during generation. Render failures must not replace saved edits with unedited pixels. Existing preview size preferences are retained.

## Validation

- `node 'scripts/test-previews.mjs'`: preview scheduling, fit/zoom threshold, cancellation, metadata-only selection, generation reset ordering, stable URLs, and bounded URL caches.
- `node 'scripts/test-controls.mjs'`: existing keyboard, history, crop, and adjustment tests.
- `cargo +1.98 test --manifest-path 'src-tauri/Cargo.toml' thumbnail_ --lib -- --nocapture`: queue, revision, cache, and original-file preservation tests. Real-file tests are opt-in.
- Frontend esbuild bundle check and lint of new preview modules; existing large files have pre-existing lint errors. No repository-wide type-check was run.

## Real-file benchmark

The opt-in `real_raw_preview_benchmark` test accepts `RAPIDRAW_PREVIEW_TEST_FILE`. It reads a real RAW file, measures full decoding, creates 480/1280 JPEGs in a temporary cache, measures warm cache reads, and confirms the source content is unchanged.

Final measurement on a 6720 × 4480 Canon CR3 from the configured photo folder, including full-JPEG cache validation:

| Operation | Measured time |
| --- | --- |
| Full RAW decode | 4471 ms |
| Uncached preview generation, three runs | 419 / 333 / 121 ms |
| Warm preview read and JPEG decode, three runs | 37.011 / 4.691 / 4.808 ms |

The decoded pixel buffers were 361,267,200 bytes for the original and 3,275,520 bytes for the medium preview. These are buffer sizes, not peak application memory. A preceding run before full-JPEG cache validation measured 2477 ms for the original, 120–167 ms for generation, and 2.488–4.731 ms for warm previews. The variation means these samples should not be treated as a fixed speedup guarantee.

This is an image-pipeline microbenchmark, not a before/after application benchmark. Source bytes had already been read; OS storage caches were not flushed. Native app inspection timed out, so folder-open latency, scrolling/frame timing, comparison switching, peak application memory, visual crop/orientation parity, and actual UI decode counts remain unverified. No export or original-image processing algorithm was changed.
