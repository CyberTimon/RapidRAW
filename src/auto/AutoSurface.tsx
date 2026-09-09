import { lazy, Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutoStore } from './store';
const AutoPanel = lazy(() => import('./AutoPanel'));
export default function AutoSurface() {
  const { t } = useTranslation();
  const open = useAutoStore((s) => s.open);
  const enabled = useAutoStore((s) => s.enabled);
  const hasBatch = useAutoStore((s) => !!s.lastBatchId);
  const running = useAutoStore((s) => !!s.progress?.running);
  useEffect(() => {
    if (enabled || hasBatch || open)
      void import('./runtime').then(({ connectAuto }) => connectAuto()).catch(console.error);
  }, [enabled, hasBatch, open]);
  if (open)
    return (
      <Suspense fallback={null}>
        <AutoPanel />
      </Suspense>
    );
  return running ? (
    <button
      className="fixed bottom-12 right-4 z-[90] rounded bg-bg-primary text-text-primary px-3 py-2 shadow-lg"
      onClick={() => useAutoStore.setState({ open: true })}
    >
      {t('sceneAuto.title')}
    </button>
  ) : null;
}
