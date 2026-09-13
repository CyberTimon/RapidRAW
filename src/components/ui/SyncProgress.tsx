import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useSyncProgressStore } from '../../store/useSyncProgressStore';

export default function SyncProgress() {
  const { t } = useTranslation();
  const jobs = useSyncProgressStore((state) => state.jobs);
  const items = Object.values(jobs);
  if (!items.length) return null;
  const total = items.reduce((sum, job) => sum + job.total, 0);
  const completed = items.reduce((sum, job) => sum + job.completed, 0);
  const remaining = items.filter((job) => job.status === 'running' || job.status === 'queued').length;
  const failed = items.filter((job) => job.status === 'failed').length;
  const label = remaining
    ? t('sync.progress.running', { defaultValue: 'Syncing · {{count}} jobs left', count: remaining })
    : failed
      ? t('sync.progress.failed', 'Sync finished with errors')
      : t('sync.progress.complete', 'Sync complete');
  return (
    <div className="mt-2 text-xs text-text-secondary">
      <div className="flex items-center gap-2">
        <span className="flex-1" role="status">
          {label}
        </span>
        <span className="tabular-nums">
          {completed}/{total}
        </span>
        {!remaining && (
          <button
            aria-label={t('sync.progress.dismiss', 'Dismiss sync progress')}
            className="rounded p-1 hover:bg-surface focus-visible:outline"
            onClick={() => useSyncProgressStore.getState().dismiss()}
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={t('sync.progress.label', 'Photo sync progress')}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
        className="mt-1 h-1 overflow-hidden rounded-full bg-surface"
      >
        <div
          className="h-full bg-accent transition-[width]"
          style={{ width: `${total ? (completed / total) * 100 : 0}%` }}
        />
      </div>
    </div>
  );
}
