import { useTranslation } from 'react-i18next';
import { Film, LocateFixed, MonitorPlay } from 'lucide-react';
import { goToLookTarget } from '../../store/useVideoStore';
import { leaveClipTools, useViewerMode } from '../../store/videoView';
import { preventFocus } from './timeline/PlaybackControls';

export default function ViewerModePill() {
  const { t } = useTranslation();
  const { clipOnly, away } = useViewerMode();
  if (!clipOnly && !away) return null;
  const ActionIcon = away ? LocateFixed : MonitorPlay;

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 h-7 px-1 rounded-full bg-black/60 backdrop-blur-sm text-white text-xs shadow-md">
      {clipOnly && (
        <span className="flex items-center gap-1.5 pl-1.5" data-tooltip={t('video.viewer.clipOnlyHint')}>
          <Film size={12} />
          {t('video.viewer.clipOnly')}
        </span>
      )}
      <button
        type="button"
        className="flex items-center gap-1 h-5 px-2 rounded-full bg-white/15 hover:bg-white/25 transition-colors"
        onMouseDown={preventFocus}
        onClick={away ? goToLookTarget : leaveClipTools}
      >
        <ActionIcon size={12} />
        {away ? t('video.viewer.goToClip') : t('video.viewer.showProgram')}
      </button>
    </div>
  );
}
