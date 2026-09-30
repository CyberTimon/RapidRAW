import React, { useCallback, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import debounce from 'lodash.debounce';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLibraryStore } from '../store/useLibraryStore';
import {
  Adjustments,
  COPYABLE_ADJUSTMENT_KEYS,
  copyAdjustmentKeys,
  originalAdjustmentsFor,
} from '../utils/adjustments';
import { Invokes, Panel } from '../components/ui/AppProperties';
import { debouncedSave } from './useEditorActions';
import { globalImageCache } from '../utils/ImageLRUCache';

import type { AppNavigationProps } from './useAppNavigation';
import {
  PreviewPipeline,
  PreviewRefinementScheduler,
  preparePreviewAdjustments,
  interactivePreviewResolution,
  retryMissingPreviewAssets,
  withClippingOverlay,
  type PreviewAssetCacheStatus,
} from '../utils/previewPipeline';
import {
  acceptMainPreviewAttempt,
  invalidatePreviewRevisions,
  isPreviewSuperseded,
  latestPreviewRevision,
  reservePreviewRevision,
} from '../utils/previewIntent';
import { clearPreviewDiagnostics, traceJpegUrl, tracePreview } from '../utils/previewDiagnostics';

const DETAIL_QUIET_MS = 150;

interface MainPreviewRequest {
  adjustments: Adjustments;
  dragging: boolean;
  compareOriginal: boolean;
  targetRes?: number;
  requestedTargetRes?: number;
  path: string;
  session: number;
  expectedGeneration: number | null;
  inputRevision: number;
  tier: 'quick' | 'detail' | 'full';
  enqueuedAt: number;
}

interface PreviousMainInput {
  request: MainPreviewRequest;
  quality: string | undefined;
  roi: string;
  waveformVisible: boolean;
  waveformChannel: string;
  quickSettled: boolean;
  releaseSeen: boolean;
}

interface SettledEditedFrame {
  request: MainPreviewRequest;
  roi: string;
  settings: ReturnType<typeof useSettingsStore.getState>['appSettings'];
  rendererWgpu: boolean;
  url: string | null;
}

interface ComparisonRestore {
  frame: SettledEditedFrame | null;
  adjustments: Adjustments;
  histogram: ReturnType<typeof useEditorStore.getState>['histogram'];
  waveform: ReturnType<typeof useEditorStore.getState>['waveform'];
  waveformVisible: boolean;
  waveformChannel: string;
}

