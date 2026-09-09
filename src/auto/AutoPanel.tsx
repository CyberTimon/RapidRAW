import { lazy, memo, Suspense } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { useAutoStore } from './store';
import { useLibraryStore } from '../store/useLibraryStore';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import AutoControls from './AutoControls';
import { runAuto } from './runtime';
const AutoGroups = lazy(() => import('./AutoGroups'));

export default memo(function AutoPanel() {
  const { t } = useTranslation();
  const { open, enabled, options, progress, pending, lastBatchId, setAuto } = useAutoStore();
  const selected = useLibraryStore((s) => s.multiSelectedPaths);
  const libraryPath = useLibraryStore((s) => s.libraryActivePath);
  const editorPath = useEditorStore((s) => s.selectedImage?.path);
  const view = useUIStore((s) => s.activeView);
  const paths = selected.length
    ? selected
    : view === 'library'
      ? libraryPath
        ? [libraryPath]
        : []
      : editorPath
        ? [editorPath]
        : [];
  const busy = pending || !!progress?.running;
  if (!open) return null;
  return (
    <aside
      aria-label={t('sceneAuto.title')}
      className="fixed bottom-12 right-4 z-[90] w-[min(25rem,calc(100vw-2rem))] rounded-lg bg-bg-primary text-text-primary shadow-xl font-sans text-sm"
    >
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="font-medium flex items-center gap-2">
          <SlidersHorizontal size={16} />
          {t('sceneAuto.title')}
        </span>
        <button
          type="button"
          onClick={() => setAuto({ open: false })}
          aria-label={t('sceneAuto.close')}
          className="p-2 hover:bg-surface rounded"
        >
          <X size={16} />
        </button>
      </div>
      <div className="max-h-[65vh] overflow-y-auto px-3 pb-3 grid gap-3">
        <label className="flex gap-2 items-center">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => setAuto({ enabled: e.target.checked })}
          />
          {t('sceneAuto.enable')}
        </label>
        <AutoControls
          value={options.controls}
          disabled={busy}
          onChange={(controls) => setAuto({ options: { ...options, controls } })}
        />
        <label className="flex gap-2 items-center">
          <input
            type="checkbox"
            checked={options.skipEdited}
            disabled={busy}
            onChange={(e) => setAuto({ options: { ...options, skipEdited: e.target.checked } })}
          />
          {t('sceneAuto.skipEdited')}
        </label>
        {progress?.groups.length ? (
          <Suspense fallback={null}>
            <AutoGroups
              groups={progress.groups}
              options={options}
              disabled={busy}
              onChange={(next) => setAuto({ options: next })}
            />
          </Suspense>
        ) : null}
        <div className="flex items-center gap-2">
          <button
            disabled={busy || !paths.length}
            className="rounded bg-surface px-3 py-2 hover:bg-card-active disabled:opacity-50"
            onClick={() => {
              setAuto({ enabled: true, options: { ...options, groups: {} } });
              void runAuto(paths);
            }}
          >
            {t('sceneAuto.apply', { count: paths.length })}
          </button>
          {lastBatchId ? (
            <>
              <button
                disabled={busy}
                className="rounded px-2 py-2 hover:bg-surface disabled:opacity-50"
                onClick={() => {
                  void runAuto([], 'tune');
                }}
              >
                {t('sceneAuto.update')}
              </button>
              <button
                disabled={busy}
                className="rounded px-2 py-2 hover:bg-surface disabled:opacity-50"
                onClick={() => {
                  void runAuto([], 'undo');
                }}
              >
                {t('sceneAuto.undo')}
              </button>
            </>
          ) : null}
          {progress?.running ? (
            <button
              className="rounded px-2 py-2 hover:bg-surface"
              onClick={() => {
                void invoke('plugin:scene-auto|cancel', { id: progress.id }).catch((error) =>
                  toast.error(String(error)),
                );
              }}
            >
              {t('sceneAuto.cancel')}
            </button>
          ) : null}
        </div>
        {progress ? (
          <div role="status" aria-live="polite" className="text-text-secondary">
            {t(`sceneAuto.phases.${progress.phase || 'complete'}`)} {progress.completed}/{progress.total}
            {progress.skipped.length ? (
              <span> · {t('sceneAuto.skipped', { count: progress.skipped.length })}</span>
            ) : null}
          </div>
        ) : null}
        {progress && (Object.keys(progress.failures).length || Object.keys(progress.warnings).length) ? (
          <details>
            <summary className="cursor-pointer">{t('sceneAuto.details')}</summary>
            <ul className="mt-2 space-y-1">
              {[...Object.entries(progress.failures), ...Object.entries(progress.warnings)].map(
                ([path, message], index) => (
                  <li key={`${path}-${index}`}>
                    <span className="font-medium">{path.split(/[\\/]/).pop()}</span>: {message}
                  </li>
                ),
              )}
            </ul>
          </details>
        ) : null}
      </div>
    </aside>
  );
});
