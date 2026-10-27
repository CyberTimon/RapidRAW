import { Crop } from 'react-image-crop';
import { v4 as uuidv4 } from 'uuid';
import { SubMask, SubMaskMode } from '../components/panel/right/Masks';
import type { AdjustmentLayout, AppSettings } from '../components/ui/AppProperties';
import type { WhiteBalance } from './whiteBalance';
import defaultAdjustments from './defaultAdjustments.json';

export enum ActiveChannel {
  Blue = 'blue',
  Green = 'green',
  Luma = 'luma',
  Red = 'red',
}

export enum DisplayMode {
  Luma = 'luma',
  Rgb = 'rgb',
  Parade = 'parade',
  Vectorscope = 'vectorscope',
  Histogram = 'histogram',
}

export enum PasteMode {
  Merge = 'merge',
  Replace = 'replace',
}

export enum AutoAdjustMode {
  Subtle = 'subtle',
  Normal = 'normal',
  Strong = 'strong',
}

export interface CopyPasteSettings {
  mode: PasteMode;
  includedAdjustments: Array<string>;
  knownAdjustments: Array<string>;
  autoSync: boolean;
}

export enum BasicAdjustment {
  Blacks = 'blacks',
  Brightness = 'brightness',
  Contrast = 'contrast',
  Exposure = 'exposure',
  Highlights = 'highlights',
  Shadows = 'shadows',
  Whites = 'whites',
}

export enum ColorAdjustment {
  ColorGrading = 'colorGrading',
  Hsl = 'hsl',
  Hue = 'hue',
  Luminance = 'luminance',
  Saturation = 'saturation',
  Temperature = 'temperature',
  Tint = 'tint',
  Vibrance = 'vibrance',
  WhiteBalance = 'whiteBalance',
}

export enum ColorGrading {
  Balance = 'balance',
  Blending = 'blending',
  Global = 'global',
  Highlights = 'highlights',
  Midtones = 'midtones',
  Shadows = 'shadows',
}

export enum DenoiseMethod {
  Ai = 'ai',
  Bm3d = 'bm3d',
}

export const getAiDenoiseEnablePatch = (aiProvider?: string): Partial<Adjustments> => ({
  aiDenoiseEnabled: true,
  aiDenoiseMethod: aiProvider === 'ai-free' ? DenoiseMethod.Bm3d : DenoiseMethod.Ai,
});

export enum DetailsAdjustment {
  AiDenoiseAmount = 'aiDenoiseAmount',
  AiDenoiseDetail = 'aiDenoiseDetail',
  AiDenoiseEnabled = 'aiDenoiseEnabled',
  AiDenoiseMethod = 'aiDenoiseMethod',
  Clarity = 'clarity',
  Dehaze = 'dehaze',
  Structure = 'structure',
  Centré = 'centré',
  CentréX = 'centréX',
  CentréY = 'centréY',
  ColorNoiseReduction = 'colorNoiseReduction',
  LumaNoiseReduction = 'lumaNoiseReduction',
  NegativeBlueWeight = 'negativeBlueWeight',
  NegativeContrast = 'negativeContrast',
  NegativeConversionEnabled = 'negativeConversionEnabled',
  NegativeExposure = 'negativeExposure',
  NegativeGreenWeight = 'negativeGreenWeight',
  NegativeRedWeight = 'negativeRedWeight',
  Sharpness = 'sharpness',
  SharpnessThreshold = 'sharpnessThreshold',
  ChromaticAberrationRedCyan = 'chromaticAberrationRedCyan',
  ChromaticAberrationBlueYellow = 'chromaticAberrationBlueYellow',
}

export enum Effect {
  GrainAmount = 'grainAmount',
  GrainRoughness = 'grainRoughness',
  GrainSize = 'grainSize',
  LutData = 'lutData',
  LutIntensity = 'lutIntensity',
  LutName = 'lutName',
  LutPath = 'lutPath',
  LutSize = 'lutSize',
  LutIsSceneReferred = 'lutIsSceneReferred',
  VignetteAmount = 'vignetteAmount',
  VignetteCenterX = 'vignetteCenterX',
  VignetteCenterY = 'vignetteCenterY',
  VignetteFeather = 'vignetteFeather',
  VignetteMidpoint = 'vignetteMidpoint',
  VignetteRoundness = 'vignetteRoundness',
  LensBlurEnabled = 'lensBlurEnabled',
  LensBlurAmount = 'lensBlurAmount',
  lensBlurDiffusion = 'lensBlurDiffusion',
  LensBlurShape = 'lensBlurShape',
  LensBlurDepthMap = 'lensBlurDepthMap',
  LensBlurMinDepth = 'lensBlurMinDepth',
  LensBlurMaxDepth = 'lensBlurMaxDepth',
  LensBlurMinFade = 'lensBlurMinFade',
  LensBlurMaxFade = 'lensBlurMaxFade',
  RelightEnabled = 'relightEnabled',
  RelightNormalMap = 'relightNormalMap',
  RelightLights = 'relightLights',
  RelightAmbient = 'relightAmbient',
  RelightSoftness = 'relightSoftness',
  RelightShine = 'relightShine',
  RelightShadows = 'relightShadows',
  RelightShadowSoftness = 'relightShadowSoftness',
  FogEnabled = 'fogEnabled',
  FogDepthMap = 'fogDepthMap',
  FogAmount = 'fogAmount',
  FogStart = 'fogStart',
  FogDensity = 'fogDensity',
  FogHeight = 'fogHeight',
  FogVariation = 'fogVariation',
  FogGlow = 'fogGlow',
  FogTemperature = 'fogTemperature',
  FogTint = 'fogTint',
}

export interface RelightLight {
  id: string;
  type: 'point' | 'spot' | 'directional';
  x: number;
  y: number;
  depth: number;
  intensity: number;
  radius: number;
  angle: number;
  elevation: number;
  cone: number;
  feather: number;
  temperature: number;
  tint: number;
  color: string;
}

export const createRelightLight = (x: number, y: number): RelightLight => ({
  id: uuidv4(),
  type: 'point',
  x,
  y,
  depth: 0,
  intensity: 60,
  radius: 30,
  angle: 135,
  elevation: 60,
  cone: 40,
  feather: 50,
  temperature: 0,
  tint: 0,
  color: '#ffffff',
});

