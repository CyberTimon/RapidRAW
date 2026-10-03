# UI Performance Benchmark

Deterministic replay for comparing UI smoothness before/after a change.

## Usage

1. Run the build you want to measure (`npm start`, or a packaged build) and get to the
   library view with at least one image loaded.
2. Open devtools (right-click → Inspect) and switch to the Console tab.
3. Paste the contents of `bench/replay.js` and press Enter.
4. It repeats the same scroll → open-image → drag-two-sliders → back-to-library cycle
   10 times (2 discarded warmup + 8 measured), then prints a JSON result between
   `BENCH_RESULT_JSON_START`/`END` markers (and copies it to your clipboard if the
   console supports `copy()`).
5. Save the result as `bench/out/<name>.json` (gitignored, doesn't need to be committed).
6. Compare two runs:
   ```
   node bench/analyze.mjs bench/out/before.json bench/out/after.json
   ```

## Why it's built this way

- **Self-measuring, not devtools-export-dependent.** `replay.js` times itself with
  `requestAnimationFrame`/`performance.now()` (standard web APIs) rather than relying on
  a devtools Timeline recording. Tauri uses a different webview per OS — WebKitGTK on
  Linux, WKWebView on macOS, WebView2 (Chromium) on Windows — and each one's devtools
  Timeline/Performance export uses a different JSON format. Self-measurement sidesteps
  that entirely, so the same script and analyzer work on all three platforms.
- **Fixed synthetic input.** All interaction timing is scripted (`setTimeout` steps at a
  fixed cadence, fixed pixel deltas), so two runs get identical input instead of
  whatever pacing a human happened to use. Don't hand-drive the interaction and try to
  compare the numbers to a scripted run — only compare scripted run to scripted run.
- **Repeated iterations, not a single sample.** One run of the interaction can't tell you
  whether a difference between "before" and "after" is real or just jitter. `replay.js`
  repeats the full cycle several times (first one discarded as warmup) and
  `analyze.mjs` reports median/p95/stdev per metric so you can judge whether a change
  is bigger than the run-to-run noise.
- **Per-phase frame attribution.** Frame timing is bucketed into the `scroll`, `open`,
  and `edit` windows separately (not just one number for the whole run), so a result
  points at *which* interaction got slower instead of just "the run as a whole".

## Known limitations

- Numbers are only comparable **on the same machine** (same window size, same display
  scaling). A slider's pixel-delta → value-delta depends on its on-screen width, so
  results aren't meaningful across different maintainers' machines — only before/after
  on one machine. `replay.js` records `viewport` (width/height/devicePixelRatio) in its
  output, and `analyze.mjs` prints a warning if you diff two runs whose viewports don't
  match.
- The thumbnail, back-to-library, undo, and first-frame selectors prefer
  `[data-bench-id="thumbnail"]` / `[data-bench-id="back-to-library"]` /
  `[data-bench-id="undo"]` / `[data-bench-id="editor-first-frame"]` (see
  `src/components/panel/library/LibraryItems.tsx`, `src/components/panel/editor/EditorToolbar.tsx`,
  and `src/components/panel/Editor.tsx`), falling back to Tailwind-class matching where no
  hook exists yet. If you add new interaction steps, prefer adding a `data-bench-id` hook
  over relying on utility classes, which shift on any restyle.
- The `open` phase waits for `[data-bench-id="editor-first-frame"]`, which renders once
  either real render signal fires -- `hasRenderedFirstFrame` (set by the `wgpu-frame-ready`
  event, wgpu path) or `finalPreviewUrl` becoming available (CPU path) -- see `Editor.tsx`.
  Whichever renderer is actually active on your machine, one of the two will fire; if this
  phase still times out, check `document.querySelectorAll('[data-bench-id]')` in the
  console to confirm the build you're testing actually contains the marker.
- This is a general smoothness/regression check, not a profiler. It won't tell you
  *why* something is slow — use devtools Timeline/Performance recording by hand for
  root-causing, and this script for confirming a fix actually helped.
- Still requires a manual paste-and-save per run (devtools console access, `copy()` to
  clipboard, write `bench/out/<name>.json` by hand). There's no CI/headless runner —
  Tauri's WebDriver story (`tauri-driver`) doesn't cover macOS and would trade away the
  cross-platform self-measurement approach above for a Linux/Windows-only automation
  path. If you need unattended/CI runs, that trade-off is worth revisiting, but it's out
  of scope for this same-machine before/after tool.

# Image Pipeline Benchmark (headless)

`replay.js` above measures UI smoothness. The image processing pipeline itself (raw decode,
preview renders, GPU work, JPEG encode) can be measured without opening the GUI:

```bash
rapidraw bench /path/to/photo.ARW --json bench/out/pipeline.json
```

It loads the image with its `.rrdata` sidecar edits, runs the same code paths the editor
uses, and prints the median and p90 time of each phase with a per-stage breakdown (`job.*`,
`gpu.*`, `decode.*`, ...). Some stages run inside others, for example `base.*` inside
`job.transformed_preview_base`, so stage times don't add up to the phase total. It uses your
saved app settings and writes to the normal app log.

| Phase      | What it measures                                                                    |
| :--------- | :---------------------------------------------------------------------------------- |
| `open`     | Decoding and raw pre-processing of the file                                         |
| `first`    | The first editor frame after opening (always runs)                                  |
| `style`    | A preview render after changing several adjustments at once, like applying a preset |
| `drag`     | Interactive slider updates                                                          |
| `geometry` | A preview render after a rotation change                                            |
| `full`     | A full-resolution render as used by the culling view                                |

| Option                 | Description                                                                    | Default                |
| :--------------------- | :----------------------------------------------------------------------------- | :--------------------- |
| `<image>`              | Image file to benchmark                                                        | _(Required)_           |
| `--adjustments <path>` | Adjustments JSON or `.rrdata` file to use instead of the image's sidecar       | `<image>.rrdata`       |
| `--iters <n>`          | Iterations per phase (`geometry` uses n/4 and `full` n/5, at least 3)          | `20`                   |
| `--preview-dim <px>`   | Preview resolution                                                             | Editor preview setting |
| `--phases <list>`      | Comma-separated subset of `open,style,drag,geometry,full`                      | All                    |
| `--gpu-sync`           | Wait for the GPU after each GPU stage, so its time is attributed to that stage | Off                    |
| `--json <path>`        | Also write every iteration's timings and each phase's output hash as JSON      | Off                    |

Each phase records a blake3 hash of its first output. To compare two builds, for example
before and after a change:

```bash
rapidraw-before bench photo.ARW --json bench/out/pipeline-before.json
rapidraw-after bench photo.ARW --json bench/out/pipeline-after.json
node bench/compare-pipeline.mjs bench/out/pipeline-before.json bench/out/pipeline-after.json
```

`compare-pipeline.mjs` prints the speedup of each phase and exits with status 1 if any phase's
output differs, so it also confirms that an optimization left rendered pixels unchanged. It
warns when the two runs used a different image, GPU, or setting that changes the output, such
as the editor preview resolution, because then neither timings nor hashes are comparable.

`compare-renders.sh` checks exported files the same way. It exports a folder with both builds,
as 16-bit TIFF and as JPEG using each image's sidecar edits, and compares the files byte for byte:

```bash
bench/compare-renders.sh ./rapidraw-before ./rapidraw-after ~/Pictures/test-set /tmp/render-check
```

Only compare builds on the same machine. GPU output is deterministic for one GPU and driver,
but can differ slightly between GPUs.
