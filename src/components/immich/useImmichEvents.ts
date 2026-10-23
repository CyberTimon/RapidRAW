import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask } from '@tauri-apps/plugin-dialog';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { flushImmichEdits, ImmichSyncStatus } from './immichApi';
import { useImmichStore } from './useImmichStore';

interface DownloadEvent {
  path: string;
  state: 'started' | 'done' | 'error';
  error?: string;
}

interface ConflictEvent {
  path: string;
  fileName: string;
}

const REFRESH_DELAY_MS = 1500;

export function useImmichEvents(refreshLibrary: () => void) {
  const { t } = useTranslation();
  const refreshRef = useRef(refreshLibrary);
  refreshRef.current = refreshLibrary;
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const uploaded = useRef(0);
  const isConfigured = useImmichStore((state) => state.isConfigured);
  const serverUrl = useSettingsStore((state) => state.appSettings?.immich?.serverUrl);

  useEffect(() => {
    useImmichStore.getState().refresh();
  }, [serverUrl]);

  useEffect(() => {
    const unlisteners = [
      listen<DownloadEvent>('immich-download', ({ payload }) => {
        if (payload.state === 'done') {
          useLibraryStore.getState().setLibrary((state) => ({
            imageList: state.imageList.map((image) =>
              image.path.split('?vc=')[0] === payload.path ? { ...image, is_cloud_placeholder: false } : image,
            ),
          }));
        } else if (payload.state === 'error') {
          toast.error(t('immich.toasts.downloadFailed', { error: payload.error }));
        }
      }),
      listen<ImmichSyncStatus>('immich-sync', ({ payload }) => {
        const previous = useImmichStore.getState().syncStatus;
        if (payload.offline && !previous.offline) {
          toast.warning(t('immich.toasts.offline'));
        } else if (previous.offline && !payload.offline && payload.pending === 0) {
          toast.success(t('immich.toasts.backOnline'));
        }
        useImmichStore.getState().setSyncStatus(payload);
      }),
      listen('immich-upload', () => {
        uploaded.current += 1;
      }),
      listen('immich-library-changed', () => {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => {
          if (uploaded.current > 0) {
            toast.success(t('immich.toasts.uploaded', { number: uploaded.current }));
            uploaded.current = 0;
          }
          useImmichStore.getState().loadAlbums();
          refreshRef.current();
        }, REFRESH_DELAY_MS);
      }),
      listen<{ error: string }>('immich-trash', ({ payload }) => {
        toast.error(t('immich.toasts.trashFailed', { error: payload.error }));
      }),
      listen<{ path: string; rating: number }>('immich-edits-fetched', ({ payload }) => {
        useLibraryStore.getState().setLibrary((state) => ({
          imageRatings: { ...state.imageRatings, [payload.path]: payload.rating },
        }));
      }),
      listen<ConflictEvent>('immich-edits-conflict', ({ payload }) => {
        toast.info(t('immich.toasts.editsConflict', { fileName: payload.fileName }));
        refreshRef.current();
      }),
    ];

    return () => {
      clearTimeout(refreshTimer.current);
      unlisteners.forEach((unlisten) => unlisten.then((fn) => fn()));
    };
  }, [t]);
  useEffect(() => {
    if (!isConfigured) return;
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      try {
        const status = await flushImmichEdits();
        if (status.pending === 0) return;
        const closeAnyway = await ask(t('immich.close.message', { number: status.pending }), {
          title: t('immich.close.title'),
          kind: 'warning',
          okLabel: t('immich.close.closeAnyway'),
          cancelLabel: t('immich.close.cancel'),
        });
        if (!closeAnyway) event.preventDefault();
      } catch (err) {
        console.error('Failed to send Immich edits before closing:', err);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [t, isConfigured]);
}
