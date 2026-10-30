/** Supported Alt-slider targets. Presentation policy is defined in altPreviewPolicy. */
export const HSL_BANDS = ['reds', 'oranges', 'yellows', 'greens', 'aquas', 'blues', 'purples', 'magentas'] as const;
export const CURVE_CHANNELS = ['luma', 'red', 'green', 'blue'] as const;
export type HslBand = (typeof HSL_BANDS)[number];
export type CurveChannel = (typeof CURVE_CHANNELS)[number];
export type TonalRange = 'shadows' | 'midtones' | 'highlights';
export type InfluenceScope = { kind: 'global' } | { kind: 'mask'; containerId: string };

export const SCALAR_CONTROLS = [
  'exposure',
  'brightness',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'temperature',
  'tint',
  'saturation',
  'vibrance',
  'hue',
  'clarity',
  'structure',
  'dehaze',
  'sharpness',
  'glowAmount',
  'halationAmount',
  'flareAmount',
] as const;
export type ScalarControl = (typeof SCALAR_CONTROLS)[number];
export const GLOBAL_EFFECTS = ['centre', 'lensBlur', 'fog', 'vignette'] as const;
export type GlobalEffect = (typeof GLOBAL_EFFECTS)[number];
export const GLOBAL_PARAMETERS = [
  'relightAmbient',
  'relightSoftness',
  'relightShine',
  'relightShadowSoftness',
] as const;

export type InfluenceTarget =
  | { kind: 'parameter'; control: (typeof GLOBAL_PARAMETERS)[number] }
  | { kind: 'scalar'; control: ScalarControl; scope: InfluenceScope }
  | { kind: 'hsl'; band: HslBand; component: 'hue' | 'saturation' | 'luminance'; scope: InfluenceScope }
  | { kind: 'grading'; range: TonalRange; scope: InfluenceScope }
  | {
      kind: 'parametric';
      channel: CurveChannel;
      parameter: 'shadows' | 'darks' | 'lights' | 'highlights' | 'blackLevel' | 'whiteLevel';
      scope: InfluenceScope;
    }
  | { kind: 'curvePoint'; channel: CurveChannel; index: number; scope: InfluenceScope }
  | { kind: 'monochromeMix'; band: HslBand }
  | { kind: 'effect'; effect: GlobalEffect }
  | { kind: 'light'; lightId: string };

const contains = (values: readonly string[], value: unknown): value is string =>
  typeof value === 'string' && values.includes(value);
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const validScope = (value: unknown): value is InfluenceScope =>
  record(value) &&
  ((value.kind === 'global' && keysAre(value, ['kind'])) ||
    (value.kind === 'mask' && isId(value.containerId) && keysAre(value, ['kind', 'containerId'])));

/** Validate untrusted IPC/state input, including disallowing unrelated fields. */
export function isInfluenceTarget(value: unknown): value is InfluenceTarget {
  if (!record(value)) return false;
  switch (value.kind) {
    case 'scalar':
      return (
        keysAre(value, ['kind', 'control', 'scope']) &&
        contains(SCALAR_CONTROLS, value.control) &&
        validScope(value.scope)
      );
    case 'parameter':
      return keysAre(value, ['kind', 'control']) && contains(GLOBAL_PARAMETERS, value.control);
    case 'hsl':
      return (
        keysAre(value, ['kind', 'band', 'component', 'scope']) &&
        contains(HSL_BANDS, value.band) &&
        contains(['hue', 'saturation', 'luminance'], value.component) &&
        validScope(value.scope)
      );
    case 'grading':
      return (
        keysAre(value, ['kind', 'range', 'scope']) &&
        contains(['shadows', 'midtones', 'highlights'], value.range) &&
        validScope(value.scope)
      );

    case 'parametric':
      return (
        keysAre(value, ['kind', 'channel', 'parameter', 'scope']) &&
        contains(CURVE_CHANNELS, value.channel) &&
        contains(['shadows', 'darks', 'lights', 'highlights', 'blackLevel', 'whiteLevel'], value.parameter) &&
        validScope(value.scope)
      );
    case 'curvePoint':
      return (
        keysAre(value, ['kind', 'channel', 'index', 'scope']) &&
        contains(CURVE_CHANNELS, value.channel) &&
        Number.isInteger(value.index) &&
        Number(value.index) >= 0 &&
        Number(value.index) < 16 &&
        validScope(value.scope)
      );
    case 'monochromeMix':
      return keysAre(value, ['kind', 'band']) && contains(HSL_BANDS, value.band);

    case 'effect':
      return keysAre(value, ['kind', 'effect']) && contains(GLOBAL_EFFECTS, value.effect);
    case 'light':
      return keysAre(value, ['kind', 'lightId']) && isId(value.lightId);

    default:
      return false;
  }
}

/** Canonical identity independent of incoming property order. */
export function influenceTargetKey(target: InfluenceTarget): string {
  const canonical = (value: unknown): unknown =>
    record(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
  return JSON.stringify(canonical(target));
}
