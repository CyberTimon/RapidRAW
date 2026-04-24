import { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import ReactCrop from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { Stage, Layer, Ellipse, Line, Transformer, Group, Circle, Rect } from 'react-konva';
import { PercentCrop, Crop } from 'react-image-crop';
import { Adjustments, AiPatch, Coord, MaskContainer } from '../../../utils/adjustments';
import { Mask, SubMask, SubMaskMode, ToolType } from '../right/Masks';
import { AppSettings, BrushSettings, SelectedImage } from '../../ui/AppProperties';
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
  flow?: number;
  points: Array<Coord>;
  tool: ToolType;
}

interface ImageCanvasProps {
  appSettings: AppSettings | null;
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
  isSliderDragging: boolean;
  isStraightenActive: boolean;
  isRotationActive?: boolean;
  maskOverlayUrl: string | null;
  onGenerateAiMask(id: string | null, start: Coord, end: Coord): void;
  onLiveMaskPreview?: (previewMaskDef: any) => void;
  onQuickErase(subMaskId: string | null, startPoint: Coord, endpoint: Coord): void;
  onSelectAiSubMask(id: string | null): void;
  onSelectMask(id: string | null): void;
  onStraighten(val: number): void;
  selectedImage: SelectedImage;
  setCrop(crop: Crop, perfentCrop: PercentCrop): void;
  setIsMaskHovered(isHovered: boolean): void;
  setIsMaskTouchInteracting(isInteracting: boolean): void;
  showOriginal: boolean;
  transformedOriginalUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  updateSubMask(id: string | null, subMask: Partial<SubMask>): void;
  interactivePatch?: { url: string; normX: number; normY: number; normW: number; normH: number } | null;
  isWbPickerActive?: boolean;
  onWbPicked?: () => void;
  setAdjustments(fn: (prev: Adjustments) => Adjustments): void;
  overlayMode?: OverlayMode;
  overlayRotation?: number;
  cursorStyle: string;
  isMaxZoom?: boolean;
  liveRotation?: number | null;
  zoomScale: number;
  hasRenderedFirstFrame: boolean;
}

interface MaskOverlay {
  adjustments: Adjustments;
  imageHeight: number;
  imageWidth: number;
  onMaskInteractionEnd(): void;
  onMaskInteractionStart(event?: any): void;
  isToolActive: boolean;
  isSelected: boolean;
  onMaskMouseEnter(): void;
  onMaskMouseLeave(): void;
  onPreviewUpdate?(id: string, subMask: Partial<SubMask>): void;
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
    onMaskInteractionEnd,
    onMaskInteractionStart,
    isToolActive,
    isSelected,
    onMaskMouseEnter,
    onMaskMouseLeave,
    onPreviewUpdate,
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

    const [p, setP] = useState(subMask.parameters);
    const pRef = useRef(p);
    const isDragging = useRef(false);

    const dragStartPointer = useRef<Coord | null>(null);
    const dragStartParams = useRef<any>(null);

    useEffect(() => {
      if (!isDragging.current) {
        setP(subMask.parameters);
        pRef.current = subMask.parameters;
      }
    }, [subMask.parameters]);

    const updateP = useCallback((newP: any) => {
      setP(newP);
      pRef.current = newP;
    }, []);

    const handleMaskTouchStart = useCallback(
      (e: any) => {
        onMaskInteractionStart(e);
        if (e.evt.cancelable) e.evt.preventDefault();
        e.evt.stopPropagation?.();
      },
      [onMaskInteractionStart],
    );

    const handleMaskTouchEnd = useCallback(() => {
      onMaskInteractionEnd();
    }, [onMaskInteractionEnd]);

    const handleSelect = isToolActive ? undefined : onSelect;

    useEffect(() => {
      if (isSelected && trRef.current && shapeRef.current) {
        trRef.current?.nodes([shapeRef.current]);
        trRef.current?.getLayer().batchDraw();
      }
    }, [isSelected, isToolActive]);

    const lockDragBoundFunc = useCallback(function (this: any) {
      return this.getAbsolutePosition();
    }, []);

    const handleRadialDragStart = useCallback(
      (e: any) => {
        isDragging.current = true;
        onMaskInteractionStart(e);
        dragStartPointer.current = e.target.getStage().getPointerPosition();
        dragStartParams.current = { ...pRef.current };
      },
      [onMaskInteractionStart],
    );

    const handleRadialDragMove = useCallback(
      (e: any) => {
        const pointerPos = e.target.getStage().getPointerPosition();
        if (!pointerPos || !dragStartPointer.current || !dragStartParams.current) return;

        const dx = (pointerPos.x - dragStartPointer.current.x) / scale;
        const dy = (pointerPos.y - dragStartPointer.current.y) / scale;

        const newP = {
          ...dragStartParams.current,
          centerX: dragStartParams.current.centerX + dx,
          centerY: dragStartParams.current.centerY + dy,
        };

        updateP(newP);
        if (onPreviewUpdate) onPreviewUpdate(subMask.id, { parameters: newP });
      },
      [scale, updateP, onPreviewUpdate, subMask.id],
    );

    const handleRadialDragEnd = useCallback(() => {
      isDragging.current = false;
      onMaskInteractionEnd();
      onUpdate(subMask.id, { parameters: pRef.current });
    }, [subMask.id, onMaskInteractionEnd, onUpdate]);

    const handleRadialTransformStart = useCallback(
      (e: any) => {
        isDragging.current = true;
        onMaskInteractionStart(e);
      },
      [onMaskInteractionStart],
    );

    const handleRadialTransform = useCallback(() => {
      const node = shapeRef.current;
      if (!node) return;

      const scaleX = Math.abs(node.scaleX());
      const scaleY = Math.abs(node.scaleY());

      if (pRef.current.radiusX * scaleX < 5 || pRef.current.radiusY * scaleY < 5) {
        node.scaleX(node.lastValidScaleX || 1);
        node.scaleY(node.lastValidScaleY || 1);
      } else {
        node.lastValidScaleX = scaleX;
        node.lastValidScaleY = scaleY;
      }

      if (onPreviewUpdate) {
        const newRadiusX = pRef.current.radiusX * node.scaleX();
        const newRadiusY = pRef.current.radiusY * node.scaleY();
        onPreviewUpdate(subMask.id, {
          parameters: {
            ...pRef.current,
            centerX: node.x() / scale + cropX,
            centerY: node.y() / scale + cropY,
            radiusX: newRadiusX,
            radiusY: newRadiusY,
            rotation: node.rotation(),
          },
        });
      }
    }, [onPreviewUpdate, scale, cropX, cropY, subMask.id]);

    const handleRadialTransformEnd = useCallback(() => {
      const node = shapeRef.current;
      if (!node) return;

      const scaleX = node.scaleX();
      const scaleY = node.scaleY();

      const newRadiusX = pRef.current.radiusX * scaleX;
      const newRadiusY = pRef.current.radiusY * scaleY;

      node.scaleX(1);
      node.scaleY(1);

      const newP = {
        ...pRef.current,
        centerX: node.x() / scale + cropX,
        centerY: node.y() / scale + cropY,
        radiusX: newRadiusX,
        radiusY: newRadiusY,
        rotation: node.rotation(),
      };

      updateP(newP);
      isDragging.current = false;
      onMaskInteractionEnd();
      onUpdate(subMask.id, { parameters: newP });
    }, [scale, cropX, cropY, updateP, onMaskInteractionEnd, onUpdate, subMask.id]);

