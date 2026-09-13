import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../components/ui/AppProperties';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { globalImageCache } from '../utils/ImageLRUCache';
import { INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments, type Adjustments } from '../utils/adjustments';
import { recordUndoableAction } from './actionHistory';
import { queueMetadataSave } from './persistence';
import { markHistoryReplay } from './replay';

export type AdjustmentSnapshots = Record<string, Adjustments>;

export async function captureAdjustmentSnapshots(paths: string[]) {
  const uniquePaths = [...new Set(paths)];
  const entries = await Promise.all(
    uniquePaths.map(async (path) => {
      const metadata = await invoke<{ adjustments?: Adjustments }>(Invokes.LoadMetadata, { path });
      return [path, normalizeLoadedAdjustments(metadata?.adjustments || INITIAL_ADJUSTMENTS)] as const;
    }),
  );
  return Object.fromEntries(entries) as AdjustmentSnapshots;
}

function applySnapshots(snapshots: AdjustmentSnapshots) {
  const editor = useEditorStore.getState();
  const library = useLibraryStore.getState();
  const editorSnapshot = editor.selectedImage ? snapshots[editor.selectedImage.path] : undefined;
  const librarySnapshot = library.libraryActivePath ? snapshots[library.libraryActivePath] : undefined;

  Object.keys(snapshots).forEach((path) => globalImageCache.delete(path));
  if (editorSnapshot) {
    const replay = markHistoryReplay(structuredClone(editorSnapshot));
    useEditorStore.setState({ adjustments: replay, history: [replay], historyIndex: 0 });
  }
  if (librarySnapshot) library.setLibrary({ libraryActiveAdjustments: structuredClone(librarySnapshot) });
}

export async function replayAdjustmentSnapshots(snapshots: AdjustmentSnapshots, rollback?: AdjustmentSnapshots) {
  applySnapshots(snapshots);
  try {
    for (const [path, adjustments] of Object.entries(snapshots))
      await queueMetadataSave(path, structuredClone(adjustments));
  } catch (error) {
    if (rollback) applySnapshots(rollback);
    throw error;
  }
}

export function recordAdjustmentBatch(label: string, before: AdjustmentSnapshots, after: AdjustmentSnapshots) {
  applySnapshots(after);
  recordUndoableAction({
    label,
    undo: () => replayAdjustmentSnapshots(before, after),
    redo: () => replayAdjustmentSnapshots(after, before),
  });
}
