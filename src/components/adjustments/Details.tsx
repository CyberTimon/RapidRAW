import Slider from '../ui/Slider';
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
  const handleAdjustmentChange = (key: string, value: number) => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: Math.trunc(value) }));
  };

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
            onChange={(value) => handleAdjustmentChange(DetailsAdjustment.Sharpness, value)}
            step={1}
            value={adjustments.sharpness}
            onDragStateChange={onDragStateChange}
          />
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
            onChange={(value) => handleAdjustmentChange(DetailsAdjustment.Clarity, value)}
            step={1}
            value={adjustments.clarity}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label="Dehaze"
            max={100}
            min={-100}
            onChange={(value) => handleAdjustmentChange(DetailsAdjustment.Dehaze, value)}
            step={1}
            value={adjustments.dehaze}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label="Structure"
            max={100}
            min={-100}
            onChange={(value) => handleAdjustmentChange(DetailsAdjustment.Structure, value)}
            step={1}
            value={adjustments.structure}
            onDragStateChange={onDragStateChange}
          />
          {!isForMask && (
            <Slider
              label="Centré"
              max={100}
              min={-100}
              onChange={(value) => handleAdjustmentChange(DetailsAdjustment.Centré, value)}
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
            onChange={(value) => handleAdjustmentChange(DetailsAdjustment.LumaNoiseReduction, value)}
            step={1}
            value={adjustments.lumaNoiseReduction}
          />
          <Slider
            label="Color"
            max={100}
            min={0}
            onChange={(value) => handleAdjustmentChange(DetailsAdjustment.ColorNoiseReduction, value)}
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
            onChange={(value) => handleAdjustmentChange(DetailsAdjustment.ChromaticAberrationRedCyan, value)}
            step={1}
            value={adjustments.chromaticAberrationRedCyan}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label="Blue/Yellow"
            max={100}
            min={-100}
            onChange={(value) => handleAdjustmentChange(DetailsAdjustment.ChromaticAberrationBlueYellow, value)}
            step={1}
            value={adjustments.chromaticAberrationBlueYellow}
            onDragStateChange={onDragStateChange}
          />
        </div>
      )}
    </div>
  );
}
