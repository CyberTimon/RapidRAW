import React, { useCallback, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import debounce from 'lodash.debounce';
import throttle from 'lodash.throttle';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { Adjustments, COPYABLE_ADJUSTMENT_KEYS } from '../utils/adjustments';
import { Invokes, Panel } from '../components/ui/AppProperties';
import { debouncedSave, getOriginalAdjustments } from './useEditorActions';
import { globalImageCache } from '../utils/ImageLRUCache';
import { prepareAdjustmentsPayload } from '../utils/backendPayload';
import { calculateTargetResolution, getVisibleImageRegion } from '../utils/previewResolution';
import { getDevicePixelRatio } from '../utils/displayScale';

const isWgpuRender = (buffer: ArrayBuffer) => new TextDecoder().decode(buffer.slice(0, 11)) === 'WGPU_RENDER';

const isSameIgnoringCrop = (a: Adjustments, b: Adjustments) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as Array<keyof Adjustments>);
  for (const key of keys) {
    if (key !== 'crop' && a[key] !== b[key]) return false;
  }
  return true;
};

const releasePreviewUrl = (url: string | null | undefined) => {
  if (url && url.startsWith('blob:') && !globalImageCache.isProtected(url)) {
    setTimeout(() => {
      if (!globalImageCache.isProtected(url)) {
        URL.revokeObjectURL(url);
      }
    }, 250);
  }
};

