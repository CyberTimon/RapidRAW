import { useUIStore } from '../store/useUIStore';
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { Invokes } from '../components/ui/AppProperties';
import { INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments, type Adjustments } from '../utils/adjustments';

export function useImageLoader(
  cachedEditStateRef: React.RefObject<any>,
  prevAdjustmentsRef: React.RefObject<{ path: string; adjustments: Adjustments } | null>,
) {
  const activeView = useUIStore((s) => s.activeView);
  const selectedImage = useEditorStore((s) => s.selectedImage);
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

  const isWgpuActive = appSettings?.useWgpuRenderer !== false && selectedImage?.isReady && hasRenderedFirstFrame;

  useEffect(() => {
    if (activeView === 'editor' && selectedImage && !selectedImage.isReady && selectedImage.path) {
      let isEffectActive = true;
      const selectedPath = selectedImage.path;
      const adjustmentsAtLoadStart = useEditorStore.getState().adjustments;

      const loadMetadataEarly = async () => {
        try {
          useEditorStore.getState().patchesSentToBackend.clear();
          await invoke('clear_session_caches').catch((e) => console.warn('Cache clear failed:', e));

          const metadata: any = await invoke(Invokes.LoadMetadata, { path: selectedPath });
          if (!isEffectActive) return;

          const current = useEditorStore.getState();
          if (current.selectedImage?.path !== selectedPath || current.adjustments !== adjustmentsAtLoadStart) return;

          let initialAdjusts;
          if (metadata.adjustments && !metadata.adjustments.is_null) {
            initialAdjusts = normalizeLoadedAdjustments(metadata.adjustments);
          } else {
            initialAdjusts = { ...INITIAL_ADJUSTMENTS };
          }

          setEditor({ adjustments: initialAdjusts });
          resetHistory(initialAdjusts);
          prevAdjustmentsRef.current = { path: selectedPath, adjustments: initialAdjusts };
        } catch (err) {
          console.error('Failed to load metadata early:', err);
        }
      };

      const loadFullImageData = async () => {
        try {
          const loadImageResult: any = await invoke(Invokes.LoadImage, { path: selectedPath });
          if (!isEffectActive) return;

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
            if (state.selectedImage && state.selectedImage.path === selectedPath) {
              const nextAdjustments =
                !state.adjustments.aspectRatio && !state.adjustments.crop
                  ? { ...state.adjustments, aspectRatio: loadImageResult.width / loadImageResult.height }
                  : state.adjustments;
              prevAdjustmentsRef.current = { path: selectedPath, adjustments: nextAdjustments };
              return {
                adjustments: nextAdjustments,
                selectedImage: {
                  ...state.selectedImage,
                  exif: loadImageResult.exif,
                  height: loadImageResult.height,
                  isRaw: loadImageResult.is_raw,
                  isReady: true,
                  metadata: loadImageResult.metadata,
                  width: loadImageResult.width,
                },
              };
            }
            return state;
          });
        } catch (err) {
          if (isEffectActive) {
            console.error('Failed to load image:', err);
            toast.error(`Failed to load image: ${err}`);
            setEditor({ selectedImage: null });
          }
        } finally {
          if (isEffectActive) {
            setLibrary({ isViewLoading: false });
          }
        }
      };

      const loadAll = async () => {
        await loadMetadataEarly();
        if (isEffectActive) {
          await loadFullImageData();
        }
      };

      loadAll();

      return () => {
        isEffectActive = false;
      };
    }
  }, [
    activeView,
    selectedImage?.path,
    selectedImage?.isReady,
    appSettings?.editorPreviewResolution,
    resetHistory,
    setEditor,
    setLibrary,
    prevAdjustmentsRef,
  ]);

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