export const getRelightLightColor = (light: RelightLight): string => {
  const hex = parseInt((light.color || '#ffffff').slice(1), 16);
  const t = light.temperature / 100;
  const m = light.tint / 100;
  const rgb = [
    (((hex >> 16) & 255) / 255) * (1 + 0.45 * t + 0.15 * m),
    (((hex >> 8) & 255) / 255) * (1 - 0.35 * m),
    ((hex & 255) / 255) * (1 - 0.45 * t + 0.15 * m),
  ].map((c) => Math.max(0, c));
  const peak = Math.max(...rgb, 1e-3);
  return `rgb(${rgb.map((c) => Math.round((c / peak) * 255)).join(', ')})`;
};

export enum CreativeAdjustment {
  GlowAmount = 'glowAmount',
  HalationAmount = 'halationAmount',
  FlareAmount = 'flareAmount',
}

enum TransformAdjustment {
  TransformDistortion = 'transformDistortion',
  TransformVertical = 'transformVertical',
  TransformHorizontal = 'transformHorizontal',
  TransformRotate = 'transformRotate',
  TransformAspect = 'transformAspect',
  TransformScale = 'transformScale',
  TransformXOffset = 'transformXOffset',
  TransformYOffset = 'transformYOffset',
}

export enum LensAdjustment {
  LensCorrectionMode = 'lensCorrectionMode',
  LensMaker = 'lensMaker',
  LensModel = 'lensModel',
  LensDistortionAmount = 'lensDistortionAmount',
  LensVignetteAmount = 'lensVignetteAmount',
  LensTcaAmount = 'lensTcaAmount',
  LensDistortionEnabled = 'lensDistortionEnabled',
  LensTcaEnabled = 'lensTcaEnabled',
  LensVignetteEnabled = 'lensVignetteEnabled',
}

export type GuideOrientation = 'vertical' | 'horizontal';

export interface GuideLine {
  id: string;
  type: GuideOrientation;
  p1: Coord;
  p2: Coord;
}

export interface GuidedPerspective {
  enabled: boolean;
  lines: GuideLine[];
  autoCrop: boolean;
}

export interface ColorCalibration {
  shadowsTint: number;
  redHue: number;
  redSaturation: number;
  greenHue: number;
  greenSaturation: number;
  blueHue: number;
  blueSaturation: number;
}

export interface ParametricCurveSettings {
  darks: number;
  shadows: number;
  highlights: number;
  lights: number;
  whiteLevel: number;
  blackLevel: number;
  split1: number;
  split2: number;
  split3: number;
}

export interface ParametricCurve {
  [index: string]: ParametricCurveSettings;
  blue: ParametricCurveSettings;
  green: ParametricCurveSettings;
  luma: ParametricCurveSettings;
  red: ParametricCurveSettings;
}

export interface Adjustments {
  activeTools: ActiveTools;
  [index: string]: any;
  aiDenoiseAmount: number;
  aiDenoiseDetail: number;
  aiDenoiseEnabled: boolean;
  aiDenoiseMethod: DenoiseMethod;
  aiPatches: Array<AiPatch>;
  aspectRatio: number | null;
  baselineExposure: boolean;
  blacks: number;
  brightness: number;
  centré: number;
  centréX: number;
  centréY: number;
  clarity: number;
  chromaticAberrationBlueYellow: number;
  chromaticAberrationRedCyan: number;
  colorCalibration: ColorCalibration;
  colorGrading: ColorGradingProps;
  colorNoiseReduction: number;
  contrast: number;
  curves: Curves;
  pointCurves?: Curves;
  parametricCurve?: ParametricCurve;
  curveMode?: 'point' | 'parametric';
  crop: Crop | null;
  dehaze: number;
  exposure: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  flareAmount: number;
  glowAmount: number;
  grainAmount: number;
  grainRoughness: number;
  grainSize: number;
  guidedPerspective: GuidedPerspective;
  halationAmount: number;
  highlights: number;
  hsl: Hsl;
  hue: number;
  lensBlurAmount: number;
  lensBlurDiffusion: number;
  lensBlurShape: 'circle' | 'hexagon' | 'octagon' | 'ring';
  lensBlurDepthMap: string | null;
  lensBlurEnabled: boolean;
  lensBlurMaxDepth: number;
  lensBlurMaxFade: number;
  lensBlurMinDepth: number;
  lensBlurMinFade: number;
  relightEnabled: boolean;
  relightNormalMap: string | null;
  relightLights: Array<RelightLight>;
  relightAmbient: number;
  relightSoftness: number;
  relightShine: number;
  relightShadows: boolean;
  relightShadowSoftness: number;
  fogEnabled: boolean;
  fogDepthMap: string | null;
  fogAmount: number;
  fogStart: number;
  fogDensity: number;
  fogHeight: number;
  fogVariation: number;
  fogGlow: number;
  fogTemperature: number;
  fogTint: number;
  lensCorrectionMode: 'auto' | 'manual';
  lensDistortionAmount: number;
  lensVignetteAmount: number;
  lensTcaAmount: number;
  lensDistortionEnabled: boolean;
  lensTcaEnabled: boolean;
  lensVignetteEnabled: boolean;
  lensDistortionParams: {
    k1: number;
    k2: number;
    k3: number;
    model: number;
    tca_vr: number;
    tca_vb: number;
    vig_k1: number;
    vig_k2: number;
    vig_k3: number;
  } | null;
  lensMaker: string | null;
  lensModel: string | null;
  lumaNoiseReduction: number;
  lutData?: string | null;
  lutIntensity?: number;
  lutName?: string | null;
  lutPath?: string | null;
  lutSize?: number;
  lutIsSceneReferred?: boolean;
  masks: Array<MaskContainer>;
  monochromeEnabled: boolean;
  monochromeFilm: MonochromeFilm;
  monochromeFilterHue: number;
  monochromeFilterStrength: number;
  monochromeMix: MonochromeMix;
  monochromeToning: MonochromeToning;
  negativeBlueWeight: number;
  negativeContrast: number;
  negativeConversionEnabled: boolean;
  negativeExposure: number;
  negativeGreenWeight: number;
  negativeRedWeight: number;
  orientationSteps: number;
  rotation: number;
  saturation: number;
  shadows: number;
  sharpness: number;
  sharpnessThreshold: number;
  showClipping: boolean;
  structure: number;
  temperature: number;
  tint: number;
  toneMapper: 'agx' | 'basic';
  transformDistortion: number;
  transformVertical: number;
  transformHorizontal: number;
  transformRotate: number;
  transformAspect: number;
  transformScale: number;
  transformXOffset: number;
  transformYOffset: number;
  vibrance: number;
  vignetteAmount: number;
  vignetteCenterX: number;
  vignetteCenterY: number;
  vignetteFeather: number;
  vignetteMidpoint: number;
  vignetteRoundness: number;
  whiteBalance: WhiteBalance | null;
  whites: number;
}

