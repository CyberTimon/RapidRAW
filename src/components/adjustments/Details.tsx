import { useTranslation } from 'react-i18next';
import { Grip } from 'lucide-react';
import Button from '../ui/Button';
import Slider from '../ui/Slider';
import { Adjustments, DetailsAdjustment } from '../../utils/adjustments';
import { AppSettings } from '../ui/AppProperties';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { useEditorStore } from '../../store/useEditorStore';
import { useUIStore } from '../../store/useUIStore';

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

  // Opens the same modal the right-click "Denoise" context-menu entry opens
  // (useAppContextMenus.ts) — a second, more discoverable entry point into
  // the exact same flow, not a reimplementation of it.
  const handleOpenAiDenoise = () => {
    const { selectedImage } = useEditorStore.getState();
    if (!selectedImage) return;
    const { setUI } = useUIStore.getState();
    setUI({
      denoiseModalState: {
        isOpen: true,
        isProcessing: false,
        previewBase64: null,
        error: null,
        targetPaths: [selectedImage.path],
        progressMessage: null,
        isRaw: selectedImage?.isRaw || false,
      },
    });
  };

  const adjustmentVisibility = appSettings?.adjustmentVisibility || {};

  return (
    <div className="space-y-4">
      {adjustmentVisibility.noiseReduction !== false && (
        <div className="p-2 bg-bg-tertiary rounded-md">
          <Text variant={TextVariants.heading} className="mb-2">
            {t('adjustments.details.noiseReduction')}
          </Text>
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
            <Button onClick={handleOpenAiDenoise} className="w-full mt-3">
              <Grip size={16} />
              {t('adjustments.details.aiDenoiseButton')}
            </Button>
          )}
        </div>
      )}

      {!isForMask && adjustmentVisibility.chromaticAberration !== false && (
        <div className="p-2 bg-bg-tertiary rounded-md">
          <Text variant={TextVariants.heading} className="mb-2">
            {t('adjustments.details.chromaticAberration')}
          </Text>
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
        </div>
      )}
    </div>
  );
}
