import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'react-toastify';
import i18n from 'i18next';
import { useAutoStore } from './store';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useProcessStore } from '../store/useProcessStore';
import { INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments, type Adjustments } from '../utils/adjustments';
import { globalImageCache } from '../utils/ImageLRUCache';
import { markAutoHydration, isAutoHydration as isPersisted } from './editSafety';
import { debouncedSave, debouncedSetHistory } from '../hooks/useEditorActions';
import type { AutoBatchInspection, AutoProgress, AutoOptions } from './types';
import { prepareAutoApplyOptions } from './applyOptions';

let listener: Promise<() => void> | undefined;
let hydrated = new Set<string>();
let activeJobId: string | null = null;
let dispatching = false;
let editorAtStart: Adjustments | null = null;
let libraryAtStart: Adjustments | null = null;
async function accept(progress: AutoProgress) {
  if (dispatching || (activeJobId && activeJobId !== progress.id)) return;
  activeJobId = progress.id;
  const current = useAutoStore.getState();
  useAutoStore.setState({ progress, lastBatchId: progress.batchId || current.lastBatchId });
  const paths = progress.changed.filter((path) => !hydrated.has(path));
  for (const path of paths) {
    hydrated.add(path);
    globalImageCache.delete(path);
  }
  if (!paths.length) return;
  const changed = new Set(paths);
  useProcessStore.setState((state) => {
    const previews = { ...state.previews };
    for (const path of paths) {
      if (previews[path]) {
        URL.revokeObjectURL(previews[path].url);
        delete previews[path];
      }
    }
    return { previews };
  });
  const editor = useEditorStore.getState();
  const library = useLibraryStore.getState();
  const active = new Set(
    [editor.selectedImage?.path, library.libraryActivePath].filter((p): p is string => !!p && changed.has(p)),
  );
  for (const path of active) {
    const meta = await invoke<{ adjustments: Adjustments }>('load_metadata', { path });
    const normalized = markAutoHydration(
      normalizeLoadedAdjustments(meta.adjustments || INITIAL_ADJUSTMENTS) as Adjustments,
    );
    if (activeJobId !== progress.id) return;
    const latestEditor = useEditorStore.getState();
    const latestLibrary = useLibraryStore.getState();
    if (latestEditor.selectedImage?.path === path && latestEditor.adjustments === editorAtStart) {
      useEditorStore.setState({ adjustments: normalized });
      editorAtStart = normalized;
      useEditorStore.getState().resetHistory(normalized);
    }
    if (latestLibrary.libraryActivePath === path && latestLibrary.libraryActiveAdjustments === libraryAtStart) {
      useLibraryStore.setState({ libraryActiveAdjustments: normalized });
      libraryAtStart = normalized;
    }
  }
}
export async function connectAuto() {
  listener ??= listen<AutoProgress>('scene-auto-progress', ({ payload }) => {
    void accept(payload).catch(console.error);
  });
  await listener;
  const status = await invoke<AutoProgress>('plugin:scene-auto|status');
  if (status.id) await accept(status);
  else {
    const { lastBatchId } = useAutoStore.getState();
    if (lastBatchId) {
      try {
        const batch = await invoke<AutoBatchInspection>('plugin:scene-auto|inspect', {
          id: lastBatchId,
        });
        useAutoStore.setState({
          canRetune: batch.canRetune,
          progress: { ...status, batchId: lastBatchId, groups: batch.groups, phase: 'complete' },
        });
      } catch {
        useAutoStore.setState({ lastBatchId: null });
      }
    }
  }
}
export async function runAuto(paths: string[], mode: 'apply' | 'tune' | 'undo' = 'apply', options?: AutoOptions) {
  const state = useAutoStore.getState();
  if (state.pending || state.progress?.running) return;
  if (mode === 'apply' && !paths.length) return;
  useAutoStore.setState({ pending: true, open: true, ...(mode === 'apply' ? { canRetune: true } : {}) });
  try {
    await connectAuto();
    await debouncedSave.flush();
    debouncedSetHistory.flush();
    const editor = useEditorStore.getState();
    // Flush the selected editor synchronously before the batch snapshots metadata.
    if (
      editor.selectedImage?.isReady &&
      (mode !== 'apply' || paths.includes(editor.selectedImage.path)) &&
      !isPersisted(editor.adjustments)
    ) {
      const path = editor.selectedImage.path;
      const saved = await invoke<{ adjustments: Adjustments }>('load_metadata', { path });
      // Opening an Auto result hydrates default fields; that alone is not a new edit.
      const normalized = normalizeLoadedAdjustments(saved.adjustments || INITIAL_ADJUSTMENTS);
      if (JSON.stringify(normalized) !== JSON.stringify(editor.adjustments)) {
        await invoke('save_metadata_and_update_thumbnail', { path, adjustments: editor.adjustments });
      }
    }
    editorAtStart = useEditorStore.getState().adjustments;
    libraryAtStart = useLibraryStore.getState().libraryActiveAdjustments;
    hydrated = new Set();
    dispatching = true;
    const requestedOptions = options || state.options;
    const id = await invoke<string>('plugin:scene-auto|start_job', {
      paths,
      options: mode === 'apply' ? prepareAutoApplyOptions(requestedOptions, paths.length) : requestedOptions,
      batchId: mode === 'apply' ? null : state.lastBatchId,
      undo: mode === 'undo',
    });
    activeJobId = id;
    dispatching = false;
    // Covers jobs that complete between command dispatch and listener registration/reconnection.
    await accept(await invoke<AutoProgress>('plugin:scene-auto|status'));
  } catch (error) {
    toast.error(i18n.t('sceneAuto.error', { error: String(error) }));
  } finally {
    dispatching = false;
    useAutoStore.setState({ pending: false });
  }
}
