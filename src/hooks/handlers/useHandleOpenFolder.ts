import { useAppState } from '../../context/ContextProviders';
import { open } from '@tauri-apps/plugin-dialog';
import { useHandleSelectSubfolder } from './useHandleSelectSubfolder';
import { homeDir } from '@tauri-apps/api/path';

export function useHandleOpenFolder() {
  const { setRootPath, setError } = useAppState();
  const handleSelectSubfolder = useHandleSelectSubfolder();

  const handleOpenFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, defaultPath: await homeDir() });
      if (typeof selected === 'string') {
        setRootPath(selected);
        await handleSelectSubfolder(selected, true);
      }
    } catch (err) {
      console.error('Failed to open directory dialog:', err);
      setError('Failed to open folder selection dialog.');
    }
  };

  return handleOpenFolder;
}
