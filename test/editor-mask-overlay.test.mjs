import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-mask-overlay-'));
after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const stubs = {
  react: `export const memo = fn => fn;
    export const useState = value => [typeof value === 'function' ? value() : value, () => {}];
    export const useRef = current => ({ current });
    export const useEffect = () => {}; export const useLayoutEffect = () => {};
    export const useCallback = fn => fn;
    export const useMemo = fn => fn();
    export const useId = () => ':r0:';`,
  'react/jsx-runtime': `export const Fragment = 'Fragment';
    export const jsx = (type, props) => ({ type, props });
    export const jsxs = jsx;`,
  'react-konva': ['Stage', 'Layer', 'Ellipse', 'Line', 'Transformer', 'Group', 'Circle', 'Rect', 'Arrow']
    .map((name) => `export const ${name} = '${name}';`)
    .join('\n'),
  'react-image-crop': 'export default () => null;',
  'lucide-react':
    'export const Stamp = () => null, Bandage = Stamp, Spline = Stamp, BrushCleaning = Stamp, ChevronLeft = Stamp, ChevronRight = Stamp;',
  '@tauri-apps/api/core': 'export const invoke = () => Promise.resolve();',
  '../right/Masks': `export const Mask = { Linear: 'linear', Radial: 'radial', Brush: 'brush', Flow: 'flow', Clone: 'clone', Heal: 'heal', Liquify: 'liquify', Retouch: 'retouch', AiSubject: 'ai-subject', QuickEraser: 'quick-eraser' };
    export const SubMaskMode = { Additive: 'additive', Subtractive: 'subtractive', Intersect: 'intersect' };
    export const ToolType = { Brush: 'brush', Eraser: 'eraser' };`,
  '../../../hooks/useOsPlatform': 'export const useOsPlatform = () => "macos";',
  'react-i18next': 'export const useTranslation = () => ({ t: key => key });',
  '../../../store/useEditorStore': 'export const useEditorStore = () => false;',
  './overlays/CompositionOverlays': 'export default () => null;',
  '../../../utils/cropUtils': 'export const calculateStraightenAngle = () => 0;',
  'react-toastify': 'export const toast = { error() {} };',
};
const output = join(directory, 'overlay.mjs');
await build({
  stdin: {
    contents: "export { MaskOverlay } from './src/components/panel/editor/ImageCanvas';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'canvas-boundaries',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (args.path.endsWith('.css')) return { path: args.path, namespace: 'empty' };
          if (Object.hasOwn(stubs, args.path)) return { path: args.path, namespace: 'stub' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
        builder.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: '', loader: 'js' }));
      },
    },
  ],
});
const { MaskOverlay } = await import(pathToFileURL(resolve(output)));

function elements(node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return [node, ...elements(node.props?.children)];
}
function renderOverlay(type, parameters, crop = null) {
  const updates = [];
  const root = MaskOverlay({
    adjustments: { crop },
    imageWidth: 1000,
    imageHeight: 800,
    subMask: { id: 'mask', type, visible: true, mode: 'additive', parameters },
    isSelected: true,
    isToolActive: false,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    stageScale: 1,
    onMaskInteractionStart() {},
    onMaskInteractionEnd() {},
    onMaskMouseEnter() {},
    onMaskMouseLeave() {},
    onSelect() {},
    onUpdate: (id, update) => updates.push({ id, ...update }),
  });
  return { nodes: elements(root), updates };
}
function dragEvent(pointer) {
  return { evt: { button: 0 }, target: { getStage: () => ({ getPointerPosition: () => pointer }) } };
}

test('linear overlay without range uses the crop-relative fade distance', () => {
  const { nodes } = renderOverlay(
    'linear',
    { startX: 0, startY: 100, endX: 100, endY: 100 },
    { unit: '%', x: 0, y: 0, width: 50, height: 50 },
  );
  const fadeLines = nodes.filter((node) => node.type === 'Line' && node.props.onDragMove);
  assert.equal(fadeLines.length, 2);
  assert.equal(fadeLines[0].props.points[1], 140);
  assert.equal(fadeLines[1].props.points[1], 60);
});

test('moving a linear mask preserves absent range and does not serialize radial fields', () => {
  const parameters = { startX: 0, startY: 100, endX: 100, endY: 100, falloff: 'smootherstep' };
  const { nodes, updates } = renderOverlay('linear', parameters);
  const group = nodes.find((node) => node.type === 'Group' && node.props.onDragStart);
  group.props.onDragStart(dragEvent({ x: 20, y: 30 }));
  group.props.onDragMove(dragEvent({ x: 30, y: 50 }));
  assert.deepEqual(updates.at(-1), {
    id: 'mask',
    parameters: { ...parameters, startX: 10, startY: 120, endX: 110, endY: 120 },
  });
  assert.equal('range' in updates.at(-1).parameters, false);
  assert.equal('radiusX' in updates.at(-1).parameters, false);
});

test('moving a radial mask preserves its parameter schema without linear fields', () => {
  const parameters = { centerX: 200, centerY: 300, radiusX: 80, radiusY: 60, rotation: 15, feather: 0.5 };
  const { nodes, updates } = renderOverlay('radial', parameters);
  const shape = nodes.find((node) => node.type === 'Ellipse' && node.props.ref);
  shape.props.onDragStart(dragEvent({ x: 20, y: 30 }));
  shape.props.onDragMove(dragEvent({ x: 30, y: 50 }));
  assert.deepEqual(updates.at(-1), { id: 'mask', parameters: { ...parameters, centerX: 210, centerY: 320 } });
  assert.equal('startX' in updates.at(-1).parameters, false);
  assert.equal('range' in updates.at(-1).parameters, false);
});

test('explicit zero and asymmetric fade distances override the crop default', () => {
  const base = { startX: 0, startY: 100, endX: 100, endY: 100 };
  for (const [parameters, expectedY] of [
    [{ ...base, range: 0 }, [100, 100]],
    [{ ...base, range: 80, fadeBefore: 0, fadeAfter: 20 }, [100, 80]],
  ]) {
    const { nodes } = renderOverlay('linear', parameters);
    const fadeLines = nodes.filter((node) => node.type === 'Line' && node.props.onDragMove);
    assert.deepEqual(
      fadeLines.map((node) => node.props.points[1]),
      expectedY,
    );
  }
});