    const handleLinearGroupDragStart = useCallback(
      (e: any) => {
        isDragging.current = true;
        onMaskInteractionStart(e);
        dragStartPointer.current = e.target.getStage().getPointerPosition();
        dragStartParams.current = { ...pRef.current };
        e.cancelBubble = true;
      },
      [onMaskInteractionStart],
    );

    const handleLinearGroupDragMove = useCallback(
      (e: any) => {
        const pointerPos = e.target.getStage().getPointerPosition();
        if (!pointerPos || !dragStartPointer.current || !dragStartParams.current) return;

        const dx = (pointerPos.x - dragStartPointer.current.x) / scale;
        const dy = (pointerPos.y - dragStartPointer.current.y) / scale;

        const newP = {
          ...dragStartParams.current,
          startX: dragStartParams.current.startX + dx,
          startY: dragStartParams.current.startY + dy,
          endX: dragStartParams.current.endX + dx,
          endY: dragStartParams.current.endY + dy,
        };

        updateP(newP);
        if (onPreviewUpdate) onPreviewUpdate(subMask.id, { parameters: newP });
      },
      [scale, updateP, onPreviewUpdate, subMask.id],
    );

    const handleLinearGroupDragEnd = useCallback(
      (e: any) => {
        isDragging.current = false;
        e.cancelBubble = true;
        onMaskInteractionEnd();
        onUpdate(subMask.id, { parameters: pRef.current });
      },
      [subMask.id, onMaskInteractionEnd, onUpdate],
    );

    const handleLinearPointDragStart = useCallback(
      (e: any) => {
        isDragging.current = true;
        onMaskInteractionStart(e);
        e.cancelBubble = true;
      },
      [onMaskInteractionStart],
    );

    const handleLinearPointDragMove = useCallback(
      (e: any, pointType: string) => {
        const stage = e.target.getStage();
        const pointerPos = stage.getPointerPosition();
        if (!pointerPos) return;

        const newX = pointerPos.x / scale + cropX;
        const newY = pointerPos.y / scale + cropY;

        const newP = { ...pRef.current };
        if (pointType === 'start') {
          newP.startX = newX;
          newP.startY = newY;
        } else {
          newP.endX = newX;
          newP.endY = newY;
        }
        updateP(newP);
        if (onPreviewUpdate) onPreviewUpdate(subMask.id, { parameters: newP });
      },
      [scale, cropX, cropY, updateP, onPreviewUpdate, subMask.id],
    );

    const handleLinearRangeDragMove = useCallback(
      (e: any) => {
        const stage = e.target.getStage();
        const pointerPos = stage.getPointerPosition();
        if (!pointerPos) return;

        const { startX, startY, endX, endY } = pRef.current;
        const sX = (startX - cropX) * scale;
        const sY = (startY - cropY) * scale;
        const eX = (endX - cropX) * scale;
        const eY = (endY - cropY) * scale;

        const dx = eX - sX;
        const dy = eY - sY;
        const len = Math.sqrt(dx * dx + dy * dy);

        let newRange = pRef.current.range;
        if (len > 0) {
          const dist = Math.abs(dx * (sY - pointerPos.y) - (sX - pointerPos.x) * dy) / len;
          newRange = Math.max(0.1, dist / scale);
        }

        const newP = { ...pRef.current, range: newRange };
        updateP(newP);
        if (onPreviewUpdate) onPreviewUpdate(subMask.id, { parameters: newP });
      },
      [scale, cropX, cropY, updateP, onPreviewUpdate, subMask.id],
    );

    const handleLinearPointDragEnd = useCallback(
      (e: any) => {
        isDragging.current = false;
        e.cancelBubble = true;
        onMaskInteractionEnd();
        onUpdate(subMask.id, { parameters: pRef.current });
      },
      [subMask.id, onMaskInteractionEnd, onUpdate],
    );

    if (!subMask.visible) {
      return null;
    }

    const commonProps = {
      dash: [4, 4],
      onClick: handleSelect,
      onTap: handleSelect,
      opacity: isSelected ? 1 : 0.7,
      stroke: isSelected
        ? '#0ea5e9'
        : subMask.mode === SubMaskMode.Subtractive
          ? '#f43f5e'
          : subMask.mode === SubMaskMode.Intersect
            ? '#a855f7'
            : 'white',
      strokeScaleEnabled: false,
      strokeWidth: isSelected ? 3 : 2,
    };

    if (subMask.type === Mask.AiSubject || subMask.type === Mask.QuickEraser) {
      const { startX, startY, endX, endY } = p;
      if (startX !== undefined && startY !== undefined && endX !== undefined && endY !== undefined) {
        const isPoint = Math.abs(startX - endX) < 1e-6 && Math.abs(startY - endY) < 1e-6;
        if (isPoint) {
          return (
            <Circle
              x={(startX - cropX) * scale}
              y={(startY - cropY) * scale}
              radius={5}
              stroke={isSelected ? '#0ea5e9' : 'white'}
              strokeWidth={2}
              listening={!isToolActive}
              onClick={handleSelect}
              onTap={handleSelect}
              onTouchEnd={handleMaskTouchEnd}
              onTouchStart={handleMaskTouchStart}
              onMouseEnter={onMaskMouseEnter}
              onMouseLeave={onMaskMouseLeave}
              shadowColor="black"
              shadowBlur={2}
              shadowOpacity={0.8}
            />
          );
        } else {
          return (
            <Rect
              height={Math.abs(endY - startY) * scale}
              onMouseEnter={onMaskMouseEnter}
              onMouseLeave={onMaskMouseLeave}
              onTouchEnd={handleMaskTouchEnd}
              onTouchStart={handleMaskTouchStart}
              width={Math.abs(endX - startX) * scale}
              x={(Math.min(startX, endX) - cropX) * scale}
              y={(Math.min(startY, endY) - cropY) * scale}
              {...commonProps}
            />
          );
        }
      }
      return null;
    }

