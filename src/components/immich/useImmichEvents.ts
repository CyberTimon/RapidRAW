import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import { useLibraryStore } from '../../store/useLibraryStore';

interface DownloadEvent {
  path: string;
  state: 'started' | 'done' | 'error';
  error?: string;
}

export function useImmichEvents() {
  const { t } = useTranslation();

  useEffect(() => {
    const unlisteners = [
      listen<DownloadEvent>('immich-download', ({ payload }) => {
        if (payload.state === 'done') {
          useLibraryStore.getState().setLibrary((state) => ({
            imageList: state.imageList.map((image) =>
              image.path === payload.path ? { ...image, is_cloud_placeholder: false } : image,
            ),
          }));
        } else if (payload.state === 'error') {
          toast.error(t('immich.toasts.downloadFailed', { error: payload.error }));
        }
      }),
    ];

    return () => {
      unlisteners.forEach((unlisten) => unlisten.then((fn) => fn()));
    };
  }, [t]);
}
