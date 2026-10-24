import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'rapidraw-analysis-test-'));
await build({
  stdin: {
    contents: `export * from './src/store/useNegativeAnalysisStore'; export { useEditorStore } from './src/store/useEditorStore'; export { useUIStore } from './src/store/useUIStore'; export { prepareAdjustmentsPayload } from './src/utils/backendPayload'; export { default as AnalysisRegionOverlay } from './src/components/panel/editor/overlays/AnalysisRegionOverlay'; export { default as ImageCanvas } from './src/components/panel/editor/ImageCanvas'; export { omitTonalAdjustments, INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments, COPYABLE_ADJUSTMENT_KEYS } from './src/utils/adjustments'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server'; import './src/i18n';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  loader: { '.css': 'empty' },
  plugins: [
    {
      name: 'canvas-host',
      setup(build) {
        build.onResolve({ filter: /^react-konva$/ }, () => ({ path: 'react-konva', namespace: 'canvas-host' }));
        build.onLoad({ filter: /.*/, namespace: 'canvas-host' }, () => ({
          contents:
            'export const Stage = () => null; export const Layer = Stage, Ellipse = Stage, Line = Stage, Transformer = Stage, Group = Stage, Circle = Stage, Rect = Stage, Arrow = Stage;',
        }));
      },
    },
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);` },
  outfile: join(temp, 'session.mjs'),
});
after(() => rm(temp, { recursive: true, force: true }));
const {
  useNegativeAnalysisStore: session,
  useEditorStore: editor,
  getAnalysisRegion,
  normalizeLoadedAdjustments,
  COPYABLE_ADJUSTMENT_KEYS,
  useUIStore: ui,
  prepareAdjustmentsPayload,
  AnalysisRegionOverlay,
  ImageCanvas,
  omitTonalAdjustments,
  INITIAL_ADJUSTMENTS,
  createElement,
  renderToStaticMarkup,
} = await import(join(temp, 'session.mjs'));

const resetImage = () => {
  session.getState().closeWorkspace();
  editor.getState().resetHistory(structuredClone(INITIAL_ADJUSTMENTS));
};
beforeEach(resetImage);

test('moving the analysis rectangle changes conversion only on release', () => {
  resetImage();
  session.getState().begin({ x: 0.5, y: 0.5 }, 'move');
  session.getState().move({ x: 0.6, y: 0.55 });
  assert.deepEqual(getAnalysisRegion(), { x: 0.12, y: 0.12, width: 0.76, height: 0.76 });
  assert.ok(session.getState().draft.x > 0.2);
  session.getState().commit();
  assert.ok(getAnalysisRegion().x > 0.2);
  assert.equal(session.getState().draft, null);
});

test('drawing a replacement region works in every direction and commits only on release', () => {
  for (const start of [
    { x: 0.05, y: 0.05 },
    { x: 0.95, y: 0.05 },
    { x: 0.05, y: 0.95 },
    { x: 0.95, y: 0.95 },
  ]) {
    resetImage();
    const previous = getAnalysisRegion();
    session.getState().begin(start, 'draw');
    session.getState().move({ x: 0.5, y: 0.5 });
    assert.deepEqual(getAnalysisRegion(), previous);
    const draft = session.getState().draft;
    assert.equal(draft.x, Math.min(start.x, 0.5));
    assert.equal(draft.y, Math.min(start.y, 0.5));
    assert.ok(Math.abs(draft.width - 0.45) < 1e-10);
    assert.ok(Math.abs(draft.height - 0.45) < 1e-10);
    session.getState().commit();
    assert.deepEqual(getAnalysisRegion(), draft);
    assert.equal(session.getState().draft, null);
    assert.equal(session.getState().gesture, null);
    assert.deepEqual(prepareAdjustmentsPayload(editor.getState().adjustments).payload.negativeAnalysisRegion, draft);
  }
});

