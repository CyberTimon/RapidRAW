import { type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Aperture,
  FlipHorizontal,
  FlipVertical,
  Grid3x3,
  RectangleHorizontal,
  RectangleVertical,
  RotateCcw,
  RotateCw,
  Ruler,
  Scan,
  X
} from 'lucide-react';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../../../utils/adjustments';
import clsx from 'clsx';
import { Orientation, SelectedImage } from '../../ui/AppProperties';
import TransformModal from '../../modals/TransformModal';
import LensCorrectionModal from '../../modals/LensCorrectionModal';

const BASE_RATIO = 1.618;
const ORIGINAL_RATIO = 0;
const RATIO_TOLERANCE = 0.01;

export type OverlayMode = 'none' | 'thirds' | 'goldenTriangle' | 'goldenSpiral' | 'phiGrid' | 'armature' | 'diagonal';

interface CropPanelProps {
  adjustments: Adjustments;
  isStraightenActive: boolean;
  selectedImage: SelectedImage;
  setAdjustments(adjustments: Partial<Adjustments> | ((prev: Adjustments) => Adjustments)): void;
  setIsStraightenActive(active: any): void;
  setIsRotationActive?(active: boolean): void;
  overlayMode?: OverlayMode;
  setOverlayMode?(mode: OverlayMode): void;
  overlayRotation?: number;
  setOverlayRotation?(rotation: SetStateAction<number>): void;
}

interface CropPreset {
  name: string;
  value: number | null;
  tooltip: string;
}

interface OverlayOption {
  id: OverlayMode;
  name: string;
  tooltip: string;
}


const PRESETS: Array<CropPreset> = [
  { name: 'Free', value: null, tooltip: 'Freeform crop' },
  { name: 'Original', value: ORIGINAL_RATIO, tooltip: 'Original image aspect ratio' },
  { name: '1:1', value: 1, tooltip: 'Square - Instagram, profile pictures' },
  { name: '5:4', value: 5 / 4, tooltip: '5:4 - Instagram landscape, 8x10 prints' },
  { name: '4:3', value: 4 / 3, tooltip: '4:3 - Traditional monitors, tablets' },
  { name: '3:2', value: 3 / 2, tooltip: '3:2 - 35mm film, DSLR cameras' },
  { name: '16:9', value: 16 / 9, tooltip: '16:9 - Widescreen, desktop wallpapers, YouTube' },
  { name: '21:9', value: 21 / 9, tooltip: '21:9 - Ultrawide monitors, cinematic' },
  { name: '65:24', value: 65 / 24, tooltip: '65:24 - Panoramic 35mm wide format' },
];

const OVERLAYS: Array<OverlayOption> = [
  { id: 'none', name: 'None', tooltip: 'No overlay' },
  { id: 'thirds', name: 'Thirds', tooltip: 'Rule of Thirds' },
  { id: 'diagonal', name: 'Diagonal Lines', tooltip: 'Diagonal Lines' },
  { id: 'goldenTriangle', name: 'Triangle', tooltip: 'Golden Triangle' },
  { id: 'goldenSpiral', name: 'Spiral', tooltip: 'Golden Spiral (Fibonacci)' },
  { id: 'phiGrid', name: 'Phi Grid', tooltip: 'Phi Grid (Golden Ratio)' },
  { id: 'armature', name: 'Armature', tooltip: 'Armature' },
];

