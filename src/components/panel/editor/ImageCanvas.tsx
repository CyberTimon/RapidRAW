import { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import ReactCrop from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { Stage, Layer, Ellipse, Line, Transformer, Group, Circle, Rect } from 'react-konva';
import { PercentCrop, Crop } from 'react-image-crop';
import clsx from 'clsx';
import { Adjustments, AiPatch, Coord, MaskContainer } from '../../../utils/adjustments';
import { Mask, SubMask, SubMaskMode, ToolType } from '../right/Masks';
import { BrushSettings, SelectedImage } from '../../ui/AppProperties';
import { RenderSize } from '../../../hooks/useImageRenderSize';
import type { OverlayMode } from '../right/CropPanel';
import CompositionOverlays from './overlays/CompositionOverlays';

interface CursorPreview {
  visible: boolean;
  x: number;
  y: number;
}

interface DrawnLine {
  brushSize: number;
  feather?: number;
  points: Array<Coord>;
  tool: ToolType;
}

interface ImageCanvasProps {
  activeAiPatchContainerId: string | null;
  activeAiSubMaskId: string | null;
  activeMaskContainerId: string | null;
  activeMaskId: string | null;
  adjustments: Adjustments;
  brushSettings: BrushSettings | null;
  crop: Crop | null;
  finalPreviewUrl: string | null;
  handleCropComplete(c: Crop, cp: PercentCrop): void;
  imageRenderSize: RenderSize;
  isAiEditing: boolean;
  isCropping: boolean;
  isMaskControlHovered: boolean;
  isMasking: boolean;
  isStraightenActive: boolean;
  isRotationActive?: boolean;
  maskOverlayUrl: string | null;
  onGenerateAiMask(id: string | null, start: Coord, end: Coord): void;
  onQuickErase(subMaskId: string | null, startPoint: Coord, endpoint: Coord): void;
  onSelectAiSubMask(id: string | null): void;
  onSelectMask(id: string | null): void;
  onStraighten(val: number): void;
  selectedImage: SelectedImage;
  setCrop(crop: Crop, perfentCrop: PercentCrop): void;
  setIsMaskHovered(isHovered: boolean): void;
  showOriginal: boolean;
  transformedOriginalUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  updateSubMask(id: string | null, subMask: Partial<SubMask>): void;
  fullResolutionUrl?: string | null;
  isFullResolution?: boolean;
  isLoadingFullRes?: boolean;
  isWbPickerActive?: boolean;
  onWbPicked?: () => void;
  setAdjustments(fn: (prev: Adjustments) => Adjustments): void;
  overlayMode?: OverlayMode;
  overlayRotation?: number;
  cursorStyle: string;
}

interface ImageLayer {
  id: string;
  opacity: number;
  url: string | null;
}

interface MaskOverlay {
  adjustments: Adjustments;
  imageHeight: number;
  imageWidth: number;
  isToolActive: boolean;
  isSelected: boolean;
  onMaskMouseEnter(): void;
  onMaskMouseLeave(): void;
  onSelect(): void;
  onUpdate(id: string, subMask: Partial<SubMask>): void;
  scale: number;
  subMask: SubMask;
}

const MaskOverlay = memo(
  ({
     adjustments,
     imageHeight,
     imageWidth,
     isToolActive,
     isSelected,
     onMaskMouseEnter,
     onMaskMouseLeave,
     onSelect,
     onUpdate,
     scale,
     subMask,
   }: MaskOverlay) => {
    const shapeRef = useRef<any>(null);
    const trRef = useRef<any>(null);

    const crop = adjustments.crop;
    const isPercent = crop?.unit === '%';
    const cropX = crop ? (isPercent ? (crop.x / 100) * imageWidth : crop.x) : 0;
    const cropY = crop ? (isPercent ? (crop.y / 100) * imageHeight : crop.y) : 0;
    const cropW = crop ? (isPercent ? (crop.width / 100) * imageWidth : crop.width) : imageWidth;
    const cropH = crop ? (isPercent ? (crop.height / 100) * imageHeight : crop.height) : imageHeight;

    const handleSelect = isToolActive ? undefined : onSelect;

    useEffect(() => {
      if (isSelected && trRef.current && shapeRef.current) {
        trRef.current?.nodes([shapeRef.current]);
        trRef.current?.getLayer().batchDraw();
      }
    }, [isSelected]);

    const handleRadialTransform = useCallback(() => {
      const node = shapeRef.current;
      if (!node) return;

      const scaleX = Math.abs(node.scaleX());
      const scaleY = Math.abs(node.scaleY());

      if (node.radiusX() * scaleX < 5 || node.radiusY() * scaleY < 5) {
        node.scaleX(node.lastValidScaleX || 1);
        node.scaleY(node.lastValidScaleY || 1);
      } else {
        node.lastValidScaleX = scaleX;
        node.lastValidScaleY = scaleY;
      }
    }, []);

    const handleRadialTransformEnd = useCallback(() => {
      const node = shapeRef.current;
      if (!node) return;

      const scaleX = node.scaleX();
      const scaleY = node.scaleY();

      const newRadiusX = (node.radiusX() * scaleX) / scale;
      const newRadiusY = (node.radiusY() * scaleY) / scale;

      node.scaleX(1);
      node.scaleY(1);

      onUpdate(subMask.id, {
        parameters: {
          ...subMask.parameters,
          centerX: node.x() / scale + cropX,
          centerY: node.y() / scale + cropY,
          radiusX: newRadiusX,
          radiusY: newRadiusY,
          rotation: node.rotation(),
        },
      });
    }, [subMask.id, subMask.parameters, onUpdate, scale, cropX, cropY]);

    const handleRadialDragEnd = useCallback((e: any) => {
      onUpdate(subMask.id, {
        parameters: {
          ...subMask.parameters,
          centerX: e.target.x() / scale + cropX,
          centerY: e.target.y() / scale + cropY,
        },
      });
    }, [subMask.id, subMask.parameters, onUpdate, scale, cropX, cropY]);

    const handleGroupDragEnd = (e: any) => {
      const group = e.target;
      const { startX, startY, endX, endY } = subMask.parameters;
      const dx = endX - startX;
      const dy = endY - startY;
      const centerX = startX + dx / 2;
      const centerY = startY + dy / 2;
      const groupX = (centerX - cropX) * scale;
      const groupY = (centerY - cropY) * scale;
      const moveX = group.x() - groupX;
      const moveY = group.y() - groupY;
      onUpdate(subMask.id, {
        parameters: {
          ...subMask.parameters,
          startX: startX + moveX / scale,
          startY: startY + moveY / scale,
          endX: endX + moveX / scale,
          endY: endY + moveY / scale,
        },
      });
    };

    const handlePointDrag = (e: any, point: string) => {
      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();
      if (!pointerPos) {
        return;
      }

      const newX = pointerPos.x / scale + cropX;
      const newY = pointerPos.y / scale + cropY;

      const newParams = { ...subMask.parameters };
      if (point === 'start') {
        newParams.startX = newX;
        newParams.startY = newY;
      } else {
        newParams.endX = newX;
        newParams.endY = newY;
      }
      onUpdate(subMask.id, { parameters: newParams });
    };

    const handleRangeDrag = (e: any) => {
      const newRange = Math.abs(e.target.y() / scale);
      onUpdate(subMask.id, {
        parameters: { ...subMask.parameters, range: newRange },
      });
    };

    if (!subMask.visible) {
      return null;
    }

    const commonProps = {
      dash: [4, 4],
      onClick: handleSelect,
      onTap: handleSelect,
      opacity: isSelected ? 1 : 0.7,
      stroke: isSelected ? '#0ea5e9' : subMask.mode === SubMaskMode.Subtractive ? '#f43f5e' : 'white',
      strokeScaleEnabled: false,
      strokeWidth: isSelected ? 3 : 2,
    };

    if (subMask.type === Mask.AiSubject) {
      const { startX, startY, endX, endY } = subMask.parameters;
      if (endX > startX && endY > startY) {
        return (
          <Rect
            height={(endY - startY) * scale}
            onMouseEnter={onMaskMouseEnter}
            onMouseLeave={onMaskMouseLeave}
            width={(endX - startX) * scale}
            x={(startX - cropX) * scale}
            y={(startY - cropY) * scale}
            {...commonProps}
          />
        );
      }
      return null;
    }

    if (subMask.type === Mask.Brush) {
      const { lines = [] } = subMask.parameters;
      return (
        <Group onClick={handleSelect} onTap={handleSelect}>
          {lines.map((line: DrawnLine, i: number) => (
            <Line
              hitStrokeWidth={line.brushSize * scale}
              key={i}
              lineCap="round"
              lineJoin="round"
              points={line.points.flatMap((p: Coord) => [(p.x - cropX) * scale, (p.y - cropY) * scale])}
              stroke="transparent"
              strokeScaleEnabled={false}
              tension={0.5}
            />
          ))}
        </Group>
      );
    }

    if (subMask.type === Mask.Radial) {
      const { centerX, centerY, radiusX, radiusY, rotation } = subMask.parameters;
      return (
        <>
          <Ellipse
            {...commonProps}
            ref={shapeRef}
            draggable={!isToolActive}
            onDragEnd={handleRadialDragEnd}
            onTransform={handleRadialTransform}
            onTransformEnd={handleRadialTransformEnd}
            onMouseEnter={onMaskMouseEnter}
            onMouseLeave={onMaskMouseLeave}
            radiusX={radiusX * scale}
            radiusY={radiusY * scale}
            rotation={rotation}
            x={(centerX - cropX) * scale}
            y={(centerY - cropY) * scale}
          />
          {isSelected && (
            <Transformer
              ref={trRef}
              centeredScaling={true}
              rotateEnabled={true}
              enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center', 'middle-left', 'middle-right']}
              onMouseDown={(e) => {
                e.cancelBubble = true;
                e.evt.preventDefault();
              }}
              boundBoxFunc={(oldBox, newBox) => {
                if (Math.abs(newBox.width) < 5 || Math.abs(newBox.height) < 5) {
                  return oldBox;
                }
                return newBox;
              }}
              onMouseEnter={onMaskMouseEnter}
              onMouseLeave={onMaskMouseLeave}
            />
          )}
        </>
      );
    }

    if (subMask.type === Mask.Linear) {
      const defaultRange = Math.min(cropW, cropH) * 0.1;

      const { startX, startY, endX, endY, range = defaultRange } = subMask.parameters;
      const dx = endX - startX;
      const dy = endY - startY;
      const len = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);
      const centerX = startX + dx / 2;
      const centerY = startY + dy / 2;
      const groupX = (centerX - cropX) * scale;
      const groupY = (centerY - cropY) * scale;
      const scaledLen = len * scale;
      const r = range * scale;

      const lineProps = {
        ...commonProps,
        strokeWidth: isSelected ? 2.5 : 2,
        dash: [6, 6],
        hitStrokeWidth: 20,
      };

      const perpendicularDragBoundFunc = function(pos: any) {
        const group = this.getParent();
        const transform = group.getAbsoluteTransform().copy();
        transform.invert();
        const localPos = transform.point(pos);
        const constrainedLocalPos = { x: 0, y: localPos.y };
        return group.getAbsoluteTransform().point(constrainedLocalPos);
      };

      return (
        <Group
          draggable={isSelected}
          onClick={handleSelect}
          onDragEnd={handleGroupDragEnd}
          onMouseEnter={(e: any) => {
            onMaskMouseEnter();
            const stage = e.target.getStage();
            if (stage) {
              stage.container().style.cursor = 'move';
            }
          }}
          onMouseLeave={(e: any) => {
            onMaskMouseLeave();
            const stage = e.target.getStage();
            if (stage) {
              stage.container().style.cursor = 'default';
            }
          }}
          onTap={handleSelect}
          rotation={(angle * 180) / Math.PI}
          x={groupX}
          y={groupY}
        >
          <Line points={[-5000, 0, 5000, 0]} {...lineProps} dash={[2, 3]} />
          <Line
            {...lineProps}
            dragBoundFunc={perpendicularDragBoundFunc}
            draggable={isSelected}
            onDragMove={handleRangeDrag}
            onDragEnd={(e: any) => {
              handleRangeDrag(e);
              e.cancelBubble = true;
            }}
            onMouseEnter={(e: any) => {
              e.target.getStage().container().style.cursor = 'row-resize';
              onMaskMouseEnter();
            }}
            onMouseLeave={(e: any) => {
              e.target.getStage().container().style.cursor = 'move';
              onMaskMouseEnter();
            }}
            points={[-scaledLen / 2, 0, scaledLen / 2, 0]}
            y={-r}
          />
          <Line
            {...lineProps}
            draggable={isSelected}
            dragBoundFunc={perpendicularDragBoundFunc}
            onDragEnd={(e: any) => {
              handleRangeDrag(e);
              e.cancelBubble = true;
            }}
            onDragMove={handleRangeDrag}
            onMouseEnter={(e: any) => {
              e.target.getStage().container().style.cursor = 'row-resize';
              onMaskMouseEnter();
            }}
            onMouseLeave={(e: any) => {
              e.target.getStage().container().style.cursor = 'move';
              onMaskMouseEnter();
            }}
            points={[-scaledLen / 2, 0, scaledLen / 2, 0]}
            y={r}
          />
          {isSelected && (
            <>
              <Circle
                draggable
                fill="#0ea5e9"
                onDragEnd={(e: any) => {
                  handlePointDrag(e, 'start');
                  e.cancelBubble = true;
                }}
                onDragMove={(e: any) => handlePointDrag(e, 'start')}
                onMouseEnter={(e: any) => {
                  e.target.getStage().container().style.cursor = 'grab';
                  onMaskMouseEnter();
                }}
                onMouseLeave={(e: any) => {
                  e.target.getStage().container().style.cursor = 'move';
                  onMaskMouseEnter();
                }}
                radius={8}
                stroke="white"
                strokeWidth={2}
                x={-scaledLen / 2}
                y={0}
              />
              <Circle
                draggable
                fill="#0ea5e9"
                onDragEnd={(e: any) => {
                  handlePointDrag(e, 'end');
                  e.cancelBubble = true;
                }}
                onDragMove={(e: any) => handlePointDrag(e, 'end')}
                onMouseEnter={(e: any) => {
                  e.target.getStage().container().style.cursor = 'grab';
                  onMaskMouseEnter();
                }}
                onMouseLeave={(e: any) => {
                  e.target.getStage().container().style.cursor = 'move';
                  onMaskMouseEnter();
                }}
                radius={8}
                stroke="white"
                strokeWidth={2}
                x={scaledLen / 2}
                y={0}
              />
            </>
          )}
        </Group>
      );
    }
    return null;
  },
);

