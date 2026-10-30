import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const name of [
  'window',
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'SVGElement',
  'Element',
  'MouseEvent',
  'KeyboardEvent',
])
  globalThis[name] = dom.window[name];
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe(target) {
    this.callback([{ target, contentRect: { width: 200, height: 200 } }]);
  }
  unobserve() {}
  disconnect() {}
};
window.ResizeObserver = globalThis.ResizeObserver;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
window.matchMedia = () => ({
  matches: false,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.Image = class {
  async decode() {}
};
const calls = [];
const openUrls = new Set();
const createUrl = URL.createObjectURL.bind(URL),
  revokeUrl = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => {
  const url = createUrl(blob);
  openUrls.add(url);
  return url;
};
URL.revokeObjectURL = (url) => {
  openUrls.delete(url);
  revokeUrl(url);
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=',
  'base64',
);
globalThis.altTestInvoke = (command, args) => {
  if (command === 'list_luts' || command === 'generate_lut_previews') return Promise.resolve([]);
  if (command !== 'request_influence_preview') return Promise.resolve();
  return new Promise((resolve, reject) =>
    calls.push({
      request: args.request,
      fail() {
        reject(new Error('Fixture diagnostic failure'));
      },
      finish() {
        const metadata = {
          identity: args.request.identity,
          generation: args.request.clientGeneration,
          status: 'ready',
          width: 1,
          height: 1,
        };
        const header = Buffer.from(JSON.stringify(metadata)),
          prefix = Buffer.alloc(8);
        prefix.write('RIF1');
        prefix.writeUInt32LE(header.length, 4);
        const bytes = Buffer.concat([prefix, header, png]);
        resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      },
    }),
  );
};
const bundle = await build({
  stdin: {
    contents: `export {default as BasicPanel} from './src/components/adjustments/Basic'; export {default as Slider} from './src/components/ui/Slider'; export {default as ColorWheel} from './src/components/ui/ColorWheel'; export {default as CurveGraph} from './src/components/adjustments/Curves'; export {default as EffectsPanel} from './src/components/adjustments/Effects'; export {default as DetailsPanel} from './src/components/adjustments/Details'; export {useInfluencePreview} from './src/hooks/useInfluencePreview'; export {useInfluencePreviewStore} from './src/store/useInfluencePreviewStore'; export {useEditorStore} from './src/store/useEditorStore'; export {useUIStore} from './src/store/useUIStore';`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  jsx: 'automatic',
  plugins: [
    {
      name: 'native-boundary',
      setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'native', namespace: 'mock' }));
        builder.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'translation', namespace: 'mock' }));
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
          contents:
            path === 'native'
              ? 'export const invoke=(...args)=>globalThis.altTestInvoke(...args); export const convertFileSrc=(path)=>path;'
              : 'const t=(key)=>key;export const useTranslation=()=>({t});',
          loader: 'js',
        }));
      },
    },
  ],
});
await mkdir('bench/out', { recursive: true });
await writeFile('bench/out/alt-react-tests.cjs', bundle.outputFiles[0].text);
const require = createRequire(import.meta.url);
const {
  Slider,
  ColorWheel,
  CurveGraph,
  EffectsPanel,
  BasicPanel,
  DetailsPanel,
  useInfluencePreview,
  useInfluencePreviewStore: preview,
  useEditorStore: editor,
  useUIStore: ui,
} = require('./out/alt-react-tests.cjs');
const React = require('react'),
  { act } = React,
  { createRoot } = require('react-dom/client');
