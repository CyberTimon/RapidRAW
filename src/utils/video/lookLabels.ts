import type { ParseKeys, TFunction } from 'i18next';
import type { Adjustments } from '../adjustments';

const STRUCTURAL = new Set(['adjustments', 'parameters', 'subMasks', 'masks']);
const MIXER_COLORS = ['reds', 'oranges', 'yellows', 'greens', 'aquas', 'blues', 'purples', 'magentas'];
const CURVE_CHANNELS = ['luma', 'red', 'green', 'blue'];
const PRIMARIES = ['red', 'green', 'blue'];

const generated = (entries: Array<[string, Array<string>]>) =>
  Object.fromEntries(entries) as Record<string, Array<ParseKeys>>;

const LABELS: Record<string, Array<ParseKeys>> = {
  exposure: ['adjustments.basic.exposure'],
  brightness: ['adjustments.basic.brightness'],
  contrast: ['adjustments.basic.contrast'],
  highlights: ['adjustments.basic.highlights'],
  shadows: ['adjustments.basic.shadows'],
  whites: ['adjustments.basic.whites'],
  blacks: ['adjustments.basic.blacks'],
  temperature: ['adjustments.color.temperature'],
  tint: ['adjustments.color.tint'],
  vibrance: ['adjustments.color.vibrance'],
  saturation: ['adjustments.color.saturation'],
  hue: ['adjustments.color.hue'],
  luminance: ['adjustments.color.luminance'],
  hsl: ['adjustments.color.colorMixer'],
  ...generated(MIXER_COLORS.map((color) => [color, [`adjustments.color.mixerColors.${color}`]])),
  colorGrading: ['adjustments.color.colorGrading'],
  global: ['adjustments.color.grading.global'],
  midtones: ['adjustments.color.grading.midtones'],
  balance: ['adjustments.color.grading.balance'],
  blending: ['adjustments.color.grading.blending'],
  colorCalibration: ['adjustments.color.calibration.title'],
  shadowsTint: ['adjustments.color.calibration.shadows', 'adjustments.color.calibration.tint'],
  ...generated(
    PRIMARIES.flatMap((primary) => [
      [`${primary}Hue`, [`adjustments.color.calibration.colors.${primary}`, 'adjustments.color.calibration.hue']],
      [
        `${primary}Saturation`,
        [`adjustments.color.calibration.colors.${primary}`, 'adjustments.color.calibration.saturation'],
      ],
    ]),
  ),
  monochromeFilterHue: ['adjustments.color.monochrome.filter', 'adjustments.color.monochrome.hue'],
  monochromeFilterStrength: ['adjustments.color.monochrome.filter', 'adjustments.color.monochrome.strength'],
  monochromeMix: ['adjustments.color.monochrome.mix'],
  monochromeToning: ['adjustments.color.monochrome.toning'],
  highlightHue: ['adjustments.color.monochrome.highlights', 'adjustments.color.monochrome.hue'],
  highlightSaturation: ['adjustments.color.monochrome.highlights', 'adjustments.color.monochrome.saturation'],
  shadowHue: ['adjustments.color.monochrome.shadows', 'adjustments.color.monochrome.hue'],
  shadowSaturation: ['adjustments.color.monochrome.shadows', 'adjustments.color.monochrome.saturation'],
  parametricCurve: ['adjustments.curves.parametricCurve'],
  ...generated(CURVE_CHANNELS.map((channel) => [channel, [`adjustments.curves.channels.${channel}`]])),
  whiteLevel: ['adjustments.curves.params.whiteLevel'],
  blackLevel: ['adjustments.curves.params.blackLevel'],
  lights: ['adjustments.curves.params.lights'],
  darks: ['adjustments.curves.params.darks'],
  clarity: ['adjustments.details.clarity'],
  dehaze: ['adjustments.details.dehaze'],
  structure: ['adjustments.details.structure'],
  centré: ['adjustments.details.centre'],
  sharpness: ['adjustments.details.sharpness'],
  sharpnessThreshold: ['adjustments.details.sharpening', 'adjustments.details.threshold'],
  lumaNoiseReduction: ['adjustments.details.noiseReduction', 'adjustments.details.luminance'],
  colorNoiseReduction: ['adjustments.details.noiseReduction', 'adjustments.details.color'],
  aiDenoiseAmount: ['adjustments.details.aiDenoise'],
  aiDenoiseDetail: ['adjustments.details.aiDenoise', 'adjustments.details.aiDenoiseDetail'],
  aiUpscaleDetail: ['adjustments.details.aiUpscale', 'adjustments.details.aiUpscaleDetail'],
  chromaticAberrationRedCyan: ['adjustments.details.chromaticAberration', 'adjustments.details.redCyan'],
  chromaticAberrationBlueYellow: ['adjustments.details.chromaticAberration', 'adjustments.details.blueYellow'],
  negativeRedWeight: ['adjustments.details.negativeConversion', 'adjustments.details.negativeRed'],
  negativeGreenWeight: ['adjustments.details.negativeConversion', 'adjustments.details.negativeGreen'],
  negativeBlueWeight: ['adjustments.details.negativeConversion', 'adjustments.details.negativeBlue'],
  negativeExposure: ['adjustments.details.negativeExposure'],
  negativeContrast: ['adjustments.details.negativeContrast'],
  glowAmount: ['adjustments.effects.glow'],
  halationAmount: ['adjustments.effects.halation'],
  flareAmount: ['adjustments.effects.lightFlares'],
  grainAmount: ['adjustments.effects.grain'],
  grainSize: ['adjustments.effects.grain', 'adjustments.effects.size'],
  grainRoughness: ['adjustments.effects.grain', 'adjustments.effects.roughness'],
  vignetteAmount: ['adjustments.effects.vignette'],
  vignetteMidpoint: ['adjustments.effects.vignette', 'adjustments.effects.midpoint'],
  vignetteRoundness: ['adjustments.effects.vignette', 'adjustments.effects.roundness'],
  vignetteFeather: ['adjustments.effects.vignette', 'adjustments.effects.feather'],
  pixelateAmount: ['adjustments.effects.pixelate'],
  motionBlurAmount: ['adjustments.effects.motionBlur'],
  motionBlurAngle: ['adjustments.effects.motionBlur', 'adjustments.effects.motionBlurAngle'],
  motionBlurHighlights: ['adjustments.effects.motionBlur', 'adjustments.effects.motionBlurHighlights'],
  motionBlurDepth: ['adjustments.effects.motionBlur', 'adjustments.effects.motionBlurDepth'],
  motionBlurShutter: ['adjustments.effects.motionBlur', 'adjustments.effects.motionBlurShutter'],
  lensBlurAmount: ['adjustments.effects.lensBlur'],
  lensBlurDiffusion: ['adjustments.effects.lensBlur', 'adjustments.effects.lensDiffusion'],
  relightAmbient: ['adjustments.effects.relight', 'adjustments.effects.relightAmbient'],
  relightSoftness: ['adjustments.effects.relight', 'adjustments.effects.relightSoftness'],
  relightShine: ['adjustments.effects.relight', 'adjustments.effects.relightShine'],
  relightShadowSoftness: ['adjustments.effects.relight', 'adjustments.effects.relightShadowSoftness'],
  fogAmount: ['adjustments.effects.fog'],
  fogStart: ['adjustments.effects.fog', 'adjustments.effects.fogStart'],
  fogDensity: ['adjustments.effects.fog', 'adjustments.effects.fogDensity'],
  fogHeight: ['adjustments.effects.fog', 'adjustments.effects.fogHeight'],
  fogVariation: ['adjustments.effects.fog', 'adjustments.effects.fogVariation'],
  fogGlow: ['adjustments.effects.fog', 'adjustments.effects.glow'],
  fogTemperature: ['adjustments.effects.fog', 'adjustments.color.temperature'],
  fogTint: ['adjustments.effects.fog', 'adjustments.color.tint'],
  lutIntensity: ['adjustments.effects.lut'],
  opacity: ['editor.masks.settings.opacity'],
};