test('replacement drawing clamps to the image and preserves the previous region on cancel or a tiny drag', () => {
  resetImage();
  const previous = getAnalysisRegion();
  session.getState().begin({ x: 0.05, y: 0.05 }, 'draw');
  session.getState().move({ x: 1.2, y: -0.2 });
  assert.deepEqual(session.getState().draft, { x: 0.05, y: 0, width: 0.95, height: 0.05 });
  session.getState().cancel();
  assert.deepEqual(getAnalysisRegion(), previous);
  assert.equal(session.getState().draft, null);
  for (const end of [
    { x: 0.05, y: 0.05 },
    { x: 0.055, y: 0.5 },
    { x: 0.5, y: 0.055 },
  ]) {
    session.getState().begin({ x: 0.05, y: 0.05 }, 'draw');
    session.getState().move(end);
    session.getState().commit();
    assert.deepEqual(getAnalysisRegion(), previous);
    assert.equal(session.getState().draft, null);
    assert.equal(session.getState().gesture, null);
  }
});

test('overlay toggling and workspace closure preserve applied image adjustments', () => {
  session.getState().begin({ x: 0.5, y: 0.5 }, 'se');
  session.getState().move({ x: 0.3, y: 0.3 });
  session.getState().commit();
  const selected = getAnalysisRegion();
  session.getState().setEditing(false);
  session.getState().setEditing(true);
  assert.deepEqual(getAnalysisRegion(), selected);
  session.getState().begin({ x: 0.5, y: 0.5 }, 'move');
  session.getState().move({ x: 0.4, y: 0.4 });
  session.getState().cancel();
  assert.deepEqual(getAnalysisRegion(), selected);
  session.getState().closeWorkspace();
  assert.deepEqual(getAnalysisRegion(), selected);
  assert.equal(session.getState().editing, false);
});

test('reset changes the saved region without changing conversion sliders', () => {
  editor.getState().setEditor({
    adjustments: {
      ...INITIAL_ADJUSTMENTS,
      negativeExposure: 1.5,
      negativeContrast: 1.2,
      negativeRedWeight: 1.7,
    },
  });
  session.getState().begin({ x: 0.5, y: 0.5 }, 'nw');
  session.getState().move({ x: 0.6, y: 0.6 });
  session.getState().commit();
  assert.notDeepEqual(getAnalysisRegion(), INITIAL_ADJUSTMENTS.negativeAnalysisRegion);
  session.getState().reset();
  const { payload } = prepareAdjustmentsPayload(editor.getState().adjustments);
  assert.equal(payload.negativeExposure, 1.5);
  assert.equal(payload.negativeContrast, 1.2);
  assert.equal(payload.negativeRedWeight, 1.7);
  assert.deepEqual(payload.negativeAnalysisRegion, INITIAL_ADJUSTMENTS.negativeAnalysisRegion);
});

test('gallery round trips hide the overlay and retain the applied region for preview and export', () => {
  resetImage();
  ui.getState().setUI({ activeView: 'editor' });
  session.getState().setEditing(true);
  session.getState().begin({ x: 0.5, y: 0.5 }, 'se');
  session.getState().move({ x: 0.3, y: 0.3 });
  session.getState().commit();
  const selected = getAnalysisRegion();
  ui.getState().setUI({ activeView: 'editor' });
  assert.deepEqual(getAnalysisRegion(), selected);
  session.getState().begin({ x: 0.2, y: 0.2 }, 'move');
  session.getState().move({ x: 0.3, y: 0.3 });
  ui.getState().setUI({ activeView: 'library' });
  assert.deepEqual(getAnalysisRegion(), selected);
  assert.equal(session.getState().editing, false);
  assert.equal(session.getState().draft, null);
  assert.equal(session.getState().gesture, null);
  assert.deepEqual(prepareAdjustmentsPayload(editor.getState().adjustments).payload.negativeAnalysisRegion, selected);
  // A late pointer release after leaving the editor cannot apply the discarded draft.
  session.getState().commit();
  ui.getState().setUI({ activeView: 'editor' });
  session.getState().setEditing(true);
  assert.deepEqual(getAnalysisRegion(), selected);
  assert.deepEqual(prepareAdjustmentsPayload(editor.getState().adjustments).payload.negativeAnalysisRegion, selected);
  resetImage();
  assert.deepEqual(getAnalysisRegion(), { x: 0.12, y: 0.12, width: 0.76, height: 0.76 });
  assert.equal(session.getState().gesture, null);
});