const root = createRoot(document.getElementById('root'));
ui.setState({ activeView: 'editor' });
editor.setState({
  selectedImage: { path: 'generated-fixture.png', isReady: true },
  compareView: 'off',
  previewOverride: null,
});
preview.getState().setTransport({ loadedImageGeneration: 1 });
function Coordinator() {
  useInfluencePreview();
  return null;
}
let incarnation = 0;
function Harness({ control, disabled }) {
  const value = editor((s) => s.adjustments[control] ?? 0);
  return React.createElement(Slider, {
    key: incarnation,
    label: control,
    influenceControl: control,
    disabled,
    min: -100,
    max: 100,
    step: 1,
    value,
    onChange: (e) => editor.setState((s) => ({ adjustments: { ...s.adjustments, [control]: Number(e.target.value) } })),
  });
}
async function mount(control = 'highlights', disabled = false) {
  incarnation++;
  await act(async () =>
    root.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Coordinator),
        React.createElement(Harness, { control, disabled }),
      ),
    ),
  );
  const input = document.querySelector('input[type=range]');
  input.getBoundingClientRect = () => ({ left: 0, width: 200 });
  return input;
}
const mouse = (element, type, x = 100, options = {}) =>
  element.dispatchEvent(
    new MouseEvent(type, { bubbles: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, clientX: x, ...options }),
  );
const key = (type, key, options = {}) =>
  window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key, ...options }));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let input = await mount();
await act(async () => mouse(input, 'mousedown', 100, { altKey: true }));
assert.equal(calls.length, 1, 'Alt-drag starts rendering before mouse release');
assert.equal(calls[0].request.presentation, 1);
await act(async () => {
  mouse(window, 'mousemove', 130, { altKey: true });
  mouse(window, 'mousemove', 150, { altKey: true });
  await delay(35);
});
assert.equal(calls.length, 1, 'Only one native frame is in flight');
await act(async () => {
  calls[0].finish();
  await delay(35);
});
assert.equal(calls.length, 2, 'Movement produces another frame while dragging');
assert.equal(calls[1].request.jsAdjustments.highlights, 50);
assert.ok(preview.getState().url);
await act(async () => key('keyup', 'Alt'));
assert.equal(preview.getState().preview.target, null);
assert.equal(preview.getState().url, null);
await act(async () => key('keydown', 'Alt', { altKey: true }));
assert.equal(calls.length, 3, 'Alt can reopen without another pointer movement');
await act(async () => mouse(window, 'mouseup', 150, { altKey: true }));
assert.equal(preview.getState().drag, null);
await act(async () => {
  calls[1].finish();
  calls[2].finish();
  await delay(20);
});
assert.equal(preview.getState().url, null, 'Late decoded frames cannot reopen a closed session');
input = await mount();
await act(async () => mouse(input, 'mousedown', 100));
let count = calls.length;
await act(async () => key('keydown', 'Alt', { altKey: true }));
assert.equal(calls.length, count + 1, 'Pressing Alt during an ordinary drag activates the preview');
await act(async () => key('keydown', 'Control', { ctrlKey: true, altKey: true }));
assert.equal(preview.getState().preview.target, null);
await act(async () => mouse(window, 'mouseup'));
input = await mount();
await act(async () => mouse(input, 'mousedown', 100));
await act(async () => {
  mouse(window, 'mousemove', 120, { shiftKey: true });
  await delay(35);
});
assert.equal(editor.getState().adjustments.highlights, 4, 'Shift retains fine sensitivity');
await act(async () => mouse(window, 'mouseup'));
input = await mount();
await act(async () => mouse(input, 'mousedown', 100, { altKey: true }));
await act(async () => {
  mouse(window, 'mousemove', 120, { altKey: true });
  await delay(35);
});
assert.equal(editor.getState().adjustments.highlights, 20, 'Alt uses normal sensitivity');
await act(async () => window.dispatchEvent(new window.Event('blur')));
assert.equal(preview.getState().drag, null);
input = await mount();
await act(async () => mouse(input, 'mousedown', 100, { altKey: true, shiftKey: true }));
await act(async () => {
  mouse(window, 'mousemove', 120, { altKey: true, shiftKey: true });
  await delay(35);
});
assert.equal(editor.getState().adjustments.highlights, 4, 'Shift+Alt combines fine adjustment with the preview');
assert.equal(preview.getState().preview.target.control, 'highlights');
await act(async () => key('keydown', 'Escape'));
assert.equal(preview.getState().drag, null, 'Escape closes the diagnostic');
await act(async () => mouse(window, 'mouseup'));
input = await mount();
await act(async () => mouse(input, 'mousedown', 100, { altKey: true, ctrlKey: true }));
assert.equal(preview.getState().preview.target, null, 'AltGr cannot activate on pointer down');
await act(async () => mouse(window, 'mouseup'));
input = await mount();
await act(async () => mouse(input, 'mousedown', 100, { altKey: true }));
await act(async () => editor.setState({ compareView: 'split' }));
assert.equal(preview.getState().drag, null, 'Compare invalidates the entire drag session');
await act(async () => {
  mouse(window, 'mouseup');
  editor.setState({ compareView: 'off' });
});
input = await mount();
await act(async () => mouse(input, 'mousedown', 100, { altKey: true }));
const debug = console.debug;
console.debug = () => {};
try {
  await act(async () => {
    calls.at(-1).fail();
    await delay(20);
  });
} finally {
  console.debug = debug;
}
assert.equal(preview.getState().preview.target, null, 'A native diagnostic failure restores ordinary photo rendering');
assert.equal(preview.getState().url, null);
await act(async () => mouse(window, 'mouseup'));
for (const control of ['exposure', 'brightness', 'contrast', 'hue', 'saturation', 'vibrance']) {
  input = await mount(control);
  count = calls.length;
  await act(async () => mouse(input, 'mousedown', 100, { altKey: true }));
  assert.ok(calls.length > count, control + ' starts a global preview');
  assert.equal(calls.at(-1).request.target.control, control);
  assert.equal(calls.at(-1).request.presentation, ['hue', 'saturation', 'vibrance'].includes(control) ? 2 : 1);
  await act(async () => mouse(window, 'mouseup'));
}
input = await mount('highlights', true);
count = calls.length;
await act(async () => mouse(input, 'mousedown', 100, { altKey: true }));
assert.equal(calls.length, count, 'Disabled sliders cannot start diagnostics');

