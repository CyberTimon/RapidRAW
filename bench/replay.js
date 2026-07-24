// Deterministic UI perf benchmark. Paste into the browser devtools Console
// of a running RapidRAW build (right-click -> Inspect) and press Enter.
//
// Drives the same scroll/open/slider-drag interaction with fixed synthetic
// timing, repeated over several iterations (with a discarded warmup
// iteration) so results carry median/p95/stdev instead of a single noisy
// sample. Frame timing is attributed per interaction phase so you can tell
// *which* interaction regressed, not just that the run as a whole did.
//
// Measures its own frame timing via requestAnimationFrame + performance.now()
// -- standard web APIs, so this works the same under WebKitGTK (Linux),
// WKWebView (macOS), and WebView2 (Windows). It does NOT depend on any
// devtools-specific recording/export format.
//
// Output: a JSON blob printed between BENCH_RESULT_JSON_START/END markers,
// and copied to the clipboard if the console supports copy(). Save it to
// bench/out/<name>.json (gitignored) and diff two runs with analyze.mjs.
//
// Requirements: library open with at least one image, at the default
// Adjustments panel (so two sliders are present to drag).

(async function bench() {
  const ITERATIONS = 10;
  const WARMUP_ITERATIONS = 2;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const dispatchMouse = (target, type, x, y, opts = {}) =>
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...opts }),
    );

  const THUMBNAIL_SELECTOR = '[data-bench-id="thumbnail"], .aspect-square.bg-surface.rounded-md.overflow-hidden.cursor-pointer';
  const SCROLL_CONTAINER_SELECTOR = '.custom-scrollbar';
  const SLIDER_SELECTOR = '.slider-input';
  const BACK_TO_LIBRARY_SELECTOR = '[data-bench-id="back-to-library"]';
  const UNDO_SELECTOR = '[data-bench-id="undo"]';
  const FIRST_FRAME_SELECTOR = '[data-bench-id="editor-first-frame"]';

  // --- continuous frame-timing capture -------------------------------------------
  // One rAF loop runs for the whole benchmark; phase attribution happens
  // afterwards by bucketing frame-to-frame durations against phase time
  // windows, so starting/stopping the loop per-phase (and the gaps that would
  // introduce) isn't a concern.
  let measuring = false;
  let rafHandle = null;
  const frameTimestamps = [];

  function frameTick(ts) {
    if (!measuring) return;
    frameTimestamps.push(ts);
    rafHandle = requestAnimationFrame(frameTick);
  }

  function startMeasuring() {
    measuring = true;
    rafHandle = requestAnimationFrame(frameTick);
  }

  function stopMeasuring() {
    measuring = false;
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
  }

  const DROPPED_THRESHOLD_MS = 1000 / 60 + 2; // small tolerance over one vsync

  function durationsInWindow(startTs, endTs) {
    const out = [];
    for (let i = 1; i < frameTimestamps.length; i++) {
      const ts = frameTimestamps[i];
      if (ts > startTs && ts <= endTs) out.push(ts - frameTimestamps[i - 1]);
    }
    return out;
  }

  function summarizeWindow(startTs, endTs) {
    const durations = durationsInWindow(startTs, endTs);
    const dropped = durations.filter((d) => d > DROPPED_THRESHOLD_MS);
    const totalMs = durations.reduce((a, b) => a + b, 0);
    return {
      durationMs: endTs - startTs,
      frameCount: durations.length,
      avgFps: durations.length ? 1000 / (totalMs / durations.length) : 0,
      worstFrameMs: durations.length ? Math.max(...durations) : 0,
      droppedFrameCount: dropped.length,
      droppedFrameTimeMs: dropped.reduce((a, b) => a + b, 0),
    };
  }

  // --- interaction steps -----------------------------------------------------
  async function scrollLibrary() {
    const container = document.querySelector(SCROLL_CONTAINER_SELECTOR);
    if (!container) throw new Error(`bench: scroll container not found (${SCROLL_CONTAINER_SELECTOR})`);
    // Reset to the top so every iteration scrolls the same distance through the
    // same content -- without this, iteration 2+ would start wherever the
    // previous iteration's scroll left off (e.g. pinned at the bottom, making
    // the phase a near no-op) instead of repeating the same interaction.
    container.scrollTop = 0;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
    await wait(50);
    const start = performance.now();
    const steps = 30;
    for (let i = 0; i < steps; i++) {
      container.scrollTop += 40;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      await wait(16);
    }
    return { start, end: performance.now() };
  }

  async function openFirstImage() {
    const thumb = document.querySelector(THUMBNAIL_SELECTOR);
    if (!thumb) throw new Error(`bench: no thumbnail found (${THUMBNAIL_SELECTOR})`);
    const start = performance.now();
    const rect = thumb.getBoundingClientRect();
    dispatchMouse(thumb, 'dblclick', rect.left + rect.width / 2, rect.top + rect.height / 2);

    // Wait for the actual decoded preview, not just the editor UI mounting.
    // `.slider-input` appears as soon as the Controls panel mounts, which
    // happens well before the image is decoded/rendered -- polling on that
    // made this phase read as ~0-1ms after the first iteration (Controls
    // mounts near-instantly on every open) instead of measuring real open
    // latency. `[data-bench-id="editor-first-frame"]` renders once either
    // real render signal fires -- `hasRenderedFirstFrame` (wgpu path) or
    // `finalPreviewUrl` (CPU path) -- see Editor.tsx.
    const timeoutMs = 8000;
    const pollMs = 50;
    let waited = 0;
    while (!document.querySelector(FIRST_FRAME_SELECTOR) && waited < timeoutMs) {
      await wait(pollMs);
      waited += pollMs;
    }
    if (waited >= timeoutMs) {
      throw new Error(
        'bench: editor did not report a rendered preview within 8s ' +
          `(${FIRST_FRAME_SELECTOR} never appeared).`,
      );
    }
    return { start, end: performance.now() };
  }

  async function dragSlider(slider, totalDeltaPx) {
    const rect = slider.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    dispatchMouse(slider, 'mousedown', startX, y);
    await wait(16);

    const steps = 30;
    for (let i = 1; i <= steps; i++) {
      const x = startX + (totalDeltaPx * i) / steps;
      dispatchMouse(window, 'mousemove', x, y);
      await wait(16);
    }

    dispatchMouse(window, 'mouseup', startX + totalDeltaPx, y);
    await wait(16);
  }

  async function editTwoSliders() {
    const sliders = document.querySelectorAll(SLIDER_SELECTOR);
    if (sliders.length < 2) throw new Error(`bench: fewer than 2 sliders found (${sliders.length})`);
    const start = performance.now();
    await dragSlider(sliders[0], 80);
    await wait(200);
    await dragSlider(sliders[1], -60);
    return { start, end: performance.now() };
  }

  async function undoSliderEdits() {
    // editTwoSliders makes two history entries; undo both so the next
    // iteration's drag starts from the same pre-edit adjustment state
    // instead of compounding on top of the previous iteration's edits.
    const button = document.querySelector(UNDO_SELECTOR);
    if (!button) throw new Error(`bench: undo button not found (${UNDO_SELECTOR})`);
    for (let i = 0; i < 2; i++) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await wait(150);
    }
  }

  async function backToLibrary() {
    const button = document.querySelector(BACK_TO_LIBRARY_SELECTOR);
    if (!button) throw new Error(`bench: back-to-library button not found (${BACK_TO_LIBRARY_SELECTOR})`);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    const timeoutMs = 8000;
    const pollMs = 50;
    let waited = 0;
    while (!document.querySelector(SCROLL_CONTAINER_SELECTOR) && waited < timeoutMs) {
      await wait(pollMs);
      waited += pollMs;
    }
    if (waited >= timeoutMs) {
      throw new Error('bench: library did not reappear within 8s of back-to-library click');
    }
  }

  // --- stats -------------------------------------------------------------------
  function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function p95(values) {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
  }

  function stdev(values) {
    if (values.length < 2) return 0;
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  function statOf(values) {
    return { median: median(values), p95: p95(values), stdev: stdev(values) };
  }

  function summarizePhaseAcrossIterations(measuredIterations, phaseName) {
    const metrics = ['durationMs', 'avgFps', 'worstFrameMs', 'droppedFrameCount', 'droppedFrameTimeMs'];
    const out = {};
    for (const metric of metrics) {
      out[metric] = statOf(measuredIterations.map((it) => it.phases[phaseName][metric]));
    }
    return out;
  }

  // --- run ---------------------------------------------------------------------
  const iterations = [];
  try {
    startMeasuring();
    for (let i = 0; i < ITERATIONS; i++) {
      const warmup = i < WARMUP_ITERATIONS;
      const scrollWindow = await scrollLibrary();
      await wait(300);
      const openWindow = await openFirstImage();
      await wait(300);
      const editWindow = await editTwoSliders();
      await wait(200);

      iterations.push({
        index: i,
        warmup,
        phases: {
          scroll: summarizeWindow(scrollWindow.start, scrollWindow.end),
          open: summarizeWindow(openWindow.start, openWindow.end),
          edit: summarizeWindow(editWindow.start, editWindow.end),
        },
      });

      await undoSliderEdits();
      await backToLibrary();
      await wait(300);
    }
    stopMeasuring();
  } catch (err) {
    stopMeasuring();
    console.error('bench: failed —', err.message);
    return;
  }

  const measuredIterations = iterations.filter((it) => !it.warmup);
  const summary = {
    scroll: summarizePhaseAcrossIterations(measuredIterations, 'scroll'),
    open: summarizePhaseAcrossIterations(measuredIterations, 'open'),
    edit: summarizePhaseAcrossIterations(measuredIterations, 'edit'),
  };

  const result = {
    userAgent: navigator.userAgent,
    recordedAt: new Date().toISOString(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    config: { iterations: ITERATIONS, warmupIterations: WARMUP_ITERATIONS },
    iterations,
    summary,
  };

  const json = JSON.stringify(result, null, 2);
  console.log('BENCH_RESULT_JSON_START');
  console.log(json);
  console.log('BENCH_RESULT_JSON_END');
  try {
    copy(json); // eslint-disable-line no-undef -- devtools console global
    console.log('bench: result copied to clipboard. Paste into bench/out/<name>.json');
  } catch {
    console.log('bench: clipboard copy() unavailable in this console, copy the JSON above manually');
  }
})();
