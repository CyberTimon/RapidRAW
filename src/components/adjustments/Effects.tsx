import Slider from '../ui/Slider';
import { Adjustments, Effect, CreativeAdjustment } from '../../utils/adjustments';
import LUTControl from '../ui/LUTControl';
import { AppSettings } from '../ui/AppProperties';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';

interface EffectsPanelProps {
  adjustments: Adjustments;
  isForMask: boolean;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  handleLutSelect(path: string): void;
  appSettings: AppSettings | null;
  onDragStateChange?: (isDragging: boolean) => void;
}

export default function EffectsPanel({
  adjustments,
  setAdjustments,
  isForMask = false,
  handleLutSelect,
  appSettings,
  onDragStateChange,
}: EffectsPanelProps) {
  const handleAdjustmentChange = (key: string, value: number) => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: Math.trunc(value) }));
  };

  const handleLutIntensityChange = (intensity: number) => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, lutIntensity: intensity }));
  };

  const handleLutClear = () => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      lutPath: null,
      lutName: null,
      lutData: null,
      lutSize: 0,
      lutIntensity: 100,
    }));
  };

  const adjustmentVisibility = appSettings?.adjustmentVisibility || {};

  return (
    <div className="space-y-4">
      <div className="p-2 bg-bg-tertiary rounded-md">
        <Text variant={TextVariants.heading} className="mb-2">
          Creative
        </Text>

        <Slider
          label="Glow"
          max={100}
          min={0}
          onChange={(value) => handleAdjustmentChange(CreativeAdjustment.GlowAmount, value)}
          step={1}
          value={adjustments.glowAmount}
          onDragStateChange={onDragStateChange}
        />

        <Slider
          label="Halation"
          max={100}
          min={0}
          onChange={(value) => handleAdjustmentChange(CreativeAdjustment.HalationAmount, value)}
          step={1}
          value={adjustments.halationAmount}
          onDragStateChange={onDragStateChange}
        />

        {!isForMask && (
          <Slider
            label="Light Flares"
            max={100}
            min={0}
            onChange={(value) => handleAdjustmentChange(CreativeAdjustment.FlareAmount, value)}
            step={1}
            value={adjustments.flareAmount}
            onDragStateChange={onDragStateChange}
          />
        )}
      </div>

      {!isForMask && (
        <div className="space-y-4">
          <div className="p-2 bg-bg-tertiary rounded-md">
            <Text variant={TextVariants.heading} className="mb-2">
              LUT
            </Text>
            <LUTControl
              lutName={adjustments.lutName || null}
              lutIntensity={adjustments.lutIntensity || 100}
              onLutSelect={handleLutSelect}
              onIntensityChange={handleLutIntensityChange}
              onClear={handleLutClear}
              onDragStateChange={onDragStateChange}
            />
          </div>

          {adjustmentVisibility.vignette !== false && (
            <div className="p-2 bg-bg-tertiary rounded-md">
              <Text variant={TextVariants.heading} className="mb-2">
                Vignette
              </Text>
              <Slider
                label="Amount"
                max={100}
                min={-100}
                onChange={(value) => handleAdjustmentChange(Effect.VignetteAmount, value)}
                step={1}
                value={adjustments.vignetteAmount}
                onDragStateChange={onDragStateChange}
              />
              <Slider
                defaultValue={50}
                label="Midpoint"
                max={100}
                min={0}
                onChange={(value) => handleAdjustmentChange(Effect.VignetteMidpoint, value)}
                step={1}
                value={adjustments.vignetteMidpoint}
                onDragStateChange={onDragStateChange}
              />
              <Slider
                label="Roundness"
                max={100}
                min={-100}
                onChange={(value) => handleAdjustmentChange(Effect.VignetteRoundness, value)}
                step={1}
                value={adjustments.vignetteRoundness}
                onDragStateChange={onDragStateChange}
              />
              <Slider
                defaultValue={50}
                label="Feather"
                max={100}
                min={0}
                onChange={(value) => handleAdjustmentChange(Effect.VignetteFeather, value)}
                step={1}
                value={adjustments.vignetteFeather}
                onDragStateChange={onDragStateChange}
              />
            </div>
          )}

          {adjustmentVisibility.grain !== false && (
            <div className="p-2 bg-bg-tertiary rounded-md">
              <Text variant={TextVariants.heading} className="mb-2">
                Grain
              </Text>
              <Slider
                label="Amount"
                max={100}
                min={0}
                onChange={(value) => handleAdjustmentChange(Effect.GrainAmount, value)}
                step={1}
                value={adjustments.grainAmount}
                onDragStateChange={onDragStateChange}
              />
              <Slider
                defaultValue={25}
                label="Size"
                max={100}
                min={0}
                onChange={(value) => handleAdjustmentChange(Effect.GrainSize, value)}
                step={1}
                value={adjustments.grainSize}
                onDragStateChange={onDragStateChange}
              />
              <Slider
                defaultValue={50}
                label="Roughness"
                max={100}
                min={0}
                onChange={(value) => handleAdjustmentChange(Effect.GrainRoughness, value)}
                step={1}
                value={adjustments.grainRoughness}
                onDragStateChange={onDragStateChange}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
