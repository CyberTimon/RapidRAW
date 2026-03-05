import { useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useAppState } from '../../context/ContextProviders';

export function useHandleImportClick() {
  const { supportedTypes, setImportSourcePaths, setImportTargetFolder, setIsImportModalOpen } = useAppState();

  const handleImportClick = useCallback(
    async (targetPath: string) => {
      try {
        const nonRaw = supportedTypes?.nonRaw || [];
        const raw = supportedTypes?.raw || [];

        const expandExtensions = (exts: string[]) => {
          return Array.from(new Set(exts.flatMap((ext) => [ext.toLowerCase(), ext.toUpperCase()])));
        };

        const processedNonRaw = expandExtensions(nonRaw);
        const processedRaw = expandExtensions(raw);
        const allImageExtensions = [...processedNonRaw, ...processedRaw];

        const selected = await open({
          filters: [
            {
              name: 'All Supported Images',
              extensions: allImageExtensions,
            },
            {
              name: 'RAW Images',
              extensions: processedRaw,
            },
            {
              name: 'Standard Images (JPEG, PNG, etc.)',
              extensions: processedNonRaw,
            },
            {
              name: 'All Files',
              extensions: ['*'],
            },
          ],
          multiple: true,
          title: 'Select files to import',
        });

        if (Array.isArray(selected) && selected.length > 0) {
          setImportSourcePaths(selected);
          setImportTargetFolder(targetPath);
          setIsImportModalOpen(true);
        }
      } catch (err) {
        console.error('Failed to open file dialog for import:', err);
      }
    },
    [supportedTypes],
  );

  return handleImportClick;
}
