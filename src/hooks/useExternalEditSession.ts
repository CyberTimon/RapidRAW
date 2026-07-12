import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { exit } from '@tauri-apps/plugin-process';

import { useProcessStore } from '../store/useProcessStore';
import { useEditorStore } from '../store/useEditorStore';
import { Invokes } from '../components/ui/AppProperties';
import { ExportSettings, Status } from '../components/ui/ExportImportProperties';
import { debouncedSave } from './useEditorActions';

/**
 * Handles files handed to the app from outside (OS "open with" and the
 * external editor protocol: rapidraw --edit <file> --output <file>).
 * Opens the requested image in the editor and, for edit sessions, exports
 * the result to the caller-provided output path and exits the app.
 */
export function useExternalEditSession(handleImageSelect: (path: string) => void) {
  const initialFileToOpen = useProcessStore((state) => state.initialFileToOpen);
  const externalEditSession = useProcessStore((state) => state.externalEditSession);
  const exportStatus = useProcessStore((state) => state.exportState.status);
  const [isFinishing, setIsFinishing] = useState(false);

  const handleImageSelectRef = useRef(handleImageSelect);
  useEffect(() => {
    handleImageSelectRef.current = handleImageSelect;
  });

  useEffect(() => {
    if (!initialFileToOpen) return;
    useProcessStore.getState().setProcess({ initialFileToOpen: null });
    handleImageSelectRef.current(initialFileToOpen);
  }, [initialFileToOpen]);

  useEffect(() => {
    if (!externalEditSession) return;
    setIsFinishing(false);
    handleImageSelectRef.current(externalEditSession.source);
  }, [externalEditSession]);

  useEffect(() => {
    if (!isFinishing) return;
    if (exportStatus === Status.Success) {
      exit(0);
    } else if (exportStatus === Status.Error || exportStatus === Status.Cancelled) {
      setIsFinishing(false);
    }
  }, [isFinishing, exportStatus]);

  const finishExternalEdit = useCallback(async () => {
    const session = useProcessStore.getState().externalEditSession;
    const { selectedImage, adjustments } = useEditorStore.getState();
    if (!session || !selectedImage) return;

    debouncedSave.flush();

    const exportSettings: ExportSettings = {
      filenameTemplate: null,
      jpegQuality: session.jpegQuality,
      keepMetadata: true,
      preserveTimestamps: false,
      preserveFolders: false,
      resize: null,
      stripGps: false,
      exportMasks: false,
      watermark: null,
    };

    setIsFinishing(true);
    useProcessStore.getState().setExportState({
      status: Status.Exporting,
      progress: { current: 0, total: 1 },
      errorMessage: '',
    });

    try {
      await invoke(Invokes.ExportImages, {
        paths: [session.source],
        outputFolderOrFile: session.output,
        isExplicitFilePath: true,
        baseOriginFolders: [],
        exportSettings,
        outputFormat: session.format,
        currentEditPath: selectedImage.path,
        currentEditAdjustments: adjustments || null,
      });
    } catch (error) {
      setIsFinishing(false);
      useProcessStore.getState().setExportState({
        status: Status.Error,
        errorMessage: typeof error === 'string' ? error : 'Export failed',
      });
    }
  }, []);

  return { externalEditSession, isFinishing, finishExternalEdit };
}
