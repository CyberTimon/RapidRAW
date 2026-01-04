import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import { Adjustments, Effect } from '../../utils/adjustments';
import LUTControl from '../ui/LUTControl';
import { AppSettings } from '../ui/AppProperties';

interface EffectsPanelProps {
  adjustments: Adjustments;
  isForMask: boolean;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  handleLutSelect(path: string): void;
  appSettings: AppSettings | null;
}

export default function EffectsPanel({
  adjustments,
  setAdjustments,
  isForMask = false,
  handleLutSelect,
  appSettings,
}: EffectsPanelProps) {
  const handleAdjustmentChange = (key: Effect, value: string) => {
    const numericValue = parseInt(value, 10);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: numericValue }));
  };

  const handleCheckedChange = (key: Effect, checked: boolean) => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: checked }));
  };

  const handleColorChange = (key: Effect, value: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: value }));
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
    <div>
      {!isForMask && (
        <>
          <div className="my-4 p-2 bg-bg-tertiary rounded-md">
            <p className="text-md font-semibold mb-2 text-primary">LUT</p>
            <LUTControl
              lutName={adjustments.lutName || null}
              lutIntensity={adjustments.lutIntensity || 100}
              onLutSelect={handleLutSelect}
              onIntensityChange={handleLutIntensityChange}
              onClear={handleLutClear}
            />
          </div>

          {adjustmentVisibility.negativeConversion !== false && (
            <div className="mb-4 p-2 bg-bg-tertiary rounded-md">
              <p className="text-md font-semibold mb-2 text-primary">Negative Conversion</p>
              <div className="mb-2">
                <Switch
                  label="Enable"
                  checked={!!adjustments.enableNegativeConversion}
                  onChange={(checked: boolean) => handleCheckedChange(Effect.EnableNegativeConversion, checked)}
                />
              </div>
              {adjustments.enableNegativeConversion && (
                <div className="space-y-2 mt-2 pt-2 border-t border-bg-secondary">
                  <div className="flex items-center justify-between">
                    <label htmlFor="filmBaseColor" className="text-sm font-medium text-text-primary">
                      Film Base Color
                    </label>
                    <input
                      className="p-0 h-8 w-12 border-none rounded-md cursor-pointer bg-bg-secondary"
                      id="filmBaseColor"
                      onChange={(e: any) => handleColorChange(Effect.FilmBaseColor, e.target.value)}
                      type="color"
                      value={adjustments.filmBaseColor || '#ff8800'}
                    />
                  </div>
                  <Slider
                    label="Red Balance"
                    max={100}
                    min={-100}
                    onChange={(e: any) => handleAdjustmentChange(Effect.NegativeRedBalance, e.target.value)}
                    step={1}
                    value={adjustments.negativeRedBalance || 0}
                  />
                  <Slider
                    label="Green Balance"
                    max={100}
                    min={-100}
                    onChange={(e: any) => handleAdjustmentChange(Effect.NegativeGreenBalance, e.target.value)}
                    step={1}
                    value={adjustments.negativeGreenBalance || 0}
                  />
                  <Slider
                    label="Blue Balance"
                    max={100}
                    min={-100}
                    onChange={(e: any) => handleAdjustmentChange(Effect.NegativeBlueBalance, e.target.value)}
                    step={1}
                    value={adjustments.negativeBlueBalance || 0}
                  />
                </div>
              )}
            </div>
          )}

          {adjustmentVisibility.vignette !== false && (
            <div className="mb-4 p-2 bg-bg-tertiary rounded-md">
              <p className="text-md font-semibold mb-2 text-primary">Vignette</p>
              <Slider
                label="Amount"
                max={100}
                min={-100}
                onChange={(e: any) => handleAdjustmentChange(Effect.VignetteAmount, e.target.value)}
                step={1}
                value={adjustments.vignetteAmount}
              />
              <Slider
                defaultValue={50}
                label="Midpoint"
                max={100}
                min={0}
                onChange={(e: any) => handleAdjustmentChange(Effect.VignetteMidpoint, e.target.value)}
                step={1}
                value={adjustments.vignetteMidpoint}
              />
              <Slider
                label="Roundness"
                max={100}
                min={-100}
                onChange={(e: any) => handleAdjustmentChange(Effect.VignetteRoundness, e.target.value)}
                step={1}
                value={adjustments.vignetteRoundness}
              />
              <Slider
                defaultValue={50}
                label="Feather"
                max={100}
                min={0}
                onChange={(e: any) => handleAdjustmentChange(Effect.VignetteFeather, e.target.value)}
                step={1}
                value={adjustments.vignetteFeather}
              />
            </div>
          )}

          {adjustmentVisibility.grain !== false && (
            <div className="p-2 bg-bg-tertiary rounded-md">
              <p className="text-md font-semibold mb-2 text-primary">Grain</p>
              <Slider
                label="Amount"
                max={100}
                min={0}
                onChange={(e: any) => handleAdjustmentChange(Effect.GrainAmount, e.target.value)}
                step={1}
                value={adjustments.grainAmount}
              />
              <Slider
                defaultValue={25}
                label="Size"
                max={100}
                min={0}
                onChange={(e: any) => handleAdjustmentChange(Effect.GrainSize, e.target.value)}
                step={1}
                value={adjustments.grainSize}
              />
              <Slider
                defaultValue={50}
                label="Roughness"
                max={100}
                min={0}
                onChange={(e: any) => handleAdjustmentChange(Effect.GrainRoughness, e.target.value)}
                step={1}
                value={adjustments.grainRoughness}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}