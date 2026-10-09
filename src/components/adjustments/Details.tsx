import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Loader2, Sparkles, Trash2 } from 'lucide-react';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import {
  Adjustments,
  DetailsAdjustment,
  getAdjustmentToolOrder,
  getHiddenAdjustmentTools,
} from '../../utils/adjustments';
import { AppSettings, Invokes } from '../ui/AppProperties';
import { useEditorStore } from '../../store/useEditorStore';
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
  const selectedImagePath = useEditorStore((s) => s.selectedImage?.path);
  const isRawImage = useEditorStore((s) => !!s.selectedImage?.isRaw);
  const [hasDenoiseLayer, setHasDenoiseLayer] = useState(false);
  const [isGeneratingDenoise, setIsGeneratingDenoise] = useState(false);
  const [denoiseProgress, setDenoiseProgress] = useState<string | null>(null);
  const [denoiseError, setDenoiseError] = useState<string | null>(null);

  const handleAdjustmentChange = (key: string, value: string) => {
    const numericValue = parseInt(value, 10);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: numericValue }));
  };

  useEffect(() => {
    setDenoiseError(null);
    if (isForMask || !selectedImagePath) {
      setHasDenoiseLayer(false);
      return;
    }
    let cancelled = false;
    invoke<boolean>(Invokes.GetAiDenoiseLayerStatus, { path: selectedImagePath })
      .then((exists) => {
        if (!cancelled) setHasDenoiseLayer(exists);
      })
      .catch(() => {
        if (!cancelled) setHasDenoiseLayer(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedImagePath, isForMask]);

  useEffect(() => {
    if (!isGeneratingDenoise) return;
    const unlisten = listen<string>('denoise-progress', (event) => setDenoiseProgress(event.payload));
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [isGeneratingDenoise]);

  const setDenoiseEnabled = (enabled: boolean) => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, aiDenoiseEnabled: enabled }));
  };

  const isStillSelected = (path: string) => useEditorStore.getState().selectedImage?.path === path;

  const handleGenerateDenoise = async () => {
    if (!selectedImagePath || isGeneratingDenoise) return;
    const path = selectedImagePath;
    const wasEnabled = !!adjustments.aiDenoiseEnabled;
    setIsGeneratingDenoise(true);
    setDenoiseError(null);
    setDenoiseProgress(null);
    try {
      await invoke(Invokes.GenerateAiDenoiseLayer, { path });
      if (isStillSelected(path)) {
        setHasDenoiseLayer(true);
        if (wasEnabled) {
          setDenoiseEnabled(false);
          requestAnimationFrame(() => setDenoiseEnabled(true));
        } else {
          setDenoiseEnabled(true);
        }
      }
    } catch (err) {
      if (isStillSelected(path)) setDenoiseError(String(err));
    } finally {
      setIsGeneratingDenoise(false);
      setDenoiseProgress(null);
    }
  };

  const handleRemoveDenoise = async () => {
    if (!selectedImagePath) return;
    const path = selectedImagePath;
    try {
      await invoke(Invokes.DeleteAiDenoiseLayer, { path });
      if (isStillSelected(path)) {
        setHasDenoiseLayer(false);
        setDenoiseEnabled(false);
      }
    } catch (err) {
      if (isStillSelected(path)) setDenoiseError(String(err));
    }
  };

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
          {!isForMask && (
            <div className="mt-2 flex flex-col gap-2">
              {hasDenoiseLayer ? (
                <div className="flex items-center gap-2">
                  <Switch
                    className="flex-1"
                    label={t('adjustments.details.aiDenoise')}
                    checked={!!adjustments.aiDenoiseEnabled}
                    onChange={setDenoiseEnabled}
                  />
                  <button
                    onClick={handleRemoveDenoise}
                    data-tooltip={t('adjustments.details.aiDenoiseRemove')}
                    className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-card-active transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleGenerateDenoise}
                  disabled={!isRawImage || isGeneratingDenoise}
                  data-tooltip={isRawImage ? undefined : t('adjustments.details.aiDenoiseRawOnly')}
                  className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-md text-sm bg-surface text-text-primary hover:bg-card-active transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isGeneratingDenoise ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  <span>
                    {isGeneratingDenoise
                      ? denoiseProgress || t('adjustments.details.aiDenoiseGenerating')
                      : t('adjustments.details.aiDenoiseGenerate')}
                  </span>
                </button>
              )}
              {denoiseError && (
                <Text variant={TextVariants.small} color={TextColors.error}>
                  {denoiseError}
                </Text>
              )}
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