    if (subMask.type === Mask.Brush || subMask.type === Mask.Flow) {
      const { lines = [] } = p;
      return (
        <Group
          onClick={handleSelect}
          onTap={handleSelect}
          onTouchEnd={handleMaskTouchEnd}
          onTouchStart={handleMaskTouchStart}
        >
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
      const { centerX, centerY, radiusX, radiusY, rotation } = p;
      if (p.isInitialDraw && (radiusX < 1 || radiusY < 2)) return null;

      return (
        <>
          <Ellipse
            {...commonProps}
            ref={shapeRef}
            draggable={!isToolActive}
            dragBoundFunc={lockDragBoundFunc}
            onDragStart={handleRadialDragStart}
            onDragMove={handleRadialDragMove}
            onDragEnd={handleRadialDragEnd}
            onMouseEnter={onMaskMouseEnter}
            onMouseLeave={onMaskMouseLeave}
            onTouchEnd={handleMaskTouchEnd}
            onTouchStart={handleMaskTouchStart}
            radiusX={radiusX * scale}
            radiusY={radiusY * scale}
            rotation={rotation}
            x={(centerX - cropX) * scale}
            y={(centerY - cropY) * scale}
          />
          {isSelected && !isToolActive && (
            <Transformer
              ref={trRef}
              centeredScaling={true}
              rotateEnabled={true}
              enabledAnchors={[
                'top-left',
                'top-right',
                'bottom-left',
                'bottom-right',
                'top-center',
                'bottom-center',
                'middle-left',
                'middle-right',
              ]}
              onMouseDown={(e) => {
                e.cancelBubble = true;
                e.evt.preventDefault();
              }}
              onTouchStart={(e) => {
                handleMaskTouchStart(e);
                e.cancelBubble = true;
                e.evt.preventDefault();
              }}
              onTouchEnd={handleMaskTouchEnd}
              boundBoxFunc={(oldBox, newBox) => {
                if (Math.abs(newBox.width) < 5 || Math.abs(newBox.height) < 5) {
                  return oldBox;
                }
                return newBox;
              }}
              onTransformStart={handleRadialTransformStart}
              onTransform={handleRadialTransform}
              onTransformEnd={handleRadialTransformEnd}
              onMouseEnter={onMaskMouseEnter}
              onMouseLeave={onMaskMouseLeave}
            />
          )}
        </>
      );
    }

    if (subMask.type === Mask.Linear) {
      const defaultRange = Math.min(cropW, cropH) * 0.1;
      const { startX, startY, endX, endY, range = defaultRange } = p;

      const flickDistX = startX - endX;
      const flickDistY = startY - endY;
      if (p.isInitialDraw && Math.sqrt(flickDistX * flickDistX + flickDistY * flickDistY) < 1) return null;

      const sX = (startX - cropX) * scale;
      const sY = (startY - cropY) * scale;
      const eX = (endX - cropX) * scale;
      const eY = (endY - cropY) * scale;
      const r = range * scale;

      const idx = endX - startX;
      const idy = endY - startY;
      const angle = Math.atan2(idy, idx);
      const angleDeg = (angle * 180) / Math.PI;

      const centerX = sX + (eX - sX) / 2;
      const centerY = sY + (eY - sY) / 2;

      const nx = -Math.sin(angle);
      const ny = Math.cos(angle);
      const dx_norm = Math.cos(angle);
      const dy_norm = Math.sin(angle);

      const EXT = 5000;
      const topRangePts = [
        sX + nx * r - dx_norm * EXT,
        sY + ny * r - dy_norm * EXT,
        eX + nx * r + dx_norm * EXT,
        eY + ny * r + dy_norm * EXT,
      ];
      const botRangePts = [
        sX - nx * r - dx_norm * EXT,
        sY - ny * r - dy_norm * EXT,
        eX - nx * r + dx_norm * EXT,
        eY - ny * r + dy_norm * EXT,
      ];

      const lineProps = {
        ...commonProps,
        strokeWidth: isSelected ? 2.5 : 2,
        dash: [6, 6],
        hitStrokeWidth: 40,
      };

      const showFeatherLines = isSelected && (!isToolActive || p.isInitialDraw);

      return (
        <Group>
          <Group
            x={centerX}
            y={centerY}
            rotation={angleDeg}
            draggable={isSelected && !isToolActive}
            dragBoundFunc={lockDragBoundFunc}
            onDragStart={handleLinearGroupDragStart}
            onDragMove={handleLinearGroupDragMove}
            onDragEnd={handleLinearGroupDragEnd}
            onClick={handleSelect}
            onTap={handleSelect}
            onTouchEnd={handleMaskTouchEnd}
            onTouchStart={handleMaskTouchStart}
            onMouseEnter={(e: any) => {
              onMaskMouseEnter();
              if (!isToolActive) e.target.getStage().container().style.cursor = 'move';
            }}
            onMouseLeave={(e: any) => {
              onMaskMouseLeave();
              e.target.getStage().container().style.cursor = 'default';
            }}
          >
            <Line points={[-5000, 0, 5000, 0]} {...lineProps} dash={[2, 3]} />
          </Group>

          {showFeatherLines && (
            <>
              <Line
                points={topRangePts}
                {...lineProps}
                draggable={!isToolActive}
                dragBoundFunc={lockDragBoundFunc}
                onDragStart={handleLinearPointDragStart}
                onDragMove={handleLinearRangeDragMove}
                onDragEnd={handleLinearPointDragEnd}
                onTouchEnd={handleMaskTouchEnd}
                onTouchStart={handleMaskTouchStart}
                onMouseEnter={(e: any) => {
                  onMaskMouseEnter();
                  if (!isToolActive) e.target.getStage().container().style.cursor = 'row-resize';
                }}
                onMouseLeave={(e: any) => {
                  onMaskMouseLeave();
                  e.target.getStage().container().style.cursor = 'default';
                }}
              />
              <Line
                points={botRangePts}
                {...lineProps}
                draggable={!isToolActive}
                dragBoundFunc={lockDragBoundFunc}
                onDragStart={handleLinearPointDragStart}
                onDragMove={handleLinearRangeDragMove}
                onDragEnd={handleLinearPointDragEnd}
                onTouchEnd={handleMaskTouchEnd}
                onTouchStart={handleMaskTouchStart}
                onMouseEnter={(e: any) => {
                  onMaskMouseEnter();
                  if (!isToolActive) e.target.getStage().container().style.cursor = 'row-resize';
                }}
                onMouseLeave={(e: any) => {
                  onMaskMouseLeave();
                  e.target.getStage().container().style.cursor = 'default';
                }}
              />
            </>
          )}

          {isSelected && !isToolActive && (
            <>
              <Circle
                x={sX}
                y={sY}
                radius={8}
                fill="#0ea5e9"
                stroke="white"
                strokeWidth={2}
                draggable
                dragBoundFunc={lockDragBoundFunc}
                onDragStart={handleLinearPointDragStart}
                onDragMove={(e) => handleLinearPointDragMove(e, 'start')}
                onDragEnd={handleLinearPointDragEnd}
                onTouchEnd={handleMaskTouchEnd}
                onTouchStart={handleMaskTouchStart}
                onMouseEnter={(e: any) => {
                  onMaskMouseEnter();
                  e.target.getStage().container().style.cursor = 'grab';
                }}
                onMouseLeave={(e: any) => {
                  onMaskMouseLeave();
                  e.target.getStage().container().style.cursor = 'default';
                }}
              />
              <Circle
                x={eX}
                y={eY}
                radius={8}
                fill="#0ea5e9"
                stroke="white"
                strokeWidth={2}
                draggable
                dragBoundFunc={lockDragBoundFunc}
                onDragStart={handleLinearPointDragStart}
                onDragMove={(e) => handleLinearPointDragMove(e, 'end')}
                onDragEnd={handleLinearPointDragEnd}
                onTouchEnd={handleMaskTouchEnd}
                onTouchStart={handleMaskTouchStart}
                onMouseEnter={(e: any) => {
                  onMaskMouseEnter();
                  e.target.getStage().container().style.cursor = 'grab';
                }}
                onMouseLeave={(e: any) => {
                  onMaskMouseLeave();
                  e.target.getStage().container().style.cursor = 'default';
                }}
              />
            </>
          )}

          {!isSelected && (
            <>
              <Line
                points={topRangePts}
                {...lineProps}
                opacity={0.7}
                stroke="white"
                listening={true}
                onClick={handleSelect}
                onTap={handleSelect}
                onTouchEnd={handleMaskTouchEnd}
                onTouchStart={handleMaskTouchStart}
                onMouseEnter={(e: any) => {
                  onMaskMouseEnter();
                  if (!isToolActive) e.target.getStage().container().style.cursor = 'row-resize';
                }}
                onMouseLeave={(e: any) => {
                  onMaskMouseLeave();
                  e.target.getStage().container().style.cursor = 'default';
                }}
              />
              <Line
                points={botRangePts}
                {...lineProps}
                opacity={0.7}
                stroke="white"
                listening={true}
                onClick={handleSelect}
                onTap={handleSelect}
                onTouchEnd={handleMaskTouchEnd}
                onTouchStart={handleMaskTouchStart}
                onMouseEnter={(e: any) => {
                  onMaskMouseEnter();
                  if (!isToolActive) e.target.getStage().container().style.cursor = 'row-resize';
                }}
                onMouseLeave={(e: any) => {
                  onMaskMouseLeave();
                  e.target.getStage().container().style.cursor = 'default';
                }}
              />
            </>
          )}
        </Group>
      );
    }

    if (subMask.type === Mask.Color || subMask.type === Mask.Luminance) {
      const { targetX, targetY } = p;
      if (targetX !== undefined && targetX >= 0 && targetY !== undefined && targetY >= 0) {
        return (
          <Circle
            x={(targetX - cropX) * scale}
            y={(targetY - cropY) * scale}
            radius={5}
            stroke={isSelected ? '#0ea5e9' : 'white'}
            strokeWidth={2}
            listening={false}
            onTouchEnd={handleMaskTouchEnd}
            onTouchStart={handleMaskTouchStart}
            shadowColor="black"
            shadowBlur={2}
            shadowOpacity={0.8}
          />
        );
      }
      return null;
    }
    return null;
  },
);

