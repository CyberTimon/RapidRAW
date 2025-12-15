import Slider from '../ui/Slider';
import { Adjustments, DetailsAdjustment, Effect } from '../../utils/adjustments';
import { AppSettings } from '../ui/AppProperties';

interface DetailsPanelProps {
  adjustments: Adjustments;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  appSettings: AppSettings | null;
  isForMask?: boolean;
}

export default function DetailsPanel({
  adjustments,
  setAdjustments,
  appSettings,
  isForMask = false,
}: DetailsPanelProps) {
  const handleAdjustmentChange = (key: string, value: string) => {
    const numericValue = parseInt(value, 10);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: numericValue }));
  };

  const adjustmentVisibility = appSettings?.adjustmentVisibility || {};

  return (
    <div>
      {adjustmentVisibility.sharpening !== false && (
        <div className="mb-4 p-2 bg-bg-tertiary rounded-md">
          <p className="text-md font-semibold mb-2 text-primary">Sharpening</p>
          <Slider
            label="Sharpness"
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Sharpness, e.target.value)}
            step={1}
            value={adjustments.sharpness}
          />
        </div>
      )}

      {adjustmentVisibility.presence !== false && (
        <div className="mb-4 p-2 bg-bg-tertiary rounded-md">
          <p className="text-md font-semibold mb-2 text-primary">Presence</p>
          <Slider
            label="Clarity"
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Clarity, e.target.value)}
            step={1}
            value={adjustments.clarity}
          />
          <Slider
            label="Dehaze"
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Dehaze, e.target.value)}
            step={1}
            value={adjustments.dehaze}
          />
          <Slider
            label="Structure"
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Structure, e.target.value)}
            step={1}
            value={adjustments.structure}
          />
          {!isForMask && (
            <Slider
              label="Centré"
              max={100}
              min={-100}
              onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Centré, e.target.value)}
              step={1}
              value={adjustments.centré}
            />
          )}
        </div>
      )}

      {adjustmentVisibility.noiseReduction !== false && (
        <div className="p-2 bg-bg-tertiary rounded-md">
          <p className="text-md font-semibold mb-2 text-primary">Noise Reduction</p>
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

      {adjustmentVisibility.chromaticAberration !== false && (
        <div className="p-2 bg-bg-tertiary rounded-md">
          <p className="text-md font-semibold mb-2 text-primary">Chromatic Aberration</p>
          <Slider
            label="Red/Cyan"
            max={100}
            min={-100}
            onChange={(e: any) =>
              handleAdjustmentChange(DetailsAdjustment.ChromaticAberrationRedCyan, e.target.value)
            }
            step={1}
            value={adjustments.chromaticAberrationRedCyan}
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
          />
        </div>
      )}
    </div>
  );
}