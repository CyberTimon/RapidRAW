import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { Crop, PercentCrop } from 'react-image-crop';
import { Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { invoke } from '@tauri-apps/api/core';
import debounce from 'lodash.debounce';
import { AnimatePresence } from 'framer-motion';
import { ImageDimensions, useImageRenderSize } from '../../hooks/useImageRenderSize';
import { Adjustments, AiPatch, Coord, MaskContainer } from '../../utils/adjustments';
import FullScreenViewer from './editor/FullScreenViewer';
import EditorToolbar from './editor/EditorToolbar';
import ImageCanvas from './editor/ImageCanvas';
import Waveform from './editor/Waveform';
import { Mask, SubMask } from './right/Masks';
import { BrushSettings, Invokes, Panel, SelectedImage, TransformState, WaveformData } from '../ui/AppProperties';

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
  fullScreenUrl: string | null;
  isAdjusting: boolean;
  isFullScreen: boolean;
  isFullScreenLoading: boolean;
  isLoading: boolean;
  isMaskControlHovered: boolean;
  isStraightenActive: boolean;
  isWaveformVisible: boolean;
  onBackToLibrary(): void;
  onCloseWaveform(): void;
  onContextMenu(event: any): void;
  onGenerateAiMask(subMaskId: string, startPoint: Coord, endPoint: Coord): void;
  onQuickErase(subMaskId: string | null, startPoint: Coord, endpoint: Coord): void;
  onRedo(): void;
  onSelectAiSubMask(id: string | null): void;
  onSelectMask(id: string): void;
  onStraighten(val: number): void;
  onToggleFullScreen(): void;
  onToggleWaveform(): void;
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
  waveform: WaveformData | null;
  onDisplaySizeChange?(size: any): void;
  onInitialFitScale?(scale: number): void;
  originalSize?: ImageDimensions;
  isFullResolution?: boolean;
  fullResolutionUrl?: string | null;
  isLoadingFullRes?: boolean;
  isWbPickerActive?: boolean;
  onWbPicked?: () => void;
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
  fullScreenUrl,
  isAdjusting,
  isFullScreen,
  isFullScreenLoading,
  isLoading,
  isMaskControlHovered,
  isStraightenActive,
  isWaveformVisible,
  onBackToLibrary,
  onCloseWaveform,
  onContextMenu,
  onGenerateAiMask,
  onQuickErase,
  onRedo,
  onSelectAiSubMask,
  onSelectMask,
  onStraighten,
  onToggleFullScreen,
  onToggleWaveform,
  onUndo,
  onZoomed,
  selectedImage,
  setAdjustments,
  setShowOriginal,
  showOriginal,
  targetZoom,
  thumbnails,
  transformWrapperRef,
  transformedOriginalUrl,
  uncroppedAdjustedPreviewUrl,
  updateSubMask,
  waveform,
  onDisplaySizeChange,
  onInitialFitScale,
  originalSize,
  isFullResolution,
  fullResolutionUrl,
  isLoadingFullRes,
  isWbPickerActive = false,
  onWbPicked,
}: EditorProps) {
  const [crop, setCrop] = useState<Crop | null>(null);
  const prevCropParams = useRef<any>(null);
  const [isMaskHovered, setIsMaskHovered] = useState(false);
  const [isLoaderVisible, setIsLoaderVisible] = useState(false);
  const [maskOverlayUrl, setMaskOverlayUrl] = useState<string | null>(null);
  const [transformState, setTransformState] = useState<TransformState>({ scale: 1, positionX: 0, positionY: 0 });
  const imageContainerRef = useRef<HTMLImageElement>(null);
  const isInitialMount = useRef(true);
  const transformStateRef = useRef<TransformState>(transformState);
  transformStateRef.current = transformState;

  const isAnimating = useRef(false);
  const animationTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const currentUrl = maskOverlayUrl;
    return () => {
      if (currentUrl && currentUrl.startsWith('blob:')) {
        URL.revokeObjectURL(currentUrl);
      }
    };
  }, [maskOverlayUrl]);

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
    (_, state: TransformState) => {
      setTransformState(state);

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
  }, [finalPreviewUrl, setShowOriginal]);

  const isCropping = activeRightPanel === Panel.Crop;
  const isMasking = activeRightPanel === Panel.Masks;
  const isAiEditing = activeRightPanel === Panel.Ai;

  const hasDisplayableImage = finalPreviewUrl || selectedImage.originalUrl || selectedImage.thumbnailUrl;
  const showSpinner = isLoading && !hasDisplayableImage;

  const croppedDimensions = useMemo<ImageDimensions | null>(() => {
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

    const scaleFor100Percent = 1 / imageRenderSize.scale;

    const minScale = 0.1 * scaleFor100Percent;
    const maxScale = 2.0 * scaleFor100Percent;

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
      };
      onDisplaySizeChange(currentDisplaySize);
    }
  }, [imageRenderSize, transformState.scale, onDisplaySizeChange]);

  useEffect(() => {
    if (onInitialFitScale && imageRenderSize.scale > 0) {
      onInitialFitScale(imageRenderSize.scale);
    }
  }, [imageRenderSize.scale, onInitialFitScale]);

  const debouncedGenerateMaskOverlay = useCallback(
    debounce(async (maskDef, renderSize) => {
      if (!maskDef || !maskDef.visible || renderSize.width === 0) {
        setMaskOverlayUrl(null);
        return;
      }
      try {
        const cropOffset = [adjustments.crop?.x || 0, adjustments.crop?.y || 0];
        const dataUrl: string = await invoke(Invokes.GenerateMaskOverlay, {
          cropOffset,
          height: Math.round(renderSize.height),
          maskDef,
          scale: renderSize.scale,
          width: Math.round(renderSize.width),
        });
        if (dataUrl) {
          setMaskOverlayUrl(dataUrl);
        } else {
          setMaskOverlayUrl(null);
        }
      } catch (e) {
        console.error('Failed to generate mask overlay:', e);
        setMaskOverlayUrl(null);
      }
    }, 100),
    [adjustments.crop],
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

    debouncedGenerateMaskOverlay(maskDefForOverlay, imageRenderSize);

    return () => debouncedGenerateMaskOverlay.cancel();
  }, [
    activeRightPanel,
    activeMaskContainerId,
    activeAiPatchContainerId,
    adjustments.masks,
    adjustments.aiPatches,
    imageRenderSize,
    debouncedGenerateMaskOverlay,
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

    const { rotation = 0, aspectRatio, orientationSteps = 0, crop } = adjustments;

    const needsRecalc =
      crop === null ||
      prevCropParams.current?.rotation !== rotation ||
      prevCropParams.current?.aspectRatio !== aspectRatio ||
      prevCropParams.current?.orientationSteps !== orientationSteps;

    if (needsRecalc) {
      const { width: imgWidth, height: imgHeight } = selectedImage;
      const isSwapped = orientationSteps === 1 || orientationSteps === 3;
      const W = isSwapped ? imgHeight : imgWidth;
      const H = isSwapped ? imgWidth : imgHeight;
      const A = aspectRatio || W / H;
      if (isNaN(A) || A <= 0) {
        return;
      }

      const angle = Math.abs(rotation);
      const rad = ((angle % 180) * Math.PI) / 180;
      const sin = Math.sin(rad);
      const cos = Math.cos(rad);

      const h_c = Math.min(H / (A * sin + cos), W / (A * cos + sin));
      const w_c = A * h_c;

      const maxPixelCrop = {
        x: Math.round((W - w_c) / 2),
        y: Math.round((H - h_c) / 2),
        width: Math.round(w_c),
        height: Math.round(h_c),
      };

      prevCropParams.current = { rotation, aspectRatio, orientationSteps };
      if (JSON.stringify(crop) !== JSON.stringify(maxPixelCrop)) {
        setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, crop: maxPixelCrop }));
      }
    }
  }, [
    adjustments.aspectRatio,
    adjustments.crop,
    adjustments.orientationSteps,
    adjustments.rotation,
    isCropping,
    selectedImage,
    setAdjustments,
  ]);

  useEffect(() => {
    if (!isCropping || !selectedImage?.width) {
      setCrop(null);
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
  }, [isCropping, adjustments.crop, adjustments.orientationSteps, selectedImage]);

  const handleCropChange = useCallback((pixelCrop: Crop, percentCrop: PercentCrop) => {
    setCrop(percentCrop);
  }, []);

  const handleCropComplete = useCallback(
    (_: any, pc: PercentCrop) => {
      if (!pc.width || !pc.height || !selectedImage?.width) {
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
    [selectedImage, adjustments.orientationSteps, setAdjustments],
  );

  const toggleShowOriginal = useCallback(() => setShowOriginal((prev: boolean) => !prev), [setShowOriginal]);

  const doubleClickProps: any = useMemo(() => {
    if (isCropping || isMasking || isAiEditing) {
      return {
        disabled: true,
      };
    }
    return {
      animationTime: 200,
      animationType: 'easeOut',
      mode: transformState.scale >= 2 ? 'reset' : 'zoomIn',
    };
  }, [isCropping, isMasking, isAiEditing, transformState.scale]);

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
    (isMasking && (activeSubMask?.type === Mask.Brush || activeSubMask?.type === Mask.AiSubject)) ||
    (isAiEditing &&
      (activeSubMask?.type === Mask.Brush ||
        activeSubMask?.type === Mask.AiSubject ||
        activeSubMask?.type === Mask.QuickEraser));

  const waveFormData: WaveformData = waveform || { blue: [], green: [], height: 0, luma: [], red: [], width: 0 };

  return (
    <>
      <FullScreenViewer
        isOpen={isFullScreen}
        onClose={onToggleFullScreen}
        onTransformChange={setTransformState}
        thumbnailUrl={thumbnails[selectedImage.path] || selectedImage.thumbnailUrl}
        transformState={transformState}
        url={fullScreenUrl}
      />

      <div className="flex-1 bg-bg-secondary rounded-lg flex flex-col relative overflow-hidden p-2 gap-2 min-h-0">
        <AnimatePresence>
          {isWaveformVisible && <Waveform waveformData={waveFormData} onClose={onCloseWaveform} />}
        </AnimatePresence>
        <EditorToolbar
          canRedo={canRedo}
          canUndo={canUndo}
          isFullScreenLoading={isFullScreenLoading}
          isLoading={isLoading}
          isWaveformVisible={isWaveformVisible}
          onBackToLibrary={onBackToLibrary}
          onRedo={onRedo}
          onToggleFullScreen={onToggleFullScreen}
          onToggleShowOriginal={toggleShowOriginal}
          onToggleWaveform={onToggleWaveform}
          onUndo={onUndo}
          selectedImage={selectedImage}
          showOriginal={showOriginal}
          isLoadingFullRes={isLoadingFullRes}
        />

        <div
          className="flex-1 relative overflow-hidden rounded-lg"
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
                isAdjusting={isAdjusting}
                isAiEditing={isAiEditing}
                isCropping={isCropping}
                isMaskControlHovered={isMaskControlHovered}
                isMasking={isMasking}
                isStraightenActive={isStraightenActive}
                maskOverlayUrl={maskOverlayUrl}
                onGenerateAiMask={onGenerateAiMask}
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
                fullResolutionUrl={fullResolutionUrl}
                isFullResolution={isFullResolution}
                isLoadingFullRes={isLoadingFullRes}
                isWbPickerActive={isWbPickerActive}
                onWbPicked={onWbPicked}
                setAdjustments={setAdjustments}
              />
            </TransformComponent>
          </TransformWrapper>
        </div>
      </div>
    </>
  );
}