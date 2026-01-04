import { Cubit } from '@blac/core';
import type {
  Adjustments,
  CurvesData,
  CurvePoint,
  HSLData,
  HSLChannel,
  VignetteData,
  GrainData,
  SplitToningData,
  LensCorrections,
  CropData,
  ToneMapper,
} from '../../types/adjustments.js';
import {
  INITIAL_ADJUSTMENTS,
  DEFAULT_CURVES,
  DEFAULT_HSL,
  DEFAULT_VIGNETTE,
  DEFAULT_GRAIN,
  DEFAULT_SPLIT_TONING,
  DEFAULT_LENS_CORRECTIONS,
} from '../../types/adjustments.js';

interface AdjustmentsState {
  adjustments: Adjustments;
  isDirty: boolean;
  lastSavedAt: number | null;
}

export class AdjustmentsBloc extends Cubit<AdjustmentsState> {
  constructor() {
    super({
      adjustments: { ...INITIAL_ADJUSTMENTS },
      isDirty: false,
      lastSavedAt: null,
    });
  }

  private updateAdjustment = <K extends keyof Adjustments>(
    key: K,
    value: Adjustments[K]
  ) => {
    this.emit({
      ...this.state,
      adjustments: { ...this.state.adjustments, [key]: value },
      isDirty: true,
    });
  };

  // Basic adjustments
  setExposure = (value: number) => this.updateAdjustment('exposure', value);
  setBrightness = (value: number) => this.updateAdjustment('brightness', value);
  setContrast = (value: number) => this.updateAdjustment('contrast', value);
  setHighlights = (value: number) => this.updateAdjustment('highlights', value);
  setShadows = (value: number) => this.updateAdjustment('shadows', value);
  setWhites = (value: number) => this.updateAdjustment('whites', value);
  setBlacks = (value: number) => this.updateAdjustment('blacks', value);

  // Tone mapper
  setToneMapper = (value: ToneMapper) => this.updateAdjustment('toneMapper', value);

  // Color adjustments
  setTemperature = (value: number) => this.updateAdjustment('temperature', value);
  setTint = (value: number) => this.updateAdjustment('tint', value);
  setSaturation = (value: number) => this.updateAdjustment('saturation', value);
  setVibrance = (value: number) => this.updateAdjustment('vibrance', value);

  // Presence
  setClarity = (value: number) => this.updateAdjustment('clarity', value);
  setDehaze = (value: number) => this.updateAdjustment('dehaze', value);
  setTexture = (value: number) => this.updateAdjustment('texture', value);

  // Detail
  setSharpness = (value: number) => this.updateAdjustment('sharpness', value);
  setNoiseReduction = (value: number) => this.updateAdjustment('noiseReduction', value);
  setColorNoiseReduction = (value: number) =>
    this.updateAdjustment('colorNoiseReduction', value);

  // Vignette
  setVignette = (value: Partial<VignetteData>) => {
    this.updateAdjustment('vignette', {
      ...this.state.adjustments.vignette,
      ...value,
    });
  };

  // Grain
  setGrain = (value: Partial<GrainData>) => {
    this.updateAdjustment('grain', {
      ...this.state.adjustments.grain,
      ...value,
    });
  };

  // Curves
  setCurves = (value: Partial<CurvesData>) => {
    this.updateAdjustment('curves', {
      ...this.state.adjustments.curves,
      ...value,
    });
  };

  setCurveChannel = (channel: keyof CurvesData, points: CurvePoint[]) => {
    this.setCurves({ [channel]: points });
  };

  resetCurves = () => {
    this.updateAdjustment('curves', { ...DEFAULT_CURVES });
  };

  // HSL
  setHSL = (value: Partial<HSLData>) => {
    this.updateAdjustment('hsl', {
      ...this.state.adjustments.hsl,
      ...value,
    });
  };

  setHSLChannel = (channel: keyof HSLData, values: Partial<HSLChannel>) => {
    this.setHSL({
      [channel]: {
        ...this.state.adjustments.hsl[channel],
        ...values,
      },
    });
  };

  resetHSL = () => {
    this.updateAdjustment('hsl', { ...DEFAULT_HSL });
  };

  // Split toning
  setSplitToning = (value: Partial<SplitToningData>) => {
    this.updateAdjustment('splitToning', {
      ...this.state.adjustments.splitToning,
      ...value,
    });
  };

  // Lens corrections
  setLensCorrections = (value: Partial<LensCorrections>) => {
    this.updateAdjustment('lensCorrections', {
      ...this.state.adjustments.lensCorrections,
      ...value,
    });
  };

  // Transform
  setCrop = (crop: CropData | null) => this.updateAdjustment('crop', crop);
  setRotation = (value: number) => this.updateAdjustment('rotation', value);
  setStraighten = (value: number) => this.updateAdjustment('straighten', value);

  toggleFlipHorizontal = () => {
    this.updateAdjustment('flipHorizontal', !this.state.adjustments.flipHorizontal);
  };

  toggleFlipVertical = () => {
    this.updateAdjustment('flipVertical', !this.state.adjustments.flipVertical);
  };

  // Rating
  setRating = (value: number) => {
    this.updateAdjustment('rating', Math.max(0, Math.min(5, value)));
  };

  // Bulk operations
  setAdjustments = (adjustments: Partial<Adjustments>) => {
    this.emit({
      ...this.state,
      adjustments: { ...this.state.adjustments, ...adjustments },
      isDirty: true,
    });
  };

  loadAdjustments = (adjustments: Adjustments) => {
    this.emit({
      adjustments,
      isDirty: false,
      lastSavedAt: Date.now(),
    });
  };

  resetAll = () => {
    this.emit({
      adjustments: { ...INITIAL_ADJUSTMENTS },
      isDirty: true,
      lastSavedAt: this.state.lastSavedAt,
    });
  };

  resetBasic = () => {
    this.setAdjustments({
      exposure: 0,
      brightness: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
    });
  };

  resetColor = () => {
    this.setAdjustments({
      temperature: 0,
      tint: 0,
      saturation: 0,
      vibrance: 0,
    });
  };

  resetPresence = () => {
    this.setAdjustments({
      clarity: 0,
      dehaze: 0,
      texture: 0,
    });
  };

  resetDetail = () => {
    this.setAdjustments({
      sharpness: 0,
      noiseReduction: 0,
      colorNoiseReduction: 0,
    });
  };

  resetEffects = () => {
    this.setAdjustments({
      vignette: { ...DEFAULT_VIGNETTE },
      grain: { ...DEFAULT_GRAIN },
    });
  };

  resetTransform = () => {
    this.setAdjustments({
      crop: null,
      rotation: 0,
      flipHorizontal: false,
      flipVertical: false,
      straighten: 0,
    });
  };

  markSaved = () => {
    this.patch({ isDirty: false, lastSavedAt: Date.now() });
  };

  get current(): Adjustments {
    return this.state.adjustments;
  }
}
