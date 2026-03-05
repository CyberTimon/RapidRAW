import { invoke } from '@tauri-apps/api/core';
import { AppSettings, Invokes } from '../../components/ui/AppProperties';
import { Status } from '../../components/ui/ExportImportProperties';
import { useAppState } from '../../context/ContextProviders';

export function useHandleStartImport() {
  const { importSourcePaths, importTargetFolder, setImportState } = useAppState();

  const handleStartImport = async (settings: AppSettings) => {
    if (importSourcePaths.length > 0 && importTargetFolder) {
      invoke(Invokes.ImportFiles, {
        destinationFolder: importTargetFolder,
        settings: settings,
        sourcePaths: importSourcePaths,
      }).catch((err) => {
        console.error('Failed to start import:', err);
        setImportState({ status: Status.Error, errorMessage: `Failed to start import: ${err}` });
      });
    }
  };

  return handleStartImport;
}
