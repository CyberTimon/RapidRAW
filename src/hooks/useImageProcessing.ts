import React, { useCallback, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import debounce from 'lodash.debounce';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { Adjustments, COPYABLE_ADJUSTMENT_KEYS } from '../utils/adjustments';
import { Invokes, Panel } from '../components/ui/AppProperties';
import { debouncedSave } from './useEditorActions';
import { globalImageCache } from '../utils/ImageLRUCache';

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
  const isWaveformVisible = useEditorStore((state) => state.isWaveformVisible);
  const activeWaveformChannel = useEditorStore((state) => state.activeWaveformChannel);
  const displaySize = useEditorStore((state) => state.displaySize);
  const baseRenderSize = useEditorStore((state) => state.baseRenderSize);
  const originalSize = useEditorStore((state) => state.originalSize);
  const showOriginal = useEditorStore((state) => state.showOriginal);
  const isSliderDragging = useEditorStore((state) => state.isSliderDragging);
  const transformedOriginalUrl = useEditorStore((state) => state.transformedOriginalUrl);
  const setEditor = useEditorStore((state) => state.setEditor);

  const activeRightPanel = useUIStore((state) => state.activeRightPanel);
  const appSettings = useSettingsStore((state) => state.appSettings);
  const multiSelectedPaths = useLibraryStore((state) => state.multiSelectedPaths);

  const inFlightCountRef = useRef(0);
  const pendingApplyRef = useRef<{ adjustments: Adjustments; targetRes?: number } | null>(null);
  const currentOriginalResRef = useRef<number>(0);
  const dragIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeWaveformChannelRef = useRef(activeWaveformChannel);
  activeWaveformChannelRef.current = activeWaveformChannel;

  const selectedImagePathRef = useRef<string | null>(null);
  useEffect(() => {
    selectedImagePathRef.current = selectedImage?.path ?? null;
  }, [selectedImage?.path]);

  const geometricAdjustmentsKey = useMemo(() => {
    if (!adjustments) return '';
    const { crop, rotation, flipHorizontal, flipVertical, orientationSteps } = adjustments;
    return JSON.stringify({ crop, rotation, flipHorizontal, flipVertical, orientationSteps });
  }, [
    adjustments?.crop,
    adjustments?.rotation,
    adjustments?.flipHorizontal,
    adjustments?.flipVertical,
    adjustments?.orientationSteps,
  ]);

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

    let roiX = (intersectLeft - imgLeft) / baseW;
    let roiY = (intersectTop - imgTop) / baseH;
    let roiW = (intersectRight - intersectLeft) / baseW;
    let roiH = (intersectBottom - intersectTop) / baseH;

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

      const payload = JSON.parse(JSON.stringify(currentAdjustments));
      const { patchesSentToBackend } = useEditorStore.getState();

      const processSubMasks = (subMasks: any[]) => {
        if (!Array.isArray(subMasks)) return;
        subMasks.forEach((sm: any) => {
          if (sm.id && sm.parameters) {
            const keys = ['mask_data_base64', 'maskDataBase64'];
            let foundMaskData = false;

            for (const key of keys) {
              if (sm.parameters[key] !== undefined && sm.parameters[key] !== null) {
                foundMaskData = true;
                if (patchesSentToBackend.has(sm.id)) {
                  sm.parameters[key] = null;
                }
              }
            }
            if (foundMaskData && !patchesSentToBackend.has(sm.id)) {
              patchesSentToBackend.add(sm.id);
            }
          }
        });
      };

      if (payload.aiPatches && Array.isArray(payload.aiPatches)) {
        payload.aiPatches.forEach((p: any) => {
          if (p.id && p.patchData && !p.isLoading) {
            if (patchesSentToBackend.has(p.id)) {
              p.patchData = null;
            } else {
              patchesSentToBackend.add(p.id);
            }
          }
          if (p.subMasks) processSubMasks(p.subMasks);
        });
      }

      if (payload.masks && Array.isArray(payload.masks)) {
        payload.masks.forEach((container: any) => {
          if (container.subMasks) processSubMasks(container.subMasks);
        });
      }

      const jobId = ++previewJobIdRef.current;
      const roi = calculateROI();

      try {
        const buffer: ArrayBuffer = await invoke(Invokes.ApplyAdjustments, {
          jsAdjustments: payload,
          isInteractive: dragging,
          targetResolution: targetRes || null,
          roi: roi || null,
          computeWaveform: !!isWaveformVisible,
          activeWaveformChannel: activeWaveformChannelRef.current || null,
        });

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

  const generateUncroppedPreview = useCallback(
    (currentAdjustments: Adjustments) => {
      if (!selectedImage?.isReady) return;
      invoke(Invokes.GenerateUncroppedPreview, { jsAdjustments: currentAdjustments }).catch((err) =>
        console.error('Failed to generate uncropped preview:', err),
      );
    },
    [selectedImage?.isReady],
  );

  const calculateTargetRes = useCallback(() => {
    const baseTargetRes = appSettings?.editorPreviewResolution || 1920;
    if (!(appSettings?.enableZoomHifi ?? true) || displaySize.width === 0) {
      return baseTargetRes;
    }

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const sharpnessFactor = 1.25;
    const zoomMultiplier = appSettings?.highResZoomMultiplier || 1.0;
    const effectiveDpr = appSettings?.useFullDpiRendering ? dpr : 1;

    let targetRes = Math.max(displaySize.width, displaySize.height) * effectiveDpr * sharpnessFactor * zoomMultiplier;
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
  }, [
    appSettings?.enableZoomHifi,
    appSettings?.editorPreviewResolution,
    appSettings?.highResZoomMultiplier,
    appSettings?.useFullDpiRendering,
    displaySize.width,
    displaySize.height,
    originalSize,
  ]);

  const requestHiFiZoom = useMemo(
    () =>
      debounce((currentAdjustments: Adjustments, targetRes: number) => {
        if (targetRes > currentResRef.current) {
          currentResRef.current = targetRes;
          applyAdjustments(currentAdjustments, false, targetRes);
        }
      }, 50),
    [applyAdjustments, currentResRef],
  );

  const requestHiFiOriginalZoom = useMemo(
    () =>
      debounce(async (currentAdjustments: Adjustments, targetRes: number) => {
        if (targetRes > currentOriginalResRef.current) {
          try {
            const base64Data: string = await invoke('generate_original_transformed_preview', {
              jsAdjustments: currentAdjustments,
              targetResolution: targetRes,
            });
            currentOriginalResRef.current = targetRes;
            setEditor({ transformedOriginalUrl: base64Data });
          } catch (e) {
            console.error('Failed to generate hi-fi original preview:', e);
          }
        }
      }, 200),
    [setEditor],
  );

  useEffect(() => {
    if (activeRightPanel === Panel.Crop && selectedImage?.isReady) {
      generateUncroppedPreview(adjustments);
    }
  }, [adjustments, activeRightPanel, selectedImage?.isReady, generateUncroppedPreview]);

  useEffect(() => {
    if (selectedImage?.isReady && displaySize.width > 0 && !isSliderDragging) {
      let baseRes = calculateTargetRes();
      if (originalSize.width > 0 && originalSize.height > 0) {
        const maxRes = Math.max(originalSize.width, originalSize.height);
        if (baseRes > maxRes) baseRes = maxRes;
      }
      const finalRes = Math.round(baseRes);

      if (finalRes > currentResRef.current) {
        requestHiFiZoom(adjustments, finalRes);
      }
    }
    return () => {
      requestHiFiZoom.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    displaySize.width,
    displaySize.height,
    calculateTargetRes,
    selectedImage?.isReady,
    isSliderDragging,
    requestHiFiZoom,
    originalSize,
  ]);

  useEffect(() => {
    if (!selectedImage?.isReady) return;

    if (dragIdleTimer.current) clearTimeout(dragIdleTimer.current);

    const targetRes = calculateTargetRes();

    if (isSliderDragging) {
      if (appSettings?.enableLivePreviews !== false) {
        applyAdjustments(adjustments, true, targetRes);
      }
    } else {
      dragIdleTimer.current = setTimeout(() => {
        const applyRes = Math.max(targetRes, currentResRef.current);
        currentResRef.current = applyRes;

        applyAdjustments(adjustments, false, applyRes);
        debouncedSave(selectedImage.path, adjustments);

        const otherPaths = multiSelectedPaths.filter((p) => p !== selectedImage.path);
        if (otherPaths.length > 0) {
          const prev = prevAdjustmentsRef.current;
          if (prev && prev.path === selectedImage.path) {
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
        }
        prevAdjustmentsRef.current = { path: selectedImage.path, adjustments };
      }, 50);
    }

    return () => {
      if (dragIdleTimer.current) clearTimeout(dragIdleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    adjustments,
    selectedImage?.path,
    selectedImage?.isReady,
    isSliderDragging,
    multiSelectedPaths,
    appSettings?.enableLivePreviews,
    appSettings?.copyPasteSettings?.includedAdjustments,
    isWaveformVisible,
  ]);

  useEffect(() => {
    setEditor({ transformedOriginalUrl: null });
    currentOriginalResRef.current = 0;
  }, [geometricAdjustmentsKey, selectedImage?.path, setEditor]);

  useEffect(() => {
    if (showOriginal && selectedImage?.isReady && displaySize.width > 0 && !isSliderDragging) {
      let targetRes = calculateTargetRes();
      if (targetRes > currentOriginalResRef.current) {
        requestHiFiOriginalZoom(adjustments, targetRes);
      }
    }
    return () => {
      requestHiFiOriginalZoom.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showOriginal,
    displaySize.width,
    displaySize.height,
    calculateTargetRes,
    selectedImage?.isReady,
    isSliderDragging,
    requestHiFiOriginalZoom,
    originalSize,
  ]);

  useEffect(() => {
    let isEffectActive = true;
    const generate = async () => {
      if (showOriginal && selectedImage?.path && !transformedOriginalUrl) {
        try {
          const targetRes = calculateTargetRes();
          const base64Data: string = await invoke('generate_original_transformed_preview', {
            jsAdjustments: adjustments,
            targetResolution: targetRes,
          });
          if (isEffectActive) {
            currentOriginalResRef.current = targetRes;
            setEditor({ transformedOriginalUrl: base64Data });
          }
        } catch (e) {
          if (isEffectActive) {
            console.error('Failed to generate original preview:', e);
            setEditor({ showOriginal: false });
          }
        }
      }
    };
    generate();
    return () => {
      isEffectActive = false;
    };
  }, [showOriginal, selectedImage?.path, adjustments, transformedOriginalUrl, calculateTargetRes, setEditor]);

  return {
    applyAdjustments,
    executeApplyAdjustments,
  };
}