const ImageCanvas = memo(
  ({
    appSettings,
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
    interactivePatch,
    isAiEditing,
    isCropping,
    isMaskControlHovered,
    isMasking,
    isSliderDragging,
    isStraightenActive,
    isRotationActive,
    maskOverlayUrl,
    onGenerateAiMask,
    onLiveMaskPreview,
    onQuickErase,
    onSelectAiSubMask,
    onSelectMask,
    onStraighten,
    selectedImage,
    setCrop,
    setIsMaskHovered,
    setIsMaskTouchInteracting,
    showOriginal,
    transformedOriginalUrl,
    uncroppedAdjustedPreviewUrl,
    updateSubMask,
    isWbPickerActive = false,
    onWbPicked,
    setAdjustments,
    overlayRotation,
    overlayMode,
    cursorStyle,
    isMaxZoom,
    liveRotation,
    zoomScale,
    hasRenderedFirstFrame,
  }: ImageCanvasProps) => {
    const [isCropViewVisible, setIsCropViewVisible] = useState(false);
    const cropImageRef = useRef<HTMLImageElement>(null);
    const [displayedMaskUrl, setDisplayedMaskUrl] = useState<string | null>(null);
    const [originalLoaded, setOriginalLoaded] = useState<boolean>(false);
    const [localInitialDrawParams, setLocalInitialDrawParams] = useState<any>(null);
    const isDrawing = useRef(false);
    const drawingStageRef = useRef<any>(null);
    const dragStartPointer = useRef<Coord | null>(null);
    const lastBrushPoint = useRef<Coord | null>(null);
    const currentLine = useRef<DrawnLine | null>(null);
    const previewBoxRef = useRef<{ start: Coord; end: Coord } | null>(null);
    const [previewBox, setPreviewBox] = useState<{ start: Coord; end: Coord } | null>(null);

    const [cursorPreview, setCursorPreview] = useState<CursorPreview>({ x: 0, y: 0, visible: false });
    const [straightenLine, setStraightenLine] = useState<any>(null);
    const isStraightening = useRef(false);

    const [displayState, setDisplayState] = useState({
      base: finalPreviewUrl || selectedImage.thumbnailUrl,
      fade: null as string | null,
    });
    const [isFadingIn, setIsFadingIn] = useState(false);
    const prevImageIdentityRef = useRef(selectedImage.thumbnailUrl);

    const [baseTool, setBaseTool] = useState<ToolType>(brushSettings?.tool ?? ToolType.Brush);
    const retainedPatchRef = useRef<typeof interactivePatch>(null);

    const isWgpuActive = appSettings?.useWgpuRenderer !== false && selectedImage?.isReady && hasRenderedFirstFrame;

    useEffect(() => {
      if (interactivePatch) {
        retainedPatchRef.current = interactivePatch;
      }
    }, [interactivePatch]);

    useEffect(() => {
      const newSrc = finalPreviewUrl || selectedImage.thumbnailUrl;
      const isNewImage = prevImageIdentityRef.current !== selectedImage.thumbnailUrl;

      if (isNewImage) {
        prevImageIdentityRef.current = selectedImage.thumbnailUrl;
        setDisplayState({ base: newSrc, fade: null });
        setIsFadingIn(false);
        return;
      }

      if (isSliderDragging) {
        setDisplayState({ base: newSrc, fade: null });
        setIsFadingIn(false);
      } else {
        if (displayState.base !== newSrc && displayState.base) {
          setDisplayState((prev) => ({ base: prev.base, fade: newSrc }));
          setIsFadingIn(false);

          let frame1: number;
          let frame2: number;

          frame1 = requestAnimationFrame(() => {
            frame2 = requestAnimationFrame(() => {
              setIsFadingIn(true);
            });
          });

          const timer = setTimeout(() => {
            setDisplayState({ base: newSrc, fade: null });
            setIsFadingIn(false);
          }, 150);

          return () => {
            cancelAnimationFrame(frame1);
            cancelAnimationFrame(frame2);
            clearTimeout(timer);
          };
        } else {
          setDisplayState({ base: newSrc, fade: null });
          setIsFadingIn(false);
        }
      }
    }, [finalPreviewUrl, selectedImage.thumbnailUrl, isSliderDragging]);

    useEffect(() => {
      setBaseTool(brushSettings?.tool ?? ToolType.Brush);
    }, [brushSettings?.tool]);

    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Alt') {
          e.preventDefault();
          (window as any).altKeyDown = true;
        }
      };
      const handleKeyUp = (e: KeyboardEvent) => {
        if (e.key === 'Alt') {
          e.preventDefault();
          (window as any).altKeyDown = false;
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
      return () => {
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('keyup', handleKeyUp);
        delete (window as any).altKeyDown;
      };
    }, []);

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

    const effectiveZoomScale = zoomScale > 0 ? zoomScale : 1;
    const brushStageSize = (brushSettings?.size ?? 0) / effectiveZoomScale;
    const brushImageSpaceSize = brushStageSize / (imageRenderSize.scale || 1);

    const isBrushActive =
      (isMasking || isAiEditing) && (activeSubMask?.type === Mask.Brush || activeSubMask?.type === Mask.Flow);
    const activeLineFlow = activeSubMask?.type === Mask.Flow ? (activeSubMask?.parameters?.flow ?? 10) : undefined;
    const isAiSubjectActive =
      (isMasking || isAiEditing) &&
      (activeSubMask?.type === Mask.AiSubject || activeSubMask?.type === Mask.QuickEraser);
    const isParametricActive =
      (isMasking || isAiEditing) && (activeSubMask?.type === Mask.Color || activeSubMask?.type === Mask.Luminance);
    const isInitialDrawing = (isMasking || isAiEditing) && activeSubMask?.parameters?.isInitialDraw === true;

    const isToolActive = isBrushActive || isAiSubjectActive || isInitialDrawing || isParametricActive;

    useEffect(() => {
      if (maskOverlayUrl && (isMasking || isAiEditing)) {
        setDisplayedMaskUrl(maskOverlayUrl);
      } else {
        setDisplayedMaskUrl(null);
      }
    }, [maskOverlayUrl, isMasking, isAiEditing]);

    useEffect(() => {
      if (isToolActive) {
        return;
      }
      isDrawing.current = false;
      drawingStageRef.current = null;
      dragStartPointer.current = null;
      currentLine.current = null;
      lastBrushPoint.current = null;
      setPreviewBox(null);
      previewBoxRef.current = null;
      setLocalInitialDrawParams(null);
    }, [isToolActive]);

    useEffect(() => {
      const clearTouchInteraction = () => {
        setIsMaskTouchInteracting(false);
      };

      window.addEventListener('touchend', clearTouchInteraction);
      window.addEventListener('touchcancel', clearTouchInteraction);

      return () => {
        window.removeEventListener('touchend', clearTouchInteraction);
        window.removeEventListener('touchcancel', clearTouchInteraction);
      };
    }, [setIsMaskTouchInteracting]);

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
      if (isCropping && uncroppedAdjustedPreviewUrl) {
        const timer = setTimeout(() => setIsCropViewVisible(true), 10);
        return () => clearTimeout(timer);
      } else {
        setIsCropViewVisible(false);
      }
    }, [isCropping, uncroppedAdjustedPreviewUrl]);

    const handleWbClick = useCallback(
      (e: any) => {
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

          let rTotal = 0,
            gTotal = 0,
            bTotal = 0;
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
      },
      [isWbPickerActive, finalPreviewUrl, imageRenderSize, onWbPicked, setAdjustments],
    );

    const handleStart = useCallback(
      (e: any) => {
        if (e.evt && e.evt.cancelable) e.evt.preventDefault();

        if (isWbPickerActive) {
          handleWbClick(e);
          return;
        }

        if (isParametricActive && activeSubMask) {
          const pos = e.target.getStage().getPointerPosition();
          if (!pos) return;

          const { scale } = imageRenderSize;
          const crop = adjustments.crop;
          const isPercent = crop?.unit === '%';
          const cropX = crop ? (isPercent ? (crop.x / 100) * effectiveImageDimensions.width : crop.x) : 0;
          const cropY = crop ? (isPercent ? (crop.y / 100) * effectiveImageDimensions.height : crop.y) : 0;

          const x = pos.x / scale + cropX;
          const y = pos.y / scale + cropY;

          let newParams = { ...activeSubMask.parameters };
          newParams.targetX = x;
          newParams.targetY = y;
          newParams.rotation = adjustments.rotation || 0;
          newParams.flipHorizontal = adjustments.flipHorizontal || false;
          newParams.flipVertical = adjustments.flipVertical || false;
          newParams.orientationSteps = adjustments.orientationSteps || 0;
          delete newParams.isInitialDraw;

          const activeId = isMasking ? activeMaskId : activeAiSubMaskId;
          updateSubMask(activeId, { parameters: newParams });
          return;
        }

        if (isInitialDrawing && activeSubMask) {
          isDrawing.current = true;
          drawingStageRef.current = e.target.getStage();
          const pos = e.target.getStage().getPointerPosition();
          if (!pos) return;

          const { scale } = imageRenderSize;
          const crop = adjustments.crop;
          const isPercent = crop?.unit === '%';
          const cropX = crop ? (isPercent ? (crop.x / 100) * effectiveImageDimensions.width : crop.x) : 0;
          const cropY = crop ? (isPercent ? (crop.y / 100) * effectiveImageDimensions.height : crop.y) : 0;

          const x = pos.x / scale + cropX;
          const y = pos.y / scale + cropY;

          dragStartPointer.current = { x, y };

          let initialParams = { ...activeSubMask.parameters };

          if (activeSubMask.type === Mask.Radial) {
            initialParams = {
              ...initialParams,
              centerX: x,
              centerY: y,
              radiusX: 0,
              radiusY: 0,
              rotation: 0,
            };
          } else if (activeSubMask.type === Mask.Linear) {
            initialParams = {
              ...initialParams,
              startX: x,
              startY: y,
              endX: x,
              endY: y,
              range: 0,
            };
          }

          setLocalInitialDrawParams(initialParams);
          return;
        }

        if (isToolActive) {
          const stage = e.target.getStage();
          const pos = stage.getPointerPosition();
          if (!pos) {
            isDrawing.current = false;
            currentLine.current = null;
            setPreviewBox(null);
            previewBoxRef.current = null;
            return;
          }

          if (isAiSubjectActive) {
            isDrawing.current = true;
            drawingStageRef.current = stage;
            const newBox = { start: pos, end: pos };
            previewBoxRef.current = newBox;
            setPreviewBox(newBox);
            return;
          }

          const isAltPressed = e.evt.altKey;
          let effectiveTool;

          if (isAiSubjectActive) {
            effectiveTool = ToolType.AiSeletor;
          } else if (isAltPressed) {
            effectiveTool = baseTool === ToolType.Brush ? ToolType.Eraser : ToolType.Brush;
          } else {
            effectiveTool = baseTool;
          }
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
              brushSize: brushImageSpaceSize,
              feather: brushSettings?.feather ? brushSettings?.feather / 100 : 0,
              flow: activeLineFlow,
              points: interpolatedPoints,
              tool: effectiveTool,
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
            isDrawing.current = false;
            currentLine.current = null;
            return;
          }

          isDrawing.current = true;
          drawingStageRef.current = stage;

          const newLine: DrawnLine = {
            brushSize: isBrushActive && brushSettings?.size ? brushStageSize : 2,
            points: [pos],
            tool: effectiveTool,
          };
          currentLine.current = newLine;
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
      [
        isWbPickerActive,
        handleWbClick,
        isInitialDrawing,
        isBrushActive,
        activeLineFlow,
        isAiSubjectActive,
        isParametricActive,
        brushSettings,
        onSelectMask,
        onSelectAiSubMask,
        isMasking,
        isAiEditing,
        imageRenderSize,
        adjustments,
        activeMaskId,
        activeAiSubMaskId,
        activeSubMask,
        updateSubMask,
        effectiveImageDimensions,
        isToolActive,
        brushImageSpaceSize,
        brushStageSize,
        baseTool,
      ],
    );

    const handleMove = useCallback(
      (e: any) => {
        if (isWbPickerActive) {
          return;
        }

        let pos;
        if (e && typeof e.target?.getStage === 'function') {
          const stage = e.target.getStage();
          pos = stage.getPointerPosition();
        } else if (e && (e.clientX != null || (e.touches && e.touches[0]))) {
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

        if (isAiSubjectActive && previewBoxRef.current) {
          const updatedBox = { ...previewBoxRef.current, end: pos };
          previewBoxRef.current = updatedBox;
          setPreviewBox(updatedBox);
          if (e.evt && e.evt.cancelable) e.evt.preventDefault();
          return;
        }

        if (isInitialDrawing && dragStartPointer.current && activeSubMask && localInitialDrawParams) {
          const stage =
            drawingStageRef.current || (e && typeof e.target?.getStage === 'function' ? e.target.getStage() : null);
          if (!stage) return;
          const pointerPos = stage.getPointerPosition();
          if (!pointerPos) return;

          const { scale } = imageRenderSize;
          const crop = adjustments.crop;
          const isPercent = crop?.unit === '%';
          const cropX = crop ? (isPercent ? (crop.x / 100) * effectiveImageDimensions.width : crop.x) : 0;
          const cropY = crop ? (isPercent ? (crop.y / 100) * effectiveImageDimensions.height : crop.y) : 0;

          const x = pointerPos.x / scale + cropX;
          const y = pointerPos.y / scale + cropY;

          const distX = x - dragStartPointer.current.x;
          const distY = y - dragStartPointer.current.y;
          const screenThreshold = 15;
          if (Math.sqrt(distX * distX + distY * distY) < screenThreshold / scale) {
            return;
          }

          let updatedParams = { ...localInitialDrawParams };

          if (activeSubMask.type === Mask.Radial) {
            updatedParams.radiusX = Math.max(1, Math.abs(x - dragStartPointer.current.x));
            updatedParams.radiusY = Math.max(1, Math.abs(y - dragStartPointer.current.y));
          } else if (activeSubMask.type === Mask.Linear) {
            const dx = x - dragStartPointer.current.x;
            const dy = y - dragStartPointer.current.y;
            const R = Math.max(1, Math.sqrt(dx * dx + dy * dy));

            const px = -dy / R;
            const py = dx / R;
            const handleDist = Math.min(effectiveImageDimensions.width, effectiveImageDimensions.height) * 0.2;

            updatedParams.startX = dragStartPointer.current.x + px * handleDist;
            updatedParams.startY = dragStartPointer.current.y + py * handleDist;
            updatedParams.endX = dragStartPointer.current.x - px * handleDist;
            updatedParams.endY = dragStartPointer.current.y - py * handleDist;
            updatedParams.range = R;
          }

          setLocalInitialDrawParams(updatedParams);

          if (onLiveMaskPreview && activeContainer && activeSubMask) {
            const previewSubMask = {
              ...activeSubMask,
              parameters: updatedParams,
            };
            const previewContainer = {
              ...activeContainer,
              subMasks: activeContainer.subMasks.map((sm: SubMask) =>
                sm.id === activeSubMask.id ? previewSubMask : sm,
              ),
            };
            onLiveMaskPreview(previewContainer);
          }
          if (e.evt && e.evt.cancelable) e.evt.preventDefault();
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

          if (onLiveMaskPreview && activeContainer && activeSubMask && isBrushActive) {
            const { scale } = imageRenderSize;
            const crop = adjustments.crop;
            const isPercent = crop?.unit === '%';
            const cropX = crop ? (isPercent ? (crop.x / 100) * effectiveImageDimensions.width : crop.x) : 0;
            const cropY = crop ? (isPercent ? (crop.y / 100) * effectiveImageDimensions.height : crop.y) : 0;

            const isAltPressedDuringMove = (window as any).altKeyDown || false;
            let effectiveToolForPreview;

            if (isAltPressedDuringMove) {
              effectiveToolForPreview = baseTool === ToolType.Brush ? ToolType.Eraser : ToolType.Brush;
            } else {
              effectiveToolForPreview = baseTool;
            }

            const imageSpaceLine: DrawnLine = {
              brushSize: brushImageSpaceSize,
              feather: brushSettings?.feather ? brushSettings?.feather / 100 : 0,
              flow: activeLineFlow,
              points: updatedLine.points.map((p: Coord) => ({
                x: p.x / scale + cropX,
                y: p.y / scale + cropY,
              })),
              tool: effectiveToolForPreview,
            };

            const existingLines = activeSubMask.parameters?.lines || [];
            const previewSubMask = {
              ...activeSubMask,
              parameters: {
                ...activeSubMask.parameters,
                lines: [...existingLines, imageSpaceLine],
              },
            };

            const previewContainer = {
              ...activeContainer,
              subMasks: activeContainer.subMasks.map((sm: SubMask) =>
                sm.id === activeSubMask.id ? previewSubMask : sm,
              ),
            };

            onLiveMaskPreview(previewContainer);
          }
          if (e.evt && e.evt.cancelable) e.evt.preventDefault();
        }
      },
      [
        isToolActive,
        isWbPickerActive,
        isInitialDrawing,
        activeMaskId,
        activeAiSubMaskId,
        updateSubMask,
        onLiveMaskPreview,
        activeContainer,
        activeSubMask,
        isBrushActive,
        activeLineFlow,
        isAiSubjectActive,
        imageRenderSize,
        adjustments.crop,
        effectiveImageDimensions,
        brushSettings,
        isMasking,
        localInitialDrawParams,
        brushImageSpaceSize,
        baseTool,
      ],
    );

    const handleUp = useCallback(() => {
      if (!isDrawing.current) {
        return;
      }

      if (isInitialDrawing && activeSubMask) {
        isDrawing.current = false;
        const activeId = isMasking ? activeMaskId : activeAiSubMaskId;

        const newParams = { ...localInitialDrawParams };
        delete newParams.isInitialDraw;

        if (activeSubMask.type === Mask.Radial && newParams.radiusX < 10 && newParams.radiusY < 10) {
          newParams.radiusX = 100;
          newParams.radiusY = 100;
        } else if (activeSubMask.type === Mask.Linear) {
          if (!newParams.range || newParams.range < 10) {
            const handleDist = Math.min(effectiveImageDimensions.width, effectiveImageDimensions.height) * 0.2;
            newParams.startX = dragStartPointer.current!.x + handleDist;
            newParams.startY = dragStartPointer.current!.y;
            newParams.endX = dragStartPointer.current!.x - handleDist;
            newParams.endY = dragStartPointer.current!.y;
            newParams.range = 100;
          }
        }

        updateSubMask(activeId, { parameters: newParams });
        setLocalInitialDrawParams(null);
        dragStartPointer.current = null;
        return;
      }

      if (!currentLine.current && !(isAiSubjectActive && previewBoxRef.current)) {
        return;
      }

      if (isAiSubjectActive && previewBoxRef.current) {
        const wasDrawing = isDrawing.current;
        isDrawing.current = false;
        const box = previewBoxRef.current;
        previewBoxRef.current = null;
        setPreviewBox(null);
        drawingStageRef.current = null;

        if (!wasDrawing || !box) {
          return;
        }

        const { scale } = imageRenderSize;
        const crop = adjustments.crop;
        const isPercent = crop?.unit === '%';
        const cropX = crop ? (isPercent ? (crop.x / 100) * effectiveImageDimensions.width : crop.x) : 0;
        const cropY = crop ? (isPercent ? (crop.y / 100) * effectiveImageDimensions.height : crop.y) : 0;

        const activeId = isMasking ? activeMaskId : activeAiSubMaskId;

        let startPoint = { x: box.start.x / scale + cropX, y: box.start.y / scale + cropY };
        let endPoint = { x: box.end.x / scale + cropX, y: box.end.y / scale + cropY };

        const dx = box.end.x - box.start.x;
        const dy = box.end.y - box.start.y;
        if (Math.sqrt(dx * dx + dy * dy) < 5) {
          endPoint = { x: startPoint.x, y: startPoint.y };
        }

        if (activeId) {
          updateSubMask(activeId, {
            parameters: {
              ...activeSubMask?.parameters,
              startX: startPoint.x,
              startY: startPoint.y,
              endX: endPoint.x,
              endY: endPoint.y,
            },
          });
        }

        if (activeSubMask?.type === Mask.QuickEraser && onQuickErase) {
          onQuickErase(activeId, startPoint, endPoint);
        } else if (activeSubMask?.type === Mask.AiSubject && onGenerateAiMask) {
          onGenerateAiMask(activeId, startPoint, endPoint);
        }
        return;
      }

      const wasDrawing = isDrawing.current;
      isDrawing.current = false;
      const line = currentLine.current;
      currentLine.current = null;
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

      if (isBrushActive) {
        const wasAltPressed = (window as any).altKeyDown || false;
        const effectiveToolForFinal = wasAltPressed
          ? baseTool === ToolType.Brush
            ? ToolType.Eraser
            : ToolType.Brush
          : baseTool;

        const imageSpaceLine: DrawnLine = {
          brushSize: brushImageSpaceSize,
          feather: brushSettings?.feather ? brushSettings?.feather / 100 : 0,
          flow: activeLineFlow,
          points: line.points.map((p: Coord) => ({
            x: p.x / scale + cropX,
            y: p.y / scale + cropY,
          })),
          tool: effectiveToolForFinal,
        };

        const existingLines = activeSubMask?.parameters.lines || [];

        updateSubMask(activeId, {
          parameters: {
            ...activeSubMask?.parameters,
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
      isInitialDrawing,
      activeAiSubMaskId,
      activeMaskId,
      activeSubMask,
      adjustments.crop,
      brushSettings,
      imageRenderSize.scale,
      isAiEditing,
      isBrushActive,
      activeLineFlow,
      isMasking,
      onGenerateAiMask,
      onQuickErase,
      updateSubMask,
      effectiveImageDimensions,
      localInitialDrawParams,
      brushImageSpaceSize,
      brushStageSize,
      baseTool,
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
      if (!isToolActive) return;

      function onGlobalMove(e: MouseEvent | TouchEvent) {
        if (!isDrawing.current) return;
        handleMove(e);
      }

      function onGlobalUp() {
        if (!isDrawing.current) return;
        handleUp();
      }

      window.addEventListener('mousemove', onGlobalMove, { passive: false });
      window.addEventListener('mouseup', onGlobalUp);
      window.addEventListener('touchmove', onGlobalMove, { passive: false });
      window.addEventListener('touchend', onGlobalUp);
      return () => {
        window.removeEventListener('mousemove', onGlobalMove);
        window.removeEventListener('mouseup', onGlobalUp);
        window.removeEventListener('touchmove', onGlobalMove);
        window.removeEventListener('touchend', onGlobalUp);
      };
    }, [isToolActive, handleMove, handleUp]);

    const handleStraightenMouseDown = (e: any) => {
      if (e.evt.button !== 0 && !e.evt.touches) {
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
      if (e.evt && e.evt.cancelable) e.evt.preventDefault();
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

    const cropPreviewUrl = uncroppedAdjustedPreviewUrl || selectedImage.thumbnailUrl;
    const originalSrc = transformedOriginalUrl;
    const isShowingOriginal = showOriginal && !!originalSrc;

    useEffect(() => {
      if (!originalSrc) {
        setOriginalLoaded(false);
        return;
      }

      const img = new Image();
      img.src = originalSrc;

      if (img.complete) {
        setOriginalLoaded(true);
      } else {
        setOriginalLoaded(false);
        img.onload = () => setOriginalLoaded(true);
      }

      return () => {
        img.onload = null;
      };
    }, [originalSrc]);

    const currentTarget = finalPreviewUrl || selectedImage.thumbnailUrl;
    const baseIsReady = displayState.base === currentTarget && !displayState.fade;

    const visiblePatch = interactivePatch ?? (baseIsReady ? null : retainedPatchRef.current);

    useEffect(() => {
      if (baseIsReady && !interactivePatch) {
        retainedPatchRef.current = null;
      }
    }, [baseIsReady, interactivePatch]);

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
      const rotation = liveRotation !== null && liveRotation !== undefined ? liveRotation : adjustments.rotation || 0;
      return `rotate(${rotation}deg)`;
    }, [adjustments.rotation, liveRotation]);

    const getCropDimensions = () => {
      if (!crop || !uncroppedImageRenderSize?.width || !uncroppedImageRenderSize?.height) {
        return { width: 0, height: 0 };
      }

      const width = crop.unit === '%' ? uncroppedImageRenderSize.width * (crop.width / 100) : crop.width;
      const height = crop.unit === '%' ? uncroppedImageRenderSize.height * (crop.height / 100) : crop.height;

      return { width, height };
    };

    const effectiveCursor = useMemo(() => {
      if (isWbPickerActive) return 'crosshair';
      if (isParametricActive) return 'crosshair';
      if (isInitialDrawing) return 'crosshair';
      if (isBrushActive) return 'none';
      if (isAiSubjectActive) return 'crosshair';
      return cursorStyle;
    }, [isWbPickerActive, isInitialDrawing, isBrushActive, isAiSubjectActive, isParametricActive, cursorStyle]);

    const handlePreviewUpdate = useCallback(
      (id: string, subMaskPreview: Partial<SubMask>) => {
        if (!activeContainer || !onLiveMaskPreview) return;
        const previewContainer = {
          ...activeContainer,
          subMasks: activeContainer.subMasks.map((sm: SubMask) => (sm.id === id ? { ...sm, ...subMaskPreview } : sm)),
        };
        onLiveMaskPreview(previewContainer);
      },
      [activeContainer, onLiveMaskPreview],
    );

    const handleMaskInteractionStart = useCallback(
      (e?: any) => {
        const eventType = e?.evt?.type;
        if (eventType === 'touchstart') {
          setIsMaskTouchInteracting(true);
        }
      },
      [setIsMaskTouchInteracting],
    );

    const handleMaskInteractionEnd = useCallback(() => {
      setIsMaskTouchInteracting(false);
    }, [setIsMaskTouchInteracting]);

    return (
      <div className="relative" style={{ width: '100%', height: '100%', cursor: effectiveCursor }}>
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
              position: 'relative',
              width: '100%',
            }}
          >
            <div className="absolute inset-0 w-full h-full">
              <svg
                className="pointer-events-none"
                style={
                  imageRenderSize.width > 0 && imageRenderSize.height > 0
                    ? {
                        position: 'absolute',
                        left: `${imageRenderSize.offsetX}px`,
                        top: `${imageRenderSize.offsetY}px`,
                        width: `${imageRenderSize.width}px`,
                        height: `${imageRenderSize.height}px`,
                        overflow: 'visible',
                      }
                    : {
                        position: 'absolute',
                        inset: '0px',
                        width: '100%',
                        height: '100%',
                        overflow: 'visible',
                      }
                }
                preserveAspectRatio={imageRenderSize.width > 0 && imageRenderSize.height > 0 ? 'none' : 'xMidYMid meet'}
              >
                {displayState.base && !isWgpuActive && (
                  <image
                    href={displayState.base}
                    x="0"
                    y="0"
                    width="100%"
                    height="100%"
                    style={{ imageRendering: isMaxZoom ? 'pixelated' : 'auto' }}
                  />
                )}

                {displayState.fade && !isWgpuActive && (
                  <image
                    href={displayState.fade}
                    x="0"
                    y="0"
                    width="100%"
                    height="100%"
                    style={{
                      imageRendering: isMaxZoom ? 'pixelated' : 'auto',
                      opacity: isFadingIn ? 1 : 0,
                      transition: 'opacity 150ms ease-in-out',
                    }}
                  />
                )}

                {visiblePatch && !isWgpuActive && (
                  <image
                    href={visiblePatch.url}
                    x={`${visiblePatch.normX * 100}%`}
                    y={`${visiblePatch.normY * 100}%`}
                    width={`${visiblePatch.normW * 100}%`}
                    height={`${visiblePatch.normH * 100}%`}
                    preserveAspectRatio="none"
                    style={{ imageRendering: isMaxZoom ? 'pixelated' : 'auto' }}
                  />
                )}
              </svg>

              {originalSrc && (
                <img
                  alt="Original"
                  className={
                    imageRenderSize.width > 0 && imageRenderSize.height > 0
                      ? 'pointer-events-none'
                      : 'absolute inset-0 w-full h-full object-contain pointer-events-none'
                  }
                  src={originalSrc}
                  style={
                    imageRenderSize.width > 0 && imageRenderSize.height > 0
                      ? {
                          position: 'absolute',
                          left: `${imageRenderSize.offsetX}px`,
                          top: `${imageRenderSize.offsetY}px`,
                          width: `${imageRenderSize.width}px`,
                          height: `${imageRenderSize.height}px`,
                          imageRendering: isMaxZoom ? 'pixelated' : 'auto',
                          opacity: isShowingOriginal && originalLoaded ? 1 : 0,
                          transition: originalLoaded ? 'opacity 150ms ease-in-out' : 'none',
                          zIndex: 2,
                        }
                      : {
                          imageRendering: isMaxZoom ? 'pixelated' : 'auto',
                          opacity: isShowingOriginal && originalLoaded ? 1 : 0,
                          transition: originalLoaded ? 'opacity 150ms ease-in-out' : 'none',
                          zIndex: 2,
                        }
                  }
                />
              )}
              {displayedMaskUrl && (
                <img
                  alt="Mask Overlay"
                  className="absolute object-contain pointer-events-none"
                  src={displayedMaskUrl}
                  style={{
                    height: `${imageRenderSize.height}px`,
                    left: `${imageRenderSize.offsetX}px`,
                    opacity: isShowingOriginal || isMaskControlHovered ? 0 : 1,
                    top: `${imageRenderSize.offsetY}px`,
                    transition: 'opacity 300ms ease-in-out',
                    width: `${imageRenderSize.width}px`,
                    imageRendering: isMaxZoom ? 'pixelated' : 'auto',
                    zIndex: 3,
                  }}
                />
              )}
            </div>
          </div>

          {(isMasking || isAiEditing || isWbPickerActive) && (
            <Stage
              height={imageRenderSize.height}
              onMouseDown={handleStart}
              onTouchStart={handleStart}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
              onMouseMove={handleMove}
              onTouchMove={handleMove}
              onMouseUp={handleUp}
              onTouchEnd={handleUp}
              style={{
                cursor: effectiveCursor,
                left: `${imageRenderSize.offsetX}px`,
                opacity: isShowingOriginal ? 0 : 1,
                transition: 'opacity 150ms ease-in-out',
                position: 'absolute',
                top: `${imageRenderSize.offsetY}px`,
                zIndex: 4,
                touchAction: 'none',
                userSelect: 'none',
              }}
              width={imageRenderSize.width}
            >
              <Layer listening={!showOriginal}>
                {(isMasking || isAiEditing) &&
                  activeContainer &&
                  sortedSubMasks.map((subMask: SubMask) => {
                    const activeId = isMasking ? activeMaskId : activeAiSubMaskId;
                    const renderSubMask =
                      subMask.id === activeId && localInitialDrawParams
                        ? { ...subMask, parameters: localInitialDrawParams }
                        : subMask;

                    return (
                      <MaskOverlay
                        adjustments={adjustments}
                        imageHeight={effectiveImageDimensions.height}
                        imageWidth={effectiveImageDimensions.width}
                        isSelected={renderSubMask.id === activeId}
                        isToolActive={isToolActive}
                        key={renderSubMask.id}
                        onMaskInteractionEnd={handleMaskInteractionEnd}
                        onMaskInteractionStart={handleMaskInteractionStart}
                        onMaskMouseEnter={() => !isToolActive && setIsMaskHovered(true)}
                        onMaskMouseLeave={() => !isToolActive && setIsMaskHovered(false)}
                        onPreviewUpdate={handlePreviewUpdate}
                        onSelect={() =>
                          isMasking ? onSelectMask(renderSubMask.id) : onSelectAiSubMask(renderSubMask.id)
                        }
                        onUpdate={updateSubMask}
                        scale={imageRenderSize.scale}
                        subMask={renderSubMask}
                      />
                    );
                  })}

                {previewBox && (
                  <Rect
                    x={Math.min(previewBox.start.x, previewBox.end.x)}
                    y={Math.min(previewBox.start.y, previewBox.end.y)}
                    width={Math.abs(previewBox.end.x - previewBox.start.x)}
                    height={Math.abs(previewBox.end.y - previewBox.start.y)}
                    stroke="#0ea5e9"
                    strokeWidth={2}
                    dash={[4, 4]}
                    listening={false}
                  />
                )}
                {isBrushActive && cursorPreview.visible && (
                  <Circle
                    listening={false}
                    perfectDrawEnabled={false}
                    stroke={
                      (window as any).altKeyDown
                        ? baseTool === ToolType.Brush
                          ? '#f43f5e'
                          : '#0ea5e9'
                        : baseTool === ToolType.Eraser
                          ? '#f43f5e'
                          : '#0ea5e9'
                    }
                    radius={brushStageSize / 2}
                    strokeWidth={1}
                    x={cursorPreview.x}
                    y={cursorPreview.y}
                  />
                )}
              </Layer>
            </Stage>
          )}
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
                  const currentOverlayMode = isRotationActive || isStraightenActive ? 'none' : overlayMode || 'none';
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
                    imageRendering: isMaxZoom ? 'pixelated' : 'auto',
                  }}
                />
              </ReactCrop>

              {isStraightenActive && (
                <Stage
                  height={uncroppedImageRenderSize.height}
                  onMouseDown={handleStraightenMouseDown}
                  onTouchStart={handleStraightenMouseDown}
                  onMouseLeave={handleStraightenMouseLeave}
                  onMouseMove={handleStraightenMouseMove}
                  onTouchMove={handleStraightenMouseMove}
                  onMouseUp={handleStraightenMouseUp}
                  onTouchEnd={handleStraightenMouseUp}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    zIndex: 10,
                    cursor: 'crosshair',
                    touchAction: 'none',
                  }}
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
