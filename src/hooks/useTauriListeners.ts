import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Status } from '../components/ui/ExportImportProperties';
import { ImageFile, Progress, CullingSuggestions } from '../components/ui/AppProperties';
import { useProcessStore, ExternalEditSession } from '../store/useProcessStore';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { acceptMainPreviewAttempt } from '../utils/previewIntent';
import { tracePreview } from '../utils/previewDiagnostics';

interface TauriListenerProps {
  refreshAllFolderTrees: () => void;
  handleSelectSubfolder: (
    path: string,
    isNewRoot?: boolean,
    preloadedImages?: ImageFile[],
    expandParents?: boolean,
  ) => void;
  refreshImageList: () => void;
  markGenerated: (path: string) => void;
  shouldAcceptGenerated: (path: string, sourceRevision?: string | null) => boolean;
  retryStaleGenerated: (path: string) => void;
}

export function useTauriListeners({
  refreshAllFolderTrees,
  handleSelectSubfolder,
  refreshImageList,
  markGenerated,
  shouldAcceptGenerated,
  retryStaleGenerated,
}: TauriListenerProps) {
  const refs = useRef({
    refreshAllFolderTrees,
    handleSelectSubfolder,
    refreshImageList,
    markGenerated,
    shouldAcceptGenerated,
    retryStaleGenerated,
  });

  useEffect(() => {
    refs.current = {
      refreshAllFolderTrees,
      handleSelectSubfolder,
      refreshImageList,
      markGenerated,
      shouldAcceptGenerated,
      retryStaleGenerated,
    };
  });

  const thumbnailBuffer = useRef<Record<string, string>>({});
  const mediumThumbnailBuffer = useRef<Record<string, string>>({});
  const thumbnailRevisionBuffer = useRef<Record<string, string | null>>({});
  const ratingBuffer = useRef<Record<string, number>>({});
  const editStatusBuffer = useRef<Record<string, boolean>>({});
  const flushHandle = useRef<number | null>(null);

  useEffect(() => {
    let isEffectActive = true;

    const flushThumbnailBatch = () => {
      flushHandle.current = null;
      if (!isEffectActive) return;

      const pendingThumbs = thumbnailBuffer.current;
      const pendingMediumThumbs = mediumThumbnailBuffer.current;
      const pendingRevisions = thumbnailRevisionBuffer.current;
      const pendingRatings = ratingBuffer.current;
      const pendingEdits = editStatusBuffer.current;

      thumbnailBuffer.current = {};
      mediumThumbnailBuffer.current = {};
      thumbnailRevisionBuffer.current = {};
      ratingBuffer.current = {};
      editStatusBuffer.current = {};

      for (const path of Object.keys(pendingThumbs)) {
        if (!refs.current.shouldAcceptGenerated(path, pendingRevisions[path])) {
          delete pendingThumbs[path];
          delete pendingMediumThumbs[path];
          delete pendingRevisions[path];
          delete pendingRatings[path];
          delete pendingEdits[path];
          refs.current.retryStaleGenerated(path);
        }
      }

      if (Object.keys(pendingThumbs).length > 0) {
        useProcessStore.getState().setProcess((state) => ({
          thumbnails: { ...state.thumbnails, ...pendingThumbs },
          mediumThumbnails: { ...state.mediumThumbnails, ...pendingMediumThumbs },
          thumbnailSourceRevisions: { ...state.thumbnailSourceRevisions, ...pendingRevisions },
        }));
      }

      if (Object.keys(pendingRatings).length > 0 || Object.keys(pendingEdits).length > 0) {
        useLibraryStore.getState().setLibrary((state) => ({
          imageRatings: { ...state.imageRatings, ...pendingRatings },
          imageList:
            Object.keys(pendingEdits).length > 0
              ? state.imageList.map((img) =>
                  pendingEdits[img.path] !== undefined ? { ...img, is_edited: pendingEdits[img.path] } : img,
                )
              : state.imageList,
        }));
      }
    };

    const scheduleFlush = () => {
      if (flushHandle.current !== null) return;
      flushHandle.current = requestAnimationFrame(flushThumbnailBatch);
    };

    const listeners = [
      listen<
        {
          path: string;
          generation: number;
          inputRevision: number | null;
          renderAttempt: number | null;
          qualityTier: string | null;
        } & Pick<Partial<ReturnType<typeof useEditorStore.getState>>, 'histogram' | 'waveform'>
      >('analytics-update', (event) => {
        if (
          isEffectActive &&
          event.payload.path === useEditorStore.getState().selectedImage?.path &&
          event.payload.generation === useEditorStore.getState().backendGeneration &&
          acceptMainPreviewAttempt(event.payload.inputRevision, event.payload.renderAttempt)
        ) {
          tracePreview({
            stage: 'analytics-accepted',
            session: useEditorStore.getState().imageSession,
            generation: event.payload.generation,
            revision: event.payload.inputRevision!,
            attempt: event.payload.renderAttempt!,
            tier:
              event.payload.qualityTier === 'quick' ||
              event.payload.qualityTier === 'detail' ||
              event.payload.qualityTier === 'full'
                ? event.payload.qualityTier
                : 'unknown',
          });
          const update: Pick<Partial<ReturnType<typeof useEditorStore.getState>>, 'histogram' | 'waveform'> = {};
          if (event.payload.histogram != null) update.histogram = event.payload.histogram;
          if (event.payload.waveform != null) update.waveform = event.payload.waveform;
          useEditorStore.getState().setEditor(update);
        }
      }),
      listen<string>('open-with-file', (event) => {
        if (isEffectActive) useProcessStore.getState().setProcess({ initialFileToOpen: event.payload as string });
      }),
      listen<ExternalEditSession>('external-edit-session', (event) => {
        if (isEffectActive) useProcessStore.getState().setProcess({ externalEditSession: event.payload });
      }),
      listen<Progress>('thumbnail-progress', (event) => {
        if (isEffectActive)
          useProcessStore
            .getState()
            .setProcess({ thumbnailProgress: { current: event.payload.current, total: event.payload.total } });
      }),
      listen('thumbnail-generation-complete', () => {
        if (isEffectActive) useProcessStore.getState().setProcess({ thumbnailProgress: { current: 0, total: 0 } });
      }),
      listen<{
        path: string;
        thumbnailPath?: string;
        previewPath?: string;
        rating?: number;
        is_edited?: boolean;
        data?: string;
        sourceRevision?: string;
      }>('thumbnail-generated', (event) => {
        if (!isEffectActive) return;
        const { path, thumbnailPath, previewPath, rating, is_edited, data, sourceRevision } = event.payload;
        if (!refs.current.shouldAcceptGenerated(path, sourceRevision)) {
          if (thumbnailPath || data) refs.current.retryStaleGenerated(path);
          return;
        }

        if (thumbnailPath && previewPath) {
          thumbnailBuffer.current[path] = convertFileSrc(thumbnailPath.replace(/\\/g, '/'));
          mediumThumbnailBuffer.current[path] = convertFileSrc(previewPath.replace(/\\/g, '/'));
          thumbnailRevisionBuffer.current[path] = sourceRevision ?? null;
          refs.current.markGenerated(path);
        } else if (data) {
          thumbnailBuffer.current[path] = data;
          mediumThumbnailBuffer.current[path] = data;
          thumbnailRevisionBuffer.current[path] = sourceRevision ?? null;
          refs.current.markGenerated(path);
        }
        if (rating !== undefined) {
          ratingBuffer.current[path] = rating;
        }
        if (is_edited !== undefined) {
          editStatusBuffer.current[path] = is_edited;
        }
        if (thumbnailPath || data || rating !== undefined || is_edited !== undefined) {
          scheduleFlush();
        }
      }),
      listen<{ path: string; rating: number; is_edited: boolean; tags: string[] | null }>(
        'image-metadata-loaded',
        (event) => {
          if (!isEffectActive) return;
          const { path, rating, is_edited, tags } = event.payload;

          useLibraryStore.getState().setLibrary((state) => ({
            imageRatings: { ...state.imageRatings, [path]: rating },
            imageList: state.imageList.map((img) =>
              img.path === path ? { ...img, is_edited, tags: tags ?? img.tags } : img,
            ),
          }));
        },
      ),
      listen<string>('ai-model-download-start', (event) => {
        if (isEffectActive) useProcessStore.getState().setProcess({ aiModelDownloadStatus: event.payload });
      }),
      listen('ai-model-download-finish', () => {
        if (isEffectActive) useProcessStore.getState().setProcess({ aiModelDownloadStatus: null });
      }),
      listen('indexing-started', () => {
        if (isEffectActive)
          useProcessStore.getState().setProcess({ isIndexing: true, indexingProgress: { current: 0, total: 0 } });
      }),
      listen<Progress>('indexing-progress', (event) => {
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
      listen<Progress>('batch-export-progress', (event) => {
        if (isEffectActive) useProcessStore.getState().setExportState({ progress: event.payload });
      }),
      listen('export-complete', () => {
        if (isEffectActive) useProcessStore.getState().setExportState({ status: Status.Success });
      }),
      listen<unknown>('export-error', (event) => {
        if (isEffectActive)
          useProcessStore.getState().setExportState({
            status: Status.Error,
            errorMessage: typeof event.payload === 'string' ? event.payload : 'Unknown error',
          });
      }),
      listen('export-cancelling', () => {
        if (isEffectActive) useProcessStore.getState().setExportState({ status: Status.Cancelling });
      }),
      listen('export-cancelled', () => {
        if (isEffectActive) useProcessStore.getState().setExportState({ status: Status.Cancelled });
      }),
      listen<{ total: number }>('import-start', (event) => {
        if (isEffectActive)
          useProcessStore.getState().setImportState({
            errorMessage: '',
            path: '',
            progress: { current: 0, total: event.payload.total },
            status: Status.Importing,
          });
      }),
      listen<Progress & { path: string }>('import-progress', (event) => {
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
      listen<unknown>('import-error', (event) => {
        if (isEffectActive)
          useProcessStore.getState().setImportState({
            status: Status.Error,
            errorMessage: typeof event.payload === 'string' ? event.payload : 'Unknown error',
          });
      }),
      listen<string>('denoise-progress', (event) => {
        if (isEffectActive)
          useUIStore.getState().setUI((state) => ({
            denoiseModalState: { ...state.denoiseModalState, progressMessage: event.payload as string },
          }));
      }),
      listen<string | { denoised: string; original: string }>('denoise-complete', (event) => {
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
      listen<unknown>('denoise-error', (event) => {
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
      listen<{
        path: string;
        generation: number;
        inputRevision: number | null;
        renderAttempt: number | null;
        qualityTier: string | null;
      }>('wgpu-frame-ready', (event) => {
        if (
          isEffectActive &&
          event.payload?.path === useEditorStore.getState().selectedImage?.path &&
          event.payload.generation === useEditorStore.getState().backendGeneration &&
          acceptMainPreviewAttempt(event.payload.inputRevision, event.payload.renderAttempt)
        ) {
          tracePreview({
            stage: 'wgpu-frame-ready',
            session: useEditorStore.getState().imageSession,
            generation: event.payload.generation,
            revision: event.payload.inputRevision!,
            attempt: event.payload.renderAttempt!,
            tier:
              event.payload.qualityTier === 'quick' ||
              event.payload.qualityTier === 'detail' ||
              event.payload.qualityTier === 'full'
                ? event.payload.qualityTier
                : 'unknown',
          });
          useEditorStore.getState().setEditor({ hasRenderedFirstFrame: true });
        }
      }),
      listen<string>('panorama-progress', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => {
            if (state.panoramaModalState.finalImageBase64 || state.panoramaModalState.error) return state;
            return { panoramaModalState: { ...state.panoramaModalState, progressMessage: event.payload } };
          });
        }
      }),
      listen<{ base64: string }>('panorama-complete', (event) => {
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
      listen<unknown>('panorama-error', (event) => {
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
      listen<string>('hdr-progress', (event) => {
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
      listen<{ base64: string }>('hdr-complete', (event) => {
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
      listen<unknown>('hdr-error', (event) => {
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
      listen<string>('focus-stack-progress', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => {
            if (state.focusStackModalState.finalImageBase64 || state.focusStackModalState.error) return state;
            return { focusStackModalState: { ...state.focusStackModalState, progressMessage: event.payload } };
          });
        }
      }),
      listen<{ base64: string; depthMap: string }>('focus-stack-complete', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            focusStackModalState: {
              ...state.focusStackModalState,
              error: null,
              finalImageBase64: event.payload.base64,
              depthMapBase64: event.payload.depthMap,
              isProcessing: false,
              progressMessage: null,
            },
          }));
        }
      }),
      listen<unknown>('focus-stack-error', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            focusStackModalState: {
              ...state.focusStackModalState,
              error: String(event.payload),
              finalImageBase64: null,
              depthMapBase64: null,
              isProcessing: false,
              progressMessage: null,
            },
          }));
        }
      }),
      listen<number>('culling-start', (event) => {
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
      listen<NonNullable<ReturnType<typeof useUIStore.getState>['cullingModalState']['progress']>>(
        'culling-progress',
        (event) => {
          if (isEffectActive) {
            useUIStore
              .getState()
              .setUI((state) => ({ cullingModalState: { ...state.cullingModalState, progress: event.payload } }));
          }
        },
      ),
      listen<CullingSuggestions>('culling-complete', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            cullingModalState: { ...state.cullingModalState, progress: null, suggestions: event.payload },
          }));
        }
      }),
      listen<unknown>('culling-error', (event) => {
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
      mediumThumbnailBuffer.current = {};
      thumbnailRevisionBuffer.current = {};
      ratingBuffer.current = {};
      editStatusBuffer.current = {};
      listeners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);
}
