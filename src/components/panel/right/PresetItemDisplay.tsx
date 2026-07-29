import { useMemo, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Crop, Layers, Loader2, Palette, Wrench } from 'lucide-react';
import Text from '../../ui/Text';
import Slider from '../../ui/Slider';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { ADJUSTMENT_GROUPS } from '../../../utils/adjustments';
import { Preset } from '../../ui/AppProperties';

export interface PresetItemDisplayProps {
  isGeneratingPreviews: boolean;
  preset: Preset;
  previewUrl: string;
  isActive?: boolean;
  intensity?: number;
  onIntensityChange?: (val: number) => void;
  onDragStateChange?: (isDragging: boolean) => void;
  // Snapshot mode: replaces the type row and hides preset-only feature badges.
  subtitle?: ReactNode;
  nameSlot?: ReactNode;
}

export default function PresetItemDisplay({
  preset,
  previewUrl,
  isGeneratingPreviews,
  isActive,
  intensity,
  onIntensityChange,
  onDragStateChange,
  subtitle,
  nameSlot,
}: PresetItemDisplayProps) {
  const { t } = useTranslation();
  const geometryKeys = ADJUSTMENT_GROUPS.geometry.flatMap((g) => g.keys);

  const supportsMasks = preset.includeMasks ?? (preset.adjustments?.masks && preset.adjustments.masks.length > 0);
  const supportsGeometry =
    preset.includeCropTransform ?? geometryKeys.some((key) => preset.adjustments?.[key] !== undefined);
  const isTool = preset.presetType === 'tool';
  const showBadges = !subtitle && (supportsMasks || supportsGeometry);
  const tooltipContent = useMemo(() => {
    const features = [];
    if (supportsMasks) features.push(t('editor.presets.supports.masks'));
    if (supportsGeometry) features.push(t('editor.presets.supports.cropTransform'));

    if (features.length === 0) return undefined;
    return t('editor.presets.supports.label', { features: features.join(' + ') });
  }, [supportsMasks, supportsGeometry, t]);

  return (
    <div className="flex flex-col p-2 rounded-lg bg-surface cursor-grabbing">
      <div className="flex items-center gap-3">
        <div
          className="w-20 h-14 bg-bg-tertiary rounded-md flex items-center justify-center shrink-0 relative overflow-hidden"
          data-tooltip={subtitle ? undefined : tooltipContent}
        >
          {isGeneratingPreviews && !previewUrl ? (
            <Loader2 size={20} className="animate-spin text-text-secondary" />
          ) : previewUrl ? (
            <img
              src={previewUrl}
              alt={`${preset.name} preview`}
              className="w-full h-full object-cover rounded-md pointer-events-none"
            />
          ) : (
            <Loader2 size={20} className="animate-spin text-text-secondary" />
          )}

          {showBadges && (
            <>
              <div className="absolute top-0 right-0 w-1/2 h-1/2 bg-linear-to-bl from-black/30 via-black/0 to-transparent pointer-events-none z-0" />

              <div className="absolute top-1 right-1 bg-primary rounded-full px-1.5 py-0.5 flex items-center gap-1.5 backdrop-blur-xs shadow-xs z-10 pointer-events-none">
                {supportsMasks && <Layers size={11} className="text-white" />}
                {supportsGeometry && <Crop size={11} className="text-white" />}
              </div>
            </>
          )}
        </div>

        <div className="grow min-w-0 flex flex-col justify-center">
          {nameSlot ?? (
            <Text color={TextColors.primary} weight={TextWeights.medium} className="truncate">
              {preset.name}
            </Text>
          )}
          <div className="flex items-center gap-1.5 mt-0.5">
            {subtitle ?? (
              <>
                {isTool ? (
                  <Wrench size={12} className="text-text-secondary" />
                ) : (
                  <Palette size={12} className="text-text-secondary" />
                )}
                <Text
                  variant={TextVariants.small}
                  color={TextColors.secondary}
                  className="text-[10px] uppercase tracking-wider"
                >
                  {isTool ? t('editor.presets.types.tool') : t('editor.presets.types.style')}
                </Text>
              </>
            )}
          </div>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isActive && onIntensityChange && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="w-full cursor-auto overflow-hidden"
            onClick={(e: any) => e.stopPropagation()}
            onPointerDown={(e: any) => e.stopPropagation()}
          >
            <div className="mt-3 px-1 pb-1">
              <Slider
                min={0}
                max={200}
                defaultValue={100}
                value={intensity ?? 100}
                onChange={(e: any) => onIntensityChange(Number(e.target.value))}
                onDragStateChange={onDragStateChange}
                label={t('editor.presets.amount')}
                step={1}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
