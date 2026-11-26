import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Pause, Play } from 'lucide-react';
import { useVideoStore } from '../../store/useVideoStore';
import { togglePlay, usePlaybackBlocked } from '../../store/videoPlayback';
import { useShortcut } from '../../hooks/useShortcuts';
import { preventFocus } from './timeline/PlaybackControls';

export default memo(function PlayButton({ disabled = false, className }: { disabled?: boolean; className?: string }) {
  const { t } = useTranslation();
  const isPlaying = useVideoStore((state) => state.isPlaying);
  const blocked = usePlaybackBlocked();
  const shortcut = useShortcut(blocked ? null : 'video_play_pause');
  const label = blocked
    ? t('video.playback.closeCrop')
    : isPlaying
      ? t('video.playback.pause')
      : t('video.playback.play');
  return (
    <button
      className={clsx(
        'w-7 h-7 shrink-0 rounded-full bg-accent text-button-text flex items-center justify-center hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed',
        className,
      )}
      onMouseDown={preventFocus}
      onClick={togglePlay}
      disabled={disabled || blocked}
      data-tooltip={label}
      aria-label={label}
      {...shortcut}
    >
      {isPlaying ? <Pause size={13} className="fill-current" /> : <Play size={13} className="fill-current ml-px" />}
    </button>
  );
});
