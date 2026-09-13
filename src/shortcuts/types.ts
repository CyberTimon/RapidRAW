import type { RefObject } from 'react';
import type { useEditorStore } from '../store/useEditorStore';
import type { useUIStore } from '../store/useUIStore';
import type { useSettingsStore } from '../store/useSettingsStore';
import type { useLibraryStore } from '../store/useLibraryStore';
import type { useProcessStore } from '../store/useProcessStore';
import type { useEditorActions } from '../hooks/useEditorActions';
import type { useLibraryActions } from '../hooks/useLibraryActions';
import type { KeyboardShortcutsProps } from '../hooks/useKeyboardShortcuts';
import type { ImageFile } from '../components/ui/AppProperties';
import type { CommandId } from './definitions';
export interface ShortcutState {
  editor: ReturnType<typeof useEditorStore.getState>;
  ui: ReturnType<typeof useUIStore.getState>;
  settings: ReturnType<typeof useSettingsStore.getState>;
  library: ReturnType<typeof useLibraryStore.getState>;
  process: ReturnType<typeof useProcessStore.getState>;
}
export interface CommandHandler {
  shouldFire?: (state: ShortcutState) => boolean;
  execute: (event: KeyboardEvent, state: ShortcutState) => void | Promise<void>;
}
export type CommandHandlers = Partial<Record<CommandId, CommandHandler>>;
export type ShortcutEnvironment = Omit<KeyboardShortcutsProps, 'sortedImageList'> &
  Pick<
    ReturnType<typeof useEditorActions>,
    | 'handleRotate'
    | 'handleCopyAdjustments'
    | 'handlePasteAdjustments'
    | 'handleSyncAdjustments'
    | 'toggleShowOriginal'
    | 'handleAutoAdjustments'
    | 'handleAutoLensCorrection'
    | 'handleResetAdjustments'
  > &
  Pick<ReturnType<typeof useLibraryActions>, 'handleRate' | 'handleSetColorLabel'> & {
    sortedListRef: RefObject<ImageFile[]>;
    getImagePathsForCopy: (state: ShortcutState) => string[];
    handleCopyImagePaths: (paths: string[]) => Promise<void>;
  };
