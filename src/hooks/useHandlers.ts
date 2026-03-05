import { useApplyAdjustments } from './handlers/useApplyAdjustments';
import { useCreateResizeHandler } from './handlers/useCreateResizeHandler';
import { useDebouncedSave } from './handlers/useDebounce';
import { useDebouncedSetHistory } from './handlers/useDebouncedSetHistory';
import { useExecuteDelete } from './handlers/useExecuteDelete';
import { useGenerateUncroppedPreview } from './handlers/useGenerateUncroppedPreview';
import { useHandleActiveTreeSectionChange } from './handlers/useHandleActiveTreeSectionChange';
import { useHandleBackToLibrary } from './handlers/useHandleBackToLibrary';
import { useHandleDeleteAiPatch } from './handlers/useHandleDeleteAiPatch';
import { useHandleDeleteMaskContainer } from './handlers/useHandleDeleteMaskContainer';
import { useHandleDeleteSelected } from './handlers/useHandleDeleteSelected';
import { useHandleDisplaySizeChange } from './handlers/useHandleDisplaySizeChange';
import { useHandleGenerateAiForegroundMask } from './handlers/useHandleGenerateAiForegroundMask';
import { useHandleGenerateAiMask } from './handlers/useHandleGenerateAiMask';
import { useHandleGenerateAiSkyMask } from './handlers/useHandleGenerateAiSkyMask';
import { useHandleGenerativeReplace } from './handlers/useHandleGenerativeReplace';
import { useHandleImageSelect } from './handlers/useHandleImageSelect';
import { useHandleLibraryRefresh } from './handlers/useHandleLibraryRefresh';
import { useHandleLutSelect } from './handlers/useHandleLutSelect';
import { useHandleQuickErase } from './handlers/useHandleQuickErase';
import { useHandleRightPanelSelect } from './handlers/useHandleRightPanelSelect';
import { useHandleSelectSubfolder } from './handlers/useHandleSelectSubfolder';
import { useHandleSettingsChange } from './handlers/useHandleSettingsChange';
import { useHandleStraighten } from './handlers/useHandleStraighten';
import { useHandleToggleAiPatchVisibility } from './handlers/useHandleToggleAiPatchVisibility';
import { useHandleToggleFolder } from './handlers/useHandleToggleFolder';
import { useHandleTogglePinFolder } from './handlers/useHandleTogglePinFolder';
import { useHandleToggleWaveform } from './handlers/useHandleToggleWaveform';
import { useRedo } from './handlers/useRedo';
import { useRefreshAllFolderTrees } from './handlers/useRefreshAllFolderTrees';
import { useRefreshImageList } from './handlers/useRefreshImageList';
import { useSetAdjustments } from './handlers/useSetAdjustments';
import { useUndo } from './handlers/useUndo';
import { useUpdateSubMask } from './handlers/useUpdateSubMask';
import { useHandleWbPicked, useToggleWbPicker } from './handlers/useWbPicker';

export function useHandlers() {
  return {
    handleBackToLibrary: useHandleBackToLibrary(),
    handleImageSelect: useHandleImageSelect(),
    executeDelete: useExecuteDelete(),
    handleDeleteSelected: useHandleDeleteSelected(),
    applyAdjustments: useApplyAdjustments(),
    debouncedSave: useDebouncedSave(),
    refreshImageList: useRefreshImageList(),
    handleDisplaySizeChange: useHandleDisplaySizeChange(),
    debouncedSetHistory: useDebouncedSetHistory(),
    setAdjustments: useSetAdjustments(),
    handleStraighten: useHandleStraighten(),
    toggleWbPicker: useToggleWbPicker(),
    handleWbPicked: useHandleWbPicked(),
    undo: useUndo(),
    redo: useRedo(),
    updateSubMask: useUpdateSubMask(),
    handleGenerativeReplace: useHandleGenerativeReplace(),
    handleQuickErase: useHandleQuickErase(),
    handleDeleteMaskContainer: useHandleDeleteMaskContainer(),
    handleDeleteAiPatch: useHandleDeleteAiPatch(),
    handleToggleAiPatchVisibility: useHandleToggleAiPatchVisibility(),
    handleGenerateAiMask: useHandleGenerateAiMask(),
    handleGenerateAiForegroundMask: useHandleGenerateAiForegroundMask(),
    handleGenerateAiSkyMask: useHandleGenerateAiSkyMask(),
    generateUncroppedPreview: useGenerateUncroppedPreview(),
    createResizeHandler: useCreateResizeHandler(),
    handleLutSelect: useHandleLutSelect(),
    handleRightPanelSelect: useHandleRightPanelSelect(),
    handleSettingsChange: useHandleSettingsChange(),
    handleToggleWaveform: useHandleToggleWaveform(),
    refreshAllFolderTrees: useRefreshAllFolderTrees(),
    handleActiveTreeSectionChange: useHandleActiveTreeSectionChange(),
    handleTogglePinFolder: useHandleTogglePinFolder(),
    handleSelectSubfolder: useHandleSelectSubfolder(),
    handleLibraryRefresh: useHandleLibraryRefresh(),
    handleToggleFolder: useHandleToggleFolder(),
  };
}
