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
import AutoAdjustmentPicker from './AutoAdjustmentPicker';
import Switch from '../components/ui/Switch';
import { runAuto } from './runtime';
import { resolveAutoPanelPaths } from './applyOptions';
const AutoGroups = lazy(() => import('./AutoGroups'));

export default memo(function AutoPanel() {
  const { t } = useTranslation();
  const { open, options, progress, pending, lastBatchId, canRetune, setAuto } = useAutoStore();
  const selected = useLibraryStore((s) => s.multiSelectedPaths);
  const libraryPath = useLibraryStore((s) => s.libraryActivePath);
  const editorPath = useEditorStore((s) => s.selectedImage?.path);
  const view = useUIStore((s) => s.activeView);
  const paths = resolveAutoPanelPaths(view, editorPath, selected, libraryPath);
  const busy = pending || !!progress?.running;
  const activeProgress = progress?.running ? progress : pending ? null : progress;
  const completed = activeProgress?.completed ?? 0;
  const total = activeProgress?.total ?? 0;
  const hasProgressTotal = total > 0;
  const progressPercent = hasProgressTotal ? Math.min(100, Math.max(0, (completed / total) * 100)) : 0;
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
        <AutoAdjustmentPicker
          value={options.adjustments}
          disabled={busy}
          onChange={(adjustments) => setAuto({ options: { ...options, adjustments } })}
        />
        <AutoControls
          value={options.controls}
          disabled={busy}
          onChange={(controls) => setAuto({ options: { ...options, controls } })}
        />
        <Switch
          checked={options.skipEdited}
          disabled={busy}
          label={t('sceneAuto.skipEdited')}
          onChange={(checked) => setAuto({ options: { ...options, skipEdited: checked } })}
        />
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
              setAuto({ options: { ...options, groups: {} } });
              void runAuto(paths);
            }}
          >
            {t('sceneAuto.apply', { count: paths.length })}
          </button>
          {lastBatchId ? (
            <>
              {canRetune ? (
                <button
                  disabled={busy}
                  className="rounded px-2 py-2 hover:bg-surface disabled:opacity-50"
                  onClick={() => {
                    void runAuto([], 'tune');
                  }}
                >
                  {t('sceneAuto.update')}
                </button>
              ) : null}
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
        {busy ? (
          <div className="grid gap-1.5" role="status" aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-text-secondary">
              <span>{t(`sceneAuto.phases.${activeProgress?.phase || 'preparing'}`)}</span>
              {hasProgressTotal ? (
                <span>
                  {completed}/{total}
                </span>
              ) : null}
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface"
              role="progressbar"
              aria-label={t('sceneAuto.title')}
              aria-valuemin={0}
              {...(hasProgressTotal ? { 'aria-valuemax': total, 'aria-valuenow': completed } : {})}
            >
              <div
                className={`h-full rounded-full bg-accent transition-[width] duration-300 ${
                  hasProgressTotal ? '' : 'w-1/3 animate-pulse'
                }`}
                style={hasProgressTotal ? { width: `${progressPercent}%` } : undefined}
              />
            </div>
          </div>
        ) : progress ? (
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
