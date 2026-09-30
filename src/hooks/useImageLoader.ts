import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useUIStore } from '../store/useUIStore';
import { Invokes, ImageMetadata } from '../components/ui/AppProperties';
import { INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments } from '../utils/adjustments';

import { globalImageCache, type ImageCacheEntry } from '../utils/ImageLRUCache';
import { tracePreview } from '../utils/previewDiagnostics';
import { latestPreviewRevision } from '../utils/previewIntent';
import type { LoadImageResult } from './hookTypes';

export function useImageLoader(
  cachedEditStateRef: React.RefObject<ImageCacheEntry | null>,
  invalidateSourceThumbnails?: (path: string, sourceRevision: string | null) => void,
  needsSourceThumbnailRefresh?: (path: string, sourceRevision: string) => boolean,
) {
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const imageSession = useEditorStore((s) => s.imageSession);
  const adjustments = useEditorStore((s) => s.adjustments);
  const histogram = useEditorStore((s) => s.histogram);
  const waveform = useEditorStore((s) => s.waveform);
  const finalPreviewUrl = useEditorStore((s) => s.finalPreviewUrl);
  const uncroppedAdjustedPreviewUrl = useEditorStore((s) => s.uncroppedAdjustedPreviewUrl);
  const originalSize = useEditorStore((s) => s.originalSize);
  const previewSize = useEditorStore((s) => s.previewSize);
  const hasRenderedFirstFrame = useEditorStore((s) => s.hasRenderedFirstFrame);

  const setEditor = useEditorStore((s) => s.setEditor);
  const resetHistory = useEditorStore((s) => s.resetHistory);
  const setLibrary = useLibraryStore((s) => s.setLibrary);
  const appSettings = useSettingsStore((s) => s.appSettings);
  const activeView = useUIStore((s) => s.activeView);

  const isWgpuActive = appSettings?.useWgpuRenderer !== false && selectedImage?.isReady && hasRenderedFirstFrame;

  useEffect(() => {
    if (selectedImage && !selectedImage.isReady && selectedImage.path) {
      let isEffectActive = true;
      const session = imageSession;
      const initialRecipe = useEditorStore.getState().adjustments;
      const isCurrent = () =>
        isEffectActive &&
        session === useEditorStore.getState().imageSession &&
        selectedImage.path === useEditorStore.getState().selectedImage?.path;

      const loadMetadataEarly = async () => {
        try {
          const metadata: ImageMetadata = await invoke(Invokes.LoadMetadata, { path: selectedImage.path });
          if (!isCurrent()) return;

          let initialAdjusts;
          if (metadata.adjustments) {
            initialAdjusts = normalizeLoadedAdjustments(metadata.adjustments);
          } else {
            initialAdjusts = { ...INITIAL_ADJUSTMENTS };
          }

          if (!selectedImage.preserveCachedAdjustments && useEditorStore.getState().adjustments === initialRecipe) {
            setEditor({ adjustments: initialAdjusts });
            resetHistory(initialAdjusts);
          }
        } catch (err) {
          console.error('Failed to load metadata early:', err);
        }
      };

      const loadFullImageData = async () => {
        try {
          const loadStart = performance.now();
          const revision = latestPreviewRevision('main');
          tracePreview({
            stage: 'source-load-start',
            session,
            generation: null,
            revision,
            attempt: 0,
            tier: 'unknown',
          });
          const loadImageResult: LoadImageResult = await invoke(Invokes.LoadImage, { path: selectedImage.path });
          tracePreview({
            stage: 'source-load-return',
            session,
            generation: loadImageResult.generation,
            revision,
            attempt: 0,
            tier: 'unknown',
            durationMs: performance.now() - loadStart,
          });
          if (!isCurrent()) return;
          const physicalPath = selectedImage.path.split('?vc=')[0];
          const validatedRevision =
            useEditorStore.getState().selectedImage?.cachedSourceRevision ?? selectedImage.cachedSourceRevision;
          const sourceChanged = !!validatedRevision && validatedRevision !== loadImageResult.source_revision;
          if (sourceChanged) globalImageCache.deleteByPrefix(physicalPath);
          if (sourceChanged || needsSourceThumbnailRefresh?.(selectedImage.path, loadImageResult.source_revision)) {
            invalidateSourceThumbnails?.(selectedImage.path, loadImageResult.source_revision);
          }

          const { width, height } = loadImageResult;
          setEditor({ originalSize: { width, height } });

          if (appSettings?.editorPreviewResolution) {
            const maxSize = appSettings.editorPreviewResolution;
            const aspectRatio = width / height;

            if (width > height) {
              const pWidth = Math.min(width, maxSize);
              const pHeight = Math.round(pWidth / aspectRatio);
              setEditor({ previewSize: { width: pWidth, height: pHeight } });
            } else {
              const pHeight = Math.min(height, maxSize);
              const pWidth = Math.round(pHeight * aspectRatio);
              setEditor({ previewSize: { width: pWidth, height: pHeight } });
            }
          } else {
            setEditor({ previewSize: { width: 0, height: 0 } });
          }

          setEditor((state) => {
            if (state.selectedImage && state.selectedImage.path === selectedImage.path) {
              return {
                backendGeneration: loadImageResult.generation,
                ...(sourceChanged
                  ? {
                      finalPreviewUrl: null,
                      uncroppedAdjustedPreviewUrl: null,
                      histogram: null,
                      waveform: null,
                      hasRenderedFirstFrame: false,
                    }
                  : {}),
                selectedImage: {
                  ...state.selectedImage,
                  exif: loadImageResult.exif,
                  height: loadImageResult.height,
                  isRaw: loadImageResult.is_raw,
                  isReady: true,
                  metadata: loadImageResult.metadata,
                  thumbnailUrl: sourceChanged ? '' : state.selectedImage.thumbnailUrl,
                  sourceRevision: loadImageResult.source_revision,
                  cachedSourceRevision: undefined,
                  preserveCachedAdjustments: false,
                  width: loadImageResult.width,
                },
              };
            }
            return state;
          });

          setEditor((state) => {
            if (!state.adjustments.aspectRatio && !state.adjustments.crop) {
              return {
                adjustments: { ...state.adjustments, aspectRatio: loadImageResult.width / loadImageResult.height },
              };
            }
            return state;
          });
        } catch (err) {
          if (isCurrent()) {
            console.error('Failed to load image:', err);
            toast.error(`Failed to load image: ${err}`);
            setLibrary({ isViewLoading: false });
            setEditor({ selectedImage: null });
          }
        } finally {
          if (isCurrent()) {
            setLibrary({ isViewLoading: false });
          }
        }
      };

      const loadAll = async () => {
        await loadMetadataEarly();
        if (isCurrent()) {
          await loadFullImageData();
        }
      };

      loadAll();

      return () => {
        isEffectActive = false;
      };
    }
  }, [
    selectedImage?.path,
    selectedImage?.isReady,
    imageSession,
    appSettings?.editorPreviewResolution,
    resetHistory,
    setEditor,
    setLibrary,
    invalidateSourceThumbnails,
    needsSourceThumbnailRefresh,
  ]);

  useEffect(() => {
    globalImageCache.setDisplayed(
      activeView === 'editor' ? (selectedImage?.path ?? null) : null,
      activeView === 'editor' ? finalPreviewUrl : null,
      activeView === 'editor' ? uncroppedAdjustedPreviewUrl : null,
    );
  }, [activeView, selectedImage?.path, finalPreviewUrl, uncroppedAdjustedPreviewUrl]);

  useEffect(() => () => globalImageCache.setDisplayed(null, null, null), []);

  useEffect(() => {
    if (selectedImage?.path && selectedImage.isReady && (finalPreviewUrl || isWgpuActive)) {
      cachedEditStateRef.current = {
        adjustments,
        histogram,
        waveform,
        finalPreviewUrl,
        uncroppedPreviewUrl: uncroppedAdjustedPreviewUrl,
        selectedImage,
        originalSize,
        previewSize,
        sourceRevision: selectedImage.sourceRevision,
      };
    } else {
      cachedEditStateRef.current = null;
    }
  }, [
    selectedImage,
    adjustments,
    histogram,
    waveform,
    finalPreviewUrl,
    uncroppedAdjustedPreviewUrl,
    originalSize,
    previewSize,
    isWgpuActive,
    cachedEditStateRef,
  ]);
}
