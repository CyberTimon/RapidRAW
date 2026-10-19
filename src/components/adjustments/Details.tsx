import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import Slider, { SliderChangeEvent } from '../ui/Slider';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { SpatialEffect } from './Effects';
import {
  Adjustments,
  DetailsAdjustment,
  getAdjustmentToolOrder,
  getHiddenAdjustmentTools,
} from '../../utils/adjustments';
import { AppSettings } from '../ui/AppProperties';
import AdjustmentSubSection from './AdjustmentSubSection';
import { useEditorStore } from '../../store/useEditorStore';
import { useProcessStore } from '../../store/useProcessStore';

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
  const setEditor = useEditorStore((state) => state.setEditor);
  const aiDenoiseProgress = useEditorStore((state) =>
    state.selectedImage ? state.aiDenoiseProgress[state.selectedImage.path] : undefined,
  );
  const aiModelDownloadStatus = useProcessStore((state) => state.aiModelDownloadStatus);

  const handleAdjustmentChange = (key: string, value: string) => {
    const numericValue = parseInt(value, 10);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: numericValue }));
  };

  const isAiFree = appSettings?.aiProvider === 'ai-free';
  const hiddenTools = getHiddenAdjustmentTools(appSettings?.adjustmentLayout);
  const toolOrder = getAdjustmentToolOrder('details', appSettings?.adjustmentLayout?.toolOrder);

  return (
    <div className="flex flex-col gap-4">
      {!hiddenTools.includes('sharpening') && (
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

      {!hiddenTools.includes('presence') && (
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
            <div
              data-center-marker-controls="centre"
              onPointerDown={() =>
                setEditor({ activeCenterMarker: 'centre', isRelightPickerActive: false, isWbPickerActive: false })
              }
            >
              <Slider
                label={t('adjustments.details.centre')}
                max={100}
                min={-100}
                onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Centré, e.target.value)}
                step={1}
                value={adjustments.centré}
                onDragStateChange={onDragStateChange}
              />
            </div>
          )}
        </AdjustmentSubSection>
      )}

      {!hiddenTools.includes('noiseReduction') && (
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
          {!isForMask && !isAiFree && (
            <div className="mt-2">
              <SpatialEffect
                enabled={!!adjustments.aiDenoiseEnabled}
                label={t('adjustments.details.aiDenoise')}
                onToggle={(enabled: boolean) =>
                  setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, aiDenoiseEnabled: enabled }))
                }
              >
                {aiDenoiseProgress !== undefined ? (
                  <div
                    className="flex flex-col items-center justify-center gap-1 p-4 text-text-secondary text-center"
                    data-tooltip={aiModelDownloadStatus ? undefined : t('modals.denoise.gpuWarningTooltip')}
                  >
                    <div className="flex items-center gap-2">
                      <Loader2 size={16} className="animate-spin shrink-0" />
                      <Text variant={TextVariants.label}>
                        {aiModelDownloadStatus
                          ? t('editor.masks.settings.aiModelDownloading')
                          : t('editor.ai.denoising')}
                      </Text>
                    </div>
                    <Text variant={TextVariants.small} className="text-accent">
                      {aiModelDownloadStatus || `${Math.round(aiDenoiseProgress * 100)}%`}
                    </Text>
                  </div>
                ) : (
                  <>
                    <Slider
                      label={t('adjustments.effects.amount')}
                      max={100}
                      min={0}
                      defaultValue={100}
                      onChange={(e: SliderChangeEvent) =>
                        handleAdjustmentChange(DetailsAdjustment.AiDenoiseAmount, String(e.target.value))
                      }
                      step={1}
                      value={adjustments.aiDenoiseAmount ?? 100}
                      onDragStateChange={onDragStateChange}
                      fillOrigin="min"
                    />
                    <Slider
                      label={t('adjustments.details.aiDenoiseDetail')}
                      max={100}
                      min={0}
                      onChange={(e: SliderChangeEvent) =>
                        handleAdjustmentChange(DetailsAdjustment.AiDenoiseDetail, String(e.target.value))
                      }
                      step={1}
                      value={adjustments.aiDenoiseDetail ?? 0}
                      onDragStateChange={onDragStateChange}
                    />
                  </>
                )}
              </SpatialEffect>
            </div>
          )}
        </AdjustmentSubSection>
      )}

      {!isForMask && !hiddenTools.includes('chromaticAberration') && (
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
