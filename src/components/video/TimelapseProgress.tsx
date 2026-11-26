import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useTimelapseState } from '../../store/videoTimelapse';

export default function TimelapseProgress({ path, className }: { path: string; className?: string }) {
  const { t } = useTranslation();
  const state = useTimelapseState(path);
  if (state?.state !== 'running') return null;
  const percent = Math.round(state.progress * 100);
  return (
    <div
      className={clsx('h-1 rounded-full overflow-hidden', className)}
      data-tooltip={t('video.timelapse.rendering', { percent })}
    >
      <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
    </div>
  );
}
