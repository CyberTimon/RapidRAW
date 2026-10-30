import { Adjustments, MaskContainer } from './adjustments';

const KEY_NAMES: Record<string, string> = {
  aiPatches: 'AI Patches',
  aspectRatio: 'Aspect Ratio',
  flipHorizontal: 'Flip Horizontal',
  flipVertical: 'Flip Vertical',
  orientationSteps: 'Rotation',
  lutPath: 'LUT',
  lutIntensity: 'LUT Intensity',
  lutData: 'LUT Data',
  lutName: 'LUT Name',
  lutSize: 'LUT Size',
  chromaticAberrationBlueYellow: 'Chromatic Aberration Blue/Yellow',
  chromaticAberrationRedCyan: 'Chromatic Aberration Red/Cyan',
  centré: 'Centré',
  centréX: 'Centré Center',
  centréY: 'Centré Center',
  lumaNoiseReduction: 'Luma Noise Reduction',
  colorNoiseReduction: 'Color Noise Reduction',
  lensMaker: 'Lens Maker',
  lensModel: 'Lens Model',
  lensDistortionAmount: 'Lens Distortion',
  lensVignetteAmount: 'Lens Vignette',
  lensTcaAmount: 'Lens TCA',
  lensDistortionEnabled: 'Enable Lens Distortion',
  lensTcaEnabled: 'Enable Lens TCA',
  lensVignetteEnabled: 'Enable Lens Vignette',
  transformDistortion: 'Transform Distortion',
  transformVertical: 'Transform Vertical',
  transformHorizontal: 'Transform Horizontal',
  transformRotate: 'Transform Rotate',
  transformAspect: 'Transform Aspect',
  transformScale: 'Transform Scale',
  transformXOffset: 'Transform X Offset',
  transformYOffset: 'Transform Y Offset',
  colorGrading: 'Color Grading',
  colorCalibration: 'Color Calibration',
  toneMapper: 'Tone Mapper',
  showClipping: 'Show Clipping',
  activeTools: 'Tool Visibility',
  flareAmount: 'Flare Amount',
  glowAmount: 'Glow Amount',
  halationAmount: 'Halation Amount',
  grainAmount: 'Grain Amount',
  grainRoughness: 'Grain Roughness',
  grainSize: 'Grain Size',
  vignetteAmount: 'Vignette Amount',
  vignetteCenterX: 'Vignette Center',
  vignetteCenterY: 'Vignette Center',
  vignetteFeather: 'Vignette Feather',
  vignetteMidpoint: 'Vignette Midpoint',
  vignetteRoundness: 'Vignette Roundness',
  dehaze: 'Dehaze',
  exposure: 'Exposure',
  blacks: 'Blacks',
  whites: 'Whites',
  shadows: 'Shadows',
  highlights: 'Highlights',
  contrast: 'Contrast',
  brightness: 'Brightness',
  clarity: 'Clarity',
  structure: 'Structure',
  sharpness: 'Sharpness',
  saturation: 'Saturation',
  temperature: 'Temperature',
  tint: 'Tint',
  vibrance: 'Vibrance',
  hsl: 'HSL',
  monochromeEnabled: 'Black & White',
  monochromeFilm: 'B&W Film',
  monochromeFilterHue: 'B&W Filter',
  monochromeFilterStrength: 'B&W Filter',
  monochromeMix: 'B&W Mix',
  monochromeToning: 'Toning',
  curves: 'Curves',
  crop: 'Crop',
  masks: 'Masks',
  rating: 'Rating',
};

const MAX_CHANGES = 6;
const CROP_RATIOS = [
  [1, 1],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [5, 4],
  [4, 5],
  [16, 9],
  [9, 16],
  [2, 1],
];

const formatKey = (key: string) =>
  KEY_NAMES[key] ?? key.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());

const formatValue = (value: unknown) => {
  if (typeof value === 'number') return `${value > 0 ? '+' : ''}${Number(value.toFixed(2))}`;
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  return null;
};

const withValue = (name: string, value: unknown) => {
  const formatted = formatValue(value);
  return formatted === null ? name : `${name} ${formatted}`;
};

export const isSameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) => isSameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  );
};