test('accepting analysis editing commits the draft and hides the rectangle', () => {
  resetImage();
  session.getState().setEditing(true);
  session.getState().begin({ x: 0.05, y: 0.05 }, 'draw');
  session.getState().move({ x: 0.5, y: 0.5 });
  const draft = session.getState().draft;
  session.getState().finishEditing(true);
  assert.deepEqual(getAnalysisRegion(), draft);
  assert.equal(session.getState().editing, false);
  assert.equal(session.getState().draft, null);
  assert.equal(session.getState().gesture, null);
});

test('dismissing analysis editing hides the rectangle and keeps the last applied region', () => {
  session.getState().setEditing(true);
  const previous = getAnalysisRegion();
  session.getState().begin({ x: 0.8, y: 0.8 }, 'draw');
  session.getState().move({ x: 0.6, y: 0.6 });
  session.getState().finishEditing(false);
  // A late pointer release after dismissal cannot commit the cancelled draft.
  session.getState().commit();
  assert.deepEqual(getAnalysisRegion(), previous);
  assert.equal(session.getState().editing, false);
  assert.equal(session.getState().draft, null);
  assert.equal(session.getState().gesture, null);
  session.getState().setEditing(true);
  session.getState().finishEditing(true);
  assert.deepEqual(getAnalysisRegion(), previous);
  assert.equal(session.getState().editing, false);
});

test('committed region survives sidecar adjustment serialization, reload, preview and undo/redo', () => {
  editor.getState().resetHistory({
    ...INITIAL_ADJUSTMENTS,
    negativeConversionEnabled: true,
    negativeExposure: 0.7,
    negativeContrast: 1.4,
  });
  session.getState().begin({ x: 0.5, y: 0.5 }, 'se');
  session.getState().move({ x: 0.3, y: 0.3 });
  session.getState().commit();
  const settings = editor.getState().adjustments;
  assert.equal(Math.round(settings.negativeAnalysisRegion.width * 100), 56);
  const sidecar = JSON.parse(JSON.stringify({ adjustments: settings }));
  editor.getState().undo();
  assert.deepEqual(getAnalysisRegion(), INITIAL_ADJUSTMENTS.negativeAnalysisRegion);
  editor.getState().redo();
  assert.deepEqual(getAnalysisRegion(), settings.negativeAnalysisRegion);
  resetImage();
  editor.getState().resetHistory(normalizeLoadedAdjustments(sidecar.adjustments));
  const { payload } = prepareAdjustmentsPayload(editor.getState().adjustments);
  assert.deepEqual(payload.negativeAnalysisRegion, settings.negativeAnalysisRegion);
  assert.equal(payload.negativeExposure, 0.7);
  assert.equal(payload.negativeContrast, 1.4);
  assert.deepEqual(normalizeLoadedAdjustments({}).negativeAnalysisRegion, INITIAL_ADJUSTMENTS.negativeAnalysisRegion);
  assert.ok(COPYABLE_ADJUSTMENT_KEYS.includes('negativeAnalysisRegion'));
});

test('each source retains its saved region and switching images cancels unfinished gestures', () => {
  const first = { ...INITIAL_ADJUSTMENTS, negativeAnalysisRegion: { x: 0.1, y: 0.2, width: 0.4, height: 0.5 } };
  const second = { ...INITIAL_ADJUSTMENTS, negativeAnalysisRegion: { x: 0.3, y: 0.4, width: 0.2, height: 0.3 } };
  editor.getState().setEditor({ selectedImage: { path: 'first.raw' }, adjustments: first });
  session.getState().begin({ x: 0.2, y: 0.2 }, 'move');
  session.getState().move({ x: 0.3, y: 0.3 });
  editor.getState().setEditor({ selectedImage: { path: 'second.raw' }, adjustments: second });
  session.getState().commit();
  assert.equal(session.getState().draft, null);
  assert.deepEqual(getAnalysisRegion(), second.negativeAnalysisRegion);
  assert.deepEqual(prepareAdjustmentsPayload(first).payload.negativeAnalysisRegion, first.negativeAnalysisRegion);
  assert.deepEqual(prepareAdjustmentsPayload(second).payload.negativeAnalysisRegion, second.negativeAnalysisRegion);
  editor.getState().setEditor({ selectedImage: { path: 'first.raw' }, adjustments: first });
  assert.deepEqual(getAnalysisRegion(), first.negativeAnalysisRegion);
});

