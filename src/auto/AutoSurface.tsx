import { lazy, Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutoStore } from './store';
const AutoPanel = lazy(() => import('./AutoPanel'));
export default function AutoSurface() {
  const { t } = useTranslation();
  const open = useAutoStore((s) => s.open);
  const hasBatch = useAutoStore((s) => !!s.lastBatchId);
  const progress = useAutoStore((s) => s.progress);
  const running = !!progress?.running;
  const total = progress?.total ?? 0;
  const completed = progress?.completed ?? 0;
  const progressPercent = total > 0 ? Math.min(100, Math.max(0, (completed / total) * 100)) : 0;
  useEffect(() => {
    if (hasBatch || open) void import('./runtime').then(({ connectAuto }) => connectAuto()).catch(console.error);
  }, [hasBatch, open]);
  if (open)
    return (
      <Suspense fallback={null}>
        <AutoPanel />
      </Suspense>
    );
  return running ? (
    <button
      className="fixed bottom-12 right-4 z-[90] grid w-48 gap-1.5 rounded bg-bg-primary px-3 py-2 text-left text-text-primary shadow-lg"
      onClick={() => useAutoStore.setState({ open: true })}
    >
      <span className="flex items-center justify-between gap-2 text-xs">
        <span>{t('sceneAuto.title')}</span>
        {total > 0 ? (
          <span className="text-text-secondary">
            {completed}/{total}
          </span>
        ) : null}
      </span>
      <span
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface"
        role="progressbar"
        aria-label={t('sceneAuto.title')}
        aria-valuemin={0}
        {...(total > 0 ? { 'aria-valuemax': total, 'aria-valuenow': completed } : {})}
      >
        <span
          className={`block h-full rounded-full bg-accent transition-[width] duration-300 ${
            total > 0 ? '' : 'w-1/3 animate-pulse'
          }`}
          style={total > 0 ? { width: `${progressPercent}%` } : undefined}
        />
      </span>
    </button>
  ) : null;
}
