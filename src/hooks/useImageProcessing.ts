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
import { debouncedSave } from './useEditorActions';
import { globalImageCache } from '../utils/ImageLRUCache';
import { prepareAdjustmentsPayload } from '../utils/backendPayload';

const SHARP_REGION_MIN_RESOLUTION_FRACTION = 0.6;
const SHARP_REGION_MARGIN = 0.15;
const SHARP_REGION_REVOKE_DELAY_MS = 1000;
const PATCH_HEADER_BYTES = 24;

type NormalisedRegion = [number, number, number, number];

function expandRegion([x, y, w, h]: NormalisedRegion, margin: number): NormalisedRegion {
  const left = Math.max(0, x - w * margin);
  const top = Math.max(0, y - h * margin);
  const right = Math.min(1, x + w * (1 + margin));
  const bottom = Math.min(1, y + h * (1 + margin));
  return [left, top, right - left, bottom - top];
}

function decodePatchResponse(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const patchX = view.getUint32(0, true);
  const patchY = view.getUint32(4, true);
  const patchW = view.getUint32(8, true);
  const patchH = view.getUint32(12, true);
  const fullW = view.getUint32(16, true);
  const fullH = view.getUint32(20, true);
  const blob = new Blob([buffer.slice(PATCH_HEADER_BYTES)], { type: 'image/jpeg' });
  return {
    url: URL.createObjectURL(blob),
    normX: patchX / fullW,
    normY: patchY / fullH,
    normW: patchW / fullW,
    normH: patchH / fullH,
  };
}

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
  const setEditor = useEditorStore((state) => state.setEditor);

  const activeView = useUIStore((state) => state.activeView);
  const activePanel = useUIStore((state) => state.activePanel);
  const appSettings = useSettingsStore((state) => state.appSettings);
  const multiSelectedPaths = useLibraryStore((state) => state.multiSelectedPaths);

  const uncroppedJobIdRef = useRef(0);
  const latestUncroppedJobIdRef = useRef(0);

  const inFlightCountRef = useRef(0);
  const lastAnalyticsTimeRef = useRef<number>(0);
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

    if (!baseRenderSize) return null;

    const { scale, positionX, positionY } = state;
    const { width: baseW, height: baseH, offsetX, offsetY, containerWidth, containerHeight } = baseRenderSize;

    if (!baseW || !baseH || !containerWidth || !containerHeight) return null;
    if (scale <= 1.01) return null;

    const paddingPixels = 2.0;
    const paddingX = paddingPixels / baseW;
    const paddingY = paddingPixels / baseH;

    const visibleLeft = -positionX / scale;
    const visibleTop = -positionY / scale;
    const visibleRight = visibleLeft + containerWidth / scale;
    const visibleBottom = visibleTop + containerHeight / scale;

    const imgLeft = offsetX;
    const imgTop = offsetY;
    const imgRight = offsetX + baseW;
    const imgBottom = offsetY + baseH;

    const intersectLeft = Math.max(visibleLeft, imgLeft);
    const intersectTop = Math.max(visibleTop, imgTop);
    const intersectRight = Math.min(visibleRight, imgRight);
    const intersectBottom = Math.min(visibleBottom, imgBottom);

    if (intersectLeft >= intersectRight || intersectTop >= intersectBottom) {
      return null;
    }

    const roiX = (intersectLeft - imgLeft) / baseW;
    const roiY = (intersectTop - imgTop) / baseH;
    const roiW = (intersectRight - intersectLeft) / baseW;
    const roiH = (intersectBottom - intersectTop) / baseH;

    const newRoiX = roiX - paddingX;
    const newRoiY = roiY - paddingY;
    const newRoiW = roiW + paddingX * 2;
    const newRoiH = roiH + paddingY * 2;

    const clampedX = Math.max(0, newRoiX);
    const clampedY = Math.max(0, newRoiY);
    const clampedW = Math.min(1 - clampedX, newRoiW);
    const clampedH = Math.min(1 - clampedY, newRoiH);

    if (clampedW > 0.999 && clampedH > 0.999) return null;

    return [clampedX, clampedY, clampedW, clampedH] as [number, number, number, number];
  }, [baseRenderSize, transformWrapperRef]);

  const executeApplyAdjustments = useCallback(
    async (currentAdjustments: Adjustments, dragging: boolean = false, targetRes?: number) => {
      const currentPath = selectedImage?.path;
      if (!currentPath) return;

      let shouldRequestAnalytics = false;
      if (dragging) {
        const now = performance.now();
        if (now - lastAnalyticsTimeRef.current > 33.33) {
          shouldRequestAnalytics = true;
          lastAnalyticsTimeRef.current = now;
        }
      } else {
        shouldRequestAnalytics = true;
        lastAnalyticsTimeRef.current = 0;
      }

      const { payload, markSent } = prepareAdjustmentsPayload(currentAdjustments);

      const jobId = ++previewJobIdRef.current;
      const roi = calculateROI();

      try {
        const buffer: ArrayBuffer = await invoke(Invokes.ApplyAdjustments, {
          jsAdjustments: payload,
          isInteractive: dragging,
          targetResolution: targetRes || null,
          roi: roi || null,
          requestAnalytics: shouldRequestAnalytics,
          computeWaveform: !!isWaveformVisible,
          activeWaveformChannel: activeWaveformChannelRef.current || null,
        });

        markSent();

        if (currentPath !== selectedImagePathRef.current) return;

        if (buffer && buffer.byteLength > 0 && jobId >= latestRenderedJobIdRef.current) {
          latestRenderedJobIdRef.current = jobId;

          const textDecoder = new TextDecoder();
          const prefix = textDecoder.decode(buffer.slice(0, 11));
          if (prefix === 'WGPU_RENDER') {
            setEditor((state) => {
              if (state.interactivePatch && state.interactivePatch.url) URL.revokeObjectURL(state.interactivePatch.url);
              return { interactivePatch: null };
            });
            return;
          }

          if (dragging) {
            const patch = decodePatchResponse(buffer);

            setEditor((state) => {
              if (state.interactivePatch && state.interactivePatch.url)
                setTimeout(() => URL.revokeObjectURL(state.interactivePatch.url), 100);
              return { interactivePatch: patch };
            });
          } else {
            const blob = new Blob([buffer], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);

            if (currentPath !== selectedImagePathRef.current || jobId < latestRenderedJobIdRef.current) {
              URL.revokeObjectURL(url);
              return;
            }

            setEditor((state) => {
              const prevUrl = state.finalPreviewUrl;
              if (prevUrl && prevUrl.startsWith('blob:') && !globalImageCache.isProtected(prevUrl)) {
                setTimeout(() => {
                  if (!globalImageCache.isProtected(prevUrl)) {
                    URL.revokeObjectURL(prevUrl);
                  }
                }, 250);
              }
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
    [selectedImage?.path, calculateROI, isWaveformVisible, setEditor, previewJobIdRef, latestRenderedJobIdRef],
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
        (adj: Adjustments) => {
          const requestedImage = useEditorStore.getState().selectedImage;
          if (!requestedImage?.isReady) return;
          const jobId = ++uncroppedJobIdRef.current;
          const { payload, markSent } = prepareAdjustmentsPayload(adj);
          invoke<ArrayBuffer>(Invokes.GenerateUncroppedPreview, { jsAdjustments: payload })
            .then((buffer) => {
              markSent();
              if (
                jobId < latestUncroppedJobIdRef.current ||
                !buffer ||
                buffer.byteLength === 0 ||
                useEditorStore.getState().selectedImage?.path !== requestedImage.path
              ) {
                return;
              }
              latestUncroppedJobIdRef.current = jobId;
              const url = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
              useEditorStore.getState().setEditor((state) => {
                const prevUrl = state.uncroppedAdjustedPreviewUrl;
                if (prevUrl && prevUrl.startsWith('blob:') && !globalImageCache.isProtected(prevUrl)) {
                  setTimeout(() => {
                    if (!globalImageCache.isProtected(prevUrl)) {
                      URL.revokeObjectURL(prevUrl);
                    }
                  }, 250);
                }
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

  const generateUncroppedPreview = useCallback(
    (currentAdjustments: Adjustments) => {
      throttledUncroppedPreview(currentAdjustments);
    },
    [throttledUncroppedPreview],
  );

  useEffect(() => {
    if (activeView === 'editor' && activePanel === Panel.Crop && selectedImage?.isReady) {
      generateUncroppedPreview(adjustments);
    }
  }, [activeView, adjustments, activePanel, selectedImage?.isReady, generateUncroppedPreview]);

  const calculateTargetRes = useCallback(
    (displayLongEdge?: number) => {
      const baseTargetRes = appSettings?.editorPreviewResolution || 1920;
      if (!(appSettings?.enableZoomHifi ?? true) || displaySize.width === 0) {
        return baseTargetRes;
      }

      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const sharpnessFactor = 1.25;
      const zoomMultiplier = appSettings?.highResZoomMultiplier || 1.0;
      const effectiveDpr = appSettings?.useFullDpiRendering ? dpr : 1;

      const longEdge = displayLongEdge ?? Math.max(displaySize.width, displaySize.height);
      let targetRes = longEdge * effectiveDpr * sharpnessFactor * zoomMultiplier;
      targetRes = Math.max(targetRes, 512);

      if (originalSize && originalSize.width > 0 && originalSize.height > 0) {
        const origMax = Math.max(originalSize.width, originalSize.height);
        targetRes = Math.min(targetRes, origMax);
        if (targetRes >= origMax * 0.8) {
          targetRes = origMax;
        }
      }

      if (originalSize && targetRes !== Math.max(originalSize.width, originalSize.height)) {
        targetRes = Math.ceil(targetRes / 256) * 256;
      }

      return Math.round(targetRes);
    },
    [
      appSettings?.enableZoomHifi,
      appSettings?.editorPreviewResolution,
      appSettings?.highResZoomMultiplier,
      appSettings?.useFullDpiRendering,
      displaySize.width,
      displaySize.height,
      originalSize,
    ],
  );

  const isSharpRegionMode = useCallback(() => {
    if (appSettings?.useWgpuRenderer !== false) return false;
    if (!(appSettings?.enableZoomHifi ?? true)) return false;
    if (!originalSize.width || !originalSize.height) return false;
    const origMax = Math.max(originalSize.width, originalSize.height);
    return calculateTargetRes() >= origMax * SHARP_REGION_MIN_RESOLUTION_FRACTION;
  }, [appSettings?.useWgpuRenderer, appSettings?.enableZoomHifi, originalSize, calculateTargetRes]);

  const calculateWholeFrameRes = useCallback(() => {
    if (!isSharpRegionMode()) return calculateTargetRes();
    return calculateTargetRes(Math.max(baseRenderSize.width, baseRenderSize.height));
  }, [isSharpRegionMode, calculateTargetRes, baseRenderSize]);

  const sharpRegionJobIdRef = useRef(0);

  const requestSharpRegion = useCallback(
    async (renderAdjustments: Adjustments) => {
      const path = selectedImagePathRef.current;
      const visibleRegion = calculateROI();
      if (!path || !visibleRegion || !originalSize.width || !originalSize.height) return;

      const jobId = ++sharpRegionJobIdRef.current;
      const { payload, markSent } = prepareAdjustmentsPayload(renderAdjustments);

      try {
        const buffer: ArrayBuffer = await invoke(Invokes.ApplyAdjustments, {
          jsAdjustments: payload,
          isInteractive: false,
          targetResolution: Math.max(originalSize.width, originalSize.height),
          roi: expandRegion(visibleRegion, SHARP_REGION_MARGIN),
          regionOnly: true,
          requestAnalytics: false,
          computeWaveform: false,
          activeWaveformChannel: null,
        });
        markSent();
        if (jobId !== sharpRegionJobIdRef.current || path !== selectedImagePathRef.current) return;
        if (!buffer || buffer.byteLength <= PATCH_HEADER_BYTES) return;

        const region = { ...decodePatchResponse(buffer), path, adjustments: renderAdjustments };
        setEditor((state) => {
          const previousUrl = state.sharpRegion?.url;
          if (previousUrl) setTimeout(() => URL.revokeObjectURL(previousUrl), SHARP_REGION_REVOKE_DELAY_MS);
          return { sharpRegion: region };
        });
      } catch (err) {
        if (err !== 'Superseded or worker failed') {
          console.error('Failed to render sharp region:', err);
        }
      }
    },
    [calculateROI, originalSize, setEditor],
  );

  const settledTransform = useEditorStore((state) => state.settledTransform);

  useEffect(() => {
    if (activeView !== 'editor' || !selectedImage?.isReady || isSliderDragging) return;
    if (!isSharpRegionMode()) return;
    const { adjustments, previewOverride } = useEditorStore.getState();
    requestSharpRegion(previewOverride ?? adjustments);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledTransform, selectedImage?.isReady]);

  useEffect(() => {
    setEditor((state) => {
      const previousUrl = state.sharpRegion?.url;
      if (previousUrl) setTimeout(() => URL.revokeObjectURL(previousUrl), SHARP_REGION_REVOKE_DELAY_MS);
      return { sharpRegion: null };
    });
  }, [selectedImage?.path, setEditor]);

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
    if (activeView === 'editor' && selectedImage?.isReady && displaySize.width > 0 && !isSliderDragging) {
      let baseRes = calculateWholeFrameRes();
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
    calculateWholeFrameRes,
    selectedImage?.isReady,
    isSliderDragging,
    requestHiFiZoom,
    originalSize,
  ]);

  useEffect(() => {
    if (!selectedImage?.isReady) return;

    if (dragIdleTimer.current) clearTimeout(dragIdleTimer.current);

    const targetRes = calculateWholeFrameRes();
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
        if (activeView === 'editor' && isSharpRegionMode()) requestSharpRegion(renderAdjustments);

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