test('all analysis rectangle corners and handles follow a perspective transform with rotation and scale', () => {
  resetImage();
  const markup = renderToStaticMarkup(
    createElement(AnalysisRegionOverlay, {
      width: 400,
      height: 400,
      zoom: 2,
      imageUrl: 'negative.png',
      imageStyle: {},
      // A forward perspective warp followed by a quarter-turn, scale, and translation.
      // Like the editor projector, this boundary can also accept already-warped UVs.
      project: ({ x, y }, isWarped = false) => {
        const denominator = isWarped ? 1 : 1 + x;
        return { x: 100 - (200 * y) / denominator, y: 200 + (200 * x) / denominator };
      },
      unproject: () => ({ x: 0, y: 0 }),
    }),
  );
  const expected = [
    [78.571, 221.429],
    [87.234, 293.617],
    [6.383, 293.617],
    [-57.143, 221.429],
  ];
  const round = (v) => Math.round(Number(v) * 1000) / 1000;
  const polygon = markup
    .match(/<polygon[^>]* points="([^"]+)"/)[1]
    .split(' ')
    .map((point) => point.split(',').map(round));
  const handles = [...markup.matchAll(/<circle[^>]* cx="([^"]+)" cy="([^"]+)"/g)].map((match) => [
    round(match[1]),
    round(match[2]),
  ]);
  assert.deepEqual(polygon, expected);
  assert.deepEqual(handles, expected);
});

test('editor canvas shows the analysis rectangle with the editor filtered adjustments', (t) => {
  // Server rendering must see the current session, as the mounted editor does.
  const initialState = { ...session.getInitialState() };
  const initialEditor = { ...editor.getInitialState() };
  t.after(() => {
    Object.assign(session.getInitialState(), initialState);
    Object.assign(editor.getInitialState(), initialEditor);
  });
  resetImage();
  session.getState().setEditing(true);
  const props = {
    adjustments: omitTonalAdjustments({ ...INITIAL_ADJUSTMENTS, negativeConversionEnabled: true }),
    selectedImage: { width: 400, height: 300, thumbnailUrl: 'negative.png', isReady: true },
    imageRenderSize: { width: 400, height: 300, offsetX: 0, offsetY: 0, scale: 1 },
    uncroppedAdjustedPreviewUrl: 'converted.png',
    transformScale: 1,
    cursorStyle: 'zoom-in',
  };
  const render = () => {
    Object.assign(session.getInitialState(), session.getState());
    Object.assign(editor.getInitialState(), editor.getState());
    return renderToStaticMarkup(createElement(ImageCanvas, props));
  };
  const initial = render();
  assert.match(initial, /data-analysis-region/);
  assert.match(initial, /cursor:move/);
  session.getState().begin({ x: 0.5, y: 0.5 }, 'se');
  session.getState().move({ x: 0.3, y: 0.3 });
  session.getState().commit();
  const moved = render();
  session.getState().reset();
  assert.notEqual(render(), moved);
  assert.equal(render(), initial);
  props.adjustments = omitTonalAdjustments({ ...INITIAL_ADJUSTMENTS, negativeConversionEnabled: false });
  assert.doesNotMatch(render(), /data-analysis-region/);
  props.adjustments = omitTonalAdjustments({ ...INITIAL_ADJUSTMENTS, negativeConversionEnabled: true });
  session.getState().setEditing(false);
  assert.doesNotMatch(render(), /data-analysis-region/);
});