export interface AiPatch {
  id: string;
  isLoading: boolean;
  invert: boolean;
  name: string;
  patchData: any | null;
  prompt: string;
  subMasks: Array<SubMask>;
  visible: boolean;
}

export interface Color {
  color: string;
  name: string;
}

interface ColorGradingProps {
  [index: string]: number | HueSatLum;
  balance: number;
  blending: number;
  global: HueSatLum;
  highlights: HueSatLum;
  midtones: HueSatLum;
  shadows: HueSatLum;
}

export interface Coord {
  x: number;
  y: number;
}

export interface Curves {
  [index: string]: Array<Coord>;
  blue: Array<Coord>;
  green: Array<Coord>;
  luma: Array<Coord>;
  red: Array<Coord>;
}

export interface HueSatLum {
  hue: number;
  saturation: number;
  luminance: number;
}

interface Hsl {
  [index: string]: HueSatLum;
  aquas: HueSatLum;
  blues: HueSatLum;
  greens: HueSatLum;
  magentas: HueSatLum;
  oranges: HueSatLum;
  purples: HueSatLum;
  reds: HueSatLum;
  yellows: HueSatLum;
}

export enum MonochromeFilm {
  Neutral = 'neutral',
  Panchromatic = 'panchromatic',
  Balanced = 'balanced',
  OrthoPanchromatic = 'orthoPanchromatic',
  ExtendedRed = 'extendedRed',
  Orthochromatic = 'orthochromatic',
  Infrared = 'infrared',
}

export interface MonochromeMix {
  [index: string]: number;
  aquas: number;
  blues: number;
  greens: number;
  magentas: number;
  oranges: number;
  purples: number;
  reds: number;
  yellows: number;
}

export interface MonochromeToning {
  balance: number;
  highlightHue: number;
  highlightSaturation: number;
  shadowHue: number;
  shadowSaturation: number;
}

export interface MaskAdjustments {
  activeTools: ActiveTools;
  [index: string]: any;
  blacks: number;
  brightness: number;
  clarity: number;
  colorGrading: ColorGradingProps;
  colorNoiseReduction: number;
  contrast: number;
  curves: Curves;
  pointCurves?: Curves;
  parametricCurve?: ParametricCurve;
  curveMode?: 'point' | 'parametric';
  dehaze: number;
  exposure: number;
  flareAmount: number;
  glowAmount: number;
  halationAmount: number;
  highlights: number;
  hsl: Hsl;
  hue: number;
  id?: string;
  lumaNoiseReduction: number;
  saturation: number;
  shadows: number;
  sharpness: number;
  sharpnessThreshold: number;
  structure: number;
  temperature: number;
  tint: number;
  vibrance: number;
  whites: number;
}

export interface MaskContainer {
  adjustments: MaskAdjustments;
  id?: any;
  invert: boolean;
  name: string;
  opacity: number;
  subMasks: Array<SubMask>;
  visible: boolean;
}

export interface Sections {
  [index: string]: Array<string>;
  basic: Array<string>;
  curves: Array<string>;
  color: Array<string>;
  details: Array<string>;
  effects: Array<string>;
}

export type ActiveTools = Record<string, boolean>;

export const COLOR_LABELS: Array<Color> = [
  { name: 'red', color: '#ef4444' },
  { name: 'yellow', color: '#facc15' },
  { name: 'green', color: '#4ade80' },
  { name: 'blue', color: '#60a5fa' },
  { name: 'purple', color: '#a78bfa' },
];

const INITIAL_COLOR_GRADING: ColorGradingProps = {
  balance: 0,
  blending: 50,
  global: { hue: 0, saturation: 0, luminance: 0 },
  highlights: { hue: 0, saturation: 0, luminance: 0 },
  midtones: { hue: 0, saturation: 0, luminance: 0 },
  shadows: { hue: 0, saturation: 0, luminance: 0 },
};

export const DEFAULT_PARAMETRIC_CURVE_SETTINGS: ParametricCurveSettings = {
  darks: 0,
  shadows: 0,
  highlights: 0,
  lights: 0,
  whiteLevel: 0,
  blackLevel: 0,
  split1: 25,
  split2: 50,
  split3: 75,
};

const getDefaultParametricCurve = (): ParametricCurve => ({
  luma: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
  red: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
  green: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
  blue: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS },
});