// Render the real wheel, point-curve editor and effects panel through the same coordinator.
function WheelHarness() {
  const value = editor((s) => s.adjustments.colorGrading.midtones);
  return React.createElement(ColorWheel, {
    influenceControl: 'grading.midtones',
    label: 'Midtones',
    defaultValue: { hue: 0, saturation: 0, luminance: 0 },
    value,
    onChange: (value) =>
      editor.setState((s) => ({
        adjustments: { ...s.adjustments, colorGrading: { ...s.adjustments.colorGrading, midtones: value } },
      })),
  });
}
async function mountComponent(Component) {
  incarnation++;
  await act(async () =>
    root.render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Coordinator),
        React.createElement(Component, { key: incarnation }),
      ),
    ),
  );
}
await mountComponent(WheelHarness);
let wheel = document.querySelector('.w-color-wheel');
assert.ok(wheel);
wheel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
await act(async () => mouse(wheel, 'mousedown', 130, { altKey: true, clientY: 70 }));
assert.equal(calls.at(-1).request.target.kind, 'grading');
assert.equal(calls.at(-1).request.selectedControl, 'grading.midtones.wheel');
await act(async () => mouse(window, 'mouseup', 130, { altKey: true }));
assert.equal(preview.getState().drag, null);
await act(async () => mouse(wheel, 'mousedown', 150, { clientY: 100 }));
count = calls.length;
await act(async () => key('keydown', 'Alt', { altKey: true }));
assert.equal(calls.length, count + 1, 'Alt can activate a wheel drag already in progress');
await act(async () => window.dispatchEvent(new window.Event('blur')));
assert.equal(preview.getState().drag, null);
function CurveHarness() {
  const adjustments = editor((s) => s.adjustments);
  return React.createElement(CurveGraph, {
    adjustments,
    theme: 'dark',
    setAdjustments: (update) => editor.setState((s) => ({ adjustments: update(s.adjustments) })),
  });
}
await act(async () =>
  editor.setState((s) => ({
    adjustments: {
      ...s.adjustments,
      curveMode: 'point',
      curves: {
        ...s.adjustments.curves,
        luma: [
          { x: 0, y: 0 },
          { x: 128, y: 128 },
          { x: 255, y: 255 },
        ],
      },
    },
  })),
);
await mountComponent(CurveHarness);
let anchor = document.querySelector('circle.cursor-pointer[cx="128"]');
assert.ok(anchor);
const graph = anchor.closest('svg');
graph.getBoundingClientRect = () => ({ left: 0, top: 0, width: 255, height: 255 });
await act(async () => mouse(anchor, 'mousedown', 128, { clientY: 127, altKey: true }));
assert.equal(calls.at(-1).request.target.kind, 'curvePoint');
assert.equal(calls.at(-1).request.target.index, 1);
assert.ok(calls.at(-1).request.coverageCurve);
await act(async () => mouse(window, 'mousemove', 140, { clientY: 107, altKey: true }));
assert.equal(editor.getState().adjustments.curves.luma[1].y, 148, 'Alt does not slow point-curve movement');
await act(async () => mouse(window, 'mouseup', 140, { clientY: 107, altKey: true }));
assert.equal(preview.getState().drag, null);
count = calls.length;
await act(async () => mouse(graph, 'mousedown', 80, { clientY: 180, altKey: true }));
assert.equal(calls.length, count + 1, 'Adding an anchor starts an immediate preview');
assert.equal(calls.at(-1).request.target.kind, 'curvePoint');
assert.equal(calls.at(-1).request.coverageCurve.length, 4);
await act(async () => mouse(window, 'mouseup', 80, { clientY: 180, altKey: true }));
function EffectsHarness() {
  const adjustments = editor((s) => s.adjustments);
  return React.createElement(EffectsPanel, {
    adjustments,
    appSettings: null,
    handleLutSelect() {},
    setAdjustments: (update) =>
      editor.setState((s) => ({
        adjustments: typeof update === 'function' ? update(s.adjustments) : { ...s.adjustments, ...update },
      })),
  });
}
await act(async () =>
  editor.setState((s) => ({
    activeRelightLightId: 'fixture-light',
    isRelightPickerActive: true,
    adjustments: {
      ...s.adjustments,
      relightEnabled: true,
      relightShadows: true,
      relightNormalMap: 'fixture-normal',
      fogEnabled: true,
      fogDepthMap: 'fixture-depth',
      relightLights: [
        {
          id: 'fixture-light',
          type: 'spot',
          visible: true,
          x: 0.5,
          y: 0.5,
          intensity: 60,
          depth: 0,
          radius: 30,
          angle: 135,
          elevation: 60,
          cone: 40,
          feather: 50,
          temperature: 0,
          tint: 0,
          color: '#ffffff',
        },
      ],
    },
  })),
);
await mountComponent(EffectsHarness);
const effectInputs = [...document.querySelectorAll('input[type=range]')];
const findByLabel = (label) => effectInputs.find((input) => input.closest('.group')?.textContent.includes(label));
for (const [label, kind] of [
  ['adjustments.effects.relightAmbient', 'parameter'],
  ['adjustments.effects.relightSoftness', 'parameter'],
  ['adjustments.effects.relightShine', 'parameter'],
  ['adjustments.effects.relightShadowSoftness', 'parameter'],
  ['adjustments.effects.relightIntensity', 'light'],
  ['adjustments.effects.relightDepth', 'light'],
  ['adjustments.effects.relightFalloff', 'light'],
  ['adjustments.effects.relightAngle', 'light'],
  ['adjustments.effects.relightElevation', 'light'],
  ['adjustments.effects.relightCone', 'light'],
  ['adjustments.effects.feather', 'light'],
  ['adjustments.color.temperature', 'light'],
  ['adjustments.color.tint', 'light'],
]) {
  const control = findByLabel(label);
  assert.ok(control, 'Missing effect control ' + label);
  control.getBoundingClientRect = () => ({ left: 0, width: 200 });
  count = calls.length;
  await act(async () => mouse(control, 'mousedown', 100, { altKey: true }));
  assert.equal(calls.length, count + 1, label + ' must render while the relight picker is armed');
  assert.equal(calls.at(-1).request.target.kind, kind);
  await act(async () => mouse(window, 'mouseup'));
}
const fog = document
  .getElementById('switch-adjustments.effects.fog')
  .closest('label')
  .parentElement.querySelector('input[type=range]');
