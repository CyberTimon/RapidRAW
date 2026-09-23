import { useTranslation } from 'react-i18next';
import Slider from '../ui/Slider';
import { Adjustments, DetailsAdjustment, getAdjustmentToolOrder } from '../../utils/adjustments';
import { AppSettings } from '../ui/AppProperties';
import AdjustmentSubSection from './AdjustmentSubSection';

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
  const { t } = useTranslation();

  const handleAdjustmentChange = (key: string, value: string) => {
    const numericValue = parseInt(value, 10);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: numericValue }));
  };

  const adjustmentVisibility = appSettings?.adjustmentVisibility || {};
  const toolOrder = getAdjustmentToolOrder('details', appSettings?.adjustmentToolOrder);

  return (
    <div className="flex flex-col gap-4">
      {adjustmentVisibility.sharpening !== false && (
        <AdjustmentSubSection
          id="sharpening"
          order={toolOrder.indexOf('sharpening')}
          title={t('adjustments.details.sharpening')}
        >
          <Slider
            label={t('adjustments.details.sharpness')}
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Sharpness, e.target.value)}
            step={1}
            value={adjustments.sharpness}
            onDragStateChange={onDragStateChange}
          />
          {!isForMask && (
            <Slider
              label={t('adjustments.details.threshold')}
              max={80}
              min={0}
              onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.SharpnessThreshold, e.target.value)}
              step={1}
              value={adjustments.sharpnessThreshold ?? 15}
              onDragStateChange={onDragStateChange}
              defaultValue={15}
              fillOrigin="min"
            />
          )}
        </AdjustmentSubSection>
      )}

      {adjustmentVisibility.presence !== false && (
        <AdjustmentSubSection
          id="presence"
          order={toolOrder.indexOf('presence')}
          title={t('adjustments.details.presence')}
        >
          <Slider
            label={t('adjustments.details.clarity')}
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Clarity, e.target.value)}
            step={1}
            value={adjustments.clarity}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label={t('adjustments.details.dehaze')}
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Dehaze, e.target.value)}
            step={1}
            value={adjustments.dehaze}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label={t('adjustments.details.structure')}
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Structure, e.target.value)}
            step={1}
            value={adjustments.structure}
            onDragStateChange={onDragStateChange}
          />
          {!isForMask && (
            <Slider
              label={t('adjustments.details.centre')}
              max={100}
              min={-100}
              onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Centré, e.target.value)}
              step={1}
              value={adjustments.centré}
              onDragStateChange={onDragStateChange}
            />
          )}
        </AdjustmentSubSection>
      )}

      {adjustmentVisibility.noiseReduction !== false && (
        <AdjustmentSubSection
          id="noiseReduction"
          order={toolOrder.indexOf('noiseReduction')}
          title={t('adjustments.details.noiseReduction')}
        >
          <Slider
            label={t('adjustments.details.luminance')}
            max={100}
            min={isForMask ? -100 : 0}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.LumaNoiseReduction, e.target.value)}
            step={1}
            value={adjustments.lumaNoiseReduction}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label={t('adjustments.details.color')}
            max={100}
            min={isForMask ? -100 : 0}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.ColorNoiseReduction, e.target.value)}
            step={1}
            value={adjustments.colorNoiseReduction}
            onDragStateChange={onDragStateChange}
          />
        </AdjustmentSubSection>
      )}

      {!isForMask && adjustmentVisibility.chromaticAberration !== false && (
        <AdjustmentSubSection
          id="chromaticAberration"
          order={toolOrder.indexOf('chromaticAberration')}
          title={t('adjustments.details.chromaticAberration')}
        >
          <Slider
            label={t('adjustments.details.redCyan')}
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.ChromaticAberrationRedCyan, e.target.value)}
            step={1}
            value={adjustments.chromaticAberrationRedCyan}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label={t('adjustments.details.blueYellow')}
            max={100}
            min={-100}
            onChange={(e: any) =>
              handleAdjustmentChange(DetailsAdjustment.ChromaticAberrationBlueYellow, e.target.value)
            }
            step={1}
            value={adjustments.chromaticAberrationBlueYellow}
            onDragStateChange={onDragStateChange}
          />
        </AdjustmentSubSection>
      )}
    </div>
  );
}
