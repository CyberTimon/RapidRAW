import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Status } from '../components/ui/ExportImportProperties';
import { useProcessStore } from '../store/useProcessStore';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useLibraryStore } from '../store/useLibraryStore';

interface TauriListenerProps {
  refreshAllFolderTrees: () => void;
  handleSelectSubfolder: (path: string, isNewRoot?: boolean, preloadedImages?: any[], expandParents?: boolean) => void;
  refreshImageList: () => void;
  markGenerated: (path: string) => void;
}

export function useTauriListeners({
  refreshAllFolderTrees,
  handleSelectSubfolder,
  refreshImageList,
  markGenerated,
}: TauriListenerProps) {
  const refs = useRef({ refreshAllFolderTrees, handleSelectSubfolder, refreshImageList, markGenerated });

  useEffect(() => {
    refs.current = { refreshAllFolderTrees, handleSelectSubfolder, refreshImageList, markGenerated };
  });

  const thumbnailBuffer = useRef<Record<string, string>>({});
  const ratingBuffer = useRef<Record<string, number>>({});
  const flushHandle = useRef<number | null>(null);

  useEffect(() => {
    let isEffectActive = true;

    const flushThumbnailBatch = () => {
      flushHandle.current = null;
      if (!isEffectActive) return;

      const pendingThumbs = thumbnailBuffer.current;
      const pendingRatings = ratingBuffer.current;
      thumbnailBuffer.current = {};
      ratingBuffer.current = {};

      const thumbKeys = Object.keys(pendingThumbs);
      const ratingKeys = Object.keys(pendingRatings);

      if (thumbKeys.length > 0) {
        useProcessStore.getState().setProcess((state) => ({
          thumbnails: { ...state.thumbnails, ...pendingThumbs },
        }));
      }

      if (ratingKeys.length > 0) {
        useLibraryStore.getState().setLibrary((state) => ({
          imageRatings: { ...state.imageRatings, ...pendingRatings },
        }));
      }
    };

    const scheduleFlush = () => {
      if (flushHandle.current !== null) return;
      flushHandle.current = requestAnimationFrame(flushThumbnailBatch);
    };

    const listeners = [
      listen('preview-update-uncropped', (event: any) => {
        if (isEffectActive) useEditorStore.getState().setEditor({ uncroppedAdjustedPreviewUrl: event.payload });
      }),
      listen('histogram-update', (event: any) => {
        if (isEffectActive && event.payload.path === useEditorStore.getState().selectedImage?.path) {
          useEditorStore.getState().setEditor({ histogram: event.payload.data });
        }
      }),
      listen('open-with-file', (event: any) => {
        if (isEffectActive) useProcessStore.getState().setProcess({ initialFileToOpen: event.payload as string });
      }),
      listen('waveform-update', (event: any) => {
        if (isEffectActive && event.payload.path === useEditorStore.getState().selectedImage?.path) {
          useEditorStore.getState().setEditor({ waveform: event.payload.data });
        }
      }),
      listen('thumbnail-progress', (event: any) => {
        if (isEffectActive)
          useProcessStore
            .getState()
            .setProcess({ thumbnailProgress: { current: event.payload.current, total: event.payload.total } });
      }),
      listen('thumbnail-generation-complete', () => {
        if (isEffectActive) useProcessStore.getState().setProcess({ thumbnailProgress: { current: 0, total: 0 } });
      }),
      listen('thumbnail-generated', (event: any) => {
        if (!isEffectActive) return;
        const { path, data, rating } = event.payload;
        if (data) {
          thumbnailBuffer.current[path] = data;
          refs.current.markGenerated(path);
        }
        if (rating !== undefined) {
          ratingBuffer.current[path] = rating;
        }
        if (data || rating !== undefined) {
          scheduleFlush();
        }
      }),
      listen('ai-model-download-start', (event: any) => {
        if (isEffectActive) useProcessStore.getState().setProcess({ aiModelDownloadStatus: event.payload });
      }),
      listen('ai-model-download-finish', () => {
        if (isEffectActive) useProcessStore.getState().setProcess({ aiModelDownloadStatus: null });
      }),
      listen('indexing-started', () => {
        if (isEffectActive)
          useProcessStore.getState().setProcess({ isIndexing: true, indexingProgress: { current: 0, total: 0 } });
      }),
      listen('indexing-progress', (event: any) => {
        if (isEffectActive) useProcessStore.getState().setProcess({ indexingProgress: event.payload });
      }),
      listen('indexing-finished', () => {
        if (isEffectActive) {
          useProcessStore.getState().setProcess({ isIndexing: false, indexingProgress: { current: 0, total: 0 } });
          const currentPath = useLibraryStore.getState().currentFolderPath;
          if (currentPath) {
            refs.current.refreshImageList();
          }
        }
      }),
      listen('batch-export-progress', (event: any) => {
        if (isEffectActive) useProcessStore.getState().setExportState({ progress: event.payload });
      }),
      listen('export-complete', () => {
        if (isEffectActive) useProcessStore.getState().setExportState({ status: Status.Success });
      }),
      listen('export-error', (event: any) => {
        if (isEffectActive)
          useProcessStore.getState().setExportState({
            status: Status.Error,
            errorMessage: typeof event.payload === 'string' ? event.payload : 'Unknown error',
          });
      }),
      listen('export-cancelled', () => {
        if (isEffectActive) useProcessStore.getState().setExportState({ status: Status.Cancelled });
      }),
      listen('import-start', (event: any) => {
        if (isEffectActive)
          useProcessStore.getState().setImportState({
            errorMessage: '',
            path: '',
            progress: { current: 0, total: event.payload.total },
            status: Status.Importing,
          });
      }),
      listen('import-progress', (event: any) => {
        if (isEffectActive)
          useProcessStore.getState().setImportState({
            path: event.payload.path,
            progress: { current: event.payload.current, total: event.payload.total },
          });
      }),
      listen('import-complete', () => {
        if (isEffectActive) {
          useProcessStore.getState().setImportState({ status: Status.Success });
          refs.current.refreshAllFolderTrees();
          const currentPath = useLibraryStore.getState().currentFolderPath;
          if (currentPath) {
            refs.current.handleSelectSubfolder(currentPath, false);
          }
        }
      }),
      listen('import-error', (event: any) => {
        if (isEffectActive)
          useProcessStore.getState().setImportState({
            status: Status.Error,
            errorMessage: typeof event.payload === 'string' ? event.payload : 'Unknown error',
          });
      }),
      listen('denoise-progress', (event: any) => {
        if (isEffectActive)
          useUIStore.getState().setUI((state) => ({
            denoiseModalState: { ...state.denoiseModalState, progressMessage: event.payload as string },
          }));
      }),
      listen('denoise-complete', (event: any) => {
        if (isEffectActive) {
          const payload = event.payload;
          const isObject = typeof payload === 'object' && payload !== null;
          useUIStore.getState().setUI((state) => ({
            denoiseModalState: {
              ...state.denoiseModalState,
              isProcessing: false,
              previewBase64: isObject ? payload.denoised : payload,
              originalBase64: isObject ? payload.original : null,
              progressMessage: null,
            },
          }));
        }
      }),
      listen('denoise-error', (event: any) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            denoiseModalState: {
              ...state.denoiseModalState,
              isProcessing: false,
              error: String(event.payload),
              progressMessage: null,
            },
          }));
        }
      }),
      listen('wgpu-frame-ready', (event: any) => {
        if (isEffectActive && event.payload?.path === useEditorStore.getState().selectedImage?.path) {
          useEditorStore.getState().setEditor({ hasRenderedFirstFrame: true });
        }
      }),

      // Panorama
      listen('panorama-progress', (event: any) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => {
            if (state.panoramaModalState.finalImageBase64 || state.panoramaModalState.error) return state;
            return { panoramaModalState: { ...state.panoramaModalState, progressMessage: event.payload } };
          });
        }
      }),
      listen('panorama-complete', (event: any) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            panoramaModalState: {
              ...state.panoramaModalState,
              error: null,
              finalImageBase64: event.payload.base64,
              isProcessing: false,
              progressMessage: null,
            },
          }));
        }
      }),
      listen('panorama-error', (event: any) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            panoramaModalState: {
              ...state.panoramaModalState,
              error: String(event.payload),
              finalImageBase64: null,
              isProcessing: false,
              progressMessage: null,
            },
          }));
        }
      }),

      // HDR
      listen('hdr-progress', (event: any) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            hdrModalState: {
              ...state.hdrModalState,
              error: null,
              finalImageBase64: null,
              isOpen: true,
              progressMessage: event.payload,
            },
          }));
        }
      }),
      listen('hdr-complete', (event: any) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            hdrModalState: {
              ...state.hdrModalState,
              error: null,
              finalImageBase64: event.payload.base64,
              isProcessing: false,
              progressMessage: 'Hdr Ready',
            },
          }));
        }
      }),
      listen('hdr-error', (event: any) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            hdrModalState: {
              ...state.hdrModalState,
              error: String(event.payload),
              finalImageBase64: null,
              isProcessing: false,
              progressMessage: 'An error occurred.',
            },
          }));
        }
      }),

      // Culling
      listen('culling-start', (event: any) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            cullingModalState: {
              ...state.cullingModalState,
              isOpen: true,
              progress: { current: 0, total: event.payload, stage: 'Initializing...' },
              suggestions: null,
              error: null,
            },
          }));
        }
      }),
      listen('culling-progress', (event: any) => {
        if (isEffectActive) {
          useUIStore
            .getState()
            .setUI((state) => ({ cullingModalState: { ...state.cullingModalState, progress: event.payload } }));
        }
      }),
      listen('culling-complete', (event: any) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            cullingModalState: { ...state.cullingModalState, progress: null, suggestions: event.payload },
          }));
        }
      }),
      listen('culling-error', (event: any) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            cullingModalState: { ...state.cullingModalState, progress: null, error: String(event.payload) },
          }));
        }
      }),
    ];

    return () => {
      isEffectActive = false;
      if (flushHandle.current !== null) {
        cancelAnimationFrame(flushHandle.current);
        flushHandle.current = null;
      }
      thumbnailBuffer.current = {};
      ratingBuffer.current = {};
      listeners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);
}