const LIGHT_LABELS: Record<string, ParseKeys> = {
  position: 'adjustments.effects.relightPosition',
  intensity: 'adjustments.effects.relightIntensity',
  depth: 'adjustments.effects.relightDepth',
  radius: 'adjustments.effects.relightFalloff',
  angle: 'adjustments.effects.relightAngle',
  elevation: 'adjustments.effects.relightElevation',
  cone: 'adjustments.effects.relightCone',
  feather: 'adjustments.effects.feather',
  temperature: 'adjustments.color.temperature',
  tint: 'adjustments.color.tint',
};

const humanize = (segment: string) =>
  segment.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (first) => first.toUpperCase());

const maskName = (look: Adjustments, id: string): string | null => {
  for (const mask of look.masks ?? []) {
    if (mask.id === id) return mask.name ?? null;
    const subMask = mask.subMasks?.find((candidate) => candidate.id === id);
    if (subMask) return subMask.name ?? null;
  }
  return null;
};

const segmentLabel = (segment: string, parent: string | undefined, t: TFunction) => {
  if (LABELS[segment]) return LABELS[segment].map((key) => t(key)).join(' ');
  if (parent === 'parameters') {
    return t(`editor.masks.params.${segment}` as ParseKeys, { defaultValue: humanize(segment) });
  }
  return humanize(segment);
};

const lightLabel = (look: Adjustments, [light, field]: Array<string>, t: TFunction) => {
  const index = (look.relightLights ?? []).findIndex((candidate) => `#${candidate.id}` === light);
  return [
    t('adjustments.effects.relight'),
    t('adjustments.effects.relightLight', { index: index + 1 }),
    LIGHT_LABELS[field] ? t(LIGHT_LABELS[field]) : humanize(field),
  ].join(' · ');
};

const pathLabel = (look: Adjustments, path: string, t: TFunction) =>
  path
    .split('.')
    .map((segment, index, segments) =>
      STRUCTURAL.has(segment)
        ? null
        : segment.startsWith('#')
          ? maskName(look, segment.slice(1))
          : segmentLabel(segment, segments[index - 1], t),
    )
    .filter(Boolean)
    .join(' · ');

export const lookValueLabel = (look: Adjustments, path: string, t: TFunction) => {
  const [root, ...rest] = path.split('.');
  return root === 'relightLights' ? lightLabel(look, rest, t) : pathLabel(look, path, t);
};