assert.ok(fog);
fog.getBoundingClientRect = () => ({ left: 0, width: 200 });
await act(async () => mouse(fog, 'mousedown', 100, { altKey: true }));
assert.equal(calls.at(-1).request.target.effect, 'fog');
assert.equal(calls.at(-1).request.selectedControl, 'fogAmount');
assert.equal(calls.at(-1).request.presentation, 1);
await act(async () => mouse(window, 'mouseup'));
function DetailsHarness() {
  const adjustments = editor((s) => s.adjustments);
  return React.createElement(DetailsPanel, {
    adjustments,
    appSettings: null,
    setAdjustments: (update) =>
      editor.setState((s) => ({
        adjustments: typeof update === 'function' ? update(s.adjustments) : { ...s.adjustments, ...update },
      })),
  });
}
await act(async () =>
  editor.setState((s) => ({ adjustments: { ...s.adjustments, aiDenoiseEnabled: true, aiDenoiseMethod: 'ai' } })),
);
await mountComponent(DetailsHarness);
for (const label of [
  'adjustments.details.luminance',
  'adjustments.details.color',
  'adjustments.effects.amount',
  'adjustments.details.aiDenoiseDetail',
]) {
  const input = [...document.querySelectorAll('input[type=range]')].find((input) =>
    input.closest('.group')?.textContent.includes(label),
  );
  assert.ok(input, 'Missing noise control ' + label);
  input.getBoundingClientRect = () => ({ left: 0, width: 200 });
  count = calls.length;
  await act(async () => mouse(input, 'mousedown', 100, { altKey: true }));
  assert.equal(calls.length, count, label + ' must never request an Alt preview');
  assert.equal(preview.getState().preview.target, null);
  await act(async () => mouse(window, 'mouseup'));
}
function BasicHarness() {
  const adjustments = editor((s) => s.adjustments);
  return React.createElement(BasicPanel, {
    adjustments,
    appSettings: {},
    setAdjustments: (updater) =>
      editor.setState((s) => ({
        adjustments: typeof updater === 'function' ? updater(s.adjustments) : { ...s.adjustments, ...updater },
      })),
  });
}
await mountComponent(BasicHarness);
input = document.querySelector('input[type=range]');
assert.ok(input, 'Actual global Tone Mapper exposure slider is present');
input.getBoundingClientRect = () => ({ left: 0, width: 200 });
count = calls.length;
await act(async () => mouse(input, 'mousedown', 100, { altKey: true }));
assert.ok(calls.length > count, 'Tone Mapper exposure must request a preview');
assert.equal(calls.at(-1).request.target.control, 'exposure');
assert.equal(calls.at(-1).request.presentation, 1);
await act(async () => mouse(window, 'mouseup'));
await act(async () => root.unmount());
assert.equal(openUrls.size, 0, 'Every decoded diagnostic URL is released');
dom.window.close();
console.log(
  'Alt integration passed: sliders, grading-wheel pointers, curve anchors, Relight and Fog Amount, noise exclusion, modifiers and lifecycle.',
);
