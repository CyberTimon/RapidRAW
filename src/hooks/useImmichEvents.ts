import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import { useLibraryStore } from '../store/useLibraryStore';
import { JobKind, JobStatus, useProcessStore } from '../store/useProcessStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { flushImmichEdits, ImmichSyncStatus } from '../utils/immichApi';
import { useImmichStore } from '../store/useImmichStore';
import { guardWindowClose } from '../utils/windowClose';
import { Progress } from '../types/library';

type DownloadEvent = { path: string } & (
  | { state: 'queued'; video: boolean }
  | { state: 'done' | 'cancelled' }
  | { state: 'progress'; current: number; total: number | null }
  | { state: 'error'; error: string }
);

interface DownloadJob {
  jobId: string | null;
  progress?: Progress;
  timer?: ReturnType<typeof setTimeout>;
}

const QUIET_PHOTO_DOWNLOAD_MS = 2000;

const FINISHED_DOWNLOADS = {
  done: { status: JobStatus.Success },
  cancelled: { status: JobStatus.Cancelled },
};

type TransferEvent =
  | { state: 'progress'; current: number; total: number }
  | { state: 'done'; added: number; failed: number; error?: string };

interface ConflictEvent {
  path: string;
  fileName: string;
}

const REFRESH_DELAY_MS = 1500;

const TRANSFER_TOAST = 'immich-transfer';

export function useImmichEvents(refreshLibrary: () => void) {
  const { t } = useTranslation();
  const refreshRef = useRef(refreshLibrary);
  refreshRef.current = refreshLibrary;
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const uploaded = useRef(0);
  const downloads = useRef<Record<string, DownloadJob>>({});
  const isConfigured = useImmichStore((state) => state.isConfigured);
  const serverUrl = useSettingsStore((state) => state.appSettings?.immich?.serverUrl);

  useEffect(() => {
    useImmichStore.getState().refresh();
  }, [serverUrl]);

  useEffect(() => {
    const unlisteners = [
      listen<DownloadEvent>('immich-download', ({ payload }) => {
        const { startJob, updateJob } = useProcessStore.getState();
        const download = downloads.current[payload.path];
        if (payload.state === 'queued') {
          const job: DownloadJob = { jobId: null };
          const show = () => {
            job.jobId = startJob(JobKind.ImmichDownload, {
              detail: payload.path,
              ...(job.progress && { progress: job.progress }),
            });
          };
          downloads.current[payload.path] = job;
          if (payload.video) show();
          else job.timer = setTimeout(show, QUIET_PHOTO_DOWNLOAD_MS);
          return;
        }
        if (payload.state === 'progress') {
          if (!download) return;
          download.progress = { current: payload.current, total: payload.total ?? 0 };
          if (download.jobId) updateJob(download.jobId, { progress: download.progress });
          return;
        }
        delete downloads.current[payload.path];
        clearTimeout(download?.timer);
        if (download?.jobId) {
          updateJob(
            download.jobId,
            payload.state === 'error'
              ? { status: JobStatus.Error, error: payload.error }
              : FINISHED_DOWNLOADS[payload.state],
          );
        }
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
      listen<TransferEvent>('immich-transfer', ({ payload }) => {
        if (payload.state === 'progress') {
          const text = t('immich.toasts.transferring', { current: payload.current + 1, total: payload.total });
          if (toast.isActive(TRANSFER_TOAST)) toast.update(TRANSFER_TOAST, { render: text });
          else toast.loading(text, { toastId: TRANSFER_TOAST });
          return;
        }
        toast.dismiss(TRANSFER_TOAST);
        if (payload.failed > 0) {
          toast.error(t('immich.toasts.transferFailed', { number: payload.failed, error: payload.error }));
        }
        if (payload.added > 0) {
          toast.success(t('immich.toasts.transferred', { number: payload.added }));
        }
      }),
      listen<ConflictEvent>('immich-edits-conflict', ({ payload }) => {
        toast.info(t('immich.toasts.editsConflict', { fileName: payload.fileName }));
        refreshRef.current();
      }),
      listen<ConflictEvent>('immich-edits-local', ({ payload }) => {
        toast.info(t('immich.toasts.editsStayLocal', { fileName: payload.fileName }));
      }),
      listen<ConflictEvent>('immich-upload-kept-copy', ({ payload }) => {
        toast.info(t('immich.toasts.uploadKeptCopy', { fileName: payload.fileName }));
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
    return guardWindowClose(async () => {
      try {
        const status = await flushImmichEdits();
        if (status.pending === 0) return true;
        return await ask(t('immich.close.message', { number: status.pending }), {
          title: t('immich.close.title'),
          kind: 'warning',
          okLabel: t('immich.close.closeAnyway'),
          cancelLabel: t('immich.close.cancel'),
        });
      } catch (err) {
        console.error('Failed to send Immich edits before closing:', err);
        return true;
      }
    });
  }, [t, isConfigured]);
}