export const getDefaultCurves = (): Curves => ({
  blue: [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
  green: [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
  luma: [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
  red: [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
});

export const DEFAULT_PARAMETRIC_CURVE = getDefaultParametricCurve();

export const INITIAL_MASK_ADJUSTMENTS: MaskAdjustments = {
  activeTools: {},
  blacks: 0,
  brightness: 0,
  clarity: 0,
  colorGrading: { ...INITIAL_COLOR_GRADING },
  colorNoiseReduction: 0,
  contrast: 0,
  curves: getDefaultCurves(),
  pointCurves: getDefaultCurves(),
  parametricCurve: getDefaultParametricCurve(),
  curveMode: 'point',
  dehaze: 0,
  exposure: 0,
  flareAmount: 0,
  glowAmount: 0,
  halationAmount: 0,
  highlights: 0,
  hsl: {
    aquas: { hue: 0, saturation: 0, luminance: 0 },
    blues: { hue: 0, saturation: 0, luminance: 0 },
    greens: { hue: 0, saturation: 0, luminance: 0 },
    magentas: { hue: 0, saturation: 0, luminance: 0 },
    oranges: { hue: 0, saturation: 0, luminance: 0 },
    purples: { hue: 0, saturation: 0, luminance: 0 },
    reds: { hue: 0, saturation: 0, luminance: 0 },
    yellows: { hue: 0, saturation: 0, luminance: 0 },
  },
  hue: 0,
  lumaNoiseReduction: 0,
  saturation: 0,
  shadows: 0,
  sharpness: 0,
  sharpnessThreshold: 15,
  structure: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  whites: 0,
};

export const INITIAL_MASK_CONTAINER: MaskContainer = {
  adjustments: INITIAL_MASK_ADJUSTMENTS,
  invert: false,
  name: 'New Mask',
  opacity: 100,
  subMasks: [],
  visible: true,
};

// Adjustments has an index signature, so keyof alone would accept any object.
type DeclaredKeys<T> = keyof { [K in keyof T as string extends K ? never : K]: T[K] };

export const INITIAL_ADJUSTMENTS: Adjustments = defaultAdjustments satisfies Record<
  DeclaredKeys<Adjustments>,
  unknown
> as unknown as Adjustments;

const deepCloneCurves = (curves: any): Curves => ({
  blue: curves?.blue?.map((p: Coord) => ({ ...p })) || [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
  green: curves?.green?.map((p: Coord) => ({ ...p })) || [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
  luma: curves?.luma?.map((p: Coord) => ({ ...p })) || [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
  red: curves?.red?.map((p: Coord) => ({ ...p })) || [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ],
});

const deepCloneParametric = (pCurve: any): ParametricCurve => ({
  luma: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS, ...(pCurve?.luma || {}) },
  red: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS, ...(pCurve?.red || {}) },
  green: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS, ...(pCurve?.green || {}) },
  blue: { ...DEFAULT_PARAMETRIC_CURVE_SETTINGS, ...(pCurve?.blue || {}) },
});

export const normalizeLoadedAdjustments = (loadedAdjustments: Adjustments): any => {
  if (!loadedAdjustments) {
    return INITIAL_ADJUSTMENTS;
  }

  const normalizeSubMasks = (subMasks: any[]) => {
    return (subMasks || []).map((subMask: Partial<SubMask>) => ({
      visible: true,
      mode: SubMaskMode.Additive,
      invert: false,
      opacity: 100,
      ...subMask,
    }));
  };

  const normalizedMasks = (loadedAdjustments.masks || []).map((maskContainer: MaskContainer) => {
    const containerAdjustments = maskContainer.adjustments || {};
    const normalizedSubMasks = normalizeSubMasks(maskContainer.subMasks);

    return {
      ...INITIAL_MASK_CONTAINER,
      id: maskContainer.id || uuidv4(),
      ...maskContainer,
      adjustments: {
        ...INITIAL_MASK_ADJUSTMENTS,
        ...containerAdjustments,
        flareAmount: containerAdjustments.flareAmount ?? INITIAL_MASK_ADJUSTMENTS.flareAmount,
        glowAmount: containerAdjustments.glowAmount ?? INITIAL_MASK_ADJUSTMENTS.glowAmount,
        halationAmount: containerAdjustments.halationAmount ?? INITIAL_MASK_ADJUSTMENTS.halationAmount,
        hue: containerAdjustments.hue ?? INITIAL_MASK_ADJUSTMENTS.hue,
        colorGrading: { ...INITIAL_MASK_ADJUSTMENTS.colorGrading, ...(containerAdjustments.colorGrading || {}) },
        hsl: { ...INITIAL_MASK_ADJUSTMENTS.hsl, ...(containerAdjustments.hsl || {}) },
        curves: containerAdjustments.curves ? deepCloneCurves(containerAdjustments.curves) : getDefaultCurves(),
        pointCurves: containerAdjustments.pointCurves
          ? deepCloneCurves(containerAdjustments.pointCurves)
          : getDefaultCurves(),
        parametricCurve: containerAdjustments.parametricCurve
          ? deepCloneParametric(containerAdjustments.parametricCurve)
          : getDefaultParametricCurve(),
        curveMode: containerAdjustments.curveMode || INITIAL_MASK_ADJUSTMENTS.curveMode,
        activeTools: getActiveTools(containerAdjustments),
        sectionVisibility: undefined,
        sharpnessThreshold: containerAdjustments.sharpnessThreshold ?? INITIAL_MASK_ADJUSTMENTS.sharpnessThreshold,
      },
      subMasks: normalizedSubMasks,
    };
  });

  const normalizedAiPatches = (loadedAdjustments.aiPatches || []).map((patch: any) => ({
    visible: true,
    ...patch,
    subMasks: normalizeSubMasks(patch.subMasks),
  }));

  return {
    ...INITIAL_ADJUSTMENTS,
    ...loadedAdjustments,
    guidedPerspective: {
      enabled: loadedAdjustments.guidedPerspective?.enabled ?? false,
      lines: (() => {
        const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
        const raw = (loadedAdjustments.guidedPerspective?.lines || []).map((l: any) => ({
          id: l.id || uuidv4(),
          type: (l.type === 'horizontal' ? 'horizontal' : 'vertical') as 'vertical' | 'horizontal',
          p1: { x: clamp01(l.p1?.x ?? 0), y: clamp01(l.p1?.y ?? 0) },
          p2: { x: clamp01(l.p2?.x ?? 1), y: clamp01(l.p2?.y ?? 1) },
        }));
        const verts = raw.filter((l) => l.type === 'vertical').slice(0, 2);
        const hors = raw.filter((l) => l.type === 'horizontal').slice(0, 2);
        return [...verts, ...hors];
      })(),
      autoCrop: loadedAdjustments.guidedPerspective?.autoCrop ?? true,
    },
    baselineExposure: loadedAdjustments.baselineExposure ?? false,
    lutIsSceneReferred: loadedAdjustments.lutIsSceneReferred ?? false,
    flareAmount: loadedAdjustments.flareAmount ?? INITIAL_ADJUSTMENTS.flareAmount,
    glowAmount: loadedAdjustments.glowAmount ?? INITIAL_ADJUSTMENTS.glowAmount,
    halationAmount: loadedAdjustments.halationAmount ?? INITIAL_ADJUSTMENTS.halationAmount,
    lensBlurAmount: loadedAdjustments.lensBlurAmount ?? INITIAL_ADJUSTMENTS.lensBlurAmount,
    lensBlurDiffusion: loadedAdjustments.lensBlurDiffusion ?? INITIAL_ADJUSTMENTS.lensBlurDiffusion,
    lensBlurShape: loadedAdjustments.lensBlurShape ?? INITIAL_ADJUSTMENTS.lensBlurShape,
    lensBlurDepthMap: loadedAdjustments.lensBlurDepthMap ?? INITIAL_ADJUSTMENTS.lensBlurDepthMap,
    lensBlurEnabled: loadedAdjustments.lensBlurEnabled ?? INITIAL_ADJUSTMENTS.lensBlurEnabled,
    lensBlurMaxDepth: loadedAdjustments.lensBlurMaxDepth ?? INITIAL_ADJUSTMENTS.lensBlurMaxDepth,
    lensBlurMaxFade: loadedAdjustments.lensBlurMaxFade ?? INITIAL_ADJUSTMENTS.lensBlurMaxFade,
    lensBlurMinDepth: loadedAdjustments.lensBlurMinDepth ?? INITIAL_ADJUSTMENTS.lensBlurMinDepth,
    lensBlurMinFade: loadedAdjustments.lensBlurMinFade ?? INITIAL_ADJUSTMENTS.lensBlurMinFade,
    relightEnabled: loadedAdjustments.relightEnabled ?? INITIAL_ADJUSTMENTS.relightEnabled,
    relightNormalMap: loadedAdjustments.relightNormalMap ?? INITIAL_ADJUSTMENTS.relightNormalMap,
    relightLights: (loadedAdjustments.relightLights ?? INITIAL_ADJUSTMENTS.relightLights).map(
      (light: RelightLight) => ({ ...createRelightLight(light.x, light.y), ...light }),
    ),
    relightAmbient: loadedAdjustments.relightAmbient ?? INITIAL_ADJUSTMENTS.relightAmbient,
    relightSoftness: loadedAdjustments.relightSoftness ?? INITIAL_ADJUSTMENTS.relightSoftness,
    relightShine: loadedAdjustments.relightShine ?? INITIAL_ADJUSTMENTS.relightShine,
    relightShadows: loadedAdjustments.relightShadows ?? INITIAL_ADJUSTMENTS.relightShadows,
    relightShadowSoftness: loadedAdjustments.relightShadowSoftness ?? INITIAL_ADJUSTMENTS.relightShadowSoftness,
    fogEnabled: loadedAdjustments.fogEnabled ?? INITIAL_ADJUSTMENTS.fogEnabled,
    fogDepthMap: loadedAdjustments.fogDepthMap ?? INITIAL_ADJUSTMENTS.fogDepthMap,
    fogAmount: loadedAdjustments.fogAmount ?? INITIAL_ADJUSTMENTS.fogAmount,
    fogStart: loadedAdjustments.fogStart ?? INITIAL_ADJUSTMENTS.fogStart,
    fogDensity: loadedAdjustments.fogDensity ?? INITIAL_ADJUSTMENTS.fogDensity,
    fogHeight: loadedAdjustments.fogHeight ?? INITIAL_ADJUSTMENTS.fogHeight,
    fogVariation: loadedAdjustments.fogVariation ?? INITIAL_ADJUSTMENTS.fogVariation,
    fogGlow: loadedAdjustments.fogGlow ?? INITIAL_ADJUSTMENTS.fogGlow,
    fogTemperature: loadedAdjustments.fogTemperature ?? INITIAL_ADJUSTMENTS.fogTemperature,
    fogTint: loadedAdjustments.fogTint ?? INITIAL_ADJUSTMENTS.fogTint,
    lensCorrectionMode: loadedAdjustments.lensCorrectionMode || 'manual',
    lensMaker: loadedAdjustments.lensMaker ?? INITIAL_ADJUSTMENTS.lensMaker,
    lensModel: loadedAdjustments.lensModel ?? INITIAL_ADJUSTMENTS.lensModel,
    lensDistortionAmount: loadedAdjustments.lensDistortionAmount ?? INITIAL_ADJUSTMENTS.lensDistortionAmount,
    lensVignetteAmount: loadedAdjustments.lensVignetteAmount ?? INITIAL_ADJUSTMENTS.lensVignetteAmount,
    lensTcaAmount: loadedAdjustments.lensTcaAmount ?? INITIAL_ADJUSTMENTS.lensTcaAmount,
    lensDistortionEnabled: loadedAdjustments.lensDistortionEnabled ?? INITIAL_ADJUSTMENTS.lensDistortionEnabled,
    lensTcaEnabled: loadedAdjustments.lensTcaEnabled ?? INITIAL_ADJUSTMENTS.lensTcaEnabled,
    lensVignetteEnabled: loadedAdjustments.lensVignetteEnabled ?? INITIAL_ADJUSTMENTS.lensVignetteEnabled,
    lensDistortionParams: loadedAdjustments.lensDistortionParams ?? INITIAL_ADJUSTMENTS.lensDistortionParams,
    transformDistortion: loadedAdjustments.transformDistortion ?? INITIAL_ADJUSTMENTS.transformDistortion,
    transformVertical: loadedAdjustments.transformVertical ?? INITIAL_ADJUSTMENTS.transformVertical,
    transformHorizontal: loadedAdjustments.transformHorizontal ?? INITIAL_ADJUSTMENTS.transformHorizontal,
    transformRotate: loadedAdjustments.transformRotate ?? INITIAL_ADJUSTMENTS.transformRotate,
    transformAspect: loadedAdjustments.transformAspect ?? INITIAL_ADJUSTMENTS.transformAspect,
    transformScale: loadedAdjustments.transformScale ?? INITIAL_ADJUSTMENTS.transformScale,
    transformXOffset: loadedAdjustments.transformXOffset ?? INITIAL_ADJUSTMENTS.transformXOffset,
    transformYOffset: loadedAdjustments.transformYOffset ?? INITIAL_ADJUSTMENTS.transformYOffset,
    colorCalibration: { ...INITIAL_ADJUSTMENTS.colorCalibration, ...(loadedAdjustments.colorCalibration || {}) },
    colorGrading: { ...INITIAL_ADJUSTMENTS.colorGrading, ...(loadedAdjustments.colorGrading || {}) },
    hsl: { ...INITIAL_ADJUSTMENTS.hsl, ...(loadedAdjustments.hsl || {}) },
    monochromeMix: { ...INITIAL_ADJUSTMENTS.monochromeMix, ...(loadedAdjustments.monochromeMix || {}) },
    monochromeToning: { ...INITIAL_ADJUSTMENTS.monochromeToning, ...(loadedAdjustments.monochromeToning || {}) },
    curves: loadedAdjustments.curves ? deepCloneCurves(loadedAdjustments.curves) : getDefaultCurves(),
    pointCurves: loadedAdjustments.pointCurves ? deepCloneCurves(loadedAdjustments.pointCurves) : getDefaultCurves(),
    parametricCurve: loadedAdjustments.parametricCurve
      ? deepCloneParametric(loadedAdjustments.parametricCurve)
      : getDefaultParametricCurve(),
    curveMode: loadedAdjustments.curveMode || INITIAL_ADJUSTMENTS.curveMode,
    masks: normalizedMasks,
    aiPatches: normalizedAiPatches,
    activeTools: getActiveTools(loadedAdjustments),
    sectionVisibility: undefined,
    sharpnessThreshold: loadedAdjustments.sharpnessThreshold ?? INITIAL_ADJUSTMENTS.sharpnessThreshold,
  };
};

export const MONOCHROME_ADJUSTMENT_KEYS = [
  'monochromeEnabled',
  'monochromeFilm',
  'monochromeFilterHue',
  'monochromeFilterStrength',
  'monochromeMix',
  'monochromeToning',
] as const;

export interface AdjustmentGroup {
  label: string;
  keys: string[];
}

export const ADJUSTMENT_GROUPS: Record<string, AdjustmentGroup[]> = {
  basic: [
    { label: 'adjustments.basic.toneMapper', keys: ['toneMapper'] },
    { label: 'adjustments.basic.exposure', keys: [BasicAdjustment.Exposure] },
    { label: 'adjustments.basic.contrast', keys: [BasicAdjustment.Contrast] },
    { label: 'adjustments.basic.highlights', keys: [BasicAdjustment.Highlights] },
    { label: 'adjustments.basic.shadows', keys: [BasicAdjustment.Shadows] },
    { label: 'adjustments.basic.whites', keys: [BasicAdjustment.Whites] },
    { label: 'adjustments.basic.blacks', keys: [BasicAdjustment.Blacks] },
    { label: 'adjustments.basic.brightness', keys: [BasicAdjustment.Brightness] },
    {
      label: 'modals.copyPaste.groups.curves',
      keys: ['curves', 'pointCurves', 'parametricCurve', 'curveMode'],
    },
  ],
  color: [
    {
      label: 'modals.copyPaste.groups.whiteBalance',
      keys: [ColorAdjustment.Temperature, ColorAdjustment.Tint, ColorAdjustment.WhiteBalance],
    },
    { label: 'modals.copyPaste.groups.presence', keys: [ColorAdjustment.Saturation, ColorAdjustment.Vibrance] },
    {
      label: 'modals.copyPaste.groups.hueShift',
      keys: [ColorAdjustment.Hue],
    },
    { label: 'modals.copyPaste.groups.colorGrading', keys: [ColorAdjustment.ColorGrading] },
    { label: 'modals.copyPaste.groups.colorMixer', keys: [ColorAdjustment.Hsl] },
    { label: 'modals.copyPaste.groups.colorCalibration', keys: ['colorCalibration'] },
    {
      label: 'modals.copyPaste.groups.blackWhite',
      keys: [...MONOCHROME_ADJUSTMENT_KEYS],
    },
  ],
  details: [
    {
      label: 'modals.copyPaste.groups.clarityDehaze',
      keys: [
        DetailsAdjustment.Clarity,
        DetailsAdjustment.Structure,
        DetailsAdjustment.Dehaze,
        DetailsAdjustment.Centré,
        DetailsAdjustment.CentréX,
        DetailsAdjustment.CentréY,
      ],
    },
    {
      label: 'modals.copyPaste.groups.sharpness',
      keys: [DetailsAdjustment.Sharpness, DetailsAdjustment.SharpnessThreshold],
    },
    {
      label: 'modals.copyPaste.groups.noiseReduction',
      keys: [DetailsAdjustment.LumaNoiseReduction, DetailsAdjustment.ColorNoiseReduction],
    },
    {
      label: 'modals.copyPaste.groups.aiDenoise',
      keys: [
        DetailsAdjustment.AiDenoiseEnabled,
        DetailsAdjustment.AiDenoiseMethod,
        DetailsAdjustment.AiDenoiseAmount,
        DetailsAdjustment.AiDenoiseDetail,
      ],
    },
    {
      label: 'modals.copyPaste.groups.chromaticAberration',
      keys: [DetailsAdjustment.ChromaticAberrationRedCyan, DetailsAdjustment.ChromaticAberrationBlueYellow],
    },
    {
      label: 'modals.copyPaste.groups.negativeConversion',
      keys: [
        DetailsAdjustment.NegativeConversionEnabled,
        DetailsAdjustment.NegativeRedWeight,
        DetailsAdjustment.NegativeGreenWeight,
        DetailsAdjustment.NegativeBlueWeight,
        DetailsAdjustment.NegativeExposure,
        DetailsAdjustment.NegativeContrast,
      ],
    },
  ],
  effects: [
    {
      label: 'modals.copyPaste.groups.vignette',
      keys: [
        Effect.VignetteAmount,
        Effect.VignetteFeather,
        Effect.VignetteMidpoint,
        Effect.VignetteRoundness,
        Effect.VignetteCenterX,
        Effect.VignetteCenterY,
      ],
    },
    { label: 'modals.copyPaste.groups.grain', keys: [Effect.GrainAmount, Effect.GrainRoughness, Effect.GrainSize] },
    {
      label: 'modals.copyPaste.groups.halationGlow',
      keys: [CreativeAdjustment.GlowAmount, CreativeAdjustment.HalationAmount, CreativeAdjustment.FlareAmount],
    },
    {
      label: 'modals.copyPaste.groups.lut',
      keys: [
        Effect.LutIntensity,
        Effect.LutName,
        Effect.LutPath,
        Effect.LutSize,
        Effect.LutData,
        Effect.LutIsSceneReferred,
      ],
    },
    {
      label: 'modals.copyPaste.groups.lensBlur',
      keys: [
        Effect.LensBlurEnabled,
        Effect.LensBlurAmount,
        Effect.lensBlurDiffusion,
        Effect.LensBlurShape,
        Effect.LensBlurMinDepth,
        Effect.LensBlurMaxDepth,
        Effect.LensBlurMinFade,
        Effect.LensBlurMaxFade,
      ],
    },
    {
      label: 'modals.copyPaste.groups.fog',
      keys: [
        Effect.FogEnabled,
        Effect.FogAmount,
        Effect.FogStart,
        Effect.FogDensity,
        Effect.FogHeight,
        Effect.FogVariation,
        Effect.FogGlow,
        Effect.FogTemperature,
        Effect.FogTint,
      ],
    },
    {
      label: 'modals.copyPaste.groups.relight',
      keys: [
        Effect.RelightEnabled,
        Effect.RelightLights,
        Effect.RelightAmbient,
        Effect.RelightSoftness,
        Effect.RelightShine,
        Effect.RelightShadows,
        Effect.RelightShadowSoftness,
      ],
    },
  ],
  geometry: [
    { label: 'modals.copyPaste.groups.cropAspectRatio', keys: ['crop', 'aspectRatio'] },
    {
      label: 'modals.copyPaste.groups.transformRotation',
      keys: [
        'rotation',
        'flipHorizontal',
        'flipVertical',
        'orientationSteps',
        TransformAdjustment.TransformDistortion,
        TransformAdjustment.TransformVertical,
        TransformAdjustment.TransformHorizontal,
        TransformAdjustment.TransformRotate,
        TransformAdjustment.TransformAspect,
        TransformAdjustment.TransformScale,
        TransformAdjustment.TransformXOffset,
        TransformAdjustment.TransformYOffset,
      ],
    },
    {
      label: 'modals.copyPaste.groups.lensCorrection',
      keys: [
        LensAdjustment.LensCorrectionMode,
        LensAdjustment.LensMaker,
        LensAdjustment.LensModel,
        LensAdjustment.LensDistortionAmount,
        LensAdjustment.LensVignetteAmount,
        LensAdjustment.LensTcaAmount,
        LensAdjustment.LensDistortionEnabled,
        LensAdjustment.LensTcaEnabled,
        LensAdjustment.LensVignetteEnabled,
      ],
    },
    {
      label: 'modals.copyPaste.groups.guidedPerspective',
      keys: ['guidedPerspective'],
    },
  ],
  masks: [{ label: 'modals.copyPaste.groups.masks', keys: ['masks'] }],
};

export const COPYABLE_ADJUSTMENT_KEYS: string[] = Object.values(ADJUSTMENT_GROUPS)
  .flat()
  .flatMap((group) => group.keys);

export const ADJUSTMENT_SECTIONS: Sections = {
  basic: [
    BasicAdjustment.Brightness,
    BasicAdjustment.Contrast,
    BasicAdjustment.Highlights,
    BasicAdjustment.Shadows,
    BasicAdjustment.Whites,
    BasicAdjustment.Blacks,
    BasicAdjustment.Exposure,
    'toneMapper',
  ],
  curves: ['curves', 'pointCurves', 'parametricCurve', 'curveMode'],
  color: [
    ColorAdjustment.Saturation,
    ColorAdjustment.Temperature,
    ColorAdjustment.Tint,
    ColorAdjustment.WhiteBalance,
    ColorAdjustment.Vibrance,
    ColorAdjustment.Hsl,
    ColorAdjustment.ColorGrading,
    'colorCalibration',
    ColorAdjustment.Hue,
    ...MONOCHROME_ADJUSTMENT_KEYS,
  ],
  details: [
    DetailsAdjustment.Clarity,
    DetailsAdjustment.Dehaze,
    DetailsAdjustment.Structure,
    DetailsAdjustment.Centré,
    DetailsAdjustment.CentréX,
    DetailsAdjustment.CentréY,
    DetailsAdjustment.Sharpness,
    DetailsAdjustment.SharpnessThreshold,
    DetailsAdjustment.LumaNoiseReduction,
    DetailsAdjustment.ColorNoiseReduction,
    DetailsAdjustment.AiDenoiseEnabled,
    DetailsAdjustment.AiDenoiseMethod,
    DetailsAdjustment.AiDenoiseAmount,
    DetailsAdjustment.AiDenoiseDetail,
    DetailsAdjustment.ChromaticAberrationRedCyan,
    DetailsAdjustment.ChromaticAberrationBlueYellow,
    DetailsAdjustment.NegativeConversionEnabled,
    DetailsAdjustment.NegativeRedWeight,
    DetailsAdjustment.NegativeGreenWeight,
    DetailsAdjustment.NegativeBlueWeight,
    DetailsAdjustment.NegativeExposure,
    DetailsAdjustment.NegativeContrast,
  ],
  effects: [
    CreativeAdjustment.GlowAmount,
    CreativeAdjustment.HalationAmount,
    CreativeAdjustment.FlareAmount,
    Effect.GrainAmount,
    Effect.GrainRoughness,
    Effect.GrainSize,
    Effect.LutIntensity,
    Effect.LutName,
    Effect.LutPath,
    Effect.LutSize,
    Effect.LutIsSceneReferred,
    Effect.VignetteAmount,
    Effect.VignetteFeather,
    Effect.VignetteMidpoint,
    Effect.VignetteRoundness,
    Effect.VignetteCenterX,
    Effect.VignetteCenterY,
    Effect.LensBlurEnabled,
    Effect.LensBlurAmount,
    Effect.lensBlurDiffusion,
    Effect.LensBlurShape,
    Effect.LensBlurDepthMap,
    Effect.LensBlurMinDepth,
    Effect.LensBlurMaxDepth,
    Effect.LensBlurMinFade,
    Effect.LensBlurMaxFade,
    Effect.RelightEnabled,
    Effect.RelightNormalMap,
    Effect.RelightLights,
    Effect.RelightAmbient,
    Effect.RelightSoftness,
    Effect.RelightShine,
    Effect.RelightShadows,
    Effect.RelightShadowSoftness,
    Effect.FogEnabled,
    Effect.FogDepthMap,
    Effect.FogAmount,
    Effect.FogStart,
    Effect.FogDensity,
    Effect.FogHeight,
    Effect.FogVariation,
    Effect.FogGlow,
    Effect.FogTemperature,
    Effect.FogTint,
  ],
};

const SECTION_KEY_OWNERS: Record<string, string> = Object.fromEntries(
  Object.entries(ADJUSTMENT_SECTIONS).flatMap(([section, keys]) => keys.map((key) => [key, section])),
);

export const areSectionPropsEqual =
  (section: string) =>
  (prev: Record<string, unknown>, next: Record<string, unknown>): boolean => {
    const propKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const key of propKeys) {
      if (key !== 'adjustments' && !Object.is(prev[key], next[key])) return false;
    }

    const prevAdjustments = prev.adjustments as Record<string, unknown> | undefined;
    const nextAdjustments = next.adjustments as Record<string, unknown> | undefined;
    if (prevAdjustments === nextAdjustments) return true;
    if (!prevAdjustments || !nextAdjustments) return false;

    const adjustmentKeys = new Set([...Object.keys(prevAdjustments), ...Object.keys(nextAdjustments)]);
    for (const key of adjustmentKeys) {
      if (Object.is(prevAdjustments[key], nextAdjustments[key])) continue;
      const owner = SECTION_KEY_OWNERS[key];
      if (owner === undefined || owner === section) return false;
    }
    return true;
  };

const CANVAS_ADJUSTMENT_KEYS = new Set([
  'vignetteCenterX',
  'vignetteCenterY',
  'vignetteMidpoint',
  'vignetteRoundness',
  'centréX',
  'centréY',
  'relightLights',
]);

const TONAL_ADJUSTMENT_KEYS = new Set(
  Object.keys(SECTION_KEY_OWNERS).filter((key) => !CANVAS_ADJUSTMENT_KEYS.has(key)),
);

export const omitTonalAdjustments = (adjustments: Adjustments): Adjustments => {
  const result: Record<string, unknown> = {};
  for (const key in adjustments) {
    if (!TONAL_ADJUSTMENT_KEYS.has(key)) {
      result[key] = (adjustments as unknown as Record<string, unknown>)[key];
    }
  }
  return result as unknown as Adjustments;
};

const reconcileOrder = (defaultOrder: string[], order: string[] = []): string[] => {
  const savedOrder = order.filter((id, index) => defaultOrder.includes(id) && order.indexOf(id) === index);
  return [...savedOrder, ...defaultOrder.filter((id) => !savedOrder.includes(id))];
};

export const getAdjustmentSectionOrder = (order?: string[]): string[] =>
  reconcileOrder(Object.keys(ADJUSTMENT_SECTIONS), order);

export const getVisibleAdjustmentSections = (layout?: AdjustmentLayout): string[] =>
  getAdjustmentSectionOrder(layout?.sectionOrder).filter((section) => !layout?.hiddenSections?.includes(section));

export const DEFAULT_HIDDEN_ADJUSTMENT_TOOLS = ['chromaticAberration', 'colorCalibration'];

export const getHiddenAdjustmentTools = (layout?: AdjustmentLayout): string[] =>
  layout?.hiddenTools ?? DEFAULT_HIDDEN_ADJUSTMENT_TOOLS;

export const withAdjustmentLayout = (settings: AppSettings, changes: Partial<AdjustmentLayout>): AppSettings => ({
  ...settings,
  adjustmentLayout: { ...settings.adjustmentLayout, ...changes },
});

export interface AdjustmentSectionTool {
  id: string;
  label: string;
  subTools?: Array<string>;
}

export const ADJUSTMENT_SECTION_TOOLS: Record<string, Array<AdjustmentSectionTool>> = {
  color: [
    { id: 'whiteBalance', label: 'adjustments.color.whiteBalance' },
    { id: 'colorPresence', label: 'adjustments.color.presence' },
    { id: 'hue', label: 'adjustments.color.hue' },
    { id: 'colorGrading', label: 'adjustments.color.colorGrading' },
    { id: 'colorMixer', label: 'adjustments.color.colorMixer' },
    { id: 'colorCalibration', label: 'adjustments.color.calibration.title' },
  ],
  details: [
    { id: 'sharpening', label: 'adjustments.details.sharpening' },
    { id: 'presence', label: 'adjustments.details.presence' },
    { id: 'noiseReduction', label: 'adjustments.details.noiseReduction' },
    { id: 'chromaticAberration', label: 'adjustments.details.chromaticAberration' },
    { id: 'negativeConversion', label: 'adjustments.details.negativeConversion' },
  ],
  effects: [
    { id: 'creative', label: 'adjustments.effects.creative' },
    { id: 'spatial', label: 'adjustments.effects.spatial', subTools: ['lensBlur', 'relight', 'fog'] },
    { id: 'lut', label: 'adjustments.effects.lut' },
    { id: 'vignette', label: 'adjustments.effects.vignette' },
    { id: 'grain', label: 'adjustments.effects.grain' },
  ],
};

export const ALL_ADJUSTMENT_TOOLS = Object.values(ADJUSTMENT_SECTION_TOOLS).flat();

export const ADJUSTMENT_TOOLS_BY_ID: Record<string, AdjustmentSectionTool> = Object.fromEntries(
  ALL_ADJUSTMENT_TOOLS.map((tool) => [tool.id, tool]),
);

export const getAdjustmentSectionToolIds = (section: string): string[] =>
  (ADJUSTMENT_SECTION_TOOLS[section] ?? []).map((tool) => tool.id);

const getToolIds = (id: string): Array<string> => {
  const expand = (tool: AdjustmentSectionTool) => tool.subTools ?? [tool.id];
  const sectionTools = ADJUSTMENT_SECTION_TOOLS[id];
  if (sectionTools) {
    return sectionTools.flatMap(expand);
  }
  const tool = ADJUSTMENT_TOOLS_BY_ID[id];
  return tool ? expand(tool) : [id];
};

export const isToolActive = (activeTools: ActiveTools, id: string): boolean =>
  getToolIds(id).some((tool) => activeTools[tool] !== false);

export const setToolActive = (activeTools: ActiveTools, id: string, active: boolean): ActiveTools => ({
  ...activeTools,
  ...Object.fromEntries(getToolIds(id).map((tool) => [tool, active])),
});

export const toggleToolActive = (activeTools: ActiveTools, id: string): ActiveTools =>
  setToolActive(activeTools, id, !isToolActive(activeTools, id));

interface ToolStateSource {
  activeTools?: ActiveTools;
  sectionVisibility?: Record<string, boolean>;
}

export const getActiveTools = (adjustments: ToolStateSource): ActiveTools =>
  adjustments.activeTools ??
  Object.entries(adjustments.sectionVisibility ?? {})
    .filter(([, visible]) => !visible)
    .reduce((activeTools, [id]) => setToolActive(activeTools, id, false), {});

export const mergeActiveTools = (base: ToolStateSource, overrides: ToolStateSource): ActiveTools => ({
  ...getActiveTools(base),
  ...getActiveTools(overrides),
});

export const getAdjustmentToolOrder = (section: string, toolOrder?: Record<string, string[]>): string[] =>
  reconcileOrder(getAdjustmentSectionToolIds(section), toolOrder?.[section]);
