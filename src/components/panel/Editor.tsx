import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect, useImperativeHandle } from 'react';
import { Crop, PercentCrop } from 'react-image-crop';
import { Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { invoke } from '@tauri-apps/api/core';
import { ImageDimensions, useImageRenderSize } from '../../hooks/useImageRenderSize';
import { Adjustments, AiPatch, Coord, MaskContainer } from '../../utils/adjustments';
import { calculateCenteredCrop, getOrientedDimensions } from '../../utils/cropUtils';
import EditorToolbar from './editor/EditorToolbar';
import ImageCanvas from './editor/ImageCanvas';
import { Mask, SubMask } from './right/Masks';
import { AppSettings, BrushSettings, Invokes, Panel, SelectedImage, TransformState } from '../ui/AppProperties';
import type { OverlayMode } from './right/CropPanel';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

const parseRgb = (rgbStr: string): [number, number, number, number] => {
  const match = rgbStr.match(/[\d.]+/g);
  if (match && match.length >= 3) {
    return [parseFloat(match[0]) / 255, parseFloat(match[1]) / 255, parseFloat(match[2]) / 255, 1.0];
  }
  return [0, 0, 0, 1.0];
};

interface WgpuRenderState {
  useWgpuRenderer: boolean | undefined;
  isReady: boolean;
  hasRenderedFirstFrame: boolean;
  isCropping: boolean;
  uncroppedAdjustedPreviewUrl: string | null;
  showOriginal: boolean;
  bgPrimary: [number, number, number, number];
  bgSecondary: [number, number, number, number];
}

interface EditorProps {
  appSettings: AppSettings | null;
  activeAiPatchContainerId: string | null;
  activeAiSubMaskId: string | null;
  activeMaskContainerId: string | null;
  activeMaskId: string | null;
  activeRightPanel: Panel | null;
  adjustments: Adjustments;
  brushSettings: BrushSettings | null;
  canRedo: boolean;
  canUndo: boolean;
  finalPreviewUrl: string | null;
  interactivePatch?: { url: string; normX: number; normY: number; normW: number; normH: number } | null;
  isFullScreen: boolean;
  isLoading: boolean;
  isSliderDragging: boolean;
  isMaskControlHovered: boolean;
  isStraightenActive: boolean;
  isRotationActive?: boolean;
  onBackToLibrary(): void;
  onContextMenu(event: any): void;
  onGenerateAiMask(subMaskId: string, startPoint: Coord, endPoint: Coord): void;
  onQuickErase(subMaskId: string | null, startPoint: Coord, endpoint: Coord): void;
  onRedo(): void;
  onSelectAiSubMask(id: string | null): void;
  onSelectMask(id: string | null): void;
  onStraighten(val: number): void;
  onToggleFullScreen(): void;
  onUndo(): void;
  onZoomed(state: TransformState): void;
  renderedRightPanel: Panel | null;
  selectedImage: SelectedImage;
  setAdjustments(adjustments: Partial<Adjustments>): void;
  setShowOriginal(show: any): void;
  showOriginal: boolean;
  targetZoom: number;
  thumbnails: Record<string, string>;
  transformWrapperRef: any;
  transformedOriginalUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  updateSubMask(id: string | null, subMask: Partial<SubMask>): void;
  onDisplaySizeChange?(size: any): void;
  originalSize?: ImageDimensions;
  isWbPickerActive?: boolean;
  onWbPicked?: () => void;
  overlayMode?: OverlayMode;
  overlayRotation?: number;
  adjustmentsHistory: any[];
  adjustmentsHistoryIndex: number;
  goToAdjustmentsHistoryIndex(index: number): void;
  liveRotation?: number | null;
  isInstantTransition: boolean;
  hasRenderedFirstFrame: boolean;
}

export default function Editor({
  appSettings,
  activeAiPatchContainerId,
  activeAiSubMaskId,
  activeMaskContainerId,
  activeMaskId,
  activeRightPanel,
  adjustments,
  brushSettings,
  canRedo,
  canUndo,
  finalPreviewUrl,
  interactivePatch,
  isFullScreen,
  isLoading,
  isSliderDragging,
  isMaskControlHovered,
  isStraightenActive,
  isRotationActive,
  onBackToLibrary,
  onContextMenu,
  onGenerateAiMask,
  onQuickErase,
  onRedo,
  onSelectAiSubMask,
  onSelectMask,
  onStraighten,
  onToggleFullScreen,
  onUndo,
  onZoomed,
  selectedImage,
  setAdjustments,
  setShowOriginal,
  showOriginal,
  targetZoom,
  thumbnails: _thumbnails,
  transformWrapperRef,
  transformedOriginalUrl,
  uncroppedAdjustedPreviewUrl,
  updateSubMask,
  onDisplaySizeChange,
  originalSize,
  isWbPickerActive = false,
  onWbPicked,
  overlayMode = 'none',
  overlayRotation = 0,
  adjustmentsHistory,
  adjustmentsHistoryIndex,
  goToAdjustmentsHistoryIndex,
  liveRotation,
  isInstantTransition,
  hasRenderedFirstFrame,
}: EditorProps) {
  const [crop, setCrop] = useState<Crop | null>(null);
  const prevCropParams = useRef<any>(null);
  const [isMaskHovered, setIsMaskHovered] = useState(false);
  const [isMaskTouchInteracting, setIsMaskTouchInteracting] = useState(false);
  const [isLoaderVisible, setIsLoaderVisible] = useState(false);
  const [showExifDateView, setShowExifDateView] = useState(false);
  const [maskOverlayUrl, setMaskOverlayUrl] = useState<string | null>(null);
  const [transformState, setTransformState] = useState<TransformState>({ scale: 1, positionX: 0, positionY: 0 });
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isInitialMount = useRef(true);
  const transformStateRef = useRef<TransformState>(transformState);
  transformStateRef.current = transformState;
  const [isPanningState, setIsPanningState] = useState(false);
  const isClickAnimating = useRef(false);
  const clickAnimationTime = 250;
  const zoomDebounceTimeoutRef = useRef<number | null>(null);
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const savedZoomState = useRef<{ scale: number; positionX: number; positionY: number } | null>(null);
  const focalPointRef = useRef({ x: 0.5, y: 0.5 });
  const isTransitioningRef = useRef(false);
  const [toolbarOverflowVisible, setToolbarOverflowVisible] = useState(!isFullScreen);
  const isGeneratingOverlayRef = useRef(false);
  const pendingOverlayRequestRef = useRef<any>(null);
  const animationFrameId = useRef<number | null>(null);
  const physicsFrameId = useRef<number | null>(null);
  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const lastPanPos = useRef<{ x: number; y: number } | null>(null);
  const lastPinch = useRef<{ dist: number; midX: number; midY: number } | null>(null);
  const panVelocityHistory = useRef<{ x: number; y: number; t: number }[]>([]);
  const wheelSnapTimeout = useRef<number | null>(null);

  const prevRenderState = useRef({
    containerLeft: 0,
    containerTop: 0,
    offsetX: 0,
    offsetY: 0,
    width: 0,
  });
  const transitionAnchorRef = useRef<{
    active: boolean;
    screenImageLeft: number;
    screenImageTop: number;
    physicalImageWidth: number;
  } | null>(null);
  const wgpuSyncRef = useRef<number | null>(null);
  const lastWgpuTransformRef = useRef<string | null>(null);

  useEffect(() => {
    if (isFullScreen) {
      setToolbarOverflowVisible(false);
    } else {
      const timer = setTimeout(() => {
        setToolbarOverflowVisible(true);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isFullScreen]);

  const isCropping = activeRightPanel === Panel.Crop;
  const isMasking = activeRightPanel === Panel.Masks;
  const isAiEditing = activeRightPanel === Panel.Ai;

  const croppedDimensions = useMemo<ImageDimensions | null>(() => {
    if (!selectedImage?.width || !selectedImage?.height) {
      return null;
    }
    if (adjustments.crop) {
      return { width: adjustments.crop.width, height: adjustments.crop.height } as ImageDimensions;
    }
    if (selectedImage) {
      const orientationSteps = adjustments.orientationSteps || 0;
      const isSwapped = orientationSteps === 1 || orientationSteps === 3;
      const width = isSwapped ? selectedImage.height : selectedImage.width;
      const height = isSwapped ? selectedImage.width : selectedImage.height;
      return { width, height } as ImageDimensions;
    }
    return null;
  }, [selectedImage, adjustments.crop, adjustments.orientationSteps]);

  const imageRenderSize = useImageRenderSize(imageContainerRef, croppedDimensions);

  const transformConfig = useMemo(() => {
    if (!selectedImage || !imageRenderSize.scale || !originalSize) {
      return { minScale: 0.1, maxScale: 20 };
    }

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const scaleFor100Percent = 1 / imageRenderSize.scale;

    const minScale = (0.1 / dpr) * scaleFor100Percent;
    const maxScale = (2.0 / dpr) * scaleFor100Percent;

    return {
      minScale: Math.max(0.1, minScale),
      maxScale: Math.max(20, maxScale),
    };
  }, [selectedImage, imageRenderSize.scale, originalSize]);

  const minScaleRef = useRef(transformConfig.minScale);
  const maxScaleRef = useRef(transformConfig.maxScale);

  useEffect(() => {
    minScaleRef.current = transformConfig.minScale;
    maxScaleRef.current = transformConfig.maxScale;
  }, [transformConfig.minScale, transformConfig.maxScale]);

  const getTransformBounds = useCallback((scale: number) => {
    const container = imageContainerRef.current;
    if (!container) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const scaledW = cw * scale;
    const scaledH = ch * scale;

    let minX, maxX, minY, maxY;

    if (scaledW <= cw) {
      minX = maxX = (cw - scaledW) / 2;
    } else {
      minX = cw - scaledW;
      maxX = 0;
    }

    if (scaledH <= ch) {
      minY = maxY = (ch - scaledH) / 2;
    } else {
      minY = ch - scaledH;
      maxY = 0;
    }

    return { minX, maxX, minY, maxY };
  }, []);

  const clampToBounds = useCallback(
    (x: number, y: number, scale: number) => {
      const bounds = getTransformBounds(scale);
      const newX = Math.min(Math.max(x, bounds.minX), bounds.maxX);
      const newY = Math.min(Math.max(y, bounds.minY), bounds.maxY);
      return { x: newX, y: newY, scale };
    },
    [getTransformBounds],
  );

  const applyTransform = useCallback(
    (x: number, y: number, scale: number) => {
      transformStateRef.current = { positionX: x, positionY: y, scale };
      setTransformState({ scale, positionX: x, positionY: y });

      if (contentRef.current) {
        contentRef.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      }

      if (!isTransitioningRef.current) {
        if (scale > 1.01) {
          const container = imageContainerRef.current;
          if (container) {
            const cw = container.offsetWidth;
            const ch = container.offsetHeight;
            focalPointRef.current = {
              x: (cw / 2 - x) / (cw * scale),
              y: (ch / 2 - y) / (ch * scale),
            };
          }
        } else {
          focalPointRef.current = { x: 0.5, y: 0.5 };
        }
      }

      if (zoomDebounceTimeoutRef.current) clearTimeout(zoomDebounceTimeoutRef.current);
      zoomDebounceTimeoutRef.current = window.setTimeout(() => {
        onZoomed({ scale, positionX: x, positionY: y });
      }, 100);
    },
    [onZoomed],
  );

  const animateTransform = useCallback(
    (targetX: number, targetY: number, targetScale: number, duration: number) => {
      if (physicsFrameId.current) cancelAnimationFrame(physicsFrameId.current);

      const startX = transformStateRef.current.positionX;
      const startY = transformStateRef.current.positionY;
      const startScale = transformStateRef.current.scale;
      const boundedTarget = clampToBounds(targetX, targetY, targetScale);

      const startTime = performance.now();

      const step = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easeProgress = 1 - Math.pow(1 - progress, 3);

        const currX = startX + (boundedTarget.x - startX) * easeProgress;
        const currY = startY + (boundedTarget.y - startY) * easeProgress;
        const currScale = startScale + (boundedTarget.scale - startScale) * easeProgress;

        applyTransform(currX, currY, currScale);

        if (progress < 1) {
          animationFrameId.current = requestAnimationFrame(step);
        }
      };

      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      animationFrameId.current = requestAnimationFrame(step);
    },
    [applyTransform, clampToBounds],
  );

  const startPhysicsLoop = useCallback(
    (initialVx: number, initialVy: number) => {
      if (physicsFrameId.current) cancelAnimationFrame(physicsFrameId.current);
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);

      let vx = initialVx;
      let vy = initialVy;
      let lastTime = performance.now();

      const step = (time: number) => {
        const dt = Math.min(time - lastTime, 32);
        lastTime = time;

        let { positionX: x, positionY: y, scale } = transformStateRef.current;
        const bounds = getTransformBounds(scale);

        x += vx * dt;
        y += vy * dt;

        const decay = Math.pow(0.994, dt);
        vx *= decay;
        vy *= decay;

        let outOfBounds = false;
        if (x > bounds.maxX || x < bounds.minX || y > bounds.maxY || y < bounds.minY) {
          outOfBounds = true;
        }

        if (outOfBounds) {
          vx *= 0.5;
          vy *= 0.5;

          const correction = 0.15;
          if (x > bounds.maxX) x += (bounds.maxX - x) * correction;
          else if (x < bounds.minX) x += (bounds.minX - x) * correction;

          if (y > bounds.maxY) y += (bounds.maxY - y) * correction;
          else if (y < bounds.minY) y += (bounds.minY - y) * correction;
        }

        applyTransform(x, y, scale);

        const speed = Math.hypot(vx, vy);

        if (speed < 0.02 && !outOfBounds) {
          const finalPos = clampToBounds(x, y, scale);
          if (Math.abs(x - finalPos.x) > 0.05 || Math.abs(y - finalPos.y) > 0.05) {
            applyTransform(finalPos.x, finalPos.y, scale);
          }
          return;
        }

        if (outOfBounds && speed < 0.05 && Math.abs(vx) < 0.05 && Math.abs(vy) < 0.05) {
          const dist = Math.max(
            x > bounds.maxX ? x - bounds.maxX : x < bounds.minX ? bounds.minX - x : 0,
            y > bounds.maxY ? y - bounds.maxY : y < bounds.minY ? bounds.minY - y : 0,
          );
          if (dist < 0.5) {
            const finalPos = clampToBounds(x, y, scale);
            applyTransform(finalPos.x, finalPos.y, scale);
            return;
          }
        }

        physicsFrameId.current = requestAnimationFrame(step);
      };
      physicsFrameId.current = requestAnimationFrame(step);
    },
    [applyTransform, getTransformBounds, clampToBounds],
  );

  const zoomToCenter = useCallback(
    (newScale: number, duration: number) => {
      const container = imageContainerRef.current;
      if (!container) return;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const centerX = cw / 2;
      const centerY = ch / 2;

      const ratio = newScale / transformStateRef.current.scale;
      const newX = centerX - (centerX - transformStateRef.current.positionX) * ratio;
      const newY = centerY - (centerY - transformStateRef.current.positionY) * ratio;

      if (duration > 0) {
        animateTransform(newX, newY, newScale, duration);
      } else {
        const bounded = clampToBounds(newX, newY, newScale);
        applyTransform(bounded.x, bounded.y, bounded.scale);
      }
    },
    [animateTransform, applyTransform, clampToBounds],
  );

  useImperativeHandle(
    transformWrapperRef,
    () => ({
      zoomIn: (factor: number, time?: number) => {
        zoomToCenter(transformStateRef.current.scale * Math.exp(factor), time || 0);
      },
      zoomOut: (factor: number, time?: number) => {
        zoomToCenter(transformStateRef.current.scale * Math.exp(-factor), time || 0);
      },
      resetTransform: (time?: number) => {
        if (time) animateTransform(0, 0, 1, time);
        else applyTransform(0, 0, 1);
      },
      setTransform: (x: number, y: number, scale: number, time?: number) => {
        if (time && time > 0) animateTransform(x, y, scale, time);
        else {
          const bounded = clampToBounds(x, y, scale);
          applyTransform(bounded.x, bounded.y, bounded.scale);
        }
      },
      instance: {
        wrapperComponent: imageContainerRef.current,
        contentComponent: contentRef.current,
        get transformState() {
          return transformStateRef.current;
        },
      },
    }),
    [animateTransform, applyTransform, clampToBounds, zoomToCenter],
  );

  useEffect(() => {
    if (!transformWrapperRef.current) return;
    const currentScale = transformStateRef.current.scale;
    if (Math.abs(currentScale - targetZoom) < 0.001) return;

    const animationTime = 200;
    if (targetZoom > currentScale) {
      transformWrapperRef.current.zoomIn(Math.log(targetZoom / currentScale), animationTime);
    } else {
      transformWrapperRef.current.zoomOut(Math.log(currentScale / targetZoom), animationTime);
    }
  }, [targetZoom, transformWrapperRef]);

  const activeSubMask = useMemo(() => {
    if (isMasking && activeMaskId) {
      const container = adjustments.masks.find((c: MaskContainer) =>
        c.subMasks.some((sm: SubMask) => sm.id === activeMaskId),
      );
      return container?.subMasks.find((sm) => sm.id === activeMaskId);
    }
    if (isAiEditing && activeAiSubMaskId) {
      const container = adjustments.aiPatches.find((c: AiPatch) =>
        c.subMasks.some((sm: SubMask) => sm.id === activeAiSubMaskId),
      );
      return container?.subMasks?.find((sm: SubMask) => sm.id === activeAiSubMaskId);
    }
    return null;
  }, [adjustments.masks, adjustments.aiPatches, activeMaskId, activeAiSubMaskId, isMasking, isAiEditing]);

  const isPanningDisabled =
    isMaskHovered ||
    isMaskTouchInteracting ||
    isCropping ||
    (isMasking &&
      (activeSubMask?.type === Mask.Brush ||
        activeSubMask?.type === Mask.Flow ||
        activeSubMask?.type === Mask.AiSubject ||
        activeSubMask?.type === Mask.Color ||
        activeSubMask?.type === Mask.Luminance ||
        activeSubMask?.parameters?.isInitialDraw)) ||
    (isAiEditing &&
      (activeSubMask?.type === Mask.Brush ||
        activeSubMask?.type === Mask.Flow ||
        activeSubMask?.type === Mask.AiSubject ||
        activeSubMask?.type === Mask.QuickEraser ||
        activeSubMask?.type === Mask.Color ||
        activeSubMask?.type === Mask.Luminance ||
        activeSubMask?.parameters?.isInitialDraw)) ||
    isWbPickerActive;

  useEffect(() => {
    const container = imageContainerRef.current;
    if (!container) return;

    const handleNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      if (physicsFrameId.current) cancelAnimationFrame(physicsFrameId.current);

      const maxDelta = Math.max(Math.abs(e.deltaX), Math.abs(e.deltaY));
      const isTrackpad = e.deltaMode === 0 && (e.deltaY % 1 !== 0 || e.deltaX % 1 !== 0 || maxDelta < 50);

      const isZoomIntent = isTrackpad ? e.ctrlKey : !e.ctrlKey && !e.shiftKey;

      if (isZoomIntent) {
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const primaryDelta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        const magnitude = Math.abs(primaryDelta);
        const direction = Math.sign(primaryDelta);

        let minSpeed, maxSpeed, maxExpectedDelta;

        if (isTrackpad) {
          minSpeed = 0.005;
          maxSpeed = 0.02;
          maxExpectedDelta = 30;
        } else {
          minSpeed = 0.001;
          maxSpeed = 0.005;
          maxExpectedDelta = 150;
        }

        const scrollIntensity = Math.min(magnitude / maxExpectedDelta, 1);
        const dynamicSpeed = minSpeed + (maxSpeed - minSpeed) * scrollIntensity;

        const maxZoomJump = isTrackpad ? 0.15 : 0.25;
        const exponent = Math.min(magnitude * dynamicSpeed, maxZoomJump);

        let newScale = transformStateRef.current.scale;
        newScale *= Math.exp(-direction * exponent);
        newScale = Math.max(minScaleRef.current, Math.min(maxScaleRef.current, newScale));

        const ratio = newScale / transformStateRef.current.scale;
        const newX = mouseX - (mouseX - transformStateRef.current.positionX) * ratio;
        const newY = mouseY - (mouseY - transformStateRef.current.positionY) * ratio;

        const bounded = clampToBounds(newX, newY, newScale);
        applyTransform(bounded.x, bounded.y, bounded.scale);
      } else {
        if (transformStateRef.current.scale <= 1.01) return;

        const { positionX: curX, positionY: curY, scale } = transformStateRef.current;
        const bounds = getTransformBounds(scale);

        let dx = e.deltaX;
        let dy = e.deltaY;

        if (!isTrackpad) {
          if (e.shiftKey && e.ctrlKey) {
            const primaryDelta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
            dx = primaryDelta;
            dy = primaryDelta;
          } else if (e.shiftKey) {
            dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
            dy = 0;
          } else if (e.ctrlKey) {
            dx = 0;
            dy = e.deltaY !== 0 ? e.deltaY : e.deltaX;
          }
        }

        let newX = curX - dx;
        let newY = curY - dy;

        const resistance = 0.5;

        if (newX > bounds.maxX) {
          const overshoot = newX - bounds.maxX;
          newX = bounds.maxX + overshoot * resistance;
        } else if (newX < bounds.minX) {
          const overshoot = newX - bounds.minX;
          newX = bounds.minX + overshoot * resistance;
        }

        if (newY > bounds.maxY) {
          const overshoot = newY - bounds.maxY;
          newY = bounds.maxY + overshoot * resistance;
        } else if (newY < bounds.minY) {
          const overshoot = newY - bounds.minY;
          newY = bounds.minY + overshoot * resistance;
        }

        applyTransform(newX, newY, scale);

        if (wheelSnapTimeout.current) clearTimeout(wheelSnapTimeout.current);
        wheelSnapTimeout.current = window.setTimeout(() => {
          startPhysicsLoop(0, 0);
        }, 150);
      }
    };

    container.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleNativeWheel);
  }, [applyTransform, clampToBounds, getTransformBounds, startPhysicsLoop]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      if (physicsFrameId.current) cancelAnimationFrame(physicsFrameId.current);

      panVelocityHistory.current = [];
      mouseDownPos.current = { x: e.clientX, y: e.clientY };
      activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.current.size === 1) {
        lastPanPos.current = { x: e.clientX, y: e.clientY };
        if (!isPanningDisabled) setIsPanningState(true);
      } else if (activePointers.current.size === 2) {
        const pts = Array.from(activePointers.current.values());
        lastPinch.current = {
          dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
          midX: (pts[0].x + pts[1].x) / 2,
          midY: (pts[0].y + pts[1].y) / 2,
        };
      }

      if (e.pointerType === 'mouse') e.currentTarget.setPointerCapture(e.pointerId);
    },
    [isPanningDisabled],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!activePointers.current.has(e.pointerId)) return;
      activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.current.size === 1 && lastPanPos.current && isPanningState && !isPanningDisabled) {
        panVelocityHistory.current.push({ x: e.clientX, y: e.clientY, t: performance.now() });
        if (panVelocityHistory.current.length > 6) panVelocityHistory.current.shift();

        let dx = e.clientX - lastPanPos.current.x;
        let dy = e.clientY - lastPanPos.current.y;
        lastPanPos.current = { x: e.clientX, y: e.clientY };

        const bounds = getTransformBounds(transformStateRef.current.scale);
        let curX = transformStateRef.current.positionX;
        let curY = transformStateRef.current.positionY;

        if (curX < bounds.minX && dx < 0) dx *= 0.35;
        if (curX > bounds.maxX && dx > 0) dx *= 0.35;
        if (curY < bounds.minY && dy < 0) dy *= 0.35;
        if (curY > bounds.maxY && dy > 0) dy *= 0.35;

        applyTransform(curX + dx, curY + dy, transformStateRef.current.scale);
      } else if (activePointers.current.size === 2 && lastPinch.current) {
        const pts = Array.from(activePointers.current.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;

        const distDelta = dist / lastPinch.current.dist;
        let newScale = transformStateRef.current.scale * distDelta;
        newScale = Math.max(minScaleRef.current, Math.min(maxScaleRef.current, newScale));

        const rect = imageContainerRef.current?.getBoundingClientRect();
        if (rect) {
          const mouseX = midX - rect.left;
          const mouseY = midY - rect.top;
          const ratio = newScale / transformStateRef.current.scale;

          const panX = midX - lastPinch.current.midX;
          const panY = midY - lastPinch.current.midY;

          let newX = mouseX - (mouseX - transformStateRef.current.positionX) * ratio + panX;
          let newY = mouseY - (mouseY - transformStateRef.current.positionY) * ratio + panY;

          const bounded = clampToBounds(newX, newY, newScale);
          applyTransform(bounded.x, bounded.y, bounded.scale);
        }

        lastPinch.current = { dist, midX, midY };
      }
    },
    [applyTransform, clampToBounds, getTransformBounds, isPanningDisabled, isPanningState],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      activePointers.current.delete(e.pointerId);

      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }

      if (activePointers.current.size === 1) {
        const pts = Array.from(activePointers.current.values());
        lastPanPos.current = { x: pts[0].x, y: pts[0].y };
        lastPinch.current = null;
      } else if (activePointers.current.size === 0) {
        lastPanPos.current = null;
        lastPinch.current = null;
        setIsPanningState(false);

        let vx = 0,
          vy = 0;
        const history = panVelocityHistory.current;
        if (history.length > 1) {
          const first = history[0];
          const last = history[history.length - 1];
          const dt = last.t - first.t;
          if (dt > 0 && performance.now() - last.t < 50) {
            vx = (last.x - first.x) / dt;
            vy = (last.y - first.y) / dt;
          }
        }

        const { positionX, positionY, scale } = transformStateRef.current;
        const bounds = getTransformBounds(scale);
        const outOfBounds =
          positionX > bounds.maxX || positionX < bounds.minX || positionY > bounds.maxY || positionY < bounds.minY;

        if (Math.abs(vx) > 0.05 || Math.abs(vy) > 0.05 || outOfBounds) {
          startPhysicsLoop(vx, vy);
        }
      }
    },
    [getTransformBounds, startPhysicsLoop],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isCropping || isMasking || isAiEditing || isWbPickerActive) return;

      if (mouseDownPos.current) {
        const dx = Math.abs(e.clientX - mouseDownPos.current.x);
        const dy = Math.abs(e.clientY - mouseDownPos.current.y);
        if (dx > 5 || dy > 5) return;
      }

      const currentScale = transformStateRef.current.scale;

      if (isClickAnimating.current || currentScale > 1.01) {
        if (!isClickAnimating.current && currentScale > 1.01) {
          savedZoomState.current = {
            scale: currentScale,
            positionX: transformStateRef.current.positionX,
            positionY: transformStateRef.current.positionY,
          };
        }
        animateTransform(0, 0, 1, clickAnimationTime);
        isClickAnimating.current = false;
      } else {
        isClickAnimating.current = true;
        setTimeout(() => {
          isClickAnimating.current = false;
        }, clickAnimationTime + 50);

        const container = imageContainerRef.current;
        if (!container) return;

        const currentPositionX = transformStateRef.current.positionX;
        const currentPositionY = transformStateRef.current.positionY;

        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        let targetScale = savedZoomState.current
          ? savedZoomState.current.scale
          : Math.min(currentScale * 2, maxScaleRef.current);
        const ratio = targetScale / currentScale;

        const newPositionX = mouseX - (mouseX - currentPositionX) * ratio;
        const newPositionY = mouseY - (mouseY - currentPositionY) * ratio;

        animateTransform(newPositionX, newPositionY, targetScale, clickAnimationTime);
      }
    },
    [isCropping, isMasking, isAiEditing, isWbPickerActive, animateTransform],
  );

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (showOriginal) {
      setShowOriginal(false);
    }
  }, [adjustments, setShowOriginal]);

  useEffect(() => {
    if (!isMasking && !isAiEditing) {
      setIsMaskTouchInteracting(false);
    }
  }, [isMasking, isAiEditing]);

  const hasDisplayableImage = finalPreviewUrl || selectedImage?.thumbnailUrl;
  const showSpinner = isLoading && !hasDisplayableImage;

  useLayoutEffect(() => {
    const container = imageContainerRef.current;
    if (!container || imageRenderSize.width === 0) return;

    const currentRect = container.getBoundingClientRect();
    const scaleOld = transformStateRef.current.scale;
    const posOldX = transformStateRef.current.positionX;
    const posOldY = transformStateRef.current.positionY;

    if (isInstantTransition && !transitionAnchorRef.current && scaleOld > 1.01) {
      transitionAnchorRef.current = {
        active: true,
        screenImageLeft: prevRenderState.current.containerLeft + posOldX + prevRenderState.current.offsetX * scaleOld,
        screenImageTop: prevRenderState.current.containerTop + posOldY + prevRenderState.current.offsetY * scaleOld,
        physicalImageWidth: prevRenderState.current.width * scaleOld,
      };
    }

    if (!isInstantTransition && transitionAnchorRef.current) {
      transitionAnchorRef.current = null;
    }

    if (transitionAnchorRef.current && transitionAnchorRef.current.active) {
      const anchor = transitionAnchorRef.current;

      const scaleNew = anchor.physicalImageWidth / imageRenderSize.width;

      const posNewX = anchor.screenImageLeft - currentRect.left - imageRenderSize.offsetX * scaleNew;
      const posNewY = anchor.screenImageTop - currentRect.top - imageRenderSize.offsetY * scaleNew;

      if (
        Math.abs(scaleNew - scaleOld) > 0.001 ||
        Math.abs(posNewX - posOldX) > 0.5 ||
        Math.abs(posNewY - posOldY) > 0.5
      ) {
        applyTransform(posNewX, posNewY, scaleNew);
      }
    }

    prevRenderState.current = {
      containerLeft: currentRect.left,
      containerTop: currentRect.top,
      offsetX: imageRenderSize.offsetX,
      offsetY: imageRenderSize.offsetY,
      width: imageRenderSize.width,
    };
  }, [isFullScreen, imageRenderSize, isInstantTransition, applyTransform]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (onDisplaySizeChange && imageRenderSize.width > 0) {
        const currentDisplaySize = {
          width: imageRenderSize.width * transformState.scale,
          height: imageRenderSize.height * transformState.scale,
          scale: transformState.scale,
          offsetX: imageRenderSize.offsetX,
          offsetY: imageRenderSize.offsetY,
          containerWidth: imageContainerRef.current?.clientWidth || 0,
          containerHeight: imageContainerRef.current?.clientHeight || 0,
        };
        onDisplaySizeChange(currentDisplaySize);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [imageRenderSize, transformState.scale, onDisplaySizeChange]);

  const processOverlayQueue = useCallback(async () => {
    if (isGeneratingOverlayRef.current || !pendingOverlayRequestRef.current) return;

    const { maskDef, renderSize, jsAdjustments } = pendingOverlayRequestRef.current;
    pendingOverlayRequestRef.current = null;

    if (!maskDef || !maskDef.visible || renderSize.width === 0) {
      setMaskOverlayUrl(null);
      return;
    }

    isGeneratingOverlayRef.current = true;
    try {
      const cropOffset = [jsAdjustments.crop?.x || 0, jsAdjustments.crop?.y || 0];
      const dataUrl: string = await invoke(Invokes.GenerateMaskOverlay, {
        cropOffset,
        height: Math.round(renderSize.height),
        maskDef,
        scale: renderSize.scale,
        width: Math.round(renderSize.width),
        jsAdjustments: jsAdjustments,
      });
      if (dataUrl) {
        setMaskOverlayUrl(dataUrl);
      } else {
        setMaskOverlayUrl(null);
      }
    } catch (e) {
      console.error('Failed to generate live mask overlay:', e);
      setMaskOverlayUrl(null);
    } finally {
      isGeneratingOverlayRef.current = false;
      if (pendingOverlayRequestRef.current) {
        requestAnimationFrame(processOverlayQueue);
      }
    }
  }, []);

  const requestMaskOverlay = useCallback(
    (maskDef: any, renderSize: any, currentAdjustments: any) => {
      pendingOverlayRequestRef.current = { maskDef, renderSize, jsAdjustments: currentAdjustments };
      processOverlayQueue();
    },
    [processOverlayQueue],
  );

  const handleLiveMaskPreview = useCallback(
    (maskDef: any) => {
      let normalizedDef = maskDef;
      if (maskDef && !maskDef.adjustments) {
        normalizedDef = {
          ...maskDef,
          adjustments: {},
          opacity: 100,
        };
      }
      requestMaskOverlay(normalizedDef, imageRenderSize, adjustments);
    },
    [imageRenderSize, adjustments, requestMaskOverlay],
  );

  const croppedDimensionsRef = useRef(croppedDimensions);
  useEffect(() => {
    croppedDimensionsRef.current = croppedDimensions;
  }, [croppedDimensions]);

  const wgpuStateRef = useRef<WgpuRenderState>({
    useWgpuRenderer: appSettings?.useWgpuRenderer,
    isReady: selectedImage?.isReady ?? false,
    hasRenderedFirstFrame,
    isCropping,
    uncroppedAdjustedPreviewUrl,
    showOriginal,
    bgPrimary: [24 / 255, 24 / 255, 24 / 255, 1.0],
    bgSecondary: [35 / 255, 35 / 255, 35 / 255, 1.0],
  });

  useEffect(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const bgPrimaryStr = rootStyle.getPropertyValue('--app-bg-primary') || 'rgb(24, 24, 24)';
    const bgSecondaryStr = rootStyle.getPropertyValue('--app-bg-secondary') || 'rgb(35, 35, 35)';

    wgpuStateRef.current = {
      useWgpuRenderer: appSettings?.useWgpuRenderer,
      isReady: selectedImage?.isReady ?? false,
      hasRenderedFirstFrame,
      isCropping,
      uncroppedAdjustedPreviewUrl,
      showOriginal,
      bgPrimary: parseRgb(bgPrimaryStr),
      bgSecondary: parseRgb(bgSecondaryStr),
    };
  }, [
    appSettings?.useWgpuRenderer,
    selectedImage?.isReady,
    hasRenderedFirstFrame,
    isCropping,
    uncroppedAdjustedPreviewUrl,
    showOriginal,
    appSettings?.theme,
    finalPreviewUrl,
  ]);

  useEffect(() => {
    let isEffectActive = true;
    let isInvoking = false;

    const syncWgpu = () => {
      if (!isEffectActive) return;

      const state = wgpuStateRef.current;
      const container = imageContainerRef.current;

      if (!container) {
        if (isEffectActive) {
          wgpuSyncRef.current = requestAnimationFrame(syncWgpu);
        }
        return;
      }

      const currentRect = container.getBoundingClientRect();

      if (currentRect.width < 10 || currentRect.height < 10) {
        if (isEffectActive) {
          wgpuSyncRef.current = requestAnimationFrame(syncWgpu);
        }
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const windowWidth = Math.max(window.innerWidth * dpr, 1);
      const windowHeight = Math.max(window.innerHeight * dpr, 1);

      const clipX = currentRect.left * dpr;
      const clipY = currentRect.top * dpr;
      const clipW = Math.max(currentRect.width * dpr, 1);
      const clipH = Math.max(currentRect.height * dpr, 1);

      if (state.useWgpuRenderer === false || !state.isReady || !state.hasRenderedFirstFrame) {
        const hiddenTransform = `${windowWidth},${windowHeight},-999999,-999999,1,1,${clipX},${clipY},${clipW},${clipH},${state.bgPrimary?.join(',')},${state.bgSecondary?.join(',')}`;

        if (lastWgpuTransformRef.current !== hiddenTransform && !isInvoking) {
          lastWgpuTransformRef.current = hiddenTransform;
          isInvoking = true;
          invoke('update_wgpu_transform', {
            payload: {
              windowWidth,
              windowHeight,
              x: -999999,
              y: -999999,
              width: 1,
              height: 1,
              clipX,
              clipY,
              clipWidth: clipW,
              clipHeight: clipH,
              bgPrimary: state.bgPrimary || [0, 0, 0, 1],
              bgSecondary: state.bgSecondary || [0, 0, 0, 1],
            },
          })
            .catch(() => {})
            .finally(() => {
              isInvoking = false;
            });
        }
        if (isEffectActive) {
          wgpuSyncRef.current = requestAnimationFrame(syncWgpu);
        }
        return;
      }

      const scale = transformStateRef.current.scale;
      const posX = transformStateRef.current.positionX;
      const posY = transformStateRef.current.positionY;

      const cw = currentRect.width;
      const ch = currentRect.height;
      const imgW = croppedDimensionsRef.current?.width || 1;
      const imgH = croppedDimensionsRef.current?.height || 1;

      const containerRatio = cw / ch;
      const imgRatio = imgW / imgH;

      let offsetX = 0;
      let offsetY = 0;
      let baseW = 0;
      let baseH = 0;

      if (imgRatio > containerRatio) {
        baseW = cw;
        baseH = cw / imgRatio;
        offsetY = (ch - baseH) / 2;
      } else {
        baseH = ch;
        baseW = ch * imgRatio;
        offsetX = (cw - baseW) / 2;
      }

      let screenX = (currentRect.left + posX + offsetX * scale) * dpr;
      let screenY = (currentRect.top + posY + offsetY * scale) * dpr;
      let screenW = baseW * scale * dpr;
      let screenH = baseH * scale * dpr;

      const isCropViewVisible = state.isCropping && state.uncroppedAdjustedPreviewUrl;

      if (isCropViewVisible) {
        screenX = -999999;
        screenY = -999999;
        screenW = 1;
        screenH = 1;
      } else {
        screenW = Math.max(screenW, 1);
        screenH = Math.max(screenH, 1);
      }

      const currentTransform = `${windowWidth},${windowHeight},${screenX},${screenY},${screenW},${screenH},${clipX},${clipY},${clipW},${clipH},${state.bgPrimary?.join(',')},${state.bgSecondary?.join(',')}`;

      if (lastWgpuTransformRef.current !== currentTransform && !isInvoking) {
        lastWgpuTransformRef.current = currentTransform;
        isInvoking = true;

        const isZoomedIn = scale >= maxScaleRef.current - 0.5;

        invoke('update_wgpu_transform', {
          payload: {
            windowWidth,
            windowHeight,
            x: screenX,
            y: screenY,
            width: screenW,
            height: screenH,
            clipX,
            clipY,
            clipWidth: clipW,
            clipHeight: clipH,
            bgPrimary: state.bgPrimary || [0, 0, 0, 1],
            bgSecondary: state.bgSecondary || [0, 0, 0, 1],
            pixelated: isZoomedIn,
          },
        })
          .catch((err) => console.warn('WGPU Sync Error:', err))
          .finally(() => {
            isInvoking = false;
          });
      }

      if (isEffectActive) {
        wgpuSyncRef.current = requestAnimationFrame(syncWgpu);
      }
    };

    wgpuSyncRef.current = requestAnimationFrame(syncWgpu);

    return () => {
      isEffectActive = false;
      if (wgpuSyncRef.current !== null) {
        cancelAnimationFrame(wgpuSyncRef.current);
      }
    };
  }, []);

  const overlayTriggerHash = useMemo(() => {
    let activeMaskDef = null;
    if (activeRightPanel === Panel.Masks && activeMaskContainerId) {
      activeMaskDef = adjustments.masks?.find((c: MaskContainer) => c.id === activeMaskContainerId);
    } else if (activeRightPanel === Panel.Ai && activeAiPatchContainerId) {
      activeMaskDef = adjustments.aiPatches?.find((p: AiPatch) => p.id === activeAiPatchContainerId);
    }

    if (!activeMaskDef) return null;

    const geometryKeys = [
      'crop',
      'rotation',
      'flipHorizontal',
      'flipVertical',
      'orientationSteps',
      'transformDistortion',
      'transformVertical',
      'transformHorizontal',
      'transformRotate',
      'transformAspect',
      'transformScale',
      'transformXOffset',
      'transformYOffset',
      'lensDistortionAmount',
      'lensVignetteAmount',
      'lensTcaAmount',
      'lensDistortionParams',
      'lensMaker',
      'lensModel',
      'lensDistortionEnabled',
      'lensTcaEnabled',
      'lensVignetteEnabled',
    ];

    const geometry: any = {};
    geometryKeys.forEach((k) => {
      geometry[k] = (adjustments as any)[k];
    });

    const subMasks = activeMaskDef.subMasks?.map((sm: any) => {
      const { parameters, ...rest } = sm;
      const cleanParams = { ...parameters };
      delete cleanParams.mask_data_base64;
      delete cleanParams.maskDataBase64;
      return { ...rest, parameters: cleanParams };
    });

    return JSON.stringify({
      id: activeMaskDef.id,
      invert: activeMaskDef.invert,
      opacity: activeMaskDef.opacity,
      subMasks,
      geometry,
      renderSize: { w: imageRenderSize.width, h: imageRenderSize.height },
    });
  }, [
    activeRightPanel,
    activeMaskContainerId,
    activeAiPatchContainerId,
    adjustments,
    imageRenderSize.width,
    imageRenderSize.height,
  ]);

  useEffect(() => {
    let maskDefForOverlay = null;

    if (activeRightPanel === Panel.Masks && activeMaskContainerId) {
      const activeMask = adjustments.masks?.find((c: MaskContainer) => c.id === activeMaskContainerId);
      if (activeMask) {
        maskDefForOverlay = {
          ...activeMask,
          adjustments: {},
        };
      }
    } else if (activeRightPanel === Panel.Ai && activeAiPatchContainerId) {
      const activePatch = adjustments.aiPatches?.find((p: AiPatch) => p.id === activeAiPatchContainerId);
      if (activePatch) {
        maskDefForOverlay = {
          ...activePatch,
          adjustments: {},
          opacity: 100,
        };
      }
    }

    requestMaskOverlay(maskDefForOverlay, imageRenderSize, adjustments);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    overlayTriggerHash,
    requestMaskOverlay,
    activeRightPanel,
    activeMaskContainerId,
    activeAiPatchContainerId,
    imageRenderSize,
  ]);

  useEffect(() => {
    let timer: number;
    if (showSpinner) {
      setIsLoaderVisible(true);
    } else {
      timer = setTimeout(() => setIsLoaderVisible(false), 300);
    }
    return () => clearTimeout(timer);
  }, [showSpinner]);

  useEffect(() => {
    if (!isCropping || !selectedImage?.width) {
      return;
    }

    const { aspectRatio, orientationSteps = 0, crop: currentAdjCrop, rotation = 0 } = adjustments;
    const effectiveRotation = liveRotation !== null && liveRotation !== undefined ? liveRotation : rotation;

    const geometryChanged =
      prevCropParams.current?.rotation !== rotation ||
      prevCropParams.current?.aspectRatio !== aspectRatio ||
      prevCropParams.current?.orientationSteps !== orientationSteps;

    const isDraggingRotation = liveRotation !== null && liveRotation !== undefined;

    const needsRecalc = currentAdjCrop === null || geometryChanged || isDraggingRotation;

    if (needsRecalc) {
      const { width: W, height: H } = getOrientedDimensions(
        selectedImage.width,
        selectedImage.height,
        orientationSteps,
      );
      const A = aspectRatio || W / H;

      if (isNaN(A) || A <= 0) {
        return;
      }

      const maxPixelCrop = calculateCenteredCrop(
        selectedImage.width,
        selectedImage.height,
        orientationSteps,
        A,
        effectiveRotation,
      );
      if (!maxPixelCrop) return;

      if (isDraggingRotation) {
        setCrop({
          unit: '%',
          x: (maxPixelCrop.x / W) * 100,
          y: (maxPixelCrop.y / H) * 100,
          width: (maxPixelCrop.width / W) * 100,
          height: (maxPixelCrop.height / H) * 100,
        });
      } else {
        if (currentAdjCrop === null || geometryChanged) {
          prevCropParams.current = { rotation, aspectRatio, orientationSteps };

          const isDifferent =
            !currentAdjCrop ||
            currentAdjCrop.x !== maxPixelCrop.x ||
            currentAdjCrop.y !== maxPixelCrop.y ||
            currentAdjCrop.width !== maxPixelCrop.width ||
            currentAdjCrop.height !== maxPixelCrop.height;

          if (isDifferent) {
            setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, crop: maxPixelCrop }));
          }
        }
      }
    }
  }, [
    adjustments.aspectRatio,
    adjustments.crop,
    adjustments.orientationSteps,
    adjustments.rotation,
    liveRotation,
    isCropping,
    selectedImage,
    setAdjustments,
  ]);

  useEffect(() => {
    if (!isCropping || !selectedImage?.width) {
      setCrop(null);
      return;
    }

    if (liveRotation !== null && liveRotation !== undefined) {
      return;
    }

    const orientationSteps = adjustments.orientationSteps || 0;
    const isSwapped = orientationSteps === 1 || orientationSteps === 3;
    const cropBaseWidth = isSwapped ? selectedImage.height : selectedImage.width;
    const cropBaseHeight = isSwapped ? selectedImage.width : selectedImage.height;

    const { crop: pixelCrop } = adjustments;

    if (pixelCrop) {
      setCrop({
        height: (pixelCrop.height / cropBaseHeight) * 100,
        unit: '%',
        width: (pixelCrop.width / cropBaseWidth) * 100,
        x: (pixelCrop.x / cropBaseWidth) * 100,
        y: (pixelCrop.y / cropBaseHeight) * 100,
      });
    }
  }, [isCropping, adjustments.crop, adjustments.orientationSteps, selectedImage, liveRotation]);

  const handleCropChange = useCallback((pixelCrop: Crop, percentCrop: PercentCrop) => {
    setCrop(percentCrop);
  }, []);

  const handleCropComplete = useCallback(
    (_: any, pc: PercentCrop) => {
      if (!pc.width || !pc.height || !selectedImage?.width) {
        return;
      }
      if (liveRotation !== null && liveRotation !== undefined) {
        return;
      }

      const orientationSteps = adjustments.orientationSteps || 0;
      const isSwapped = orientationSteps === 1 || orientationSteps === 3;

      const cropBaseWidth = isSwapped ? selectedImage.height : selectedImage.width;
      const cropBaseHeight = isSwapped ? selectedImage.width : selectedImage.height;

      const newPixelCrop: Crop = {
        height: Math.round((pc.height / 100) * cropBaseHeight),
        width: Math.round((pc.width / 100) * cropBaseWidth),
        x: Math.round((pc.x / 100) * cropBaseWidth),
        y: Math.round((pc.y / 100) * cropBaseHeight),
      };

      setAdjustments((prev: Partial<Adjustments>) => {
        if (JSON.stringify(newPixelCrop) !== JSON.stringify(prev.crop)) {
          return { ...prev, crop: newPixelCrop };
        }
        return prev;
      });
    },
    [selectedImage, adjustments.orientationSteps, setAdjustments, liveRotation],
  );

  const toggleShowOriginal = useCallback(() => setShowOriginal((prev: boolean) => !prev), [setShowOriginal]);

  if (!selectedImage) {
    return (
      <div className="flex-1 bg-bg-secondary rounded-lg flex items-center justify-center">
        <Text variant={TextVariants.heading} color={TextColors.secondary} weight={TextWeights.normal}>
          Select an image from the library to begin editing.
        </Text>
      </div>
    );
  }

  const isZoomActionActive = !isCropping && !isMasking && !isAiEditing && !isWbPickerActive;
  const isMaxZoom = transformState.scale >= maxScaleRef.current - 0.5;

  let cursorStyle = 'default';
  if (isZoomActionActive) {
    if (isPanningState) {
      cursorStyle = 'grabbing';
    } else if (transformState.scale > 1.01) {
      cursorStyle = 'zoom-out';
    } else {
      cursorStyle = 'zoom-in';
    }
  }

  const isWgpuActive = appSettings?.useWgpuRenderer !== false && hasRenderedFirstFrame;

  return (
    <div
      className={clsx(
        'flex-1 flex flex-col relative overflow-hidden min-h-0',
        !isInstantTransition && 'transition-all duration-300 ease-in-out',
        isFullScreen
          ? 'rounded-none p-0 gap-0'
          : clsx('rounded-lg p-2 gap-2', appSettings?.useWgpuRenderer !== false ? 'bg-transparent' : 'bg-bg-secondary'),
      )}
    >
      <div
        className={clsx(
          'shrink-0 relative z-10',
          !isInstantTransition && 'transition-all duration-300 ease-in-out',
          isFullScreen ? 'max-h-0 opacity-0 m-0' : 'max-h-25 opacity-100',
          toolbarOverflowVisible ? 'overflow-visible' : 'overflow-hidden',
        )}
      >
        <EditorToolbar
          canRedo={canRedo}
          canUndo={canUndo}
          isLoading={isLoading}
          onBackToLibrary={onBackToLibrary}
          onRedo={onRedo}
          onToggleFullScreen={onToggleFullScreen}
          onToggleShowOriginal={toggleShowOriginal}
          onUndo={onUndo}
          selectedImage={selectedImage}
          showOriginal={showOriginal}
          showDateView={showExifDateView}
          onToggleDateView={() => setShowExifDateView((prev) => !prev)}
          adjustmentsHistory={adjustmentsHistory}
          adjustmentsHistoryIndex={adjustmentsHistoryIndex}
          goToAdjustmentsHistoryIndex={goToAdjustmentsHistoryIndex}
        />
      </div>

      <div
        className={clsx(
          'flex-1 relative overflow-hidden',
          isFullScreen ? 'rounded-none' : 'rounded-lg',
          appSettings?.useWgpuRenderer !== false && !isFullScreen && 'ring-[9999px] ring-bg-secondary',
          !isWgpuActive && 'bg-bg-secondary',
        )}
        onContextMenu={onContextMenu}
        ref={imageContainerRef}
      >
        {showSpinner && (
          <div
            className={clsx(
              'absolute inset-0 bg-bg-secondary/80 flex items-center justify-center z-50 transition-opacity duration-300',
              isLoaderVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
            )}
          >
            <Loader2 size={48} className="animate-spin text-accent" />
          </div>
        )}

        <div
          ref={contentRef}
          className="w-full h-full flex items-center justify-center touch-none origin-top-left"
          style={{ transform: `translate(0px, 0px) scale(1)` }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClick={handleClick}
        >
          <ImageCanvas
            appSettings={appSettings}
            activeAiPatchContainerId={activeAiPatchContainerId}
            activeAiSubMaskId={activeAiSubMaskId}
            activeMaskContainerId={activeMaskContainerId}
            activeMaskId={activeMaskId}
            adjustments={adjustments}
            brushSettings={brushSettings}
            crop={crop}
            finalPreviewUrl={finalPreviewUrl}
            handleCropComplete={handleCropComplete}
            imageRenderSize={imageRenderSize}
            interactivePatch={interactivePatch}
            isAiEditing={isAiEditing}
            isCropping={isCropping}
            isMaskControlHovered={isMaskControlHovered}
            isMasking={isMasking}
            isStraightenActive={isStraightenActive}
            isRotationActive={isRotationActive}
            isSliderDragging={isSliderDragging}
            maskOverlayUrl={maskOverlayUrl}
            onGenerateAiMask={onGenerateAiMask}
            onLiveMaskPreview={handleLiveMaskPreview}
            onQuickErase={onQuickErase}
            onSelectAiSubMask={onSelectAiSubMask}
            onSelectMask={onSelectMask}
            onStraighten={onStraighten}
            selectedImage={selectedImage}
            setCrop={handleCropChange}
            setIsMaskHovered={setIsMaskHovered}
            setIsMaskTouchInteracting={setIsMaskTouchInteracting}
            showOriginal={showOriginal}
            transformedOriginalUrl={transformedOriginalUrl}
            uncroppedAdjustedPreviewUrl={uncroppedAdjustedPreviewUrl}
            updateSubMask={updateSubMask}
            isWbPickerActive={isWbPickerActive}
            onWbPicked={onWbPicked}
            setAdjustments={setAdjustments}
            overlayRotation={overlayRotation}
            overlayMode={overlayMode}
            cursorStyle={cursorStyle}
            isMaxZoom={isMaxZoom}
            liveRotation={liveRotation}
            zoomScale={transformState.scale}
            hasRenderedFirstFrame={hasRenderedFirstFrame}
          />
        </div>
      </div>
    </div>
  );
}