export function useImageProcessing(
  transformWrapperRef: any,
  prevAdjustmentsRef: React.RefObject<any>,
  renderRefs: {
    previewJobIdRef: React.RefObject<number>;
    latestRenderedJobIdRef: React.RefObject<number>;
    currentResRef: React.RefObject<number>;
  },
) {
  const { previewJobIdRef, latestRenderedJobIdRef, currentResRef } = renderRefs;

  const selectedImage = useEditorStore((state) => state.selectedImage);
  const adjustments = useEditorStore((state) => state.adjustments);
  const previewOverride = useEditorStore((state) => state.previewOverride);
  const isWaveformVisible = useEditorStore((state) => state.isWaveformVisible);
  const activeWaveformChannel = useEditorStore((state) => state.activeWaveformChannel);
  const displaySize = useEditorStore((state) => state.displaySize);
  const baseRenderSize = useEditorStore((state) => state.baseRenderSize);
  const originalSize = useEditorStore((state) => state.originalSize);
  const isSliderDragging = useEditorStore((state) => state.isSliderDragging);
  const compareView = useEditorStore((state) => state.compareView);
  const setEditor = useEditorStore((state) => state.setEditor);

  const activeView = useUIStore((state) => state.activeView);
  const activePanel = useUIStore((state) => state.activePanel);
  const isViewerOpen = useUIStore((state) => state.isViewerOpen);
  const appSettings = useSettingsStore((state) => state.appSettings);
  const multiSelectedPaths = useLibraryStore((state) => state.multiSelectedPaths);

  const uncroppedJobIdRef = useRef(0);
  const latestUncroppedJobIdRef = useRef(0);
  const lastUncroppedRequestRef = useRef<{ path: string; adjustments: Adjustments; res: number } | null>(null);

  const originalRequestKeyRef = useRef<string | null>(null);
  const inFlightCountRef = useRef(0);
  const pendingApplyRef = useRef<{ adjustments: Adjustments; targetRes?: number } | null>(null);
  const dragIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeWaveformChannelRef = useRef(activeWaveformChannel);
  activeWaveformChannelRef.current = activeWaveformChannel;

  const selectedImagePathRef = useRef<string | null>(null);
  useEffect(() => {
    selectedImagePathRef.current = selectedImage?.path ?? null;
  }, [selectedImage?.path]);

  const calculateROI = useCallback(() => {
    if (!transformWrapperRef.current) return null;
    const state = transformWrapperRef.current.instance.transformState;
    if (!state) return null;

    if (!baseRenderSize || state.scale <= 1.01) return null;

    const region = getVisibleImageRegion(state, baseRenderSize);
    if (!region) return null;

    const paddingX = 2 / baseRenderSize.width;
    const paddingY = 2 / baseRenderSize.height;
    const x = Math.max(0, region[0] - paddingX);
    const y = Math.max(0, region[1] - paddingY);
    const width = Math.min(1 - x, region[2] + paddingX * 2);
    const height = Math.min(1 - y, region[3] + paddingY * 2);
    if (width > 0.999 && height > 0.999) return null;

    return [x, y, width, height] as [number, number, number, number];
  }, [baseRenderSize, transformWrapperRef]);

  const renderOriginal = useCallback(
    async (targetRes?: number) => {
      const { selectedImage: image, adjustments: currentAdjustments, compareView: view } = useEditorStore.getState();
      const ui = useUIStore.getState();
      if (view === 'off' || !image?.isReady || ui.activeView !== 'editor' || ui.activePanel === Panel.Crop) return;

      const originalAdjustments = getOriginalAdjustments(currentAdjustments);
      const { useWgpuRenderer } = useSettingsStore.getState().appSettings ?? {};
      const key = JSON.stringify([image.path, targetRes, useWgpuRenderer, originalAdjustments]);
      if (key === originalRequestKeyRef.current) return;
      originalRequestKeyRef.current = key;

      const { payload, markSent } = prepareAdjustmentsPayload(originalAdjustments);
      try {
        const buffer: ArrayBuffer = await invoke(Invokes.ApplyAdjustments, {
          jsAdjustments: payload,
          original: true,
          isInteractive: false,
          targetResolution: targetRes || null,
          roi: null,
          requestAnalytics: false,
          computeWaveform: false,
          activeWaveformChannel: null,
        });
        markSent();

        if (key !== originalRequestKeyRef.current || !buffer || buffer.byteLength === 0) return;

        const url = isWgpuRender(buffer) ? null : URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
        setEditor((state) => {
          releasePreviewUrl(state.originalPreview?.url);
          return { originalPreview: { path: image.path, url } };
        });
      } catch {
        if (key === originalRequestKeyRef.current) originalRequestKeyRef.current = null;
      }
    },
    [setEditor],
  );

  const executeApplyAdjustments = useCallback(
    async (currentAdjustments: Adjustments, dragging: boolean = false, targetRes?: number) => {
      const currentPath = selectedImage?.path;
      if (!currentPath) return;

      const { payload, markSent } = prepareAdjustmentsPayload(currentAdjustments);

      const jobId = ++previewJobIdRef.current;
      const roi = calculateROI();

      try {
        const request = invoke<ArrayBuffer>(Invokes.ApplyAdjustments, {
          jsAdjustments: payload,
          original: false,
          isInteractive: dragging,
          targetResolution: targetRes || null,
          roi: roi || null,
          requestAnalytics: true,
          computeWaveform: !!isWaveformVisible,
          activeWaveformChannel: activeWaveformChannelRef.current || null,
        });
        if (!dragging) renderOriginal(targetRes);
        const buffer = await request;

        markSent();

        if (currentPath !== selectedImagePathRef.current) return;

        if (buffer && buffer.byteLength > 0 && jobId >= latestRenderedJobIdRef.current) {
          latestRenderedJobIdRef.current = jobId;

          if (isWgpuRender(buffer)) {
            setEditor((state) => {
              if (!state.interactivePatch) return state;
              if (state.interactivePatch.url) URL.revokeObjectURL(state.interactivePatch.url);
              return { interactivePatch: null };
            });
            return;
          }

          if (dragging) {
            const view = new DataView(buffer);
            const patchX = view.getUint32(0, true);
            const patchY = view.getUint32(4, true);
            const patchW = view.getUint32(8, true);
            const patchH = view.getUint32(12, true);
            const fullW = view.getUint32(16, true);
            const fullH = view.getUint32(20, true);

            const imageBuffer = buffer.slice(24);
            const blob = new Blob([imageBuffer], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);

            setEditor((state) => {
              if (state.interactivePatch && state.interactivePatch.url)
                setTimeout(() => URL.revokeObjectURL(state.interactivePatch.url), 100);
              return {
                interactivePatch: {
                  url,
                  normX: patchX / fullW,
                  normY: patchY / fullH,
                  normW: patchW / fullW,
                  normH: patchH / fullH,
                },
              };
            });
          } else {
            const blob = new Blob([buffer], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);

            if (currentPath !== selectedImagePathRef.current || jobId < latestRenderedJobIdRef.current) {
              URL.revokeObjectURL(url);
              return;
            }

            setEditor((state) => {
              releasePreviewUrl(state.finalPreviewUrl);
              return { finalPreviewUrl: url };
            });

            setEditor((state) => {
              if (state.interactivePatch && state.interactivePatch.url) {
                setTimeout(() => URL.revokeObjectURL(state.interactivePatch.url), 500);
              }
              return { interactivePatch: null };
            });
          }
        }
      } catch (err) {
        if (err !== 'Superseded or worker failed') {
          console.error('Failed to apply adjustments:', err);
        }
        if (!dragging) {
          setEditor((state) => {
            if (state.interactivePatch && state.interactivePatch.url) URL.revokeObjectURL(state.interactivePatch.url);
            return { interactivePatch: null };
          });
        }
      }
    },
    [
      selectedImage?.path,
      calculateROI,
      isWaveformVisible,
      setEditor,
      previewJobIdRef,
      latestRenderedJobIdRef,
      renderOriginal,
    ],
  );

  const flushPipeline = useCallback(() => {
    if (inFlightCountRef.current >= 3) return;
    if (!pendingApplyRef.current) return;

    const { adjustments, targetRes } = pendingApplyRef.current;
    pendingApplyRef.current = null;

    inFlightCountRef.current += 1;

    executeApplyAdjustments(adjustments, true, targetRes).finally(() => {
      inFlightCountRef.current -= 1;
      if (pendingApplyRef.current) {
        requestAnimationFrame(() => flushPipeline());
      }
    });
  }, [executeApplyAdjustments]);

  const applyAdjustments = useCallback(
    (currentAdjustments: Adjustments, dragging: boolean = false, targetRes?: number) => {
      if (!selectedImage?.isReady) return;

      if (dragging) {
        pendingApplyRef.current = { adjustments: currentAdjustments, targetRes };
        flushPipeline();
      } else {
        pendingApplyRef.current = null;
        executeApplyAdjustments(currentAdjustments, false, targetRes);
      }
    },
    [selectedImage?.isReady, flushPipeline, executeApplyAdjustments],
  );

  const throttledUncroppedPreview = useMemo(
    () =>
      throttle(
        (adj: Adjustments, targetResolution: number) => {
          const requestedImage = useEditorStore.getState().selectedImage;
          if (!requestedImage?.isReady) return;
          const jobId = ++uncroppedJobIdRef.current;
          const { payload, markSent } = prepareAdjustmentsPayload(adj);
          invoke<ArrayBuffer>(Invokes.GenerateUncroppedPreview, { jsAdjustments: payload, targetResolution })
            .then(async (buffer) => {
              markSent();
              if (!buffer || buffer.byteLength === 0) return;
              const url = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
              const image = new Image();
              image.src = url;
              await image.decode().catch(() => {});
              if (
                jobId < latestUncroppedJobIdRef.current ||
                useEditorStore.getState().selectedImage?.path !== requestedImage.path
              ) {
                URL.revokeObjectURL(url);
                return;
              }
              latestUncroppedJobIdRef.current = jobId;
              useEditorStore.getState().setEditor((state) => {
                releasePreviewUrl(state.uncroppedAdjustedPreviewUrl);
                return { uncroppedAdjustedPreviewUrl: url };
              });
            })
            .catch(console.error);
        },
        30,
        { leading: true, trailing: true },
      ),
    [],
  );

  const fittedDisplayMax = useMemo(() => {
    if (!selectedImage?.width || !selectedImage?.height) return 0;
    const isSwapped = (adjustments.orientationSteps || 0) % 2 === 1;
    const width = adjustments.crop ? adjustments.crop.width : isSwapped ? selectedImage.height : selectedImage.width;
    const height = adjustments.crop ? adjustments.crop.height : isSwapped ? selectedImage.width : selectedImage.height;
    const containerWidth = baseRenderSize.containerWidth || window.innerWidth;
    const containerHeight = baseRenderSize.containerHeight || window.innerHeight;
    if (!width || !height || !containerWidth || !containerHeight) return 0;
    return Math.max(width, height) * Math.min(containerWidth / width, containerHeight / height);
  }, [
    selectedImage?.width,
    selectedImage?.height,
    adjustments.crop,
    adjustments.orientationSteps,
    baseRenderSize.containerWidth,
    baseRenderSize.containerHeight,
  ]);

  const calculateTargetRes = useCallback(
    (displayMax: number = fittedDisplayMax * (transformWrapperRef.current?.instance.transformState?.scale || 1)) => {
      const dpr = getDevicePixelRatio();
      const originalMax =
        originalSize.width > 0 && originalSize.height > 0 ? Math.max(originalSize.width, originalSize.height) : 0;
      return calculateTargetResolution(
        appSettings,
        displayMax,
        appSettings?.useFullDpiRendering ? dpr : 1,
        originalMax,
      );
    },
    [appSettings, fittedDisplayMax, transformWrapperRef, originalSize],
  );

  const uncroppedTargetRes = useMemo(() => {
    const { width: baseWidth, containerWidth, containerHeight } = baseRenderSize;
    const isSwapped = (adjustments.orientationSteps || 0) % 2 === 1;
    const width = (isSwapped ? selectedImage?.height : selectedImage?.width) || 0;
    const height = (isSwapped ? selectedImage?.width : selectedImage?.height) || 0;
    if (!width || !height || !baseWidth || !containerWidth || !containerHeight) return calculateTargetRes(0);
    const zoom = displaySize.width / baseWidth;
    const fitScale = Math.min(containerWidth / width, containerHeight / height);
    return calculateTargetRes(Math.max(width, height) * fitScale * zoom);
  }, [
    baseRenderSize,
    adjustments.orientationSteps,
    selectedImage?.width,
    selectedImage?.height,
    displaySize.width,
    calculateTargetRes,
  ]);

  useEffect(() => {
    const path = selectedImage?.path;
    if (activeView !== 'editor' || activePanel !== Panel.Crop || !selectedImage?.isReady || !path) {
      lastUncroppedRequestRef.current = null;
      return;
    }
    const last = lastUncroppedRequestRef.current?.path === path ? lastUncroppedRequestRef.current : null;
    const res = Math.max(uncroppedTargetRes, last?.res ?? 0);
    if (last && last.res === res && isSameIgnoringCrop(last.adjustments, adjustments)) return;
    lastUncroppedRequestRef.current = { path, adjustments, res };
    throttledUncroppedPreview(adjustments, res);
  }, [
    activeView,
    adjustments,
    activePanel,
    selectedImage?.path,
    selectedImage?.isReady,
    uncroppedTargetRes,
    throttledUncroppedPreview,
  ]);

  const requestHiFiZoom = useMemo(
    () =>
      debounce((targetRes: number) => {
        if (targetRes > currentResRef.current) {
          currentResRef.current = targetRes;
          const { adjustments, previewOverride } = useEditorStore.getState();
          const renderAdjustments = previewOverride ?? adjustments;
          applyAdjustments(renderAdjustments, false, targetRes);
        }
      }, 50),
    [applyAdjustments, currentResRef],
  );

  useEffect(() => {
    const editor = useEditorStore.getState();
    if (isViewerOpen && editor.selectedImage?.isReady) {
      applyAdjustments(editor.previewOverride ?? editor.adjustments, false, currentResRef.current);
    }
  }, [isViewerOpen, applyAdjustments, currentResRef]);

  useEffect(() => {
    if (activeView === 'editor' && selectedImage?.isReady && displaySize.width > 0 && !isSliderDragging) {
      let baseRes = calculateTargetRes();
      if (originalSize.width > 0 && originalSize.height > 0) {
        const maxRes = Math.max(originalSize.width, originalSize.height);
        if (baseRes > maxRes) baseRes = maxRes;
      }
      const finalRes = Math.round(baseRes);

      if (finalRes > currentResRef.current) {
        requestHiFiZoom(finalRes);
      }
    }
    return () => {
      requestHiFiZoom.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeView,
    displaySize.width,
    displaySize.height,
    calculateTargetRes,
    selectedImage?.isReady,
    isSliderDragging,
    requestHiFiZoom,
    originalSize,
  ]);

  const isComparing = compareView !== 'off';

  useEffect(() => {
    if (isComparing && currentResRef.current > 0) renderOriginal(currentResRef.current);
  }, [
    isComparing,
    activeView,
    activePanel,
    selectedImage?.path,
    selectedImage?.isReady,
    renderOriginal,
    currentResRef,
  ]);

  useEffect(() => {
    if (!isComparing) return;
    return () => {
      originalRequestKeyRef.current = null;
      setEditor((state) => {
        releasePreviewUrl(state.originalPreview?.url);
        return { originalPreview: null };
      });
      invoke(Invokes.ReleaseOriginalPreview).catch(console.error);
    };
  }, [isComparing, setEditor]);

  useEffect(() => {
    if (!selectedImage?.isReady) return;

    if (dragIdleTimer.current) clearTimeout(dragIdleTimer.current);

    const targetRes = calculateTargetRes();
    const renderAdjustments = previewOverride ?? adjustments;

    if (activeView !== 'editor') {
      if (isSliderDragging) return;
    }

    if (isSliderDragging) {
      if (appSettings?.enableLivePreviews !== false) {
        applyAdjustments(renderAdjustments, true, targetRes);
      }
    } else {
      dragIdleTimer.current = setTimeout(() => {
        currentResRef.current = targetRes;

        applyAdjustments(renderAdjustments, false, targetRes);

        if (previewOverride) return;

        const prev = prevAdjustmentsRef.current;

        if (!prev || prev.path !== selectedImage.path) {
          prevAdjustmentsRef.current = { path: selectedImage.path, adjustments };
          return;
        }

        const hasAdjustmentsChanged = prev.adjustments !== adjustments;

        if (hasAdjustmentsChanged) {
          debouncedSave(selectedImage.path, adjustments);

          const otherPaths = multiSelectedPaths.filter((p) => p !== selectedImage.path);
          if (appSettings?.copyPasteSettings?.autoSync && otherPaths.length > 0) {
            const delta: Partial<Adjustments> = {};
            const includedKeys = appSettings?.copyPasteSettings?.includedAdjustments || COPYABLE_ADJUSTMENT_KEYS;
            for (const key of Object.keys(adjustments) as Array<keyof Adjustments>) {
              if (includedKeys.includes(key as string)) {
                if (JSON.stringify(adjustments[key]) !== JSON.stringify(prev.adjustments[key])) {
                  (delta as any)[key] = adjustments[key];
                }
              }
            }
            if (Object.keys(delta).length > 0) {
              otherPaths.forEach((p) => globalImageCache.delete(p));
              invoke(Invokes.ApplyAdjustmentsToPaths, { paths: otherPaths, adjustments: delta }).catch((err) => {
                console.error('Failed to apply adjustments to multi-selection:', err);
              });
            }
          }

          prevAdjustmentsRef.current = { path: selectedImage.path, adjustments };
        }
      }, 50);
    }

    return () => {
      if (dragIdleTimer.current) clearTimeout(dragIdleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeView,
    adjustments,
    previewOverride,
    selectedImage?.path,
    selectedImage?.isReady,
    isSliderDragging,
    multiSelectedPaths,
    appSettings?.enableLivePreviews,
    appSettings?.enableBaselineExposure,
    appSettings?.baselineExposure,
    appSettings?.compensateHighlightPreservation,
    appSettings?.copyPasteSettings?.includedAdjustments,
    appSettings?.copyPasteSettings?.autoSync,
    isWaveformVisible,
  ]);

  return {
    applyAdjustments,
    executeApplyAdjustments,
  };
}
