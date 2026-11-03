import clsx from 'clsx';
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
        <div role="radiogroup" aria-label={t('modals.panorama.projection')} className="flex flex-col gap-1.5">
          {preview.projections.map((p) => (
            <button
              key={p}
              role="radio"
              aria-checked={activeProjection === p}
              disabled={disabled}
              onClick={() => p !== activeProjection && onProjectionChange(p)}
              className={clsx(
                'px-3 py-1.5 text-sm text-left rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                activeProjection === p
                  ? 'bg-accent text-button-text'
                  : 'bg-bg-primary text-text-primary hover:bg-card-active',
              )}
            >
              {t(`modals.panorama.projections.${p}`)}
              {preview.recommendedProjection === p && (
                <span className="ml-1 opacity-70">({t('modals.panorama.recommended')})</span>
              )}
            </button>
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
        />
        <p className="mt-1.5 text-[11px] leading-snug text-text-secondary">{t('modals.panorama.qualityHint')}</p>
      </div>
      {preview.dropped.length > 0 && (
        <div className="p-2 rounded-lg bg-bg-primary text-xs text-text-primary">
          <div className="font-semibold mb-1">{t('modals.panorama.excluded', { count: preview.dropped.length })}</div>
          <ul className="space-y-1.5">
            {preview.dropped.map((d, i) => (
              <li key={i} className="font-mono">
                <div className="truncate">{d.filename}</div>
                <div className="text-text-secondary text-[11px] leading-snug">{panoramaMessage(t, d.reason)}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
