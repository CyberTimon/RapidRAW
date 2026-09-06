/**
 * External control: parameter table and action registry.
 *
 * A hardware controller talks to the Rust-side TCP server (src-tauri/src/external_control.rs),
 * which forwards each message to the webview as the `external-control-command` event.
 * `useExternalControl` interprets those messages; this module holds the data it needs:
 *
 *  - CONTROL_PARAMS: every adjustment a controller may address, with its range and default.
 *    Ranges mirror the sliders in src/components/adjustments so a dial can never push a value
 *    the UI could not.
 *  - the action registry: the named actions (undo, preview_next, rate_3, ...) that
 *    useKeyboardShortcuts builds are registered here so a controller button can fire them
 *    without a synthetic keyboard event.
 *
 * Message vocabulary: docs/EXTERNAL_CONTROL_API.md
 */

import { Adjustments, INITIAL_ADJUSTMENTS } from './adjustments';

export const EXTERNAL_CONTROL_COMMAND_EVENT = 'external-control-command';
export const EXTERNAL_CONTROL_CLIENTS_EVENT = 'external-control-clients';
export const EXTERNAL_CONTROL_PROTOCOL = 1;

export interface ControlParam {
  /** Stable identifier used on the wire, e.g. `exposure`, `hsl.reds.hue`. */
  id: string;
  /** Path into the Adjustments object. */
  path: string[];
  /** Panel the slider lives in; informational, for controller UIs. */
  group: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

const p = (
  id: string,
  group: string,
  min: number,
  max: number,
  step: number,
  path: string[] = id.split('.'),
  def?: number,
): ControlParam => ({
  id,
  path,
  group,
  min,
  max,
  step,
  default: def ?? numberOr(readPath(INITIAL_ADJUSTMENTS, path), 0),
});

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const HSL_COLORS = ['reds', 'oranges', 'yellows', 'greens', 'aquas', 'blues', 'purples', 'magentas'];
const GRADING_RANGES = ['shadows', 'midtones', 'highlights', 'global'];

const FLAT_PARAMS: ControlParam[] = [
  // Basic (Basic.tsx)
  p('exposure', 'basic', -5, 5, 0.01),
  p('brightness', 'basic', -5, 5, 0.01),
  p('contrast', 'basic', -100, 100, 1),
  p('highlights', 'basic', -100, 100, 1),
  p('shadows', 'basic', -100, 100, 1),
  p('whites', 'basic', -100, 100, 1),
  p('blacks', 'basic', -100, 100, 1),
  // Color (Color.tsx)
  p('temperature', 'color', -100, 100, 1),
  p('tint', 'color', -100, 100, 1),
  p('vibrance', 'color', -100, 100, 1),
  p('saturation', 'color', -100, 100, 1),
  p('hue', 'color', -180, 180, 1),
  p('colorGrading.blending', 'colorGrading', 0, 100, 1),
  p('colorGrading.balance', 'colorGrading', -100, 100, 1),
  p('colorCalibration.shadowsTint', 'calibration', -100, 100, 1),
  p('colorCalibration.redHue', 'calibration', -100, 100, 1),
  p('colorCalibration.redSaturation', 'calibration', -100, 100, 1),
  p('colorCalibration.greenHue', 'calibration', -100, 100, 1),
  p('colorCalibration.greenSaturation', 'calibration', -100, 100, 1),
  p('colorCalibration.blueHue', 'calibration', -100, 100, 1),
  p('colorCalibration.blueSaturation', 'calibration', -100, 100, 1),
  // Details (Details.tsx)
  p('sharpness', 'details', -100, 100, 1),
  p('sharpnessThreshold', 'details', 0, 80, 1),
  p('clarity', 'details', -100, 100, 1),
  p('dehaze', 'details', -100, 100, 1),
  p('structure', 'details', -100, 100, 1),
  p('centré', 'details', -100, 100, 1),
  p('lumaNoiseReduction', 'details', 0, 100, 1),
  p('colorNoiseReduction', 'details', 0, 100, 1),
  p('chromaticAberrationRedCyan', 'details', -100, 100, 1),
  p('chromaticAberrationBlueYellow', 'details', -100, 100, 1),
  // Effects (Effects.tsx)
  p('glowAmount', 'effects', 0, 100, 1),
  p('halationAmount', 'effects', 0, 100, 1),
  p('flareAmount', 'effects', 0, 100, 1),
  p('lensBlurAmount', 'effects', 0, 100, 1),
  p('lensBlurDiffusion', 'effects', 0, 100, 1),
  p('vignetteAmount', 'effects', -100, 100, 1),
  p('vignetteMidpoint', 'effects', 0, 100, 1),
  p('vignetteRoundness', 'effects', -100, 100, 1),
  p('vignetteFeather', 'effects', 0, 100, 1),
  p('grainAmount', 'effects', 0, 100, 1),
  p('grainSize', 'effects', 0, 100, 1),
  p('grainRoughness', 'effects', 0, 100, 1),
  p('lutIntensity', 'effects', 0, 100, 1),
  // Transform / crop
  p('rotation', 'transform', -45, 45, 0.1),
  p('transformRotate', 'transform', -45, 45, 0.1),
  p('transformVertical', 'transform', -100, 100, 1),
  p('transformHorizontal', 'transform', -100, 100, 1),
  p('transformDistortion', 'transform', -100, 100, 1),
  p('transformAspect', 'transform', -100, 100, 1),
  p('transformScale', 'transform', 50, 150, 1),
  p('transformXOffset', 'transform', -100, 100, 1),
  p('transformYOffset', 'transform', -100, 100, 1),
];

const HSL_PARAMS: ControlParam[] = HSL_COLORS.flatMap((color) => [
  p(`hsl.${color}.hue`, 'hsl', -100, 100, 1),
  p(`hsl.${color}.saturation`, 'hsl', -100, 100, 1),
  p(`hsl.${color}.luminance`, 'hsl', -100, 100, 1),
]);

const GRADING_PARAMS: ControlParam[] = GRADING_RANGES.flatMap((range) => [
  p(`colorGrading.${range}.hue`, 'colorGrading', 0, 360, 1),
  p(`colorGrading.${range}.saturation`, 'colorGrading', 0, 100, 1),
  p(`colorGrading.${range}.luminance`, 'colorGrading', -100, 100, 1),
]);

export const CONTROL_PARAMS: ControlParam[] = [...FLAT_PARAMS, ...HSL_PARAMS, ...GRADING_PARAMS];

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

/** Immutable set along `path`, shallow-copying every object on the way. */
export function writePath<T extends object>(obj: T, path: string[], value: unknown): T {
  if (path.length === 0) return obj;
  const [head, ...rest] = path;
  const current = (obj as Record<string, unknown>)[head];
  const next =
    rest.length === 0 ? value : writePath(current && typeof current === 'object' ? current : {}, rest, value);
  return { ...obj, [head]: next };
}

/** Snap to the parameter's step grid and clamp to its range. */
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

/** Flat `{ id: value }` map of every parameter, for the `state` message. */
export function snapshotParams(adjustments: Adjustments): Record<string, number> {
  const out: Record<string, number> = {};
  for (const param of CONTROL_PARAMS) {
    out[param.id] = readParamValue(adjustments, param);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Action registry
// ---------------------------------------------------------------------------

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
