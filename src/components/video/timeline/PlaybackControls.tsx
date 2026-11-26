import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { Check, MonitorPlay } from 'lucide-react';
import { OPTION_SEPARATOR } from '../../../types/ui';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { PlaybackQuality, setVideo, useVideoStore } from '../../../store/useVideoStore';
import { requestProgramFrame } from '../../../store/videoView';

const QUALITIES: Array<PlaybackQuality> = ['auto', 'full', 'half', 'quarter'];

export const preventFocus = (event: React.MouseEvent) => event.preventDefault();

export const PlaybackMenuButton = memo(function PlaybackMenuButton() {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const { quality, useProxies } = useVideoStore(
    useShallow((s) => ({ quality: s.playbackQuality, useProxies: s.useProxies })),
  );
  const open = (event: React.MouseEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom + 4, [
      ...QUALITIES.map((option) => ({
        icon: option === quality ? Check : undefined,
        label: t(`video.timeline.quality.${option}`),
        onClick: () => {
          setVideo({ playbackQuality: option });
          void requestProgramFrame();
        },
      })),
      { type: OPTION_SEPARATOR },
      {
        icon: useProxies ? Check : undefined,
        label: t('video.timeline.useProxies'),
        onClick: () => {
          setVideo({ useProxies: !useProxies });
          void requestProgramFrame();
        },
      },
    ]);
  };
  return (
    <button
      className="h-8 px-2 shrink-0 flex items-center gap-1.5 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
      onMouseDown={preventFocus}
      onClick={open}
      data-tooltip={t('video.timeline.playbackSettings')}
      aria-label={t('video.timeline.playbackSettings')}
    >
      <MonitorPlay size={16} />
      <span className="text-xs">{t(`video.timeline.qualityShort.${quality}`)}</span>
    </button>
  );
});