const nestedChanges = (prefix: string, before: object | undefined, after: object): string[] => {
  const prev = (before || {}) as Record<string, unknown>;
  const next = after as Record<string, unknown>;
  return Object.keys(next)
    .filter((key) => !isSameValue(prev[key], next[key]))
    .map((key) => withValue(`${prefix}: ${formatKey(key)}`, next[key]));
};

const maskChanges = (before: MaskContainer[] = [], after: MaskContainer[] = []): string[] => {
  const changes: string[] = [];
  before
    .filter((mask) => !after.some((m) => m.id === mask.id))
    .forEach((mask) => changes.push(`Deleted Mask: ${mask.name || 'Mask'}`));

  after.forEach((mask) => {
    const prev = before.find((m) => m.id === mask.id);
    const name = mask.name || 'Mask';
    if (!prev) {
      changes.push(`Added Mask: ${name}`);
      return;
    }
    if (isSameValue(prev, mask)) return;

    changes.push(...nestedChanges(name, prev.adjustments, mask.adjustments));
    if (!isSameValue(prev.subMasks, mask.subMasks)) changes.push(`${name}: Mask Area / Brush`);
    if (prev.opacity !== mask.opacity) changes.push(`${name}: Opacity ${mask.opacity}`);
    if (prev.invert !== mask.invert) changes.push(`${name}: Invert ${formatValue(mask.invert)}`);
    if (prev.visible !== mask.visible) changes.push(`${name}: Visible ${formatValue(mask.visible)}`);
    if (prev.name !== mask.name) changes.push(`Renamed Mask: ${name}`);
  });
  return changes;
};

const aiPatchChanges = (before: Adjustments['aiPatches'] = [], after: Adjustments['aiPatches'] = []): string[] => {
  if (after.length > before.length) return ['Added AI Patch'];
  if (after.length < before.length) return ['Deleted AI Patch'];
  const changes: string[] = [];
  after.forEach((patch) => {
    const prev = before.find((p) => p.id === patch.id);
    if (!prev) return;
    if (prev.visible !== patch.visible) changes.push('AI Patch Visibility');
    if (!isSameValue(prev.subMasks, patch.subMasks)) changes.push('AI Patch Area');
    if (prev.patchData !== patch.patchData || prev.prompt !== patch.prompt) changes.push('AI Generation');
  });
  return changes;
};

const cropLabel = ({ crop, aspectRatio }: Adjustments) => {
  if (!crop) return 'Crop Cleared';
  const ratio = aspectRatio || crop.width / crop.height;
  const standard = CROP_RATIOS.find(([w, h]) => Math.abs(ratio - w / h) < 0.001);
  return `Crop ${standard ? standard.join(':') : `${Math.round(crop.width)} × ${Math.round(crop.height)}`}`;
};

export function describeHistoryChange(before: Adjustments, after: Adjustments): string {
  const changedKeys = Object.keys(after).filter((key) => !isSameValue(before[key], after[key]));

  const changes = changedKeys.flatMap((key): string[] => {
    switch (key) {
      case 'activeTools':
        return changedKeys.length === 1 ? [formatKey(key)] : [];
      case 'masks':
        return maskChanges(before.masks, after.masks);
      case 'aiPatches':
        return aiPatchChanges(before.aiPatches, after.aiPatches);
      case 'crop':
      case 'aspectRatio':
        return key === 'aspectRatio' && changedKeys.includes('crop') ? [] : [cropLabel(after)];
      case 'curves':
      case 'pointCurves':
      case 'parametricCurve': {
        const curves: Record<string, unknown> = after[key] || {};
        return Object.keys(curves)
          .filter((channel) => !isSameValue(before[key]?.[channel], curves[channel]))
          .map((channel) => `Curves: ${formatKey(channel)}`);
      }
      case 'hsl':
        return Object.keys(after.hsl).flatMap((channel) =>
          nestedChanges(`HSL ${formatKey(channel.replace(/s$/, ''))}`, before.hsl?.[channel], after.hsl[channel]),
        );
      case 'colorGrading':
      case 'colorCalibration':
        return nestedChanges(formatKey(key), before[key], after[key]);
      default:
        return [withValue(formatKey(key), after[key])];
    }
  });

  const unique = Array.from(new Set(changes));
  if (unique.length === 0) return 'Adjustment';
  const extra = unique.length - MAX_CHANGES;
  return unique.slice(0, MAX_CHANGES).join(', ') + (extra > 0 ? ` (+${extra} more)` : '');
}
