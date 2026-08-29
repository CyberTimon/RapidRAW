import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';

import { useSettingsStore } from '../store/useSettingsStore';
import { fileExtension } from './convertedInputSupport';

function isSupportedImagePath(path: string): boolean {
  const supportedTypes = useSettingsStore.getState().supportedTypes;
  if (!supportedTypes) return false;

  const extension = fileExtension(path);
  return [...supportedTypes.raw, ...supportedTypes.nonRaw].some(
    (supportedExtension) => supportedExtension.toLowerCase() === extension,
  );
}

/** Opens image files dropped from the operating system. Internal library drag
 * operations continue to be handled by dnd-kit and never reach this listener. */
export function useExternalImageDrop(onOpenImage: (path: string) => boolean | void | Promise<boolean | void>) {
  const { t } = useTranslation();
  const osPlatform = useSettingsStore((state) => state.osPlatform);

  useEffect(() => {
    if (osPlatform === 'android') return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return;

        const supportedPaths = event.payload.paths.filter(isSupportedImagePath);
        if (supportedPaths.length === 0) {
          toast.error(
            t('library.drop.unsupported', {
              defaultValue: 'No supported image files were found in the drop.',
            }),
          );
          return;
        }

        void Promise.resolve(onOpenImage(supportedPaths[0]))
          .then((opened) => {
            if (opened === false || supportedPaths.length === 1) return;
            toast.info(
              t('library.drop.openedFirst', {
                total: supportedPaths.length,
                defaultValue: `Opened the first of ${supportedPaths.length} dropped images.`,
              }),
            );
          })
          .catch((error) => console.error('Failed to open dropped image:', error));
      })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((error) => console.error('Failed to register file drop listener:', error));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onOpenImage, osPlatform, t]);
}
