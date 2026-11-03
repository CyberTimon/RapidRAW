import { useTranslation } from 'react-i18next';
import Slider, { SliderChangeEvent } from '../ui/Slider';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import {
  PANORAMA_FULL_QUALITY,
  panoramaMessage,
  type PanoramaPreview,
  type PanoramaProjection,
} from '../../utils/panorama';

interface PanoramaSidebarProps {
  disabled: boolean;
  onProjectionChange(projection: PanoramaProjection): void;
  onQualityChange(quality: number): void;
  pendingProjection: PanoramaProjection | null;
  preview: PanoramaPreview;
  quality: number;
}

export default function PanoramaSidebar({
  disabled,
  onProjectionChange,
  onQualityChange,
  pendingProjection,
  preview,
  quality,
}: PanoramaSidebarProps) {
  const { t } = useTranslation();
  const activeProjection = pendingProjection ?? preview.selectedProjection;

  return (
    <div className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto">
      <div>
        <Text variant={TextVariants.small} className="uppercase tracking-wide opacity-60 mb-2">
          {t('modals.panorama.projection')}
        </Text>
        <div className="space-y-2">
          {preview.projections.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="projection"
                checked={activeProjection === p}
                disabled={disabled}
                onChange={() => onProjectionChange(p)}
              />
              <span className="capitalize">
                {t(`modals.panorama.projections.${p}`)}
                {preview.recommendedProjection === p ? ` (${t('modals.panorama.recommended')})` : ''}
              </span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <Slider
          defaultValue={PANORAMA_FULL_QUALITY * 100}
          disabled={disabled}
          fillOrigin="min"
          label={t('modals.panorama.quality')}
          max={PANORAMA_FULL_QUALITY * 100}
          min={preview.minQuality * 100}
          step={5}
          suffix="%"
          value={quality * 100}
          onChange={(e: SliderChangeEvent) => onQualityChange(Number(e.target.value) / 100)}
          trackClassName="bg-white/30"
        />
        <p className="mt-1.5 text-[11px] leading-snug text-text-tertiary">{t('modals.panorama.qualityHint')}</p>
      </div>
      {preview.dropped.length > 0 && (
        <div className="p-2 rounded-lg border border-amber-700/40 bg-amber-950/30 text-xs text-amber-200">
          <div className="font-semibold mb-1">{t('modals.panorama.excluded', { count: preview.dropped.length })}</div>
          <ul className="space-y-1.5">
            {preview.dropped.map((d, i) => (
              <li key={i} className="font-mono">
                <div className="truncate">{d.filename}</div>
                <div className="text-amber-200/80 text-[11px] leading-snug">{panoramaMessage(t, d.reason)}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
