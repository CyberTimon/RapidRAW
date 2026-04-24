import { useCallback } from 'react';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import { Adjustments, DetailsAdjustment } from '../../utils/adjustments';
import { AppSettings } from '../ui/AppProperties';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';

interface DetailsPanelProps {
  adjustments: Adjustments;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  appSettings: AppSettings | null;
  isForMask?: boolean;
  onDragStateChange?: (isDragging: boolean) => void;
}

export default function DetailsPanel({
  adjustments,
  setAdjustments,
  appSettings,
  isForMask = false,
  onDragStateChange,
}: DetailsPanelProps) {
  const handleAdjustmentChange = (key: string, value: string) => {
    const numericValue = parseFloat(value);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: numericValue, lastChanged: key }));
  };

  const handleMaskDragStateChange = useCallback(
    (isDragging: boolean) => {
      onDragStateChange?.(isDragging);
      if (!isForMask) {
        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          sharpeningMaskShowBw: isDragging,
        }));
      }
    },
    [onDragStateChange, isForMask, setAdjustments],
  );

  const handleMaskDebugChange = useCallback(
    (val: boolean) => {
      setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, sharpeningMaskDebug: val }));
    },
    [setAdjustments],
  );

  const adjustmentVisibility = appSettings?.adjustmentVisibility || {};

  return (
    <div className="space-y-4">
      {adjustmentVisibility.sharpening !== false && (
        <div className="p-2 bg-bg-tertiary rounded-md">
          <Text variant={TextVariants.heading} className="mb-2">
            Sharpening
          </Text>
          <Slider
            label="Sharpness"
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Sharpness, e.target.value)}
            step={1}
            value={adjustments.sharpness}
            onDragStateChange={onDragStateChange}
          />

          <Slider
            label="Masking"
            max={1}
            min={0}
            step={0.01}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.SharpeningMask, e.target.value)}
            value={adjustments.sharpeningMask || 0}
            onDragStateChange={handleMaskDragStateChange}
          />
          {!isForMask && (
            <div className="mt-2">
              <Switch
                label="Show Mask Overlay"
                checked={adjustments.sharpeningMaskDebug || false}
                onChange={handleMaskDebugChange}
                tooltip="Display the areas receiving sharpening as a red overlay"
              />
            </div>
          )}
        </div>
      )}

      {adjustmentVisibility.presence !== false && (
        <div className="p-2 bg-bg-tertiary rounded-md">
          <Text variant={TextVariants.heading} className="mb-2">
            Presence
          </Text>
          <Slider
            label="Clarity"
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Clarity, e.target.value)}
            step={1}
            value={adjustments.clarity}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label="Dehaze"
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Dehaze, e.target.value)}
            step={1}
            value={adjustments.dehaze}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label="Structure"
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Structure, e.target.value)}
            step={1}
            value={adjustments.structure}
            onDragStateChange={onDragStateChange}
          />
          {!isForMask && (
            <Slider
              label="Centré"
              max={100}
              min={-100}
              onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Centré, e.target.value)}
              step={1}
              value={adjustments.centré}
              onDragStateChange={onDragStateChange}
            />
          )}
        </div>
      )}

      {/* Hide noise reduction to stop people from thinking it exists
      {adjustmentVisibility.noiseReduction !== false && (
        <div className="p-2 bg-bg-tertiary rounded-md">
          <Text variant={TextVariants.heading} className="mb-2">Noise Reduction</Text>
          <Slider
            label="Luminance"
            max={100}
            min={0}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.LumaNoiseReduction, e.target.value)}
            step={1}
            value={adjustments.lumaNoiseReduction}
          />
          <Slider
            label="Color"
            max={100}
            min={0}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.ColorNoiseReduction, e.target.value)}
            step={1}
            value={adjustments.colorNoiseReduction}
          />
        </div>
      )}
      */}

      {!isForMask && adjustmentVisibility.chromaticAberration !== false && (
        <div className="p-2 bg-bg-tertiary rounded-md">
          <Text variant={TextVariants.heading} className="mb-2">
            Chromatic Aberration
          </Text>
          <Slider
            label="Red/Cyan"
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.ChromaticAberrationRedCyan, e.target.value)}
            step={1}
            value={adjustments.chromaticAberrationRedCyan}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label="Blue/Yellow"
            max={100}
            min={-100}
            onChange={(e: any) =>
              handleAdjustmentChange(DetailsAdjustment.ChromaticAberrationBlueYellow, e.target.value)
            }
            step={1}
            value={adjustments.chromaticAberrationBlueYellow}
            onDragStateChange={onDragStateChange}
          />
        </div>
      )}
    </div>
  );
}
