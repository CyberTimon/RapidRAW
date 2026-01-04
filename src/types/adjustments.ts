export type ToneMapper = 'agx' | 'reinhard' | 'filmic' | 'none';

export interface CurvePoint {
  x: number;
  y: number;
}

export interface CurvesData {
  rgb: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

export interface HSLChannel {
  hue: number;
  saturation: number;
  luminance: number;
}

export interface HSLData {
  red: HSLChannel;
  orange: HSLChannel;
  yellow: HSLChannel;
  green: HSLChannel;
  aqua: HSLChannel;
  blue: HSLChannel;
  purple: HSLChannel;
  magenta: HSLChannel;
}

export interface CropData {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: 'px' | '%';
  aspect?: number;
}

export interface VignetteData {
  amount: number;
  midpoint: number;
  roundness: number;
  feather: number;
}

export interface GrainData {
  amount: number;
  size: number;
  roughness: number;
}

export interface SplitToningData {
  highlightHue: number;
  highlightSaturation: number;
  shadowHue: number;
  shadowSaturation: number;
  balance: number;
}

export interface LensCorrections {
  distortion: number;
  chromaticAberration: number;
  vignetting: number;
}

export interface Adjustments {
  // Basic
  exposure: number;
  brightness: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;

  // Tone mapping
  toneMapper: ToneMapper;

  // Color
  temperature: number;
  tint: number;
  saturation: number;
  vibrance: number;

  // Presence
  clarity: number;
  dehaze: number;
  texture: number;

  // Detail
  sharpness: number;
  noiseReduction: number;
  colorNoiseReduction: number;

  // Effects
  vignette: VignetteData;
  grain: GrainData;

  // Advanced
  curves: CurvesData;
  hsl: HSLData;
  splitToning: SplitToningData;
  lensCorrections: LensCorrections;

  // Transform
  crop: CropData | null;
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  straighten: number;

  // Metadata-like
  rating: number;
}

export const DEFAULT_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 255, y: 255 },
];

export const DEFAULT_CURVES: CurvesData = {
  rgb: [...DEFAULT_CURVE],
  red: [...DEFAULT_CURVE],
  green: [...DEFAULT_CURVE],
  blue: [...DEFAULT_CURVE],
};

export const DEFAULT_HSL_CHANNEL: HSLChannel = {
  hue: 0,
  saturation: 0,
  luminance: 0,
};

export const DEFAULT_HSL: HSLData = {
  red: { ...DEFAULT_HSL_CHANNEL },
  orange: { ...DEFAULT_HSL_CHANNEL },
  yellow: { ...DEFAULT_HSL_CHANNEL },
  green: { ...DEFAULT_HSL_CHANNEL },
  aqua: { ...DEFAULT_HSL_CHANNEL },
  blue: { ...DEFAULT_HSL_CHANNEL },
  purple: { ...DEFAULT_HSL_CHANNEL },
  magenta: { ...DEFAULT_HSL_CHANNEL },
};

export const DEFAULT_VIGNETTE: VignetteData = {
  amount: 0,
  midpoint: 50,
  roundness: 0,
  feather: 50,
};

export const DEFAULT_GRAIN: GrainData = {
  amount: 0,
  size: 25,
  roughness: 50,
};

export const DEFAULT_SPLIT_TONING: SplitToningData = {
  highlightHue: 0,
  highlightSaturation: 0,
  shadowHue: 0,
  shadowSaturation: 0,
  balance: 0,
};

export const DEFAULT_LENS_CORRECTIONS: LensCorrections = {
  distortion: 0,
  chromaticAberration: 0,
  vignetting: 0,
};

export const INITIAL_ADJUSTMENTS: Adjustments = {
  exposure: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  toneMapper: 'agx',
  temperature: 0,
  tint: 0,
  saturation: 0,
  vibrance: 0,
  clarity: 0,
  dehaze: 0,
  texture: 0,
  sharpness: 0,
  noiseReduction: 0,
  colorNoiseReduction: 0,
  vignette: { ...DEFAULT_VIGNETTE },
  grain: { ...DEFAULT_GRAIN },
  curves: { ...DEFAULT_CURVES },
  hsl: { ...DEFAULT_HSL },
  splitToning: { ...DEFAULT_SPLIT_TONING },
  lensCorrections: { ...DEFAULT_LENS_CORRECTIONS },
  crop: null,
  rotation: 0,
  flipHorizontal: false,
  flipVertical: false,
  straighten: 0,
  rating: 0,
};