export default function CropPanel({
  adjustments,
  isStraightenActive,
  selectedImage,
  setAdjustments,
  setIsStraightenActive,
  setIsRotationActive: setGlobalRotationActive,
  overlayMode: propOverlayMode,
  setOverlayMode: setPropOverlayMode,
  overlayRotation: _propOverlayRotation,
  setOverlayRotation: propSetOverlayRotation,
}: CropPanelProps) {
  const [customW, setCustomW] = useState('');
  const [customH, setCustomH] = useState('');
  const [isTransformModalOpen, setIsTransformModalOpen] = useState(false);
  const [isLensModalOpen, setIsLensModalOpen] = useState(false);
  const [isRotationActive, setIsRotationActive] = useState(false);
  const [preferPortrait, setPreferPortrait] = useState(false);
  const [isEditingCustom, setIsEditingCustom] = useState(false);

  const [internalOverlayMode, setInternalOverlayMode] = useState<OverlayMode>('thirds');
  const [_internalOverlayRotation, setInternalOverlayRotation] = useState(0);

  const activeOverlay = propOverlayMode ?? internalOverlayMode;
  const setOverlay = setPropOverlayMode ?? setInternalOverlayMode;
  const setOverlayRotation = propSetOverlayRotation ?? setInternalOverlayRotation;

  const lastSyncedRatio = useRef<number | null>(null);

  const { aspectRatio, rotation = 0, flipHorizontal = false, flipVertical = false, orientationSteps = 0 } = adjustments;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName.toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea') return;

      if (e.ctrlKey || e.metaKey) return;

      if (e.key.toLowerCase() === 'o') {
        e.preventDefault();

        if (e.shiftKey) {
          setOverlayRotation((prev) => (prev + 1) % 4);
        } else {
          const currentIndex = OVERLAYS.findIndex((o) => o.id === activeOverlay);
          const nextIndex = (currentIndex + 1) % OVERLAYS.length;
          setOverlay(OVERLAYS[nextIndex].id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeOverlay, setOverlay, setOverlayRotation]);

  useEffect(() => {
    const handleDragEndGlobal = () => {
      if (isRotationActive) {
        setIsRotationActive(false);
        setGlobalRotationActive?.(false);
      }
    };

    if (isRotationActive) {
      window.addEventListener('mouseup', handleDragEndGlobal);
      window.addEventListener('touchend', handleDragEndGlobal);
    }

    return () => {
      window.removeEventListener('mouseup', handleDragEndGlobal);
      window.removeEventListener('touchend', handleDragEndGlobal);
    };
  }, [isRotationActive, setGlobalRotationActive]);

  const getEffectiveOriginalRatio = useCallback(() => {
    if (!selectedImage?.width || !selectedImage?.height) {
      return null;
    }
    const isSwapped = orientationSteps === 1 || orientationSteps === 3;
    const W = isSwapped ? selectedImage.height : selectedImage.width;
    const H = isSwapped ? selectedImage.width : selectedImage.height;
    return W > 0 && H > 0 ? W / H : null;
  }, [selectedImage, orientationSteps]);

  const activePreset = useMemo(() => {
    if (aspectRatio === null) {
      return PRESETS.find((p: CropPreset) => p.value === null);
    }

    const numericPresetMatch = PRESETS.find(
      (p: CropPreset) =>
        p.value &&
        p.value !== ORIGINAL_RATIO &&
        (Math.abs(aspectRatio - p.value) < RATIO_TOLERANCE ||
          Math.abs(aspectRatio - 1 / p.value) < RATIO_TOLERANCE),
    );

    if (numericPresetMatch) {
      return numericPresetMatch;
    }

    const originalRatio = getEffectiveOriginalRatio();
    if (originalRatio && Math.abs(aspectRatio - originalRatio) < RATIO_TOLERANCE) {
      return PRESETS.find((p: CropPreset) => p.value === ORIGINAL_RATIO);
    }

    return null;
  }, [aspectRatio, getEffectiveOriginalRatio]);

  let orientation = Orientation.Horizontal;
  if (activePreset && activePreset.value && activePreset.value !== 1) {
    let baseRatio: number | null = activePreset.value;
    if (activePreset.value === ORIGINAL_RATIO) {
      baseRatio = getEffectiveOriginalRatio();
    }
    if (baseRatio && aspectRatio && Math.abs(aspectRatio - baseRatio) > RATIO_TOLERANCE) {
      orientation = Orientation.Vertical;
    }
  }

  const isCustomActive = aspectRatio !== null && !activePreset;

  useEffect(() => {
    if (aspectRatio && aspectRatio !== 1) {
      setPreferPortrait(aspectRatio < 1);
    }
  }, [aspectRatio]);

  useEffect(() => {
    if (isCustomActive && aspectRatio && !isEditingCustom) {
      if (lastSyncedRatio.current === null || Math.abs(lastSyncedRatio.current - aspectRatio) > RATIO_TOLERANCE) {
        const h = 100;
        const w = aspectRatio * h;
        setCustomW(w.toFixed(1).replace(/\.0$/, ''));
        setCustomH(h.toString());
        lastSyncedRatio.current = aspectRatio;
      }
    } else if (!isCustomActive) {
      setCustomW('');
      setCustomH('');
      lastSyncedRatio.current = null;
    }
  }, [isCustomActive, aspectRatio, isEditingCustom]);

  useEffect(() => {
    if (activePreset?.value === ORIGINAL_RATIO) {
      const newOriginalRatio = getEffectiveOriginalRatio();
      if (
        newOriginalRatio !== null &&
        aspectRatio &&
        Math.abs(aspectRatio - newOriginalRatio) > RATIO_TOLERANCE
      ) {
        setAdjustments((prev: Adjustments) => ({ ...prev, aspectRatio: newOriginalRatio, crop: null }));
      }
    }
  }, [orientationSteps, activePreset, aspectRatio, getEffectiveOriginalRatio, setAdjustments]);

  const handleCustomInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    if (name === 'customW') {
      setCustomW(value);
    } else if (name === 'customH') {
      setCustomH(value);
    }
  };

  const handleCustomInputFocus = () => {
    setIsEditingCustom(true);
  };

  const handleApplyCustomRatio = () => {
    setIsEditingCustom(false);
    const numW = parseFloat(customW);
    const numH = parseFloat(customH);

    if (numW > 0 && numH > 0) {
      const newAspectRatio = numW / numH;
      lastSyncedRatio.current = newAspectRatio;
      if (
        !adjustments?.aspectRatio ||
        Math.abs(adjustments.aspectRatio - newAspectRatio) > RATIO_TOLERANCE
      ) {
        setAdjustments((prev: Adjustments) => ({ ...prev, aspectRatio: newAspectRatio, crop: null }));
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApplyCustomRatio();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      setIsEditingCustom(false);
      if (aspectRatio) {
        const h = 100;
        const w = aspectRatio * h;
        setCustomW(w.toFixed(1).replace(/\.0$/, ''));
        setCustomH(h.toString());
      }
      (e.target as HTMLInputElement).blur();
    }
  };

  const handlePresetClick = (preset: CropPreset) => {
    if (preset.value === ORIGINAL_RATIO) {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aspectRatio: getEffectiveOriginalRatio(),
        crop: null,
      }));
      return;
    }

    const targetRatio = preset.value;
    if (activePreset === preset && targetRatio && targetRatio !== 1) {
      const newRatio = 1 / (adjustments.aspectRatio ? adjustments.aspectRatio : 1);
      setPreferPortrait(newRatio < 1);
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aspectRatio: newRatio,
        crop: null,
      }));
      return;
    }

    let newAspectRatio = targetRatio;
    if (targetRatio && targetRatio !== 1) {
      if (preferPortrait) {
        newAspectRatio = targetRatio > 1 ? 1 / targetRatio : targetRatio;
      } else {
        newAspectRatio = targetRatio > 1 ? targetRatio : targetRatio;
      }
    }

    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, aspectRatio: newAspectRatio, crop: null }));
  };

  const handleOrientationToggle = useCallback(() => {
    if (aspectRatio && aspectRatio !== 1) {
      const newRatio = 1 / aspectRatio;
      setPreferPortrait(newRatio < 1);
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aspectRatio: newRatio,
        crop: null,
      }));
    }
  }, [aspectRatio, setAdjustments]);

  const handleReset = () => {
    const originalAspectRatio =
      selectedImage?.width && selectedImage?.height ? selectedImage.width / selectedImage.height : null;

    setPreferPortrait(false);
    setIsEditingCustom(false);
    lastSyncedRatio.current = null;

    setOverlay('thirds');

    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aspectRatio: originalAspectRatio,
      crop: INITIAL_ADJUSTMENTS.crop,
      flipHorizontal: INITIAL_ADJUSTMENTS.flipHorizontal ?? false,
      flipVertical: INITIAL_ADJUSTMENTS.flipVertical ?? false,
      orientationSteps: INITIAL_ADJUSTMENTS.orientationSteps ?? 0,
      rotation: INITIAL_ADJUSTMENTS.rotation ?? 0,
      transformDistortion: INITIAL_ADJUSTMENTS.transformDistortion ?? 0,
      transformVertical: INITIAL_ADJUSTMENTS.transformVertical ?? 0,
      transformHorizontal: INITIAL_ADJUSTMENTS.transformHorizontal ?? 0,
      transformRotate: INITIAL_ADJUSTMENTS.transformRotate ?? 0,
      transformAspect: INITIAL_ADJUSTMENTS.transformAspect ?? 0,
      transformScale: INITIAL_ADJUSTMENTS.transformScale ?? 100,
      transformXOffset: INITIAL_ADJUSTMENTS.transformXOffset ?? 0,
      transformYOffset: INITIAL_ADJUSTMENTS.transformYOffset ?? 0,
      lensMaker: INITIAL_ADJUSTMENTS.lensMaker,
      lensModel: INITIAL_ADJUSTMENTS.lensModel,
      lensDistortionAmount: INITIAL_ADJUSTMENTS.lensDistortionAmount,
      lensVignetteAmount: INITIAL_ADJUSTMENTS.lensVignetteAmount,
      lensTcaAmount: INITIAL_ADJUSTMENTS.lensTcaAmount,
      lensDistortionEnabled: INITIAL_ADJUSTMENTS.lensDistortionEnabled,
      lensTcaEnabled: INITIAL_ADJUSTMENTS.lensTcaEnabled,
      lensVignetteEnabled: INITIAL_ADJUSTMENTS.lensVignetteEnabled,
      lensDistortionParams: INITIAL_ADJUSTMENTS.lensDistortionParams,
    }));
  };

  const isPresetActive = (preset: CropPreset) => preset === activePreset;
  const isOrientationToggleDisabled = !aspectRatio || aspectRatio === 1 || activePreset?.value === ORIGINAL_RATIO;

  const fineRotation = useMemo(() => {
    return rotation || 0;
  }, [rotation]);

  const handleFineRotationChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newFineRotation = parseFloat(e.target.value);
    setAdjustments((prev: Adjustments) => ({ ...prev, rotation: newFineRotation }));
  };

  const handleStepRotate = (degrees: number) => {
    const increment = degrees > 0 ? 1 : 3;
    setAdjustments((prev: Adjustments) => {
      const newAspectRatio = prev.aspectRatio && prev.aspectRatio !== 0 ? 1 / prev.aspectRatio : null;
      return {
        ...prev,
        aspectRatio: newAspectRatio,
        orientationSteps: ((prev.orientationSteps || 0) + increment) % 4,
        rotation: 0,
        crop: null,
      };
    });
  };

  const resetFineRotation = () => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, rotation: 0 }));
  };

  const handleRotationMouseDown = () => {
    setIsRotationActive(true);
    setGlobalRotationActive?.(true);
  };

  const handleRotationMouseUp = () => {
    setIsRotationActive(false);
    setGlobalRotationActive?.(false);
  };

  const handleOverlayCycle = () => {
    const currentIndex = OVERLAYS.findIndex((o) => o.id === activeOverlay);
    const nextIndex = (currentIndex + 1) % OVERLAYS.length;
    setOverlay(OVERLAYS[nextIndex].id);
  };

  const getOverlayTooltip = () => {
    const current = OVERLAYS.find((o) => o.id === activeOverlay);
    if (!current) return 'Composition Overlay';
    const isRotatable = ['goldenSpiral', 'goldenTriangle'].includes(activeOverlay);
    return `Overlay: ${current.name}${isRotatable ? ' (Shift+O to rotate)' : ''}`;
  };

  const getOrientationTooltip = () => {
    if (isOrientationToggleDisabled) {
      return 'Switch orientation';
    }
    return orientation === Orientation.Vertical ? 'Switch to landscape' : 'Switch to portrait';
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
        <h2 className="text-xl font-bold text-primary text-shadow-shiny">Crop & Transform</h2>
        <button className="p-2 rounded-full hover:bg-surface transition-colors" onClick={handleReset} data-tooltip="Reset Crop & Transform">
          <RotateCcw size={18} />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto p-4 text-text-secondary space-y-6">
        {selectedImage ? (
          <>
            <div className="space-y-4">
              <div className="flex justify-between items-center mb-3">
                <p className="text-sm font-semibold text-text-primary">Aspect Ratio</p>
                <div className="flex items-center gap-2">
                  <button
                    className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
                    onClick={handleOverlayCycle}
                    data-tooltip={getOverlayTooltip()}
                  >
                    <Grid3x3 size={16} />
                  </button>
                  <button
                    className="p-1.5 rounded-md hover:bg-surface disabled:text-text-tertiary disabled:cursor-not-allowed"
                    disabled={isOrientationToggleDisabled}
                    onClick={handleOrientationToggle}
                    data-tooltip={getOrientationTooltip()}
                  >
                    {orientation === Orientation.Vertical ? (
                      <RectangleVertical size={16} />
                    ) : (
                      <RectangleHorizontal size={16} />
                    )}
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {PRESETS.map((preset: CropPreset) => (
                  <button
                    className={clsx(
                      'px-2 py-1.5 text-sm rounded-md transition-colors',
                      isPresetActive(preset) ? 'bg-accent text-button-text' : 'bg-surface hover:bg-card-active',
                    )}
                    key={preset.name}
                    onClick={() => handlePresetClick(preset)}
                    data-tooltip={preset.tooltip}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
              <div className="mt-3">
                <button
                  className={clsx(
                    'w-full px-2 py-1.5 text-sm rounded-md transition-colors',
                    isCustomActive ? 'bg-accent text-button-text' : 'bg-surface hover:bg-card-active',
                  )}
                  onClick={() => {
                    const imageRatio = getEffectiveOriginalRatio();
                    let newAspectRatio = BASE_RATIO;
                    if (preferPortrait || (imageRatio && imageRatio < 1)) {
                      newAspectRatio = 1 / BASE_RATIO;
                    }
                    setAdjustments((prev: Partial<Adjustments>) => ({
                      ...prev,
                      aspectRatio: newAspectRatio,
                      crop: null,
                    }));
                  }}
                  data-tooltip="Enter custom aspect ratio"
                >
                  Custom
                </button>
                <div
                  className={clsx(
                    'mt-2 bg-surface p-2 rounded-md transition-opacity',
                    isCustomActive ? 'opacity-100' : 'opacity-50 pointer-events-none',
                  )}
                >
                  <div className="flex items-center justify-center gap-2">
                    <input
                      className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent focus:ring-accent"
                      min="0"
                      name="customW"
                      onBlur={handleApplyCustomRatio}
                      onChange={handleCustomInputChange}
                      onFocus={handleCustomInputFocus}
                      onKeyDown={handleKeyDown}
                      placeholder="W"
                      data-tooltip="Width"
                      type="number"
                      value={customW}
                    />
                    <X size={16} className="text-text-tertiary flex-shrink-0" />
                    <input
                      className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent focus:ring-accent"
                      min="0"
                      name="customH"
                      onBlur={handleApplyCustomRatio}
                      onChange={handleCustomInputChange}
                      onFocus={handleCustomInputFocus}
                      onKeyDown={handleKeyDown}
                      placeholder="H"
                      data-tooltip="Height"
                      type="number"
                      value={customH}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <p className="text-sm mb-3 font-semibold text-text-primary">Rotation</p>
              <div className="bg-surface px-4 py-3 pb-4 rounded-lg">
                <div className="flex justify-between items-center mb-3">
                  <span className="font-mono text-lg text-text-primary">{rotation.toFixed(1)}°</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setIsStraightenActive((isActive: boolean) => {
                          const willBeActive = !isActive;
                          if (willBeActive) {
                            setAdjustments((prev: Adjustments) => ({ ...prev, rotation: 0 }));
                          }
                          return willBeActive;
                        });
                      }}
                      className={clsx(
                        'p-1.5 rounded-md transition-colors',
                        isStraightenActive
                          ? 'bg-accent text-button-text'
                          : 'text-text-secondary hover:bg-card-active hover:text-text-primary',
                      )}
                      data-tooltip="Straighten Tool"
                    >
                      <Ruler size={16} />
                    </button>
                    <button
                      className="p-1.5 rounded-md text-text-secondary transition-colors cursor-pointer hover:bg-card-active hover:text-text-primary"
                      onClick={resetFineRotation}
                      data-tooltip="Reset Fine Rotation"
                      disabled={rotation === 0}
                    >
                      <RotateCcw size={14} />
                    </button>
                  </div>
                </div>
                <div className="relative w-full h-5">
                  <div className="absolute top-1/2 left-0 w-full h-1.5 -translate-y-1/4 bg-card-active rounded-full pointer-events-none" />
                  <input
                    className={clsx(
                      'absolute top-1/2 left-0 w-full h-1.5 appearance-none bg-transparent cursor-pointer m-0 p-0 slider-input z-10',
                      isRotationActive && 'slider-thumb-active',
                    )}
                    style={{ margin: 0 }}
                    max="45"
                    min="-45"
                    onChange={handleFineRotationChange}
                    onDoubleClick={resetFineRotation}
                    onMouseDown={handleRotationMouseDown}
                    onMouseUp={handleRotationMouseUp}
                    onTouchStart={handleRotationMouseDown}
                    onTouchEnd={handleRotationMouseUp}
                    step="0.1"
                    type="range"
                    value={fineRotation}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <p className="text-sm mb-3 font-semibold text-text-primary">Orientation</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  className="flex flex-col items-center justify-center p-3 rounded-lg transition-colors bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary"
                  onClick={() => handleStepRotate(-90)}
                  data-tooltip="Rotate 90° counter-clockwise"
                >
                  <RotateCcw size={20} className="transition-none" />
                  <span className="text-xs mt-1.5 transition-none">Rotate Left</span>
                </button>
                <button
                  className="flex flex-col items-center justify-center p-3 rounded-lg transition-colors bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary"
                  onClick={() => handleStepRotate(90)}
                  data-tooltip="Rotate 90° clockwise"
                >
                  <RotateCw size={20} className="transition-none" />
                  <span className="text-xs mt-1.5 transition-none">Rotate Right</span>
                </button>
                <button
                  className={clsx(
                    'flex flex-col items-center justify-center p-3 rounded-lg transition-colors',
                    flipHorizontal
                      ? 'bg-accent text-button-text'
                      : 'bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary',
                  )}
                  onClick={() =>
                    setAdjustments((prev: Adjustments) => ({
                      ...prev,
                      flipHorizontal: !prev.flipHorizontal,
                    }))
                  }
                  data-tooltip="Flip image horizontally"
                >
                  <FlipHorizontal size={20} className="transition-none" />
                  <span className="text-xs mt-1.5 transition-none">Flip Horiz</span>
                </button>
                <button
                  className={clsx(
                    'flex flex-col items-center justify-center p-3 rounded-lg transition-colors',
                    flipVertical
                      ? 'bg-accent text-button-text'
                      : 'bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary',
                  )}
                  onClick={() =>
                    setAdjustments((prev: Adjustments) => ({ ...prev, flipVertical: !prev.flipVertical }))
                  }
                  data-tooltip="Flip image vertically"
                >
                  <FlipVertical size={20} className="transition-none" />
                  <span className="text-xs mt-1.5 transition-none">Flip Vert</span>
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <p className="text-sm mb-3 font-semibold text-text-primary">Geometry</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  className="flex flex-col items-center justify-center p-3 rounded-lg transition-colors bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary group"
                  onClick={() => setIsTransformModalOpen(true)}
                  data-tooltip="Perspective and keystone correction"
                >
                  <Scan size={20} className="transition-none" />
                  <span className="text-xs mt-1.5 transition-none">Transform</span>
                </button>
                <button
                  className="flex flex-col items-center justify-center p-3 rounded-lg transition-colors bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary group"
                  onClick={() => setIsLensModalOpen(true)}
                  data-tooltip="Lens distortion correction"
                >
                  <Aperture size={20} className="transition-none" />
                  <span className="text-xs mt-1.5 transition-none">Lens</span>
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="text-center text-text-tertiary mt-4">No image selected.</p>
        )}
      </div>

      <TransformModal
        isOpen={isTransformModalOpen}
        onClose={() => setIsTransformModalOpen(false)}
        onApply={(newParams) => {
          setAdjustments((prev: Adjustments) => ({
            ...prev,
            transformDistortion: newParams.distortion,
            transformVertical: newParams.vertical,
            transformHorizontal: newParams.horizontal,
            transformRotate: newParams.rotate,
            transformAspect: newParams.aspect,
            transformScale: newParams.scale,
            transformXOffset: newParams.x_offset,
            transformYOffset: newParams.y_offset,
            crop: null,
          }));
        }}
        currentAdjustments={adjustments}
      />

      <LensCorrectionModal
        isOpen={isLensModalOpen}
        onClose={() => setIsLensModalOpen(false)}
        onApply={(newParams) => {
          setAdjustments((prev: Adjustments) => ({
            ...prev,
            ...newParams,
            crop: null,
          }));
        }}
        currentAdjustments={adjustments}
        selectedImage={selectedImage}
      />
    </div>
  );
}