const ImageCanvas = memo(
  ({
    activeAiPatchContainerId,
    activeAiSubMaskId,
    activeMaskContainerId,
    activeMaskId,
    adjustments,
    brushSettings,
    crop,
    finalPreviewUrl,
    handleCropComplete,
    imageRenderSize,
    isAiEditing,
    isCropping,
    isMaskControlHovered,
    isMasking,
    isStraightenActive,
    isRotationActive,
    maskOverlayUrl,
    onGenerateAiMask,
    onQuickErase,
    onSelectAiSubMask,
    onSelectMask,
    onStraighten,
    selectedImage,
    setCrop,
    setIsMaskHovered,
    showOriginal,
    transformedOriginalUrl,
    uncroppedAdjustedPreviewUrl,
    updateSubMask,
    fullResolutionUrl,
    isFullResolution,
    isLoadingFullRes,
    isWbPickerActive = false,
    onWbPicked,
    setAdjustments,
    overlayRotation,
    overlayMode,
    cursorStyle
  }: ImageCanvasProps) => {
    const [isCropViewVisible, setIsCropViewVisible] = useState(false);
    const [layers, setLayers] = useState<Array<ImageLayer>>([]);
    const cropImageRef = useRef<HTMLImageElement>(null);
    const imagePathRef = useRef<string | null>(null);
    const latestEditedUrlRef = useRef<string | null>(null);
    const [displayedMaskUrl, setDisplayedMaskUrl] = useState<string | null>(null);
    const [maskOpacity, setMaskOpacity] = useState(0);

    const isDrawing = useRef(false);
    const drawingStageRef = useRef<any>(null);
    const lastBrushPoint = useRef<Coord | null>(null);
    const currentLine = useRef<DrawnLine | null>(null);
    const [previewLine, setPreviewLine] = useState<DrawnLine | null>(null);
    const [cursorPreview, setCursorPreview] = useState<CursorPreview>({ x: 0, y: 0, visible: false });
    const [straightenLine, setStraightenLine] = useState<any>(null);
    const isStraightening = useRef(false);

    const activeContainer = useMemo(() => {
      if (isMasking) {
        return adjustments.masks.find((c: MaskContainer) => c.id === activeMaskContainerId);
      }
      if (isAiEditing) {
        return adjustments.aiPatches.find((p: AiPatch) => p.id === activeAiPatchContainerId);
      }
      return null;
    }, [
      adjustments.masks,
      adjustments.aiPatches,
      activeMaskContainerId,
      activeAiPatchContainerId,
      isMasking,
      isAiEditing,
    ]);

    const activeSubMask = useMemo(() => {
      if (!activeContainer) {
        return null;
      }
      if (isMasking) {
        return activeContainer.subMasks.find((m: SubMask) => m.id === activeMaskId);
      }
      if (isAiEditing) {
        return activeContainer.subMasks.find((m: SubMask) => m.id === activeAiSubMaskId);
      }
      return null;
    }, [activeContainer, activeMaskId, activeAiSubMaskId, isMasking, isAiEditing]);

    const effectiveImageDimensions = useMemo(() => {
      const steps = adjustments.orientationSteps || 0;
      const w = selectedImage.width || 0;
      const h = selectedImage.height || 0;
      if (steps === 1 || steps === 3) {
        return { width: h, height: w };
      }
      return { width: w, height: h };
    }, [selectedImage.width, selectedImage.height, adjustments.orientationSteps]);

    const isBrushActive = (isMasking || isAiEditing) && activeSubMask?.type === Mask.Brush;
    const isAiSubjectActive =
      (isMasking || isAiEditing) &&
      (activeSubMask?.type === Mask.AiSubject || activeSubMask?.type === Mask.QuickEraser);
    const isToolActive = isBrushActive || isAiSubjectActive;

    useEffect(() => {
      if (maskOverlayUrl && (isMasking || isAiEditing)) {
        setDisplayedMaskUrl(maskOverlayUrl);
        requestAnimationFrame(() => {
          setMaskOpacity(1);
        });
      } else {
        setMaskOpacity(0);
      }
    }, [maskOverlayUrl, isMasking, isAiEditing]);

    const handleMaskTransitionEnd = useCallback(() => {
      if (maskOpacity === 0) {
        setDisplayedMaskUrl(null);
      }
    }, [maskOpacity]);


    useEffect(() => {
      if (isToolActive) {
        return;
      }
      isDrawing.current = false;
      drawingStageRef.current = null;
      currentLine.current = null;
      lastBrushPoint.current = null;
      setPreviewLine(null);
    }, [isToolActive]);

    const sortedSubMasks = useMemo(() => {
      if (!activeContainer) {
        return [];
      }
      const activeId = isMasking ? activeMaskId : activeAiSubMaskId;
      const selectedMask = activeContainer.subMasks.find((m: SubMask) => m.id === activeId);
      const otherMasks = activeContainer.subMasks.filter((m: SubMask) => m.id !== activeId);
      return selectedMask ? [...otherMasks, selectedMask] : activeContainer.subMasks;
    }, [activeContainer, activeMaskId, activeAiSubMaskId, isMasking, isAiEditing]);

    useEffect(() => {
      const { path: currentImagePath, originalUrl, thumbnailUrl } = selectedImage;
      const imageChanged = currentImagePath !== imagePathRef.current;

      const currentPreviewUrl = showOriginal
        ? transformedOriginalUrl
        : isFullResolution && !isLoadingFullRes && fullResolutionUrl
          ? fullResolutionUrl
          : finalPreviewUrl;

      if (imageChanged) {
        imagePathRef.current = currentImagePath;
        latestEditedUrlRef.current = null;
        const initialUrl = thumbnailUrl || originalUrl;
        setLayers(initialUrl ? [{ id: initialUrl, url: initialUrl, opacity: 1 }] : []);
        return;
      }

      if (currentPreviewUrl && currentPreviewUrl !== latestEditedUrlRef.current) {
        latestEditedUrlRef.current = currentPreviewUrl;
        const img = new Image();
        img.src = currentPreviewUrl;
        img.onload = () => {
          if (img.src === latestEditedUrlRef.current) {
            setLayers((prev) => {
              if (prev.some((l) => l.id === img.src)) {
                return prev;
              }
              return [...prev, { id: img.src, url: img.src, opacity: 0 }];
            });
          }
        };
        return () => {
          img.onload = null;
        };
      }

      if (!currentPreviewUrl) {
        const initialUrl = originalUrl || thumbnailUrl;
        if (initialUrl && initialUrl !== latestEditedUrlRef.current) {
          latestEditedUrlRef.current = initialUrl;
          setLayers((prev) => {
            if (prev.length === 0) {
              return [{ id: initialUrl, url: initialUrl, opacity: 1 }];
            }
            return prev;
          });
        }
      }
    }, [
      selectedImage,
      finalPreviewUrl,
      fullResolutionUrl,
      transformedOriginalUrl,
      showOriginal,
      isFullResolution,
      isLoadingFullRes,
    ]);

    useEffect(() => {
      const layerToFadeIn = layers.find((l: ImageLayer) => l.opacity === 0);
      if (layerToFadeIn) {
        const frame = requestAnimationFrame(() => {
          setLayers((prev: Array<ImageLayer>) =>
            prev.map((l: ImageLayer) => (l.id === layerToFadeIn.id ? { ...l, opacity: 1 } : l)),
          );
        });
        return () => cancelAnimationFrame(frame);
      }
    }, [layers]);

    const handleTransitionEnd = useCallback((finishedId: string) => {
      setLayers((prev: Array<ImageLayer>) => {
        const finishedIndex = prev.findIndex((l) => l.id === finishedId);
        if (finishedIndex < 0 || prev.length <= 1) {
          return prev;
        }
        return prev.slice(finishedIndex);
      });
    }, []);

    useEffect(() => {
      if (isCropping && uncroppedAdjustedPreviewUrl) {
        const timer = setTimeout(() => setIsCropViewVisible(true), 10);
        return () => clearTimeout(timer);
      } else {
        setIsCropViewVisible(false);
      }
    }, [isCropping, uncroppedAdjustedPreviewUrl]);

    const handleWbClick = useCallback((e: any) => {
      if (!isWbPickerActive || !finalPreviewUrl || !onWbPicked) return;

      const stage = e.target.getStage();
      const pointerPos = stage.getPointerPosition();
      if (!pointerPos) return;

      const x = pointerPos.x / imageRenderSize.scale;
      const y = pointerPos.y / imageRenderSize.scale;

      const imgLogicalWidth = imageRenderSize.width / imageRenderSize.scale;
      const imgLogicalHeight = imageRenderSize.height / imageRenderSize.scale;

      if (x < 0 || x > imgLogicalWidth || y < 0 || y > imgLogicalHeight) return;

      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.src = finalPreviewUrl;

      img.onload = () => {
        const radius = 5;
        const side = radius * 2 + 1;

        const canvas = document.createElement('canvas');
        canvas.width = side;
        canvas.height = side;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        const scaleX = img.width / imgLogicalWidth;
        const scaleY = img.height / imgLogicalHeight;
        const srcX = Math.floor(x * scaleX);
        const srcY = Math.floor(y * scaleY);

        const startX = Math.max(0, srcX - radius);
        const startY = Math.max(0, srcY - radius);
        const endX = Math.min(img.width, srcX + radius + 1);
        const endY = Math.min(img.height, srcY + radius + 1);
        const sw = endX - startX;
        const sh = endY - startY;

        if (sw <= 0 || sh <= 0) return;

        ctx.drawImage(img, startX, startY, sw, sh, 0, 0, sw, sh);

        const imageData = ctx.getImageData(0, 0, sw, sh);
        const data = imageData.data;

        let rTotal = 0, gTotal = 0, bTotal = 0;
        let count = 0;

        for (let i = 0; i < data.length; i += 4) {
          rTotal += data[i];
          gTotal += data[i + 1];
          bTotal += data[i + 2];
          count++;
        }

        if (count === 0) return;

        const avgR = rTotal / count;
        const avgG = gTotal / count;
        const avgB = bTotal / count;

        const linR = Math.pow(avgR / 255.0, 2.2);
        const linG = Math.pow(avgG / 255.0, 2.2);
        const linB = Math.pow(avgB / 255.0, 2.2);

        const sumRB = linR + linB;
        const deltaTemp = sumRB > 0.0001 ? ((linB - linR) / sumRB) * 125.0 : 0;

        const linM = sumRB / 2.0;
        const sumGM = linG + linM;
        const deltaTint = sumGM > 0.0001 ? ((linG - linM) / sumGM) * 400.0 : 0;

        setAdjustments((prev: Adjustments) => ({
          ...prev,
          temperature: Math.max(-100, Math.min(100, (prev.temperature || 0) + deltaTemp)),
          tint: Math.max(-100, Math.min(100, (prev.tint || 0) + deltaTint)),
        }));

        onWbPicked();
      };
    }, [isWbPickerActive, finalPreviewUrl, imageRenderSize, onWbPicked, setAdjustments]);

    const handleMouseDown = useCallback(
      (e: any) => {
        e.evt.preventDefault();

        if (isWbPickerActive) {
          handleWbClick(e);
          return;
        }

        if (isToolActive) {
          const stage = e.target.getStage();
          const pos = stage.getPointerPosition();
          if (!pos) {
            isDrawing.current = false;
            currentLine.current = null;
            setPreviewLine(null);
            return;
          }

          const toolType = isAiSubjectActive ? ToolType.AiSeletor : ToolType.Brush;
          const isShiftClick = isBrushActive && e.evt.shiftKey && lastBrushPoint.current;

          if (isShiftClick) {
            const { scale } = imageRenderSize;
            const crop = adjustments.crop;
            const isPercent = crop?.unit === '%';
            const cropX = crop ? (isPercent ? (crop.x / 100) * effectiveImageDimensions.width : crop.x) : 0;
            const cropY = crop ? (isPercent ? (crop.y / 100) * effectiveImageDimensions.height : crop.y) : 0;

            const startImageSpace = lastBrushPoint.current!;
            const endImageSpace = {
              x: pos.x / scale + cropX,
              y: pos.y / scale + cropY,
            };

            const dx = endImageSpace.x - startImageSpace.x;
            const dy = endImageSpace.y - startImageSpace.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const steps = Math.max(Math.ceil(distance), 2);
            const interpolatedPoints: Coord[] = [];
            for (let i = 0; i <= steps; i++) {
              const t = i / steps;
              interpolatedPoints.push({
                x: startImageSpace.x + dx * t,
                y: startImageSpace.y + dy * t,
              });
            }

            const imageSpaceLine: DrawnLine = {
              brushSize: (brushSettings?.size ?? 0) / scale,
              feather: brushSettings?.feather ? brushSettings?.feather / 100 : 0,
              points: interpolatedPoints,
              tool: brushSettings?.tool ?? ToolType.Brush,
            };

            const activeId = isMasking ? activeMaskId : activeAiSubMaskId;
            const existingLines = activeSubMask?.parameters?.lines || [];

            updateSubMask(activeId, {
              parameters: {
                ...activeSubMask?.parameters,
                lines: [...existingLines, imageSpaceLine],
              },
            });

            lastBrushPoint.current = endImageSpace;

            const screenPoints = interpolatedPoints.map((p) => ({
              x: (p.x - cropX) * scale,
              y: (p.y - cropY) * scale,
            }));
            const previewDrwnLine: DrawnLine = {
              brushSize: brushSettings?.size ?? 0,
              points: screenPoints,
              tool: brushSettings?.tool ?? ToolType.Brush,
            };
            setPreviewLine(previewDrwnLine);
            setTimeout(() => setPreviewLine(null), 50);

            isDrawing.current = false;
            currentLine.current = null;
            return;
          }

          isDrawing.current = true;
          drawingStageRef.current = stage;

          const newLine: DrawnLine = {
            brushSize: isBrushActive && brushSettings?.size ? brushSettings.size : 2,
            points: [pos],
            tool: toolType,
          };
          currentLine.current = newLine;
          setPreviewLine(newLine);
        } else {
          if (e.target === e.target.getStage()) {
            if (isMasking) {
              onSelectMask(null);
            }
            if (isAiEditing) {
              onSelectAiSubMask(null);
            }
          }
        }
      },
      [isWbPickerActive, handleWbClick, isBrushActive, isAiSubjectActive, brushSettings, onSelectMask, onSelectAiSubMask, isMasking, isAiEditing, imageRenderSize, adjustments.crop, activeMaskId, activeAiSubMaskId, activeSubMask, updateSubMask, effectiveImageDimensions],
    );

    const handleMouseMove = useCallback(
      (e: any) => {
        if (isWbPickerActive) {
          return;
        }

        let pos;
        if (e && typeof e.target?.getStage === 'function') {
          const stage = e.target.getStage();
          pos = stage.getPointerPosition();
        } else if (e && e.clientX != null && e.clientY != null) {
          const stage = drawingStageRef.current;
          if (stage) {
            stage.setPointersPositions(e);
            pos = stage.getPointerPosition();
          }
        }

        if (isToolActive) {
          if (pos) {
            setCursorPreview({ x: pos.x, y: pos.y, visible: true });
          } else {
            setCursorPreview((p: CursorPreview) => ({ ...p, visible: false }));
          }
        }

        if (!isDrawing.current || !isToolActive) {
          return;
        }

        if (!pos) {
          return;
        }

        if (currentLine.current) {
          const updatedLine = {
            ...currentLine.current,
            points: [...currentLine.current.points, pos],
          };
          currentLine.current = updatedLine;
          setPreviewLine(updatedLine);
        }
      },
      [isToolActive, isWbPickerActive],
    );

    const handleMouseUp = useCallback(() => {
      if (!isDrawing.current || !currentLine.current) {
        return;
      }

      const wasDrawing = isDrawing.current;
      isDrawing.current = false;
      const line = currentLine.current;
      currentLine.current = null;
      setPreviewLine(null);
      drawingStageRef.current = null;

      if (!wasDrawing || !line) {
        return;
      }

      const { scale } = imageRenderSize;
      const crop = adjustments.crop;
      const isPercent = crop?.unit === '%';
      const cropX = crop ? (isPercent ? (crop.x / 100) * effectiveImageDimensions.width : crop.x) : 0;
      const cropY = crop ? (isPercent ? (crop.y / 100) * effectiveImageDimensions.height : crop.y) : 0;

      const activeId = isMasking ? activeMaskId : activeAiSubMaskId;

      if (activeSubMask?.type === Mask.AiSubject || activeSubMask?.type === Mask.QuickEraser) {
        const points = line.points;
        if (points.length > 1) {
          const xs = points.map((p: Coord) => p.x);
          const ys = points.map((p: Coord) => p.y);
          const minX = Math.min(...xs);
          const minY = Math.min(...ys);
          const maxX = Math.max(...xs);
          const maxY = Math.max(...ys);

          const startPoint = { x: minX / scale + cropX, y: minY / scale + cropY };
          const endPoint = { x: maxX / scale + cropX, y: maxY / scale + cropY };

          if (activeSubMask.type === Mask.QuickEraser && onQuickErase) {
            onQuickErase(activeId, startPoint, endPoint);
          } else if (activeSubMask.type === Mask.AiSubject && onGenerateAiMask) {
            onGenerateAiMask(activeId, startPoint, endPoint);
          }
        }
      } else if (isBrushActive) {
        const imageSpaceLine: DrawnLine = {
          brushSize: (brushSettings?.size ?? 0) / scale,
          feather: brushSettings?.feather ? brushSettings?.feather / 100 : 0,
          points: line.points.map((p: Coord) => ({
            x: p.x / scale + cropX,
            y: p.y / scale + cropY,
          })),
          tool: brushSettings?.tool ?? ToolType.Brush,
        };

        const existingLines = activeSubMask.parameters.lines || [];

        updateSubMask(activeId, {
          parameters: {
            ...activeSubMask.parameters,
            lines: [...existingLines, imageSpaceLine],
          },
        });

        const lastPoint = line.points[line.points.length - 1];
        if (lastPoint) {
          lastBrushPoint.current = {
            x: lastPoint.x / scale + cropX,
            y: lastPoint.y / scale + cropY,
          };
        }
      }
    }, [
      activeAiSubMaskId,
      activeMaskId,
      activeSubMask,
      adjustments.crop,
      brushSettings,
      imageRenderSize.scale,
      isAiEditing,
      isBrushActive,
      isMasking,
      onGenerateAiMask,
      onQuickErase,
      updateSubMask,
      effectiveImageDimensions
    ]);

    const handleMouseEnter = useCallback(() => {
      if (isToolActive) {
        setCursorPreview((p: CursorPreview) => ({ ...p, visible: true }));
      }
    }, [isToolActive]);

    const handleMouseLeave = useCallback(() => {
      setCursorPreview((p: CursorPreview) => ({ ...p, visible: false }));
    }, []);

    useEffect(() => {
      if (isToolActive) {
        setCursorPreview((p: CursorPreview) => ({ ...p, visible: false }));
      }
    }, [isToolActive]);

    useEffect(() => {
      if (!isToolActive) return;

      function onMove(e: MouseEvent) {
        if (!isDrawing.current) {
          return;
        }
        handleMouseMove(e);
      }

      function onUp() {
        if (!isDrawing.current) {
          return;
        }
        handleMouseUp();
      }

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
    }, [isToolActive, handleMouseMove, handleMouseUp]);

    const handleStraightenMouseDown = (e: any) => {
      if (e.evt.button !== 0) {
        return;
      }

      isStraightening.current = true;
      const pos = e.target.getStage().getPointerPosition();
      setStraightenLine({ start: pos, end: pos });
    };

    const handleStraightenMouseMove = (e: any) => {
      if (!isStraightening.current) {
        return;
      }

      const pos = e.target.getStage().getPointerPosition();
      setStraightenLine((prev: any) => ({ ...prev, end: pos }));
    };

    const handleStraightenMouseUp = () => {
      if (!isStraightening.current) {
        return;
      }
      isStraightening.current = false;
      if (
        !straightenLine ||
        (straightenLine.start.x === straightenLine.end.x && straightenLine.start.y === straightenLine.start.y)
      ) {
        setStraightenLine(null);
        return;
      }

      const { start, end } = straightenLine;
      const { rotation = 0 } = adjustments;
      const theta_rad = (rotation * Math.PI) / 180;
      const cos_t = Math.cos(theta_rad);
      const sin_t = Math.sin(theta_rad);
      const width = uncroppedImageRenderSize?.width ?? 0;
      const height = uncroppedImageRenderSize?.height ?? 0;
      const cx = width / 2;
      const cy = height / 2;

      const unrotate = (p: Coord) => {
        const x = p.x - cx;
        const y = p.y - cy;
        return {
          x: cx + x * cos_t + y * sin_t,
          y: cy - x * sin_t + y * cos_t,
        };
      };

      const start_unrotated = unrotate(start);
      const end_unrotated = unrotate(end);
      const dx = end_unrotated.x - start_unrotated.x;
      const dy = end_unrotated.y - start_unrotated.y;
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);
      let targetAngle;

      if (angle > -45 && angle <= 45) {
        targetAngle = 0;
      } else if (angle > 45 && angle <= 135) {
        targetAngle = 90;
      } else if (angle > 135 || angle <= -135) {
        targetAngle = 180;
      } else {
        targetAngle = -90;
      }

      let correction = targetAngle - angle;
      if (correction > 180) {
        correction -= 360;
      }
      if (correction < -180) {
        correction += 360;
      }

      onStraighten(correction);
      setStraightenLine(null);
    };

    const handleStraightenMouseLeave = () => {
      if (isStraightening.current) {
        isStraightening.current = false;
        setStraightenLine(null);
      }
    };

    const cropPreviewUrl = uncroppedAdjustedPreviewUrl || selectedImage.originalUrl;
    const isContentReady = layers.length > 0 && layers.some((l) => l.url);

    const uncroppedImageRenderSize = useMemo<Partial<RenderSize> | null>(() => {
      if (!selectedImage?.width || !selectedImage?.height || !imageRenderSize?.width || !imageRenderSize?.height) {
        return null;
      }

      const viewportWidth = imageRenderSize.width + 2 * imageRenderSize.offsetX;
      const viewportHeight = imageRenderSize.height + 2 * imageRenderSize.offsetY;

      let uncroppedEffectiveWidth = selectedImage.width;
      let uncroppedEffectiveHeight = selectedImage.height;
      const orientationSteps = adjustments.orientationSteps || 0;
      if (orientationSteps === 1 || orientationSteps === 3) {
        [uncroppedEffectiveWidth, uncroppedEffectiveHeight] = [uncroppedEffectiveHeight, uncroppedEffectiveWidth];
      }

      if (uncroppedEffectiveWidth <= 0 || uncroppedEffectiveHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
        return null;
      }

      const scale = Math.min(viewportWidth / uncroppedEffectiveWidth, viewportHeight / uncroppedEffectiveHeight);

      const renderWidth = uncroppedEffectiveWidth * scale;
      const renderHeight = uncroppedEffectiveHeight * scale;

      return { width: renderWidth, height: renderHeight };
    }, [selectedImage?.width, selectedImage?.height, imageRenderSize, adjustments.orientationSteps]);

    const cropImageTransforms = useMemo(() => {
      const transforms = [`rotate(${adjustments.rotation || 0}deg)`];
      return transforms.join(' ');
    }, [adjustments.rotation]);

    const getCropDimensions = () => {
      if (!crop || !uncroppedImageRenderSize?.width || !uncroppedImageRenderSize?.height) {
        return { width: 0, height: 0 };
      }

      const width = crop.unit === '%'
        ? uncroppedImageRenderSize.width * (crop.width / 100)
        : crop.width;

      const height = crop.unit === '%'
        ? uncroppedImageRenderSize.height * (crop.height / 100)
        : crop.height;

      return { width, height };
    };

    const effectiveCursor = useMemo(() => {
      if (isWbPickerActive) return 'crosshair';
      if (isBrushActive) return 'none';
      if (isAiSubjectActive) return 'crosshair';
      return cursorStyle;
    }, [isWbPickerActive, isBrushActive, isAiSubjectActive, cursorStyle]);

    return (
      <div className="relative" style={{ width: '100%', height: '100%' }}>
        <div
          className="absolute inset-0 w-full h-full transition-opacity duration-200 flex items-center justify-center"
          style={{
            opacity: isCropViewVisible ? 0 : 1,
            pointerEvents: isCropViewVisible ? 'none' : 'auto',
          }}
        >
          <div
            className="opacity-100"
            style={{
              height: '100%',
              opacity: isContentReady ? 1 : 0,
              position: 'relative',
              width: '100%',
            }}
          >
            <div className="absolute inset-0 w-full h-full">
              {layers.map((layer: ImageLayer) =>
                layer.url ? (
                  <img
                    alt=" "
                    className="absolute inset-0 w-full h-full object-contain"
                    key={layer.id}
                    onTransitionEnd={() => handleTransitionEnd(layer.id)}
                    src={layer.url}
                    style={{
                      opacity: layer.opacity,
                      transition: 'opacity 80ms linear',
                      willChange: 'opacity, transform',
                      imageRendering: 'high-quality',
                      WebkitImageRendering: 'high-quality',
                      transform: 'translateZ(0)',
                      backfaceVisibility: 'hidden',
                    }}
                  />
                ) : null,
              )}
              {displayedMaskUrl && (
                <img
                  alt="Mask Overlay"
                  className="absolute object-contain pointer-events-none"
                  src={displayedMaskUrl}
                  onTransitionEnd={handleMaskTransitionEnd}
                  style={{
                    height: `${imageRenderSize.height}px`,
                    left: `${imageRenderSize.offsetX}px`,
                    opacity: showOriginal || isMaskControlHovered ? 0 : maskOpacity,
                    top: `${imageRenderSize.offsetY}px`,
                    transition: 'opacity 200ms ease-in-out',
                    width: `${imageRenderSize.width}px`,
                  }}
                />
              )}
            </div>
          </div>

          <Stage
            height={imageRenderSize.height}
            onMouseDown={handleMouseDown}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            style={{
              cursor: effectiveCursor,
              left: `${imageRenderSize.offsetX}px`,
              opacity: showOriginal ? 0 : 1,
              pointerEvents: showOriginal ? 'none' : 'auto',
              position: 'absolute',
              top: `${imageRenderSize.offsetY}px`,
              zIndex: 4,
              touchAction: 'none',
              userSelect: 'none',
            }}
            width={imageRenderSize.width}
          >
            <Layer>
              {(isMasking || isAiEditing) &&
                activeContainer &&
                sortedSubMasks.map((subMask: SubMask) => (
                  <MaskOverlay
                    adjustments={adjustments}
                    imageHeight={effectiveImageDimensions.height}
                    imageWidth={effectiveImageDimensions.width}
                    isSelected={subMask.id === (isMasking ? activeMaskId : activeAiSubMaskId)}
                    isToolActive={isToolActive}
                    key={subMask.id}
                    onMaskMouseEnter={() => !isToolActive && setIsMaskHovered(true)}
                    onMaskMouseLeave={() => !isToolActive && setIsMaskHovered(false)}
                    onSelect={() => (isMasking ? onSelectMask(subMask.id) : onSelectAiSubMask(subMask.id))}
                    onUpdate={updateSubMask}
                    scale={imageRenderSize.scale}
                    subMask={subMask}
                  />
                ))}
              {previewLine && (
                <Line
                  dash={previewLine.tool === ToolType.AiSeletor ? [4, 4] : undefined}
                  lineCap="round"
                  lineJoin="round"
                  listening={false}
                  opacity={0.8}
                  points={previewLine.points.flatMap((p: Coord) => [p.x, p.y])}
                  stroke={previewLine.tool === ToolType.Eraser ? '#f43f5e' : '#0ea5e9'}
                  strokeWidth={previewLine.tool === ToolType.AiSeletor ? 2 : previewLine.brushSize}
                  tension={0.5}
                />
              )}
              {isBrushActive && cursorPreview.visible && (
                <Circle
                  listening={false}
                  perfectDrawEnabled={false}
                  stroke={brushSettings?.tool === ToolType.Eraser ? '#f43f5e' : '#0ea5e9'}
                  radius={brushSettings?.size ? brushSettings.size / 2 : 0}
                  strokeWidth={1}
                  x={cursorPreview.x}
                  y={cursorPreview.y}
                />
              )}
            </Layer>
          </Stage>
        </div>

        <div
          className="absolute inset-0 w-full h-full flex items-center justify-center transition-opacity duration-200"
          style={{
            opacity: isCropViewVisible ? 1 : 0,
            pointerEvents: isCropViewVisible ? 'auto' : 'none',
          }}
        >
          {cropPreviewUrl && uncroppedImageRenderSize && (
            <div
              style={{
                height: uncroppedImageRenderSize.height,
                position: 'relative',
                width: uncroppedImageRenderSize.width,
              }}
            >
              <ReactCrop
                aspect={adjustments.aspectRatio}
                crop={crop}
                onChange={setCrop}
                onComplete={handleCropComplete}
                ruleOfThirds={false}
                renderSelectionAddon={() => {
                  const { width, height } = getCropDimensions();
                  if (width <= 0 || height <= 0) {
                    return null;
                  }
                  const showDenseGrid = isRotationActive && !isStraightenActive;
                  const currentOverlayMode =
                    isRotationActive || isStraightenActive ? 'none' : overlayMode || 'none';
                  return (
                    <CompositionOverlays
                      width={width}
                      height={height}
                      mode={currentOverlayMode}
                      rotation={overlayRotation || 0}
                      denseVisible={showDenseGrid}
                    />
                  );
                }}
              >
                <img
                  alt="Crop preview"
                  ref={cropImageRef}
                  src={cropPreviewUrl}
                  style={{
                    display: 'block',
                    width: `${uncroppedImageRenderSize.width}px`,
                    height: `${uncroppedImageRenderSize.height}px`,
                    objectFit: 'contain',
                    transform: cropImageTransforms,
                  }}
                />
              </ReactCrop>

              {isStraightenActive && (
                <Stage
                  height={uncroppedImageRenderSize.height}
                  onMouseDown={handleStraightenMouseDown}
                  onMouseLeave={handleStraightenMouseLeave}
                  onMouseMove={handleStraightenMouseMove}
                  onMouseUp={handleStraightenMouseUp}
                  style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, cursor: 'crosshair' }}
                  width={uncroppedImageRenderSize.width}
                >
                  <Layer>
                    {straightenLine && (
                      <Line
                        dash={[4, 4]}
                        listening={false}
                        points={[
                          straightenLine.start.x,
                          straightenLine.start.y,
                          straightenLine.end.x,
                          straightenLine.end.y,
                        ]}
                        stroke="#0ea5e9"
                        strokeWidth={2}
                      />
                    )}
                  </Layer>
                </Stage>
              )}
            </div>
          )}
        </div>
      </div>
    );
  },
);

export default ImageCanvas;