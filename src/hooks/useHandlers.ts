import { useApplyAdjustments } from './handlers/useApplyAdjustments';
import { useCloseConfirmModal } from './handlers/useCloseConfirmModal';
import { useCreateResizeHandler } from './handlers/useCreateResizeHandler';
import { useDebouncedSave } from './handlers/useDebounce';
import { useDebouncedSetHistory } from './handlers/useDebouncedSetHistory';
import { useExecuteDelete } from './handlers/useExecuteDelete';
import { useGenerateUncroppedPreview } from './handlers/useGenerateUncroppedPreview';
import { useGetCommonTags } from './handlers/useGetCommonTags';
import { useHandleActiveTreeSectionChange } from './handlers/useHandleActiveTreeSectionChange';
import { useHandleApplyDenoise } from './handlers/useHandleApplyDenoise';
import { useHandleAutoAdjustments } from './handlers/useHandleAutoAdjustments';
import { useHandleBackToLibrary } from './handlers/useHandleBackToLibrary';
import { useHandleClearSelection } from './handlers/useHandleClearSelection';
import { useHandleContinueSession } from './handlers/useHandleContinueSession';
import { useHandleCopyAdjustments } from './handlers/useHandleCopyAdjustments';
import { useHandleCreateFolder } from './handlers/useHandleCreateFolder';
import { useHandleDeleteAiPatch } from './handlers/useHandleDeleteAiPatch';
import { useHandleDeleteMaskContainer } from './handlers/useHandleDeleteMaskContainer';
import { useHandleDeleteSelected } from './handlers/useHandleDeleteSelected';
import { useHandleDisplaySizeChange } from './handlers/useHandleDisplaySizeChange';
import { useHandleEditorContextMenu } from './handlers/useHandleEditorContextMenu';
import { useHandleFolderTreeContextMenu } from './handlers/useHandleFolderTreeContextMenu';
import { useHandleFullResolutionLogic } from './handlers/useHandleFullResolutionLogic';
import { useHandleGenerateAiForegroundMask } from './handlers/useHandleGenerateAiForegroundMask';
import { useHandleGenerateAiMask } from './handlers/useHandleGenerateAiMask';
import { useHandleGenerateAiSkyMask } from './handlers/useHandleGenerateAiSkyMask';
import { useHandleGenerativeReplace } from './handlers/useHandleGenerativeReplace';
import { useHandleGoHome } from './handlers/useHandleGoHome';
import { useHandleImageClick } from './handlers/useHandleImageClick';
import { useHandleImageSelect } from './handlers/useHandleImageSelect';
import { useHandleImportClick } from './handlers/useHandleImportClick';
import { useHandleLibraryImageSingleClick } from './handlers/useHandleLibraryImageSingleClick';
import { useHandleLibraryRefresh } from './handlers/useHandleLibraryRefresh';
import { useHandleLutSelect } from './handlers/useHandleLutSelect';
import { useHandleMainLibraryContextMenu } from './handlers/useHandleMainLibraryContextMenu';
import { useHandleMultiselectClick } from './handlers/useHandleMultiSelectClick';
import { useHandleOpenFolder } from './handlers/useHandleOpenFolder';
import { useHandlePasteAdjustments } from './handlers/useHandlePasteAdjustments';
import { useHandlePasteFiles } from './handlers/useHandlePasteFiles';
import { useHandleQuickErase } from './handlers/useHandleQuickErase';
import { useHandleRate } from './handlers/useHandleRate';
import { useHandleRenameFiles } from './handlers/useHandleRenameFiles';
import { useHandleRenameFolder } from './handlers/useHandleRenameFolder';
import { useHandleResetAdjustments } from './handlers/useHandleResetAdjustments';
import { useHandleRightPanelSelect } from './handlers/useHandleRightPanelSelect';
import { useHandleSaveCollage } from './handlers/useHandleSaveCollage';
import { useHandleSaveDenoisedImage } from './handlers/useHandleSaveDenoisedImage';
import { useHandleSaveHdr } from './handlers/useHandleSaveHdr';
import { useHandleSavePanorama } from './handlers/useHandleSavePanorama';
import { useHandleSaveRename } from './handlers/useHandleSaveRename';
import { useHandleSelectSubfolder } from './handlers/useHandleSelectSubfolder';
import { useHandleSetColorLabel } from './handlers/useHandleSetColorLabel';
import { useHandleSettingsChange } from './handlers/useHandleSettingsChange';
import { useHandleStartImport } from './handlers/useHandleStartImport';
import { useHandleStraighten } from './handlers/useHandleStraighten';
import { useHandleTagsChanged } from './handlers/useHandleTagsChanged';
import { useHandleThumbnailContextMenu } from './handlers/useHandleThumbnailContextmenu';
import { useHandleToggleAiPatchVisibility } from './handlers/useHandleToggleAiPatchVisibility';
import { useHandleToggleFolder } from './handlers/useHandleToggleFolder';
import { useHandleToggleFullScreen } from './handlers/useHandleToggleFullScreen';
import { useHandleTogglePinFolder } from './handlers/useHandleTogglePinFolder';
import { useHandleToggleWaveform } from './handlers/useHandleToggleWaveform';
import { useHandleUserTransform } from './handlers/useHandleUserTransform';
import { useHandleZoomChange } from './handlers/useHandleZoomChange';
import { useRedo } from './handlers/useRedo';
import { useRefreshAllFolderTrees } from './handlers/useRefreshAllFolderTrees';
import { useRefreshImageList } from './handlers/useRefreshImageList';
import { useRequestFullResolution } from './handlers/useRequestFullResolution';
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
    handleToggleFullScreen: useHandleToggleFullScreen(),
    handleCopyAdjustments: useHandleCopyAdjustments(),
    handlePasteAdjustments: useHandlePasteAdjustments(),
    handleAutoAdjustments: useHandleAutoAdjustments(),
    handleRate: useHandleRate(),
    handleSetColorLabel: useHandleSetColorLabel(),
    getCommonTags: useGetCommonTags(),
    handleTagsChanged: useHandleTagsChanged(),
    closeConfirmModal: useCloseConfirmModal(),
    handlePasteFiles: useHandlePasteFiles(),
    requestFullResolution: useRequestFullResolution(),
    handleFullResolutionLogic: useHandleFullResolutionLogic(),
    handleZoomChange: useHandleZoomChange(),
    handleUserTransform: useHandleUserTransform(),
    handleSavePanorama: useHandleSavePanorama(),
    handleSaveHdr: useHandleSaveHdr(),
    handleApplyDenoise: useHandleApplyDenoise(),
    handleSaveDenoisedImage: useHandleSaveDenoisedImage(),
    handleSaveCollage: useHandleSaveCollage(),
    handleOpenFolder: useHandleOpenFolder(),
    handleGoHome: useHandleGoHome(),
    handleContinueSession: useHandleContinueSession(),
    handleMultiSelectClick: useHandleMultiselectClick(),
    handleLibraryImageSingleClick: useHandleLibraryImageSingleClick(),
    handleImageClick: useHandleImageClick(),
    handleClearSelection: useHandleClearSelection(),
    handleRenameFiles: useHandleRenameFiles(),
    handleSaveRename: useHandleSaveRename(),
    handleStartImport: useHandleStartImport(),
    handleResetAdjustments: useHandleResetAdjustments(),
    handleImportClick: useHandleImportClick(),
    handleEditorContextMenu: useHandleEditorContextMenu(),
    handleThumbnailContextMenu: useHandleThumbnailContextMenu(),
    handleCreateFolder: useHandleCreateFolder(),
    handleRenameFolder: useHandleRenameFolder(),
    handleFolderTreeContextMenu: useHandleFolderTreeContextMenu(),
    handleMainLibraryContextMenu: useHandleMainLibraryContextMenu(),
  };
}
