import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'rapidraw-analysis-test-'));
await build({
  stdin: {
    contents: `export * from './src/store/useNegativeAnalysisStore'; export { useUIStore } from './src/store/useUIStore'; export { prepareAdjustmentsPayload } from './src/utils/backendPayload'; export { default as AnalysisRegionOverlay } from './src/components/panel/editor/overlays/AnalysisRegionOverlay'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server'; import './src/i18n';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);` },
  outfile: join(temp, 'session.mjs'),
});
after(() => rm(temp, { recursive: true, force: true }));
const {
  useNegativeAnalysisStore: session,
  useUIStore: ui,
  prepareAdjustmentsPayload,
  AnalysisRegionOverlay,
  createElement,
  renderToStaticMarkup,
} = await import(join(temp, 'session.mjs'));

test('moving the analysis rectangle changes conversion only on release', () => {
  session.getState().closeWorkspace();
  session.getState().begin({ x: 0.5, y: 0.5 }, 'move');
  session.getState().move({ x: 0.6, y: 0.55 });
  assert.deepEqual(session.getState().region, { x: 0.12, y: 0.12, width: 0.76, height: 0.76 });
  assert.ok(session.getState().draft.x > 0.2);
  session.getState().commit();
  assert.ok(session.getState().region.x > 0.2);
  assert.equal(session.getState().draft, null);
});

test('overlay toggling retains region, cancellation discards draft, reopening resets workspace', () => {
  session.getState().begin({ x: 0.5, y: 0.5 }, 'se');
  session.getState().move({ x: 0.3, y: 0.3 });
  session.getState().commit();
  const selected = session.getState().region;
  session.getState().setEditing(false);
  session.getState().setEditing(true);
  assert.deepEqual(session.getState().region, selected);
  session.getState().begin({ x: 0.5, y: 0.5 }, 'move');
  session.getState().move({ x: 0.4, y: 0.4 });
  session.getState().cancel();
  assert.deepEqual(session.getState().region, selected);
  session.getState().closeWorkspace();
  assert.deepEqual(session.getState().region, { x: 0.12, y: 0.12, width: 0.76, height: 0.76 });
  assert.equal(session.getState().editing, false);
});

test('reset reanalyzes default region and render/export payloads retain sliders and batch proportions', async () => {
  const { withAnalysisRegion } = await import(join(temp, 'session.mjs'));
  session.getState().begin({ x: 0.5, y: 0.5 }, 'nw');
  session.getState().move({ x: 0.6, y: 0.6 });
  session.getState().commit();
  const adjustments = { negativeExposure: 1.5, negativeContrast: 1.2, negativeRedWeight: 1.7 };
  const preview = withAnalysisRegion(adjustments);
  const batch = [{ negativeExposure: 0.2 }, { negativeExposure: -1 }].map(withAnalysisRegion);
  assert.deepEqual(
    batch.map((p) => p.negativeAnalysisRegion),
    [preview.negativeAnalysisRegion, preview.negativeAnalysisRegion],
  );
  assert.equal(preview.negativeExposure, 1.5);
  assert.equal(preview.negativeContrast, 1.2);
  assert.equal(preview.negativeRedWeight, 1.7);
  assert.equal('negativeAnalysisRegion' in adjustments, false);
  session.getState().reset();
  assert.deepEqual(withAnalysisRegion(adjustments).negativeAnalysisRegion, {
    x: 0.12,
    y: 0.12,
    width: 0.76,
    height: 0.76,
  });
});

test('leaving the editor ends the workspace, while switching editor panels retains the region', () => {
  ui.getState().setUI({ activeView: 'editor' });
  session.getState().begin({ x: 0.5, y: 0.5 }, 'se');
  session.getState().move({ x: 0.3, y: 0.3 });
  session.getState().commit();
  const selected = session.getState().region;
  ui.getState().setUI({ activeView: 'editor' });
  assert.deepEqual(session.getState().region, selected);
  ui.getState().setUI({ activeView: 'library' });
  ui.getState().setUI({ activeView: 'editor' });
  assert.deepEqual(session.getState().region, { x: 0.12, y: 0.12, width: 0.76, height: 0.76 });
  assert.equal(session.getState().gesture, null);
});

test('actual preview payload adds the session region without changing persisted adjustments', () => {
  session.getState().begin({ x: 0.5, y: 0.5 }, 'se');
  session.getState().move({ x: 0.3, y: 0.3 });
  session.getState().commit();
  const settings = { negativeConversionEnabled: true, negativeExposure: 0.7, negativeContrast: 1.4 };
  const { payload } = prepareAdjustmentsPayload(settings);
  assert.equal(Math.round(payload.negativeAnalysisRegion.width * 100), 56);
  assert.equal(payload.negativeExposure, 0.7);
  assert.equal(payload.negativeContrast, 1.4);
  assert.equal('negativeAnalysisRegion' in settings, false);
});

test('all analysis rectangle corners and handles follow a perspective transform with rotation and scale', () => {
  session.getState().closeWorkspace();
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
