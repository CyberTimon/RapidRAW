import { Adjustments, ADJUSTMENT_GROUPS, ADJUSTMENT_SECTIONS, INITIAL_ADJUSTMENTS } from './adjustments';

export const EXTERNAL_CONTROL_COMMAND_EVENT = 'external-control-command';
export const EXTERNAL_CONTROL_CLIENTS_EVENT = 'external-control-clients';
export const EXTERNAL_CONTROL_PROTOCOL = 1;

export interface ControlParam {
  id: string;
  path: string[];
  group: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

type Range = [number, number, number];

const DEFAULT_RANGE: Range = [-100, 100, 1];

const RANGES: Record<string, Range> = {
  exposure: [-5, 5, 0.01],
  brightness: [-5, 5, 0.01],
  hue: [-180, 180, 1],
  sharpnessThreshold: [0, 80, 1],
  rotation: [-45, 45, 0.1],
  transformRotate: [-45, 45, 0.1],
  transformScale: [50, 150, 1],
  lensDistortionAmount: [0, 200, 1],
  lensVignetteAmount: [0, 200, 1],
  lensTcaAmount: [0, 200, 1],
  'colorGrading.blending': [0, 100, 1],
  'colorGrading.*.hue': [0, 360, 1],
  'colorGrading.*.saturation': [0, 100, 1],
  glowAmount: [0, 100, 1],
  halationAmount: [0, 100, 1],
  flareAmount: [0, 100, 1],
  lensBlurAmount: [0, 100, 1],
  lensBlurDiffusion: [0, 100, 1],
  vignetteMidpoint: [0, 100, 1],
  vignetteFeather: [0, 100, 1],
  grainAmount: [0, 100, 1],
  grainSize: [0, 100, 1],
  grainRoughness: [0, 100, 1],
  lutIntensity: [0, 100, 1],
  lumaNoiseReduction: [0, 100, 1],
  colorNoiseReduction: [0, 100, 1],
};

const NOT_SLIDERS = new Set([
  'lutSize',
  'orientationSteps',
  'lensBlurMinDepth',
  'lensBlurMaxDepth',
  'lensBlurMinFade',
  'lensBlurMaxFade',
]);

const SECTION_KEYS: Array<[string, string[]]> = [
  ['basic', ADJUSTMENT_SECTIONS.basic],
  ['color', ADJUSTMENT_SECTIONS.color],
  ['details', ADJUSTMENT_SECTIONS.details],
  ['effects', ADJUSTMENT_SECTIONS.effects],
  ['geometry', ADJUSTMENT_GROUPS.geometry.flatMap((group) => group.keys)],
];

const rangeFor = (id: string): Range => RANGES[id] ?? RANGES[id.replace(/^([^.]+)\.[^.]+\./, '$1.*.')] ?? DEFAULT_RANGE;

const collectParams = (group: string, path: string[], value: unknown, out: ControlParam[]) => {
  const id = path.join('.');
  if (typeof value === 'number') {
    if (NOT_SLIDERS.has(id)) return;
    const [min, max, step] = rangeFor(id);
    out.push({ id, path, group, min, max, step, default: value });
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectParams(group, [...path, key], child, out);
    }
  }
};

export const CONTROL_PARAMS: ControlParam[] = SECTION_KEYS.flatMap(([group, keys]) => {
  const out: ControlParam[] = [];
  for (const key of keys) {
    collectParams(group, [key], (INITIAL_ADJUSTMENTS as unknown as Record<string, unknown>)[key], out);
  }
  return out;
});

const PARAM_INDEX = new Map(CONTROL_PARAMS.map((param) => [param.id, param]));

export function getControlParam(id: unknown): ControlParam | undefined {
  return typeof id === 'string' ? PARAM_INDEX.get(id) : undefined;
}

export function readPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function writePath<T extends object>(obj: T, path: string[], value: unknown): T {
  if (path.length === 0) return obj;
  const [head, ...rest] = path;
  const current = (obj as Record<string, unknown>)[head];
  const next =
    rest.length === 0 ? value : writePath(current && typeof current === 'object' ? current : {}, rest, value);
  return { ...obj, [head]: next };
}

export function normalizeParamValue(param: ControlParam, raw: number): number {
  if (!Number.isFinite(raw)) return param.default;
  const decimals = Math.max(0, Math.ceil(-Math.log10(param.step)));
  const snapped = Math.round(raw / param.step) * param.step;
  const clamped = Math.min(param.max, Math.max(param.min, snapped));
  return Number(clamped.toFixed(decimals));
}

export function readParamValue(adjustments: Adjustments, param: ControlParam): number {
  const value = readPath(adjustments, param.path);
  return typeof value === 'number' && Number.isFinite(value) ? value : param.default;
}

export function snapshotParams(adjustments: Adjustments): Record<string, number> {
  const out: Record<string, number> = {};
  for (const param of CONTROL_PARAMS) {
    out[param.id] = readParamValue(adjustments, param);
  }
  return out;
}

export interface RegisteredAction {
  shouldFire?: (storeState: unknown) => boolean;
  execute: (event: { preventDefault(): void; stopPropagation(): void }, storeState: unknown) => void;
}

interface ActionRegistry {
  actions: Record<string, RegisteredAction>;
  getStoreState: () => unknown;
}

let registry: ActionRegistry | null = null;

export function registerControlActions(actions: Record<string, RegisteredAction>, getStoreState: () => unknown) {
  registry = { actions, getStoreState };
  return () => {
    if (registry && registry.actions === actions) registry = null;
  };
}

export function listControlActions(): string[] {
  return registry ? Object.keys(registry.actions) : [];
}

export type ActionResult = 'ok' | 'ignored' | 'unknown' | 'unavailable';

export function runControlAction(id: unknown): ActionResult {
  if (!registry) return 'unavailable';
  if (typeof id !== 'string') return 'unknown';
  const handler = registry.actions[id];
  if (!handler) return 'unknown';
  const storeState = registry.getStoreState();
  if (handler.shouldFire && !handler.shouldFire(storeState)) return 'ignored';
  handler.execute({ preventDefault() {}, stopPropagation() {} }, storeState);
  return 'ok';
}
