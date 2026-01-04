import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  FlipHorizontal,
  FlipVertical,
  RectangleHorizontal,
  RectangleVertical,
  RotateCcw,
  RotateCw,
  Ruler,
  X,
} from 'lucide-react';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../../../utils/adjustments';
import clsx from 'clsx';
import { Orientation, SelectedImage } from '../../ui/AppProperties';

const BASE_RATIO = 1.618;
const ORIGINAL_RATIO = 0;

interface CropPanelProps {
  adjustments: Adjustments;
  isStraightenActive: boolean;
  selectedImage: SelectedImage;
  setAdjustments(adjustments: Partial<Adjustments>): void;
  setIsStraightenActive(active: any): void;
}

interface CropPreset {
  name: string;
  value: number | null;
}

const PRESETS: Array<CropPreset> = [
  { name: 'Free', value: null },
  { name: 'Original', value: ORIGINAL_RATIO },
  { name: '1:1', value: 1 },
  { name: '5:4', value: 5 / 4 },
  { name: '4:3', value: 4 / 3 },
  { name: '3:2', value: 3 / 2 },
  { name: '16:9', value: 16 / 9 },
  { name: '21:9', value: 21 / 9 },
  { name: '65:24', value: 65 / 24 },
];

export default function CropPanel({
  adjustments,
  isStraightenActive,
  selectedImage,
  setAdjustments,
  setIsStraightenActive,
}: CropPanelProps) {
  const [customW, setCustomW] = useState('');
  const [customH, setCustomH] = useState('');

  const { aspectRatio, rotation = 0, flipHorizontal = false, flipVertical = false, orientationSteps = 0 } = adjustments;

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
        p.value && (Math.abs(aspectRatio - p.value) < 0.001 || Math.abs(aspectRatio - 1 / p.value) < 0.001),
    );

    if (numericPresetMatch) {
      return numericPresetMatch;
    }

    const originalRatio = getEffectiveOriginalRatio();
    if (originalRatio && Math.abs(aspectRatio - originalRatio) < 0.001) {
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
    if (baseRatio && aspectRatio && Math.abs(aspectRatio - baseRatio) > 0.001) {
      orientation = Orientation.Vertical;
    }
  }

  const isCustomActive = aspectRatio !== null && !activePreset;

  useEffect(() => {
    if (isCustomActive && aspectRatio) {
      const currentInputRatio = parseFloat(customW) / parseFloat(customH);
      if (isNaN(currentInputRatio) || Math.abs(currentInputRatio - aspectRatio) > 0.001) {
        const h = 100;
        const w = aspectRatio * h;
        setCustomW(w.toFixed(1).replace(/\.0$/, ''));
        setCustomH(h.toString());
      }
    } else if (!isCustomActive) {
      setCustomW('');
      setCustomH('');
    }
  }, [isCustomActive, aspectRatio]);

  useEffect(() => {
    if (activePreset?.value === ORIGINAL_RATIO) {
      const newOriginalRatio = getEffectiveOriginalRatio();
      if (newOriginalRatio !== null && aspectRatio && Math.abs(aspectRatio - newOriginalRatio) > 0.001) {
        setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, aspectRatio: newOriginalRatio, crop: null }));
      }
    }
  }, [orientationSteps, activePreset, aspectRatio, getEffectiveOriginalRatio, setAdjustments]);

  const handleCustomInputChange = (e: any) => {
    const { name, value } = e.target;
    if (name === 'customW') {
      setCustomW(value);
    } else if (name === 'customH') {
      setCustomH(value);
    }
  };

  const handleApplyCustomRatio = () => {
    const numW = parseFloat(customW);
    const numH = parseFloat(customH);

    if (numW > 0 && numH > 0) {
      const newAspectRatio = numW / numH;
      if (adjustments?.aspectRatio && Math.abs(adjustments.aspectRatio - newAspectRatio) > 0.001) {
        setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, aspectRatio: newAspectRatio, crop: null }));
      }
    }
  };

  const handleKeyDown = (e: any) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApplyCustomRatio();
      e.target.blur();
    }
  };

  const handlePresetClick = (preset: CropPreset) => {
    if (preset.value === ORIGINAL_RATIO) {
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aspectRatio: getEffectiveOriginalRatio(),
        crop: null,
      }));
      return;
    }

    let targetRatio = preset.value;
    if (activePreset === preset && targetRatio && targetRatio !== 1) {
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aspectRatio: 1 / (prev.aspectRatio ? prev.aspectRatio : 1),
        crop: null,
      }));

      return;
    }

    const imageRatio = getEffectiveOriginalRatio();

    let newAspectRatio = targetRatio;
    if (targetRatio && imageRatio && imageRatio < 1 && targetRatio > 1) {
      newAspectRatio = 1 / targetRatio;
    }

    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, aspectRatio: newAspectRatio, crop: null }));
  };

  const handleOrientationToggle = useCallback(() => {
    if (aspectRatio && aspectRatio !== 1) {
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aspectRatio: 1 / (prev.aspectRatio ? prev.aspectRatio : 1),
        crop: null,
      }));
    }
  }, [aspectRatio, setAdjustments]);

  const handleReset = () => {
    const originalAspectRatio =
      selectedImage?.width && selectedImage?.height ? selectedImage.width / selectedImage.height : null;

    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      aspectRatio: originalAspectRatio,
      crop: INITIAL_ADJUSTMENTS.crop,
      flipHorizontal: INITIAL_ADJUSTMENTS.flipHorizontal || false,
      flipVertical: INITIAL_ADJUSTMENTS.flipVertical || false,
      orientationSteps: INITIAL_ADJUSTMENTS.orientationSteps || 0,
      rotation: INITIAL_ADJUSTMENTS.rotation || 0,
    }));
  };

  const isPresetActive = (preset: CropPreset) => preset === activePreset;
  const isOrientationToggleDisabled = !aspectRatio || aspectRatio === 1 || activePreset?.value === ORIGINAL_RATIO;

  const fineRotation = useMemo(() => {
    return rotation || 0;
  }, [rotation]);

  const handleFineRotationChange = (e: any) => {
    const newFineRotation = parseFloat(e.target.value);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, rotation: newFineRotation }));
  };

  const handleStepRotate = (degrees: number) => {
    const increment = degrees > 0 ? 1 : 3;
    setAdjustments((prev: Partial<Adjustments>) => {
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

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
        <h2 className="text-xl font-bold text-primary text-shadow-shiny">Crop & Transform</h2>
        <button className="p-2 rounded-full hover:bg-surface transition-colors" onClick={handleReset} title="Reset All">
          <RotateCcw size={18} />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto p-4 text-text-secondary space-y-6">
        {selectedImage ? (
          <>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <p className="text-sm mb-3 font-semibold text-text-primary">Aspect Ratio</p>
                <button
                  className="p-1.5 rounded-md hover:bg-surface disabled:text-text-tertiary disabled:cursor-not-allowed"
                  disabled={isOrientationToggleDisabled}
                  onClick={handleOrientationToggle}
                  title="Switch Orientation"
                >
                  {orientation === Orientation.Vertical ? (
                    <RectangleVertical size={16} />
                  ) : (
                    <RectangleHorizontal size={16} />
                  )}
                </button>
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
                    if (imageRatio && imageRatio < 1) {
                      newAspectRatio = 1 / BASE_RATIO;
                    }
                    setAdjustments((prev: Partial<Adjustments>) => ({
                      ...prev,
                      aspectRatio: newAspectRatio,
                      crop: null,
                    }));
                  }}
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
                      onKeyDown={handleKeyDown}
                      placeholder="W"
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
                      onKeyDown={handleKeyDown}
                      placeholder="H"
                      type="number"
                      value={customH}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-sm mb-3 font-semibold text-text-primary">Rotation</p>
              <div className="flex justify-between items-center">
                <span className="font-mono text-lg text-text-primary">{rotation.toFixed(1)}°</span>
                <button
                  className="p-1.5 rounded-full hover:bg-surface"
                  onClick={resetFineRotation}
                  title="Reset Fine Rotation"
                >
                  <RotateCcw size={14} />
                </button>
              </div>
              <input
                className="w-full h-2 bg-surface rounded-lg appearance-none cursor-pointer accent-accent"
                max="45"
                min="-45"
                onChange={handleFineRotationChange}
                step="0.1"
                type="range"
                value={fineRotation}
              />
            </div>

            <div className="space-y-4">
              <p className="text-sm mb-3 font-semibold text-text-primary">Tools</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  className="flex flex-col items-center justify-center p-3 rounded-lg transition-colors bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary"
                  onClick={() => handleStepRotate(-90)}
                >
                  <RotateCcw size={20} className="transition-none" />
                  <span className="text-xs mt-1.5 transition-none">Rotate Left</span>
                </button>
                <button
                  className="flex flex-col items-center justify-center p-3 rounded-lg transition-colors bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary"
                  onClick={() => handleStepRotate(90)}
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
                    setAdjustments((prev: Partial<Adjustments>) => ({
                      ...prev,
                      flipHorizontal: !prev.flipHorizontal,
                    }))
                  }
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
                    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, flipVertical: !prev.flipVertical }))
                  }
                >
                  <FlipVertical size={20} className="transition-none" />
                  <span className="text-xs mt-1.5 transition-none">Flip Vert</span>
                </button>
                <button
                  className={clsx(
                    'flex flex-col items-center justify-center p-3 rounded-lg transition-colors group',
                    isStraightenActive
                      ? 'bg-accent text-button-text hover:bg-red-500'
                      : 'bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary',
                  )}
                  onClick={() => {
                    setIsStraightenActive((isActive: boolean) => {
                      const willBeActive = !isActive;
                      if (willBeActive) {
                        setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, rotation: 0 }));
                      }
                      return willBeActive;
                    });
                  }}
                >
                  <Ruler size={20} className="transition-none" />
                  <span className="relative text-xs mt-1.5 h-4 flex items-center justify-center transition-none">
                    <span className={clsx('transition-none', isStraightenActive && 'group-hover:opacity-0')}>
                      Straighten
                    </span>
                    <span
                      className={clsx(
                        'absolute left-0 right-0 text-center opacity-0 transition-none',
                        isStraightenActive && 'group-hover:opacity-100',
                      )}
                    >
                      Cancel
                    </span>
                  </span>
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="text-center text-text-tertiary mt-4">No image selected.</p>
        )}
      </div>
    </div>
  );
}
