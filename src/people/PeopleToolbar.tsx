import { useState } from 'react';
import { usePeopleEvents } from './usePeopleEvents';
import { ScanFace, ChevronDown, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../store/useUIStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { peopleInvoke, usePeopleStore } from './store';
import type { PeopleScanScope } from './types';
import { resolvePeopleScope } from './scopes';
import ConfirmModal from '../components/modals/ConfirmModal';
export default function PeopleToolbar({ filteredPaths }: { filteredPaths: string[] }) {
  const { t } = useTranslation();
  const progress = usePeopleStore((s) => s.progress);
  const error = usePeopleStore((s) => s.error);
  const [menu, setMenu] = useState(false);
  const [pending, setPending] = useState<PeopleScanScope | null>(null);
  const [starting, setStarting] = useState(false);
  usePeopleEvents();
  const start = async (scope: PeopleScanScope) => {
    setStarting(true);
    setPending(null);
    setMenu(false);
    try {
      await peopleInvoke('start', { scope });
      localStorage.setItem('people-models-confirmed', '1');
    } catch (e) {
      usePeopleStore.setState({ error: String(e) });
    } finally {
      setStarting(false);
    }
  };
  const choose = (kind: 'context' | 'results' | 'source' | 'roots', force = false, detailed = false) => {
    const library = useLibraryStore.getState();
    const scope = resolvePeopleScope(
      kind,
      library.multiSelectedPaths,
      filteredPaths,
      library.imageList.map((i) => i.path),
      library.rootPaths,
      force,
    );
    scope.detailed = detailed;
    if (!scope.paths.length) return;
    setMenu(false);
    if (localStorage.getItem('people-models-confirmed')) void start(scope);
    else setPending(scope);
  };
  const busy = starting || progress?.running;
  return (
    <div className="px-3 pt-2 flex flex-wrap items-center gap-2 text-sm">
      <button
        className="flex items-center gap-1 p-2 hover:bg-surface rounded-md"
        onClick={() => useUIStore.getState().setUI({ activeView: 'people' })}
      >
        <ScanFace size={17} />
        {t('people.title')}
      </button>
      <button
        className="p-2 hover:bg-surface rounded-md disabled:opacity-40"
        disabled={!!busy}
        onClick={() => choose('context')}
      >
        {t('people.scan')}
      </button>
      <div className="relative">
        <button
          className="p-2 hover:bg-surface rounded-md"
          disabled={!!busy}
          aria-label={t('people.scope')}
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <ChevronDown size={16} />
        </button>
        {menu && (
          <div className="absolute left-0 top-full z-30 bg-bg-secondary shadow-lg rounded-md p-1 min-w-44">
            <button className="block p-2 w-full text-left hover:bg-surface" onClick={() => choose('results')}>
              {t('people.results')}
            </button>
            <button className="block p-2 w-full text-left hover:bg-surface" onClick={() => choose('source')}>
              {t('people.source')}
            </button>
            <button className="block p-2 w-full text-left hover:bg-surface" onClick={() => choose('roots')}>
              {t('people.roots')}
            </button>
            <button
              className="block p-2 w-full text-left hover:bg-surface"
              onClick={() => choose('context', false, true)}
            >
              {t('people.findMore')}
            </button>
            <button className="block p-2 w-full text-left hover:bg-surface" onClick={() => choose('context', true)}>
              {t('people.rescan')}
            </button>
          </div>
        )}
      </div>
      {progress?.stage && (
        <span role="status" className="text-text-secondary">
          {t(`people.stages.${progress.stage}`)}
        </span>
      )}
      {progress && progress.total > 0 && (
        <span role="status" className="text-text-secondary">
          {t('people.progress', {
            processed: progress.processed,
            total: progress.total,
            faces: progress.detectedFaces,
            skipped: progress.skipped,
            failed: progress.failed,
          })}
        </span>
      )}
      {progress?.running && (
        <button
          className="p-2"
          aria-label={t('people.cancel')}
          onClick={() => void peopleInvoke('cancel').catch((e) => usePeopleStore.setState({ error: String(e) }))}
        >
          <X size={16} />
        </button>
      )}
      {error && (
        <span role="alert" className="text-red-600 dark:text-red-400">
          {error}
        </span>
      )}
      <ConfirmModal
        isOpen={!!pending}
        title={t('people.scan')}
        message={t('people.confirm')}
        confirmText={t('people.scan')}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) void start(pending);
        }}
      />
    </div>
  );
}