export function useImageProcessing(
  transformWrapperRef: AppNavigationProps['refs']['transformWrapperRef'],
  prevAdjustmentsRef: AppNavigationProps['refs']['prevAdjustmentsRef'],
  renderRefs: {
    previewJobIdRef: React.RefObject<number>;
    latestRenderedJobIdRef: React.RefObject<number>;
    currentResRef: React.RefObject<number>;
  },
) {
  const { previewJobIdRef, latestRenderedJobIdRef, currentResRef } = renderRefs;

  const imageSession = useEditorStore((state) => state.imageSession);
  const selectedImage = useEditorStore((state) => state.selectedImage);
  const adjustments = useEditorStore((state) => state.adjustments);
  const previewOverride = useEditorStore((state) => state.previewOverride);
  const isWaveformVisible = useEditorStore((state) => state.isWaveformVisible);
  const activeWaveformChannel = useEditorStore((state) => state.activeWaveformChannel);
  const displaySize = useEditorStore((state) => state.displaySize);
  const baseRenderSize = useEditorStore((state) => state.baseRenderSize);
  const originalSize = useEditorStore((state) => state.originalSize);
  const isSliderDragging = useEditorStore((state) => state.isSliderDragging);
  const showClipping = useEditorStore((state) => state.showClipping);
  const setEditor = useEditorStore((state) => state.setEditor);

  const activeView = useUIStore((state) => state.activeView);
  const activePanel = useUIStore((state) => state.activePanel);
  const appSettings = useSettingsStore((state) => state.appSettings);
  const multiSelectedPaths = useLibraryStore((state) => state.multiSelectedPaths);

  const renderedSessionRef = useRef<number | null>(null);
  const renderAttemptRef = useRef(0);
  const lastInputRef = useRef<PreviousMainInput | null>(null);
  const lastEditedFrameRef = useRef<SettledEditedFrame | null>(null);
  const comparisonRestoreRef = useRef<ComparisonRestore | null>(null);
  const comparisonReturnPendingRef = useRef(false);
  const preallocatedInputRef = useRef<{
    adjustments: Adjustments;
    path: string;
    session: number;
    expectedGeneration: number | null;
    inputRevision: number;
  } | null>(null);
  const lastAnalyticsTimeRef = useRef<number>(0);
  const dragIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeWaveformChannelRef = useRef(activeWaveformChannel);
  activeWaveformChannelRef.current = activeWaveformChannel;

  const selectedImagePathRef = useRef<string | null>(null);
  const imageGenerationRef = useRef(0);
  useEffect(() => {
    selectedImagePathRef.current = selectedImage?.path ?? null;
    imageGenerationRef.current += 1;
    pipelineRef.current?.clear();
    refinementRef.current?.clear();
    lastInputRef.current = null;
    lastEditedFrameRef.current = null;
    comparisonRestoreRef.current = null;
    comparisonReturnPendingRef.current = false;
    preallocatedInputRef.current = null;
    uncroppedPipeline.clear();
    comparisonPipeline.clear();
    comparisonKeyRef.current = null;
  }, [selectedImage?.path, imageSession]);

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
    async (request: MainPreviewRequest, isLatest: () => boolean) => {
      const { path, session, expectedGeneration, inputRevision, tier, compareOriginal } = request;
      const generation = imageGenerationRef.current;
      const isCurrent = () =>
        session === useEditorStore.getState().imageSession &&
        path === useEditorStore.getState().selectedImage?.path &&
        expectedGeneration === useEditorStore.getState().backendGeneration &&
        generation === imageGenerationRef.current &&
        inputRevision === latestPreviewRevision('main') &&
        isLatest();
      if (!isCurrent()) return;

      const attempt = ++renderAttemptRef.current;
      const interactive = request.dragging || tier === 'quick';
      const trace = (stage: string, durationMs?: number) =>
        tracePreview({
          stage,
          session,
          generation: expectedGeneration,
          revision: inputRevision,
          attempt,
          tier,
          durationMs,
          resolution: request.targetRes,
        });
      trace('queue-start', performance.now() - request.enqueuedAt);

      let shouldRequestAnalytics = false;
      if (interactive) {
        const now = performance.now();
        if (now - lastAnalyticsTimeRef.current > 100) {
          shouldRequestAnalytics = true;
          lastAnalyticsTimeRef.current = now;
        }
      } else {
        shouldRequestAnalytics = true;
        lastAnalyticsTimeRef.current = 0;
      }

      const { patchesSentToBackend } = useEditorStore.getState();
      const hydrationStart = performance.now();
      let prepared = preparePreviewAdjustments(request.adjustments, patchesSentToBackend);
      trace('frontend-payload-ready', performance.now() - hydrationStart);
      if (!isCurrent()) return;

      const jobId = ++previewJobIdRef.current;
      const roi = !compareOriginal && renderedSessionRef.current === session ? calculateROI() : null;

      try {
        const invokeStart = performance.now();
        const buffer = await retryMissingPreviewAssets(
          (forceInline) => {
            if (forceInline) {
              prepared = preparePreviewAdjustments(request.adjustments, new Set());
              trace('asset-resend');
            }
            return invoke<ArrayBuffer>(Invokes.ApplyAdjustments, {
              jsAdjustments: prepared.payload,
              expectedGeneration,
              inputRevision,
              renderAttempt: attempt,
              qualityTier: tier,
              isInteractive: interactive,
              compareOriginal,
              targetResolution: request.targetRes || null,
              roi: roi || null,
              requestAnalytics: shouldRequestAnalytics,
              computeWaveform: !!isWaveformVisible,
              activeWaveformChannel: activeWaveformChannelRef.current || null,
            });
          },
          isCurrent,
          (keys) => keys.forEach((key) => patchesSentToBackend.delete(key)),
        );
        trace('invoke-return', performance.now() - invokeStart);

        if (!isCurrent()) return;
        if (prepared.sentAssets.size) {
          // A successful render may have used an oversized inline asset that the
          // native cache deliberately did not retain. Acknowledge only keys
          // confirmed present, without delaying display on this bookkeeping.
          void invoke<PreviewAssetCacheStatus>(Invokes.GetPreviewAssetCacheStatus, {
            keys: [...prepared.sentAssets],
          })
            .then(({ retainedKeys }) => {
              const state = useEditorStore.getState();
              if (
                state.imageSession === session &&
                state.backendGeneration === expectedGeneration &&
                state.selectedImage?.path === path &&
                state.patchesSentToBackend === patchesSentToBackend
              ) {
                retainedKeys.forEach((key) => patchesSentToBackend.add(key));
              }
            })
            .catch((error) => console.warn('Could not confirm preview asset retention:', error));
        }

        if (buffer && buffer.byteLength > 0 && jobId >= latestRenderedJobIdRef.current) {
          if (!acceptMainPreviewAttempt(inputRevision, attempt)) return;
          renderedSessionRef.current = session;
          latestRenderedJobIdRef.current = jobId;

          const textDecoder = new TextDecoder();
          const prefix = textDecoder.decode(buffer.slice(0, 11));
          if (prefix === 'WGPU_RENDER') {
            trace('wgpu-accepted');
            setEditor((state) => {
              if (state.interactivePatch && state.interactivePatch.url) URL.revokeObjectURL(state.interactivePatch.url);
              return { interactivePatch: null };
            });
            if (!compareOriginal && !interactive) {
              lastEditedFrameRef.current = {
                request,
                roi: JSON.stringify(roi),
                settings: useSettingsStore.getState().appSettings,
                rendererWgpu: true,
                url: null,
              };
            }
            return;
          }

          if (compareOriginal) {
            // The native renderer encodes this comparison without touching its
            // displayed WGPU texture. Keep the edited base intact so leaving
            // Show Original can simply remove this webview overlay.
            const jpegBuffer = interactive ? buffer.slice(24) : buffer;
            const url = URL.createObjectURL(new Blob([jpegBuffer], { type: 'image/jpeg' }));
            if (!isCurrent()) {
              URL.revokeObjectURL(url);
              return;
            }
            traceJpegUrl(url, {
              session,
              generation: expectedGeneration,
              revision: inputRevision,
              attempt,
              tier,
              resolution: request.targetRes,
            });
            setEditor({ comparisonPreviewUrl: url });
            trace('jpeg-accepted');
            return;
          }

          if (interactive) {
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
            if (!isCurrent()) {
              URL.revokeObjectURL(url);
              return;
            }
            traceJpegUrl(url, {
              session,
              generation: expectedGeneration,
              revision: inputRevision,
              attempt,
              tier,
              resolution: request.targetRes,
            });

            setEditor((state) => {
              const previousPatchUrl = state.interactivePatch?.url;
              if (previousPatchUrl) setTimeout(() => URL.revokeObjectURL(previousPatchUrl), 100);
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

            if (!isCurrent() || path !== selectedImagePathRef.current || jobId < latestRenderedJobIdRef.current) {
              URL.revokeObjectURL(url);
              return;
            }
            globalImageCache.registerBlobSize(url, blob.size);
            traceJpegUrl(url, {
              session,
              generation: expectedGeneration,
              revision: inputRevision,
              attempt,
              tier,
              resolution: request.targetRes,
            });

            setEditor((state) => {
              const prevUrl = state.finalPreviewUrl;
              if (prevUrl && prevUrl.startsWith('blob:') && !globalImageCache.isProtected(prevUrl)) {
                setTimeout(() => {
                  if (!globalImageCache.isProtected(prevUrl)) {
                    URL.revokeObjectURL(prevUrl);
                  }
                }, 250);
              }
              const previousPatchUrl = state.interactivePatch?.url;
              if (previousPatchUrl) setTimeout(() => URL.revokeObjectURL(previousPatchUrl), 500);
              return { finalPreviewUrl: url, interactivePatch: null };
            });
            lastEditedFrameRef.current = {
              request,
              roi: JSON.stringify(roi),
              settings: useSettingsStore.getState().appSettings,
              rendererWgpu: false,
              url,
            };
          }
          trace('jpeg-accepted');
        }
      } catch (err) {
        if (!isCurrent()) return;
        if (isPreviewSuperseded(err) || err === 'Superseded or worker failed') {
          trace('superseded');
          return;
        }
        console.error('Failed to apply adjustments:', err);
        trace('render-error');
        if (!interactive) {
          setEditor((state) => {
            if (state.interactivePatch && state.interactivePatch.url) URL.revokeObjectURL(state.interactivePatch.url);
            return { interactivePatch: null };
          });
        }
      }
    },
    [calculateROI, isWaveformVisible, setEditor, previewJobIdRef, latestRenderedJobIdRef],
  );

  const executeRef = useRef(executeApplyAdjustments);
  executeRef.current = executeApplyAdjustments;
  const refinementRef = useRef<PreviewRefinementScheduler<MainPreviewRequest> | null>(null);
  const pipelineRef = useRef<PreviewPipeline<MainPreviewRequest> | null>(null);
  if (!pipelineRef.current) {
    pipelineRef.current = new PreviewPipeline(async (request, isLatest) => {
      const state = useEditorStore.getState();
      if (
        !state.selectedImage?.isReady ||
        request.path !== state.selectedImage.path ||
        request.session !== state.imageSession ||
        request.expectedGeneration !== state.backendGeneration ||
        request.inputRevision !== latestPreviewRevision('main')
      ) {
        return;
      }
      try {
        await executeRef.current(request, isLatest);
      } finally {
        if (request.tier === 'quick') {
          const last = lastInputRef.current;
          if (last?.request === request) last.quickSettled = true;
          refinementRef.current?.quickCompleted(request);
        }
      }
    });
  }
  if (!refinementRef.current) {
    refinementRef.current = new PreviewRefinementScheduler(
      DETAIL_QUIET_MS,
      (request) => {
        const state = useEditorStore.getState();
        if (
          state.imageSession !== request.session ||
          state.backendGeneration !== request.expectedGeneration ||
          latestPreviewRevision('main') !== request.inputRevision
        ) {
          return;
        }
        pipelineRef.current?.enqueue({
          ...request,
          dragging: false,
          tier: 'detail',
          targetRes: request.requestedTargetRes,
          enqueuedAt: performance.now(),
        });
      },
      (request, durationMs) =>
        tracePreview({
          stage: 'detail-quiet-elapsed',
          session: request.session,
          generation: request.expectedGeneration,
          revision: request.inputRevision,
          attempt: 0,
          tier: 'detail',
          durationMs,
          resolution: request.requestedTargetRes,
        }),
    );
  }

  useEffect(
    () => () => {
      invalidatePreviewRevisions(useEditorStore.getState().backendGeneration);
      pipelineRef.current?.clear();
      refinementRef.current?.clear();
      clearPreviewDiagnostics();
      selectedImagePathRef.current = null;
      imageGenerationRef.current += 1;
    },
    [],
  );

  const applyAdjustments = useCallback(
    (currentAdjustments: Adjustments, dragging: boolean = false, targetRes?: number) => {
      const state = useEditorStore.getState();
      const image = state.selectedImage;
      if (!image?.isReady) return;
      const quality = useSettingsStore.getState().appSettings?.livePreviewQuality;
      const currentRoi = JSON.stringify(renderedSessionRef.current === state.imageSession ? calculateROI() : null);
      if (comparisonReturnPendingRef.current) {
        comparisonReturnPendingRef.current = false;
        const comparison = comparisonRestoreRef.current;
        comparisonRestoreRef.current = null;
        const frame = comparison?.frame;
        if (
          !dragging &&
          !state.showOriginal &&
          !state.previewOverride &&
          !state.interactivePatch &&
          comparison?.adjustments === currentAdjustments &&
          frame?.request.adjustments === currentAdjustments &&
          frame.request.path === image.path &&
          frame.request.session === state.imageSession &&
          frame.request.expectedGeneration === state.backendGeneration &&
          (frame.request.targetRes === targetRes ||
            (targetRes !== undefined &&
              frame.request.targetRes !== undefined &&
              frame.request.targetRes > targetRes &&
              frame.request.requestedTargetRes === frame.request.targetRes)) &&
          frame.roi === currentRoi &&
          frame.settings === useSettingsStore.getState().appSettings &&
          (frame.rendererWgpu ? state.hasRenderedFirstFrame : !!frame.url && state.finalPreviewUrl === frame.url) &&
          comparison.waveformVisible === state.isWaveformVisible &&
          comparison.waveformChannel === state.activeWaveformChannel
        ) {
          const preallocated = preallocatedInputRef.current;
          const inputRevision =
            preallocated?.adjustments === currentAdjustments &&
            preallocated.path === image.path &&
            preallocated.session === state.imageSession &&
            preallocated.expectedGeneration === state.backendGeneration
              ? preallocated.inputRevision
              : reservePreviewRevision('main', state.backendGeneration);
          preallocatedInputRef.current = null;
          lastInputRef.current = {
            request: {
              ...frame.request,
              inputRevision,
              enqueuedAt: performance.now(),
            },
            quality,
            roi: currentRoi,
            waveformVisible: state.isWaveformVisible,
            waveformChannel: state.activeWaveformChannel,
            quickSettled: true,
            releaseSeen: true,
          };
          setEditor({ histogram: comparison.histogram, waveform: comparison.waveform });
          tracePreview({
            stage: 'compare-restore-hit',
            session: state.imageSession,
            generation: state.backendGeneration,
            revision: inputRevision,
            attempt: 0,
            tier: 'full',
            resolution: targetRes,
          });
          return;
        }
      }
      const quickResolution = interactivePreviewResolution(targetRes ?? 1920, quality);
      const needsDetail = !!targetRes && quickResolution < targetRes;
      const previous = lastInputRef.current;
      const sameInput =
        previous?.request.path === image.path &&
        previous.request.session === state.imageSession &&
        previous.request.expectedGeneration === state.backendGeneration &&
        previous.request.adjustments === currentAdjustments &&
        previous.request.compareOriginal === state.showOriginal &&
        previous.request.requestedTargetRes === targetRes &&
        previous.quality === quality &&
        previous.waveformVisible === state.isWaveformVisible &&
        previous.waveformChannel === state.activeWaveformChannel &&
        (previous.roi === currentRoi || previous.roi === 'null');

      if (sameInput && previous) {
        if (dragging || previous.releaseSeen) return;
        previous.releaseSeen = true;
        if (needsDetail) {
          tracePreview({
            stage: 'detail-quiet-armed',
            session: state.imageSession,
            generation: state.backendGeneration,
            revision: previous.request.inputRevision,
            attempt: 0,
            tier: 'detail',
            resolution: targetRes,
          });
          refinementRef.current?.schedule(previous.request, previous.quickSettled);
          return;
        }
        // An interactive patch cannot replace the settled full-frame base.
        pipelineRef.current?.enqueue({
          ...previous.request,
          dragging: false,
          tier: 'full',
          enqueuedAt: performance.now(),
        });
        return;
      }

      refinementRef.current?.clear();
      const preallocated = preallocatedInputRef.current;
      const inputRevision =
        preallocated?.adjustments === currentAdjustments &&
        preallocated.path === image.path &&
        preallocated.session === state.imageSession &&
        preallocated.expectedGeneration === state.backendGeneration
          ? preallocated.inputRevision
          : reservePreviewRevision('main', state.backendGeneration);
      preallocatedInputRef.current = null;
      const request: MainPreviewRequest = {
        adjustments: currentAdjustments,
        dragging,
        compareOriginal: state.showOriginal,
        targetRes: dragging ? quickResolution : needsDetail ? quickResolution : targetRes,
        requestedTargetRes: targetRes,
        path: image.path,
        session: state.imageSession,
        expectedGeneration: state.backendGeneration,
        inputRevision,
        tier: dragging || needsDetail ? 'quick' : 'full',
        enqueuedAt: performance.now(),
      };
      lastInputRef.current = {
        request,
        quality,
        roi: currentRoi,
        waveformVisible: state.isWaveformVisible,
        waveformChannel: state.activeWaveformChannel,
        quickSettled: false,
        releaseSeen: !dragging,
      };
      tracePreview({
        stage: 'input-enqueued',
        session: state.imageSession,
        generation: state.backendGeneration,
        revision: inputRevision,
        attempt: 0,
        tier: request.tier,
        resolution: targetRes,
      });
      pipelineRef.current?.enqueue(request);
      if (needsDetail && !dragging) {
        tracePreview({
          stage: 'detail-quiet-armed',
          session: state.imageSession,
          generation: state.backendGeneration,
          revision: inputRevision,
          attempt: 0,
          tier: 'detail',
          resolution: targetRes,
        });
        refinementRef.current?.schedule(request, false);
      }
    },
    [calculateROI],
  );

  const uncroppedPipeline = useMemo(
    () =>
      new PreviewPipeline<{
        adjustments: Adjustments;
        path: string;
        session: number;
        expectedGeneration: number | null;
        inputRevision: number;
      }>(async (request, isLatest) => {
        const isCurrent = () =>
          request.path === useEditorStore.getState().selectedImage?.path &&
          request.session === useEditorStore.getState().imageSession &&
          request.expectedGeneration === useEditorStore.getState().backendGeneration &&
          request.inputRevision === latestPreviewRevision('uncropped') &&
          isLatest();
        if (!isCurrent()) return;
        try {
          const dataUrl = await invoke<string>(Invokes.GenerateUncroppedPreview, {
            jsAdjustments: request.adjustments,
            expectedGeneration: request.expectedGeneration,
            inputRevision: request.inputRevision,
          });
          if (isCurrent()) useEditorStore.getState().setEditor({ uncroppedAdjustedPreviewUrl: dataUrl });
        } catch (error) {
          if (isCurrent() && !isPreviewSuperseded(error)) console.error(error);
        }
      }),
    [],
  );

  useEffect(() => () => uncroppedPipeline.clear(), [uncroppedPipeline]);

  // Renders the unedited side of the before/after split view. It has its own
  // native lane, so it never supersedes or waits behind edited previews.
  const comparisonKeyRef = useRef<string | null>(null);
  const comparisonPipeline = useMemo(
    () =>
      new PreviewPipeline<{
        adjustments: Adjustments;
        path: string;
        session: number;
        expectedGeneration: number | null;
        inputRevision: number;
        targetRes: number;
      }>(async (request, isLatest) => {
        const isCurrent = () => {
          const state = useEditorStore.getState();
          return (
            state.splitCompare &&
            request.path === state.selectedImage?.path &&
            request.session === state.imageSession &&
            request.expectedGeneration === state.backendGeneration &&
            request.inputRevision === latestPreviewRevision('comparison') &&
            isLatest()
          );
        };
        if (!isCurrent()) return;
        try {
          const buffer = await invoke<ArrayBuffer>(Invokes.GenerateComparisonPreview, {
            jsAdjustments: request.adjustments,
            expectedGeneration: request.expectedGeneration,
            inputRevision: request.inputRevision,
            targetResolution: request.targetRes,
          });
          if (!isCurrent()) return;
          const url = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
          useEditorStore.getState().setEditor({ splitComparisonUrl: url });
        } catch (error) {
          if (isCurrent() && !isPreviewSuperseded(error)) console.error('Failed to render comparison:', error);
        }
      }),
    [],
  );

  useEffect(() => () => comparisonPipeline.clear(), [comparisonPipeline]);

  useEffect(
    () =>
      useEditorStore.subscribe((state, previous) => {
        if (state.selectedImage?.path !== previous.selectedImage?.path) {
          // Zustand subscribers run during the selection update, before metadata
          // loading or React effects can delay native source invalidation.
          invalidatePreviewRevisions(previous.backendGeneration);
          refinementRef.current?.clear();
          pipelineRef.current?.clear();
          uncroppedPipeline.clear();
          comparisonPipeline.clear();
          comparisonKeyRef.current = null;
          lastInputRef.current = null;
          lastEditedFrameRef.current = null;
          comparisonRestoreRef.current = null;
          comparisonReturnPendingRef.current = false;
          preallocatedInputRef.current = null;
          return;
        }
        if (!previous.showOriginal && state.showOriginal) {
          comparisonRestoreRef.current = {
            frame: lastEditedFrameRef.current,
            adjustments: withClippingOverlay(previous.adjustments, previous.showClipping),
            histogram: previous.histogram,
            waveform: previous.waveform,
            waveformVisible: previous.isWaveformVisible,
            waveformChannel: previous.activeWaveformChannel,
          };
          comparisonReturnPendingRef.current = false;
        } else if (previous.showOriginal && !state.showOriginal) {
          comparisonReturnPendingRef.current = true;
        }
        const renderAdjustments = withClippingOverlay(state.previewOverride ?? state.adjustments, state.showClipping);
        const previousAdjustments = withClippingOverlay(
          previous.previewOverride ?? previous.adjustments,
          previous.showClipping,
        );
        if (!state.selectedImage?.isReady || renderAdjustments === previousAdjustments) return;
        const inputRevision = reservePreviewRevision('main', state.backendGeneration);
        tracePreview({
          stage: 'input-changed',
          session: state.imageSession,
          generation: state.backendGeneration,
          revision: inputRevision,
          attempt: 0,
          tier: 'unknown',
        });
        preallocatedInputRef.current = {
          adjustments: renderAdjustments,
          path: state.selectedImage.path,
          session: state.imageSession,
          expectedGeneration: state.backendGeneration,
          inputRevision,
        };
        refinementRef.current?.clear();
        pipelineRef.current?.clear();
      }),
    [uncroppedPipeline, comparisonPipeline],
  );

  const generateUncroppedPreview = useCallback(
    (currentAdjustments: Adjustments) => {
      const image = useEditorStore.getState().selectedImage;
      if (!image?.isReady) return;
      const state = useEditorStore.getState();
      uncroppedPipeline.enqueue({
        adjustments: currentAdjustments,
        path: image.path,
        session: state.imageSession,
        expectedGeneration: state.backendGeneration,
        inputRevision: reservePreviewRevision('uncropped', state.backendGeneration),
      });
    },
    [uncroppedPipeline],
  );

  useEffect(() => {
    if (activeView === 'editor' && activePanel === Panel.Crop && selectedImage?.isReady) {
      generateUncroppedPreview(adjustments);
    }
  }, [activeView, adjustments, activePanel, selectedImage?.path, selectedImage?.isReady, generateUncroppedPreview]);

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
      debounce((targetRes: number) => {
        if (targetRes > currentResRef.current) {
          currentResRef.current = targetRes;
          const { adjustments, previewOverride, showClipping } = useEditorStore.getState();
          const renderAdjustments = withClippingOverlay(previewOverride ?? adjustments, showClipping);
          applyAdjustments(renderAdjustments, false, targetRes);
        }
      }, 250),
    [applyAdjustments, currentResRef],
  );

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

  useEffect(() => {
    if (!selectedImage?.isReady) return;

    if (dragIdleTimer.current) clearTimeout(dragIdleTimer.current);

    const targetRes = calculateTargetRes();
    const renderAdjustments = withClippingOverlay(previewOverride ?? adjustments, showClipping);

    if (activeView !== 'editor') {
      if (isSliderDragging) return;
    }

    if (isSliderDragging) {
      if (appSettings?.enableLivePreviews !== false) {
        applyAdjustments(renderAdjustments, true, targetRes);
      }
    } else {
      currentResRef.current = targetRes;
      applyAdjustments(renderAdjustments, false, targetRes);
      dragIdleTimer.current = setTimeout(() => {
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
                  copyAdjustmentKeys(delta, adjustments, [key]);
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
  }, [
    activeView,
    adjustments,
    previewOverride,
    selectedImage?.path,
    selectedImage?.isReady,
    isSliderDragging,
    multiSelectedPaths,
    appSettings?.enableLivePreviews,
    appSettings?.livePreviewQuality,
    appSettings?.copyPasteSettings?.includedAdjustments,
    appSettings?.copyPasteSettings?.autoSync,
    isWaveformVisible,
    activeWaveformChannel,
    showClipping,
  ]);

  const splitCompare = useEditorStore((state) => state.splitCompare);
  useEffect(() => {
    const image = selectedImage;
    if (!splitCompare || activeView !== 'editor' || !image?.isReady) {
      comparisonKeyRef.current = null;
      comparisonPipeline.clear();
      return;
    }
    // Only geometry reaches the unedited side; wait for a drag to settle.
    if (isSliderDragging) return;
    const original = originalAdjustmentsFor(adjustments);
    const targetRes = calculateTargetRes();
    const state = useEditorStore.getState();
    const key = JSON.stringify([image.path, state.imageSession, state.backendGeneration, targetRes, original]);
    if (key === comparisonKeyRef.current) return;
    comparisonKeyRef.current = key;
    comparisonPipeline.enqueue({
      adjustments: original,
      path: image.path,
      session: state.imageSession,
      expectedGeneration: state.backendGeneration,
      inputRevision: reservePreviewRevision('comparison', state.backendGeneration),
      targetRes,
    });
  }, [splitCompare, activeView, selectedImage, isSliderDragging, adjustments, calculateTargetRes, comparisonPipeline]);

  return {
    applyAdjustments,
    executeApplyAdjustments,
  };
}
