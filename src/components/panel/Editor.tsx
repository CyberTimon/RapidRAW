import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
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
import { BrushSettings, Invokes, Panel, SelectedImage, TransformState } from '../ui/AppProperties';
import type { OverlayMode } from './right/CropPanel';

interface EditorProps {
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
}

export default function Editor({
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
}: EditorProps) {
  const [crop, setCrop] = useState<Crop | null>(null);
  const prevCropParams = useRef<any>(null);
  const [isMaskHovered, setIsMaskHovered] = useState(false);
  const [isLoaderVisible, setIsLoaderVisible] = useState(false);
  const [showExifDateView, setShowExifDateView] = useState(false);
  const [maskOverlayUrl, setMaskOverlayUrl] = useState<string | null>(null);
  const [transformState, setTransformState] = useState<TransformState>({ scale: 1, positionX: 0, positionY: 0 });
  const imageContainerRef = useRef<HTMLImageElement>(null);
  const isInitialMount = useRef(true);
  const transformStateRef = useRef<TransformState>(transformState);
  transformStateRef.current = transformState;
  const [isPanningState, setIsPanningState] = useState(false);
  const isClickAnimating = useRef(false);
  const clickAnimationTime = 200;
  const isAnimating = useRef(false);
  const animationTimeoutRef = useRef<number | null>(null);
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const savedZoomState = useRef<{ scale: number; positionX: number; positionY: number } | null>(null);
  const focalPointRef = useRef({ x: 0.5, y: 0.5 });
  const isTransitioningRef = useRef(false);
  const [toolbarOverflowVisible, setToolbarOverflowVisible] = useState(!isFullScreen);
  const isGeneratingOverlayRef = useRef(false);
  const pendingOverlayRequestRef = useRef<any>(null);
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

  useEffect(() => {
    if (!transformWrapperRef.current) {
      return;
    }

    const wrapperInstance = transformWrapperRef.current;
    const { zoomIn, zoomOut } = wrapperInstance;
    const currentScale = transformStateRef.current.scale;

    if (Math.abs(currentScale - targetZoom) < 0.001) {
      return;
    }

    const animationTime = 200;
    const animationType = 'easeOut';
    const factor = Math.log(targetZoom / currentScale);

    if (animationTimeoutRef.current) {
      clearTimeout(animationTimeoutRef.current);
    }

    isAnimating.current = true;

    if (targetZoom > currentScale) {
      zoomIn(factor, animationTime, animationType);
    } else {
      zoomOut(-factor, animationTime, animationType);
    }

    animationTimeoutRef.current = window.setTimeout(() => {
      isAnimating.current = false;
    }, animationTime + 50);
  }, [targetZoom, transformWrapperRef]);

  const handleTransform = useCallback(
    (ref: any, state: TransformState) => {
      setTransformState(state);

      if (!isTransitioningRef.current) {
        if (state.scale > 1.01) {
          const wrapperEl = ref.instance?.wrapperComponent;
          const contentEl = ref.instance?.contentComponent;
          if (wrapperEl && contentEl) {
            const ww = wrapperEl.offsetWidth;
            const wh = wrapperEl.offsetHeight;
            const cw = contentEl.offsetWidth;
            const ch = contentEl.offsetHeight;

            focalPointRef.current = {
              x: (ww / 2 - state.positionX) / (cw * state.scale),
              y: (wh / 2 - state.positionY) / (ch * state.scale),
            };
          }
        } else {
          focalPointRef.current = { x: 0.5, y: 0.5 };
        }
      }

      if (isAnimating.current) {
        return;
      }

      onZoomed(state);
    },
    [onZoomed],
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

  const isCropping = activeRightPanel === Panel.Crop;
  const isMasking = activeRightPanel === Panel.Masks;
  const isAiEditing = activeRightPanel === Panel.Ai;

  const hasDisplayableImage = finalPreviewUrl || selectedImage.thumbnailUrl;
  const showSpinner = isLoading && !hasDisplayableImage;

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

  useLayoutEffect(() => {
    const wrapper = transformWrapperRef.current;
    const container = imageContainerRef.current;

    if (!wrapper || !container || imageRenderSize.width === 0) return;

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
        wrapper.setTransform(posNewX, posNewY, scaleNew, 0);

        const contentNode = wrapper.instance?.contentComponent;
        if (contentNode) {
          contentNode.style.transform = `translate(${posNewX}px, ${posNewY}px) scale(${scaleNew})`;
        }
      }
    }

    prevRenderState.current = {
      containerLeft: currentRect.left,
      containerTop: currentRect.top,
      offsetX: imageRenderSize.offsetX,
      offsetY: imageRenderSize.offsetY,
      width: imageRenderSize.width,
    };
  }, [isFullScreen, imageRenderSize, isInstantTransition]);

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

  useEffect(() => {
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

  useEffect(() => {
    let maskDefForOverlay = null;

    if (activeRightPanel === Panel.Masks && activeMaskContainerId) {
      maskDefForOverlay = adjustments.masks.find((c: MaskContainer) => c.id === activeMaskContainerId);
    } else if (activeRightPanel === Panel.Ai && activeAiPatchContainerId) {
      const activePatch = adjustments.aiPatches.find((p: AiPatch) => p.id === activeAiPatchContainerId);
      if (activePatch) {
        maskDefForOverlay = {
          ...activePatch,
          adjustments: {},
          opacity: 100,
        };
      }
    }

    requestMaskOverlay(maskDefForOverlay, imageRenderSize, adjustments);
  }, [
    activeRightPanel,
    activeMaskContainerId,
    activeAiPatchContainerId,
    adjustments,
    imageRenderSize,
    requestMaskOverlay,
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

  const doubleClickProps = useMemo(() => ({ disabled: true }), []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const wrapper = transformWrapperRef.current;
      if (!wrapper) return;

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
        wrapper.resetTransform(clickAnimationTime, 'easeOut');
        isClickAnimating.current = false;
      } else {
        isClickAnimating.current = true;

        setTimeout(() => {
          isClickAnimating.current = false;
        }, clickAnimationTime + 50);

        if (savedZoomState.current) {
          const wrapperElement = wrapper.instance.wrapperComponent;
          if (!wrapperElement) return;

          const currentPositionX = transformStateRef.current.positionX;
          const currentPositionY = transformStateRef.current.positionY;

          const rect = wrapperElement.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;

          const targetScale = savedZoomState.current.scale;
          const ratio = targetScale / currentScale;

          const newPositionX = mouseX - (mouseX - currentPositionX) * ratio;
          const newPositionY = mouseY - (mouseY - currentPositionY) * ratio;

          wrapper.setTransform(newPositionX, newPositionY, targetScale, clickAnimationTime, 'easeOut');
        } else {
          const wrapperElement = wrapper.instance.wrapperComponent;
          if (!wrapperElement) return;

          const currentPositionX = transformStateRef.current.positionX;
          const currentPositionY = transformStateRef.current.positionY;

          const rect = wrapperElement.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;

          const targetScale = Math.min(currentScale * 2, transformConfig.maxScale);
          const ratio = targetScale / currentScale;

          const newPositionX = mouseX - (mouseX - currentPositionX) * ratio;
          const newPositionY = mouseY - (mouseY - currentPositionY) * ratio;

          wrapper.setTransform(newPositionX, newPositionY, targetScale, clickAnimationTime, 'easeOut');
        }
      }
    },
    [isCropping, isMasking, isAiEditing, isWbPickerActive, transformWrapperRef, transformConfig.maxScale],
  );

  if (!selectedImage) {
    return (
      <div className="flex-1 bg-bg-secondary rounded-lg flex items-center justify-center text-text-secondary">
        <p>Select an image from the library to begin editing.</p>
      </div>
    );
  }

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
    isCropping ||
    (isMasking &&
      (activeSubMask?.type === Mask.Brush ||
        activeSubMask?.type === Mask.AiSubject ||
        activeSubMask?.type === Mask.Color ||
        activeSubMask?.type === Mask.Luminance ||
        activeSubMask?.parameters?.isInitialDraw)) ||
    (isAiEditing &&
      (activeSubMask?.type === Mask.Brush ||
        activeSubMask?.type === Mask.AiSubject ||
        activeSubMask?.type === Mask.QuickEraser ||
        activeSubMask?.type === Mask.Color ||
        activeSubMask?.type === Mask.Luminance ||
        activeSubMask?.parameters?.isInitialDraw));

  const isZoomActionActive = !isCropping && !isMasking && !isAiEditing && !isWbPickerActive;
  const isMaxZoom = transformState.scale >= transformConfig.maxScale - 0.5;

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

  return (
    <div
      className={clsx(
        'flex-1 flex flex-col relative overflow-hidden min-h-0',
        !isInstantTransition && 'transition-all duration-300 ease-in-out',
        isFullScreen ? 'bg-black rounded-none p-0 gap-0' : 'bg-bg-secondary rounded-lg p-2 gap-2',
      )}
    >
      <div
        className={clsx(
          'shrink-0',
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
        className={clsx('flex-1 relative overflow-hidden', isFullScreen ? 'rounded-none' : 'rounded-lg')}
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

        <TransformWrapper
          ref={transformWrapperRef}
          minScale={transformConfig.minScale}
          maxScale={transformConfig.maxScale}
          limitToBounds={true}
          centerZoomedOut={true}
          doubleClick={doubleClickProps}
          panning={{ disabled: isPanningDisabled || isWbPickerActive }}
          onTransformed={handleTransform}
          onPanning={() => setIsPanningState(true)}
          onPanningStop={() => setIsPanningState(false)}
          wheel={{
            step: transformState.scale * 0.0013,
            smoothStep: transformState.scale * 0.0013,
          }}
        >
          <TransformComponent
            wrapperStyle={{ width: '100%', height: '100%' }}
            contentStyle={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            contentProps={{
              onMouseDown: handleMouseDown,
              onClick: handleClick,
            }}
          >
            <ImageCanvas
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
            />
          </TransformComponent>
        </TransformWrapper>
      </div>
    </div>
  );
}
