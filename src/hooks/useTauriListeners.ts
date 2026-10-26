import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { Status } from '../components/ui/ExportImportProperties';
import { Invokes, Progress, WaveformData } from '../components/ui/AppProperties';
import { MaskContainer } from '../utils/adjustments';
import { AiJobsStatus, JobKind, JobStatus, useProcessStore } from '../store/useProcessStore';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useLibraryStore } from '../store/useLibraryStore';

const parseAnalyticsPacket = async (buffer: ArrayBuffer) => {
  const view = new DataView(buffer);
  let offset = 0;
  const readU32 = () => {
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };

  const pathLength = readU32();
  const path = new TextDecoder().decode(new Uint8Array(buffer, offset, pathLength));
  offset += pathLength;

  const bins = readU32();
  let histogram: { red: number[]; green: number[]; blue: number[]; luma: number[] } | null = null;
  if (bins > 0) {
    const readChannel = () => {
      const channel = new Array<number>(bins);
      for (let i = 0; i < bins; i++) {
        channel[i] = view.getFloat32(offset, true);
        offset += 4;
      }
      return channel;
    };
    histogram = { red: readChannel(), green: readChannel(), blue: readChannel(), luma: readChannel() };
  }

  const width = readU32();
  const height = readU32();
  let waveform: WaveformData | null = null;
  if (width > 0 && height > 0) {
    const readPlane = () => {
      const length = readU32();
      const plane = new Uint8ClampedArray(buffer, offset, length);
      offset += length;
      return length === width * height * 4 ? createImageBitmap(new ImageData(plane, width, height)) : null;
    };
    const [rgb, luma, parade, vectorscope] = await Promise.all([readPlane(), readPlane(), readPlane(), readPlane()]);
    waveform = { width, height, rgb, luma, parade, vectorscope };
  }

  return { path, histogram, waveform };
};

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
  const mediumThumbnailBuffer = useRef<Record<string, string>>({});
  const ratingBuffer = useRef<Record<string, number>>({});
  const editStatusBuffer = useRef<Record<string, boolean>>({});
  const metadataBuffer = useRef<Record<string, { flag: any; tags: any; needs_ai: boolean }>>({});
  const progressBuffer = useRef<{ current: number; total: number } | null>(null);
  const flushHandle = useRef<number | null>(null);

  useEffect(() => {
    let isEffectActive = true;
    let aiTaggingJobId: string | null = null;
    const modelDownloadJobIds: Record<string, string> = {};

    const flushThumbnailBatch = () => {
      flushHandle.current = null;
      if (!isEffectActive) return;

      const pendingThumbs = thumbnailBuffer.current;
      const pendingMediumThumbs = mediumThumbnailBuffer.current;
      const pendingRatings = ratingBuffer.current;
      const pendingEdits = editStatusBuffer.current;
      const pendingMetadata = metadataBuffer.current;
      const pendingProgress = progressBuffer.current;

      thumbnailBuffer.current = {};
      mediumThumbnailBuffer.current = {};
      ratingBuffer.current = {};
      editStatusBuffer.current = {};
      metadataBuffer.current = {};
      progressBuffer.current = null;

      const hasThumbs = Object.keys(pendingThumbs).length > 0;
      if (hasThumbs || pendingProgress) {
        useProcessStore.getState().setProcess((state) => {
          const update: Partial<typeof state> = {};
          if (hasThumbs) {
            update.thumbnails = { ...state.thumbnails, ...pendingThumbs };
            update.mediumThumbnails = { ...state.mediumThumbnails, ...pendingMediumThumbs };
          }
          if (
            pendingProgress &&
            (state.thumbnailProgress?.current !== pendingProgress.current ||
              state.thumbnailProgress?.total !== pendingProgress.total)
          ) {
            update.thumbnailProgress = pendingProgress;
          }
          return update;
        });
      }

      const ratingPaths = Object.keys(pendingRatings);
      const editPaths = Object.keys(pendingEdits);
      const metadataPaths = Object.keys(pendingMetadata);
      if (ratingPaths.length === 0 && editPaths.length === 0 && metadataPaths.length === 0) return;

      const libraryState = useLibraryStore.getState();

      let nextRatings: Record<string, number> | null = null;
      for (const path of ratingPaths) {
        const rating = pendingRatings[path];
        if (libraryState.imageRatings[path] !== rating || !(path in libraryState.imageRatings)) {
          if (!nextRatings) nextRatings = { ...libraryState.imageRatings };
          nextRatings[path] = rating;
        }
      }

      let nextImageList: typeof libraryState.imageList | null = null;
      if (editPaths.length > 0 || metadataPaths.length > 0) {
        const list = libraryState.imageList;
        for (let i = 0; i < list.length; i++) {
          const img = list[i];
          const hasEdit = img.path in pendingEdits;
          const meta = pendingMetadata[img.path];
          if (!hasEdit && !meta) continue;
          const isEdited = hasEdit ? pendingEdits[img.path] : img.is_edited;
          const flag = meta ? meta.flag : img.flag;
          const tags = meta ? (meta.tags ?? img.tags) : img.tags;
          const needsAi = meta ? meta.needs_ai : img.needs_ai;
          if (isEdited === img.is_edited && flag === img.flag && tags === img.tags && needsAi === img.needs_ai)
            continue;
          if (!nextImageList) nextImageList = list.slice();
          nextImageList[i] = meta
            ? { ...img, flag, is_edited: isEdited, tags, needs_ai: needsAi }
            : { ...img, is_edited: isEdited };
        }
      }

      if (nextRatings || nextImageList) {
        const update: Partial<typeof libraryState> = {};
        if (nextRatings) update.imageRatings = nextRatings;
        if (nextImageList) update.imageList = nextImageList;
        libraryState.setLibrary(update);
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
      listen('open-with-file', (event: any) => {
        if (isEffectActive) useProcessStore.getState().setProcess({ initialFileToOpen: event.payload as string });
      }),
      listen('external-edit-session', (event: any) => {
        if (isEffectActive) useProcessStore.getState().setProcess({ externalEditSession: event.payload });
      }),
      listen('thumbnail-progress', (event: any) => {
        if (!isEffectActive) return;
        progressBuffer.current = { current: event.payload.current, total: event.payload.total };
        scheduleFlush();
      }),
      listen('thumbnail-generation-complete', () => {
        if (!isEffectActive) return;
        progressBuffer.current = null;
        useProcessStore.getState().setProcess({ thumbnailProgress: { current: 0, total: 0 } });
      }),
      listen('thumbnail-generated', (event: any) => {
        if (!isEffectActive) return;
        const { path, thumbnailPath, previewPath, rating, is_edited, data } = event.payload;

        if (thumbnailPath && previewPath) {
          thumbnailBuffer.current[path] = convertFileSrc(thumbnailPath.replace(/\\/g, '/'));
          mediumThumbnailBuffer.current[path] = convertFileSrc(previewPath.replace(/\\/g, '/'));
          refs.current.markGenerated(path);
        } else if (data) {
          thumbnailBuffer.current[path] = data;
          mediumThumbnailBuffer.current[path] = data;
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
      listen('image-metadata-loaded', (event: any) => {
        if (!isEffectActive) return;
        const { path, rating, flag, is_edited, tags, needs_ai } = event.payload;

        ratingBuffer.current[path] = rating;
        editStatusBuffer.current[path] = is_edited;
        metadataBuffer.current[path] = { flag, tags, needs_ai };
        scheduleFlush();
      }),
      listen<string>('ai-model-download-start', (event) => {
        if (isEffectActive)
          modelDownloadJobIds[event.payload] = useProcessStore
            .getState()
            .startJob(JobKind.ModelDownload, { detail: event.payload });
      }),
      listen<{ name: string; current: number; total: number }>('ai-model-download-progress', (event) => {
        const { name, current, total } = event.payload;
        const jobId = modelDownloadJobIds[name];
        if (isEffectActive && jobId) useProcessStore.getState().updateJob(jobId, { progress: { current, total } });
      }),
      listen<{ name: string; error: string | null }>('ai-model-download-finish', (event) => {
        if (!isEffectActive) return;
        const { name, error } = event.payload;
        const jobId = modelDownloadJobIds[name];
        delete modelDownloadJobIds[name];
        if (jobId)
          useProcessStore
            .getState()
            .updateJob(jobId, error ? { status: JobStatus.Error, error } : { status: JobStatus.Success });
      }),
      listen<Progress>('indexing-started', (event) => {
        if (!isEffectActive) return;
        const { removeJob, startJob } = useProcessStore.getState();
        if (aiTaggingJobId) removeJob(aiTaggingJobId);
        aiTaggingJobId = startJob(JobKind.AiTagging, { progress: event.payload });
      }),
      listen<Progress>('indexing-progress', (event) => {
        if (isEffectActive && aiTaggingJobId)
          useProcessStore.getState().updateJob(aiTaggingJobId, { progress: event.payload });
      }),
      listen('indexing-cancelled', () => {
        if (isEffectActive && aiTaggingJobId) useProcessStore.getState().removeJob(aiTaggingJobId);
        aiTaggingJobId = null;
      }),
      listen('indexing-finished', () => {
        if (isEffectActive) {
          if (aiTaggingJobId) useProcessStore.getState().updateJob(aiTaggingJobId, { status: JobStatus.Success });
          aiTaggingJobId = null;
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
      listen('export-cancelling', () => {
        if (isEffectActive) useProcessStore.getState().setExportState({ status: Status.Cancelling });
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
      listen<{ path: string; progress: number }>('ai-denoise-progress', (event) => {
        if (!isEffectActive) return;
        const { path, progress } = event.payload;
        useEditorStore
          .getState()
          .setEditor((state) => ({ aiDenoiseProgress: { ...state.aiDenoiseProgress, [path]: progress } }));
      }),
      listen<string>('ai-denoise-ready', (event) => {
        if (!isEffectActive) return;
        useEditorStore.getState().setEditor((state) => {
          const { [event.payload]: _, ...aiDenoiseProgress } = state.aiDenoiseProgress;
          return {
            aiDenoiseProgress,
            ...(state.selectedImage?.path === event.payload ? { adjustments: { ...state.adjustments } } : {}),
          };
        });
      }),
      listen<{ path: string; error: string }>('ai-denoise-error', (event) => {
        if (!isEffectActive) return;
        const { path, error } = event.payload;
        toast.error(`AI denoise failed: ${error}`);
        useEditorStore.getState().setEditor((state) => {
          const { [path]: _, ...aiDenoiseProgress } = state.aiDenoiseProgress;
          return {
            aiDenoiseProgress,
            ...(state.selectedImage?.path === path
              ? { adjustments: { ...state.adjustments, aiDenoiseEnabled: false } }
              : {}),
          };
        });
      }),
      listen<AiJobsStatus>('ai-jobs-status', (event) => {
        if (!isEffectActive) return;
        const { aiJobs, setProcess } = useProcessStore.getState();
        const selectedPath = useEditorStore.getState().selectedImage?.path;
        event.payload.failed
          .filter((job) => job.path === selectedPath && !aiJobs.failed.some((prev) => prev.path === job.path))
          .forEach((job) => toast.error(`AI Processing Failed: ${job.error}`));
        setProcess({ aiJobs: event.payload });
      }),
      listen<{ added: string[]; removed: string[]; resolved: boolean }>('ai-jobs-pending', (event) => {
        if (!isEffectActive) return;
        const { added, removed, resolved } = event.payload;
        useProcessStore.getState().setProcess((state) => {
          const aiPendingPaths = { ...state.aiPendingPaths };
          added.forEach((path) => (aiPendingPaths[path] = true));
          removed.forEach((path) => delete aiPendingPaths[path]);
          return { aiPendingPaths };
        });

        const removedPaths = new Set(removed);
        const { imageList, setLibrary } = useLibraryStore.getState();
        if (imageList.some((img) => removedPaths.has(img.path) && img.needs_ai === resolved)) {
          setLibrary({
            imageList: imageList.map((img) => (removedPaths.has(img.path) ? { ...img, needs_ai: !resolved } : img)),
          });
        }
      }),
      listen<{ path: string; subMasks: Record<string, any>; maps: Record<string, string>; noResults: string[] }>(
        'ai-job-result',
        (event) => {
          const { path, subMasks, maps, noResults } = event.payload;
          const { selectedImage, patchesSentToBackend, setEditor } = useEditorStore.getState();
          if (!isEffectActive || selectedImage?.path !== path) return;

          noResults.forEach((noResult) => toast.error(`AI Mask: ${noResult}`));
          Object.keys(subMasks).forEach((id) => patchesSentToBackend.delete(id));
          setEditor((state) => ({
            adjustments: {
              ...state.adjustments,
              ...maps,
              masks: state.adjustments.masks?.map((container: MaskContainer) => ({
                ...container,
                subMasks: container.subMasks.map((subMask) =>
                  subMasks[subMask.id]
                    ? { ...subMask, parameters: { ...subMask.parameters, ...subMasks[subMask.id] } }
                    : subMask,
                ),
              })),
            },
          }));
        },
      ),
      listen('wgpu-frame-ready', (event: any) => {
        const editorState = useEditorStore.getState();
        if (
          isEffectActive &&
          !editorState.hasRenderedFirstFrame &&
          event.payload?.path === editorState.selectedImage?.path
        ) {
          editorState.setEditor({ hasRenderedFirstFrame: true });
        }
      }),
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
      listen('focus-stack-progress', (event: any) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => {
            if (state.focusStackModalState.finalImageBase64 || state.focusStackModalState.error) return state;
            return { focusStackModalState: { ...state.focusStackModalState, progressMessage: event.payload } };
          });
        }
      }),
      listen('focus-stack-complete', (event: any) => {
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
      listen('focus-stack-error', (event: any) => {
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

    invoke<AiJobsStatus>(Invokes.GetAiJobsStatus)
      .then((aiJobs) => {
        if (isEffectActive) useProcessStore.getState().setProcess({ aiJobs });
      })
      .catch((err) => console.error('Failed to load AI job status:', err));
    let analyticsSequence = 0;
    let latestAppliedAnalytics = 0;
    const analyticsChannel = new Channel<ArrayBuffer>();
    analyticsChannel.onmessage = async (buffer) => {
      const sequence = ++analyticsSequence;
      const { path, histogram, waveform } = await parseAnalyticsPacket(buffer);
      if (!isEffectActive || sequence < latestAppliedAnalytics) return;
      if (path !== useEditorStore.getState().selectedImage?.path) return;
      latestAppliedAnalytics = sequence;
      const update: { histogram?: any; waveform?: WaveformData } = {};
      if (histogram) update.histogram = histogram;
      if (waveform) update.waveform = waveform;
      useEditorStore.getState().setEditor(update);
    };
    invoke(Invokes.SubscribeAnalytics, { channel: analyticsChannel }).catch((err) =>
      console.error('Failed to subscribe to analytics:', err),
    );

    invoke<string[]>(Invokes.GetPendingAiPaths)
      .then((paths) => {
        if (isEffectActive) {
          useProcessStore
            .getState()
            .setProcess({ aiPendingPaths: Object.fromEntries(paths.map((path) => [path, true as const])) });
        }
      })
      .catch((err) => console.error('Failed to load pending AI jobs:', err));

    return () => {
      isEffectActive = false;
      if (flushHandle.current !== null) {
        cancelAnimationFrame(flushHandle.current);
        flushHandle.current = null;
      }
      thumbnailBuffer.current = {};
      mediumThumbnailBuffer.current = {};
      ratingBuffer.current = {};
      editStatusBuffer.current = {};
      metadataBuffer.current = {};
      progressBuffer.current = null;
      listeners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);
}
