import { Cubit } from '@blac/core';
import type { CropData } from '../../types/adjustments.js';

export interface CropPreset {
  name: string;
  value: number | null;
}

export const CROP_PRESETS: CropPreset[] = [
  { name: 'Free', value: null },
  { name: 'Original', value: 0 },
  { name: '1:1', value: 1 },
  { name: '5:4', value: 5 / 4 },
  { name: '4:3', value: 4 / 3 },
  { name: '3:2', value: 3 / 2 },
  { name: '16:9', value: 16 / 9 },
  { name: '21:9', value: 21 / 9 },
  { name: '65:24', value: 65 / 24 },
];

export type Orientation = 'horizontal' | 'vertical';

interface CropState {
  aspectRatio: number | null;
  crop: CropData | null;
  rotation: number;
  orientationSteps: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  isStraightenActive: boolean;
  customWidth: string;
  customHeight: string;
}

const INITIAL_CROP_STATE: CropState = {
  aspectRatio: null,
  crop: null,
  rotation: 0,
  orientationSteps: 0,
  flipHorizontal: false,
  flipVertical: false,
  isStraightenActive: false,
  customWidth: '',
  customHeight: '',
};

export class CropBloc extends Cubit<CropState> {
  private imageWidth: number = 0;
  private imageHeight: number = 0;

  constructor() {
    super({ ...INITIAL_CROP_STATE });
  }

  setImageDimensions = (width: number, height: number) => {
    this.imageWidth = width;
    this.imageHeight = height;
  };

  getEffectiveOriginalRatio = (): number | null => {
    if (!this.imageWidth || !this.imageHeight) {
      return null;
    }
    const isSwapped =
      this.state.orientationSteps === 1 || this.state.orientationSteps === 3;
    const w = isSwapped ? this.imageHeight : this.imageWidth;
    const h = isSwapped ? this.imageWidth : this.imageHeight;
    return w > 0 && h > 0 ? w / h : null;
  };

  setAspectRatio = (ratio: number | null) => {
    this.emit({
      ...this.state,
      aspectRatio: ratio,
      crop: null,
    });
  };

  applyPreset = (preset: CropPreset) => {
    if (preset.value === 0) {
      const originalRatio = this.getEffectiveOriginalRatio();
      this.emit({
        ...this.state,
        aspectRatio: originalRatio,
        crop: null,
      });
      return;
    }

    let targetRatio = preset.value;
    const imageRatio = this.getEffectiveOriginalRatio();

    if (targetRatio && imageRatio && imageRatio < 1 && targetRatio > 1) {
      targetRatio = 1 / targetRatio;
    }

    this.emit({
      ...this.state,
      aspectRatio: targetRatio,
      crop: null,
    });
  };

  toggleOrientation = () => {
    if (this.state.aspectRatio && this.state.aspectRatio !== 1) {
      this.emit({
        ...this.state,
        aspectRatio: 1 / this.state.aspectRatio,
        crop: null,
      });
    }
  };

  getOrientation = (): Orientation => {
    const { aspectRatio } = this.state;
    if (!aspectRatio || aspectRatio === 1) {
      return 'horizontal';
    }
    return aspectRatio > 1 ? 'horizontal' : 'vertical';
  };

  setCustomRatio = (width: string, height: string) => {
    this.emit({
      ...this.state,
      customWidth: width,
      customHeight: height,
    });
  };

  applyCustomRatio = () => {
    const numW = parseFloat(this.state.customWidth);
    const numH = parseFloat(this.state.customHeight);

    if (numW > 0 && numH > 0) {
      const newAspectRatio = numW / numH;
      this.emit({
        ...this.state,
        aspectRatio: newAspectRatio,
        crop: null,
      });
    }
  };

  setCrop = (crop: CropData | null) => {
    this.emit({
      ...this.state,
      crop,
    });
  };

  setRotation = (value: number) => {
    this.emit({
      ...this.state,
      rotation: Math.max(-45, Math.min(45, value)),
    });
  };

  resetRotation = () => {
    this.emit({
      ...this.state,
      rotation: 0,
    });
  };

  rotateLeft = () => {
    const newOrientationSteps = (this.state.orientationSteps + 3) % 4;
    const newAspectRatio =
      this.state.aspectRatio && this.state.aspectRatio !== 0
        ? 1 / this.state.aspectRatio
        : null;

    this.emit({
      ...this.state,
      orientationSteps: newOrientationSteps,
      aspectRatio: newAspectRatio,
      rotation: 0,
      crop: null,
    });
  };

  rotateRight = () => {
    const newOrientationSteps = (this.state.orientationSteps + 1) % 4;
    const newAspectRatio =
      this.state.aspectRatio && this.state.aspectRatio !== 0
        ? 1 / this.state.aspectRatio
        : null;

    this.emit({
      ...this.state,
      orientationSteps: newOrientationSteps,
      aspectRatio: newAspectRatio,
      rotation: 0,
      crop: null,
    });
  };

  toggleFlipHorizontal = () => {
    this.emit({
      ...this.state,
      flipHorizontal: !this.state.flipHorizontal,
    });
  };

  toggleFlipVertical = () => {
    this.emit({
      ...this.state,
      flipVertical: !this.state.flipVertical,
    });
  };

  toggleStraighten = () => {
    const willBeActive = !this.state.isStraightenActive;
    this.emit({
      ...this.state,
      isStraightenActive: willBeActive,
      rotation: willBeActive ? 0 : this.state.rotation,
    });
  };

  cancelStraighten = () => {
    this.emit({
      ...this.state,
      isStraightenActive: false,
    });
  };

  getActivePreset = (): CropPreset | null => {
    const { aspectRatio } = this.state;

    if (aspectRatio === null) {
      return CROP_PRESETS.find((p) => p.value === null) || null;
    }

    const numericMatch = CROP_PRESETS.find(
      (p) =>
        p.value &&
        (Math.abs(aspectRatio - p.value) < 0.001 ||
          Math.abs(aspectRatio - 1 / p.value) < 0.001)
    );

    if (numericMatch) {
      return numericMatch;
    }

    const originalRatio = this.getEffectiveOriginalRatio();
    if (originalRatio && Math.abs(aspectRatio - originalRatio) < 0.001) {
      return CROP_PRESETS.find((p) => p.value === 0) || null;
    }

    return null;
  };

  isCustomActive = (): boolean => {
    return this.state.aspectRatio !== null && this.getActivePreset() === null;
  };

  isOrientationToggleDisabled = (): boolean => {
    const { aspectRatio } = this.state;
    const activePreset = this.getActivePreset();
    return (
      !aspectRatio || aspectRatio === 1 || activePreset?.value === 0
    );
  };

  reset = () => {
    const originalRatio = this.getEffectiveOriginalRatio();
    this.emit({
      ...INITIAL_CROP_STATE,
      aspectRatio: originalRatio,
    });
  };

  loadFromAdjustments = (
    crop: CropData | null,
    rotation: number,
    flipHorizontal: boolean,
    flipVertical: boolean,
    straighten: number
  ) => {
    this.emit({
      ...this.state,
      crop,
      rotation: straighten || rotation,
      flipHorizontal,
      flipVertical,
      aspectRatio: crop?.aspect ?? this.getEffectiveOriginalRatio(),
    });
  };
}
