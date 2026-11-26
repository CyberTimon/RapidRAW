import { useEffect, useRef, useState } from 'react';
import { Circle, Group, Line, Rect, Shape, Transformer } from 'react-konva';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { useTranslation } from 'react-i18next';
import { Spline, Trash2, TriangleRight } from 'lucide-react';
import { useContextMenu } from '../../../../context/ContextMenuContext';
import { SubMask } from '../../../../types/masks';
import {
  HandleSide,
  PenPoint,
  Point,
  cubicAt,
  handleOf,
  hasHandles,
  isSmoothPoint,
  moveHandle,
  nearestOnPen,
  penSegments,
  splitPen,
  toggleSmooth,
  translatePen,
} from '../../../../utils/maskShapes';
import { Homography, invert, localScale, project } from '../../../../utils/video/planar';

export const ACCENT = '#0ea5e9';
export const OUTLINE_HIT_PX = 8;
export const PLANE_HANDLE_PX = 4.5;
const MIN_TRANSFORM_PX = 5;
const MIN_POINTS = 3;
const ANCHOR_PX = 4.5;
const SELECTED_ANCHOR_PX = 5.5;
const HOVERED_ANCHOR_PX = 6.5;
const ANCHOR_HIT_PX = 8;
const CLOSE_RING_PX = 11;
const INSERT_PX = 3.5;

export type ShapeParameters = SubMask['parameters'];
export type ShapeEvent = KonvaEventObject<MouseEvent | TouchEvent | DragEvent>;

interface ShapeMaskProps {
  parameters: ShapeParameters;
  cropX: number;
  cropY: number;
  scale: number;
  zoomScale: number;
  isSelected: boolean;
  isToolActive: boolean;
  outline: Konva.ShapeConfig;
  onSelect?: () => void;
  onInteractionStart(event: ShapeEvent): void;
  onLiveChange(parameters: ShapeParameters): void;
  onChange(parameters: ShapeParameters): void;
  onInteractionEnd(): void;
  onHover(hovered: boolean): void;
  getPointer(stage: Konva.Stage): Point | null;
}

type PointerProps = Pick<ShapeMaskProps, 'cropX' | 'cropY' | 'scale' | 'getPointer'>;

type DragProps<T> = PointerProps & {
  onInteractionStart(event: ShapeEvent, value: T): void;
  onInteractionEnd(event: ShapeEvent, value: T): void;
};

const lockPosition = function (this: Konva.Node) {
  return this.getAbsolutePosition();
};

const setCursor = (event: ShapeEvent, cursor: string) => {
  const stage = event.target.getStage();
  if (stage) stage.container().style.cursor = cursor;
};

const isPrimary = (event: ShapeEvent) => !('button' in event.evt) || event.evt.button === 0;

let deleteActivePoint: (() => void) | null = null;

export const hasActivePenPoint = () => deleteActivePoint !== null;

export const deleteActivePenPoint = () => deleteActivePoint?.();

export function imagePointer({ getPointer, scale, cropX, cropY }: PointerProps) {
  return (event: ShapeEvent): Point | null => {
    const stage = event.target.getStage();
    const pointer = stage && getPointer(stage);
    return pointer && { x: pointer.x / scale + cropX, y: pointer.y / scale + cropY };
  };
}

export function useDrag<T>(props: DragProps<T>, update: (origin: T, delta: Point, event: ShapeEvent) => void) {
  const pointerAt = imagePointer(props);
  const origin = useRef<{ pointer: Point; value: T } | null>(null);
  return {
    dragBoundFunc: lockPosition,
    start: (value: T) => (event: ShapeEvent) => {
      const pointer = pointerAt(event);
      if (!isPrimary(event) || !pointer) return;
      event.cancelBubble = true;
      origin.current = { pointer, value };
      props.onInteractionStart(event, value);
    },
    onDragMove: (event: ShapeEvent) => {
      const pointer = pointerAt(event);
      if (!origin.current || !pointer) return;
      const delta = { x: pointer.x - origin.current.pointer.x, y: pointer.y - origin.current.pointer.y };
      update(origin.current.value, delta, event);
    },
    onDragEnd: (event: ShapeEvent) => {
      event.cancelBubble = true;
      const started = origin.current;
      if (!started) return;
      origin.current = null;
      props.onInteractionEnd(event, started.value);
    },
  };
}

export const hoverProps = (
  props: Pick<ShapeMaskProps, 'onHover'>,
  cursor: string,
  onHover?: (hovered: boolean) => void,
) => ({
  onMouseEnter: (event: ShapeEvent) => {
    props.onHover(true);
    onHover?.(true);
    setCursor(event, cursor);
  },
  onMouseLeave: (event: ShapeEvent) => {
    props.onHover(false);
    onHover?.(false);
    setCursor(event, '');
  },
});

export const stopBubble = (event: ShapeEvent) => {
  event.cancelBubble = true;
};

export function RectangleMaskShape(props: ShapeMaskProps) {
  const { parameters: p, cropX, cropY, scale, isSelected, isToolActive, outline, onSelect } = props;
  const shapeRef = useRef<Konva.Rect>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const editable = isSelected && !isToolActive;
  const drag = useDrag<ShapeParameters>(props, (origin, delta) =>
    props.onChange({ ...origin, centerX: origin.centerX + delta.x, centerY: origin.centerY + delta.y }),
  );

  useEffect(() => {
    if (editable && transformerRef.current && shapeRef.current) {
      transformerRef.current.nodes([shapeRef.current]);
      transformerRef.current.getLayer()?.batchDraw();
    }
  }, [editable]);

  const width = Math.abs(p.width ?? 0) * scale;
  const height = Math.abs(p.height ?? 0) * scale;
  if (p.isInitialDraw && (width < 1 || height < 1)) return null;

  const readNode = (): ShapeParameters => {
    const node = shapeRef.current!;
    return {
      ...p,
      centerX: node.x() / scale + cropX,
      centerY: node.y() / scale + cropY,
      width: (node.width() * Math.abs(node.scaleX())) / scale,
      height: (node.height() * Math.abs(node.scaleY())) / scale,
      rotation: node.rotation(),
    };
  };

  return (
    <Group>
      <Rect
        {...outline}
        ref={shapeRef}
        x={(p.centerX - cropX) * scale}
        y={(p.centerY - cropY) * scale}
        width={Math.max(0.1, width)}
        height={Math.max(0.1, height)}
        offsetX={Math.max(0.1, width) / 2}
        offsetY={Math.max(0.1, height) / 2}
        rotation={p.rotation ?? 0}
        cornerRadius={(Math.min(1, Math.max(0, p.roundness ?? 0)) * Math.min(width, height)) / 2}
        fill="transparent"
        listening={!isToolActive}
        onClick={onSelect}
        onTap={onSelect}
        draggable={editable}
        dragBoundFunc={drag.dragBoundFunc}
        onDragStart={drag.start(p)}
        onDragMove={drag.onDragMove}
        onDragEnd={drag.onDragEnd}
        {...hoverProps(props, editable ? 'move' : 'pointer')}
      />
      {editable && (
        <Transformer
          ref={transformerRef}
          rotateEnabled
          keepRatio={false}
          rotationSnaps={[0, 90, 180, 270]}
          rotationSnapTolerance={4}
          ignoreStroke
          onMouseDown={(event) => {
            if (!isPrimary(event)) return;
            event.cancelBubble = true;
            event.evt.preventDefault();
          }}
          boundBoxFunc={(oldBox, newBox) =>
            Math.abs(newBox.width) < MIN_TRANSFORM_PX || Math.abs(newBox.height) < MIN_TRANSFORM_PX ? oldBox : newBox
          }
          onTransformStart={props.onInteractionStart}
          onTransform={() => props.onLiveChange(readNode())}
          onTransformEnd={() => {
            const next = readNode();
            shapeRef.current?.scaleX(1);
            shapeRef.current?.scaleY(1);
            props.onChange(next);
            props.onInteractionEnd();
          }}
          onMouseEnter={() => props.onHover(true)}
          onMouseLeave={() => props.onHover(false)}
        />
      )}
    </Group>
  );
}

interface HandleDrag {
  index: number;
  point: PenPoint;
  side: HandleSide;
  smooth: boolean;
}

export function PenMaskShape(props: ShapeMaskProps) {
  const { parameters: p, cropX, cropY, scale, zoomScale, isSelected, isToolActive, outline, onSelect } = props;
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const [selection, setSelection] = useState<{ id: string; last?: string } | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [insertAt, setInsertAt] = useState<Point | null>(null);
  const pointerAt = imagePointer(props);
  const points: Array<PenPoint> = p.points ?? [];
  const closed = !!p.closed;
  const drawing = !!p.isInitialDraw;
  const editable = isSelected && !isToolActive && closed;
  const interactive = editable || (isSelected && drawing);
  const closable = isSelected && drawing && points.length >= MIN_POINTS;
  const minPoints = drawing ? 1 : MIN_POINTS;
  const lastId = points.at(-1)?.id;
  const activeId = !interactive ? null : drawing && selection?.last !== lastId ? lastId : selection?.id;
  const activeIndex = activeId ? points.findIndex((point) => point.id === activeId) : -1;
  const px = (value: number) => value / zoomScale;
  const toCanvas = (point: Point) => ({ x: (point.x - cropX) * scale, y: (point.y - cropY) * scale });
  const withPoints = (next: Array<PenPoint>) => ({ ...p, points: next });
  const select = (id: string) => setSelection({ id, last: lastId });

  const moveShape = useDrag<Array<PenPoint>>(props, (origin, delta) =>
    props.onChange(withPoints(translatePen(origin, delta.x, delta.y))),
  );
  const replacePoint = (index: number, moved: PenPoint) =>
    props.onChange(withPoints(points.map((point, i) => (i === index ? moved : point))));
  const moveAnchor = useDrag<{ index: number; point: PenPoint }>(props, ({ index, point }, delta) =>
    replacePoint(index, { ...point, x: point.x + delta.x, y: point.y + delta.y }),
  );
  const moveHandleDrag = useDrag<HandleDrag>(props, ({ index, point, side, smooth }, delta, event) => {
    const handle = handleOf(point, side);
    const offset = { x: handle.x + delta.x, y: handle.y + delta.y };
    replacePoint(index, moveHandle(point, side, offset, smooth && !event.evt.altKey));
  });
  const deletePoint = (index: number) => {
    if (points.length <= minPoints) return;
    select(points[(index - 1 + points.length) % points.length].id);
    props.onChange(withPoints(points.filter((_, i) => i !== index)));
  };

  useEffect(() => {
    if (!isSelected) setSelection(null);
  }, [isSelected]);

  useEffect(() => {
    if (activeIndex < 0) return;
    const remove = () => deletePoint(activeIndex);
    deleteActivePoint = remove;
    return () => {
      if (deleteActivePoint === remove) deleteActivePoint = null;
    };
  });

  if (points.length === 0) return null;

  const nearOutline = (event: ShapeEvent) => {
    const pointer = pointerAt(event);
    const nearest = pointer && nearestOnPen(points, closed, pointer);
    return nearest && nearest.distance * scale * zoomScale <= OUTLINE_HIT_PX ? nearest : null;
  };

  const showInsert = (event: ShapeEvent) => {
    if (!editable) return;
    const nearest = nearOutline(event);
    setCursor(event, nearest ? 'copy' : 'move');
    setInsertAt(nearest && cubicAt(penSegments(points, closed)[nearest.index], nearest.t));
  };

  const addPoint = (event: ShapeEvent) => {
    if (!isPrimary(event)) return;
    const nearest = nearOutline(event);
    if (!nearest) return;
    const next = splitPen(points, closed, nearest.index, nearest.t);
    select(next[nearest.index + 1].id);
    setInsertAt(null);
    props.onChange(withPoints(next));
  };

  const closePath = () => {
    const { isInitialDraw: _drawing, ...rest } = p;
    setSelection(null);
    props.onChange({ ...rest, closed: true });
  };

  const pressAnchor = (event: ShapeEvent, index: number) => {
    event.cancelBubble = true;
    if (!isPrimary(event)) return;
    if (index === 0 && closable) closePath();
    else select(points[index].id);
  };

  const hoverAnchor = (id: string) => (hovered: boolean) =>
    setHoveredId((current) => (hovered ? id : current === id ? null : current));

  const anchorHit = (context: Konva.Context, shape: Konva.Shape) => {
    context.beginPath();
    context.arc(0, 0, px(ANCHOR_HIT_PX), 0, Math.PI * 2, false);
    context.closePath();
    context.fillStrokeShape(shape);
  };

  const openPointMenu = (event: KonvaEventObject<PointerEvent>, index: number) => {
    event.evt.preventDefault();
    event.evt.stopPropagation();
    event.cancelBubble = true;
    select(points[index].id);
    const curved = hasHandles(points[index]);
    showContextMenu(event.evt.clientX, event.evt.clientY, [
      {
        label: t(curved ? 'editor.masks.pen.makeCorner' : 'editor.masks.pen.makeSmooth'),
        icon: curved ? TriangleRight : Spline,
        onClick: () => props.onChange(withPoints(toggleSmooth(points, closed, index))),
      },
      {
        label: t('editor.masks.pen.deletePoint'),
        icon: Trash2,
        disabled: points.length <= minPoints,
        onClick: () => deletePoint(index),
      },
    ]);
  };

  const drawPath = (context: Konva.Context, shape: Konva.Shape) => {
    const start = toCanvas(points[0]);
    context.beginPath();
    context.moveTo(start.x, start.y);
    penSegments(points, closed).forEach(([, first, second, end]) => {
      const a = toCanvas(first);
      const b = toCanvas(second);
      const c = toCanvas(end);
      context.bezierCurveTo(a.x, a.y, b.x, b.y, c.x, c.y);
    });
    if (closed) context.closePath();
    context.fillStrokeShape(shape);
  };

  return (
    <Group>
      <Shape
        {...outline}
        sceneFunc={drawPath}
        fill={closed ? 'transparent' : undefined}
        hitStrokeWidth={OUTLINE_HIT_PX * 2}
        listening={!drawing && !isToolActive}
        onClick={editable ? addPoint : onSelect}
        onTap={editable ? addPoint : onSelect}
        draggable={editable}
        dragBoundFunc={moveShape.dragBoundFunc}
        onDragStart={moveShape.start(points)}
        onDragMove={moveShape.onDragMove}
        onDragEnd={moveShape.onDragEnd}
        onMouseMove={showInsert}
        {...hoverProps(props, editable ? 'move' : 'pointer', (hovered) => !hovered && setInsertAt(null))}
      />
      {editable && insertAt && !hoveredId && (
        <Circle
          {...toCanvas(insertAt)}
          radius={px(INSERT_PX)}
          fill="white"
          stroke={ACCENT}
          strokeWidth={1.5}
          strokeScaleEnabled={false}
          opacity={0.85}
          listening={false}
        />
      )}
      {activeIndex >= 0 &&
        (['in', 'out'] as const).map((side) => {
          const point = points[activeIndex];
          const offset = handleOf(point, side);
          if (offset.x === 0 && offset.y === 0) return null;
          const anchor = toCanvas(point);
          const end = toCanvas({ x: point.x + offset.x, y: point.y + offset.y });
          return (
            <Group key={side}>
              <Line
                points={[anchor.x, anchor.y, end.x, end.y]}
                stroke={ACCENT}
                strokeWidth={1}
                strokeScaleEnabled={false}
                listening={false}
              />
              <Circle
                x={end.x}
                y={end.y}
                radius={px(3.5)}
                fill={ACCENT}
                stroke="white"
                strokeWidth={1}
                strokeScaleEnabled={false}
                draggable
                dragBoundFunc={moveHandleDrag.dragBoundFunc}
                onMouseDown={stopBubble}
                onTouchStart={stopBubble}
                onDragStart={moveHandleDrag.start({ index: activeIndex, point, side, smooth: isSmoothPoint(point) })}
                onDragMove={moveHandleDrag.onDragMove}
                onDragEnd={moveHandleDrag.onDragEnd}
                {...hoverProps(props, 'grab')}
              />
            </Group>
          );
        })}
      {(isSelected || drawing) &&
        points.map((point, index) => {
          const at = toCanvas(point);
          const hovered = interactive && point.id === hoveredId;
          const closing = hovered && closable && index === 0;
          const filled = index === activeIndex || closing;
          return (
            <Group key={point.id}>
              {closing && (
                <Circle
                  x={at.x}
                  y={at.y}
                  radius={px(CLOSE_RING_PX)}
                  stroke={ACCENT}
                  strokeWidth={2}
                  strokeScaleEnabled={false}
                  listening={false}
                />
              )}
              <Circle
                x={at.x}
                y={at.y}
                radius={px(hovered ? HOVERED_ANCHOR_PX : index === activeIndex ? SELECTED_ANCHOR_PX : ANCHOR_PX)}
                fill={filled ? ACCENT : 'white'}
                stroke={filled ? 'white' : ACCENT}
                strokeWidth={hovered ? 2 : 1.5}
                strokeScaleEnabled={false}
                hitFunc={anchorHit}
                listening={interactive}
                draggable={interactive}
                dragBoundFunc={moveAnchor.dragBoundFunc}
                onMouseDown={(event) => pressAnchor(event, index)}
                onTouchStart={(event) => pressAnchor(event, index)}
                onClick={(event) => event.evt.altKey && props.onChange(withPoints(toggleSmooth(points, closed, index)))}
                onContextMenu={(event) => openPointMenu(event, index)}
                onDragStart={moveAnchor.start({ index, point })}
                onDragMove={moveAnchor.onDragMove}
                onDragEnd={moveAnchor.onDragEnd}
                {...hoverProps(props, 'pointer', hoverAnchor(point.id))}
              />
            </Group>
          );
        })}
    </Group>
  );
}

const OUTLINE_STEPS = 72;
const CORNER_STEPS = 8;
const ROTATE_GAP_PX = 28;

type PlaneHandle = 'corner' | 'axisX' | 'axisY' | 'rotate';

interface PlaneDrag {
  parameters: ShapeParameters;
  handle: PlaneHandle;
  sx: number;
  sy: number;
}

const PLANE_HANDLES: Record<'rectangle' | 'ellipse', Array<[PlaneHandle, number, number]>> = {
  rectangle: [
    ['corner', 1, 1],
    ['corner', -1, 1],
    ['corner', -1, -1],
    ['corner', 1, -1],
    ['rotate', 0, -1],
  ],
  ellipse: [
    ['axisX', 1, 0],
    ['axisX', -1, 0],
    ['axisY', 0, 1],
    ['axisY', 0, -1],
    ['rotate', 0, -1],
  ],
};

const planeOutline = (p: ShapeParameters, rectangle: boolean): Array<[number, number]> => {
  if (!rectangle)
    return Array.from({ length: OUTLINE_STEPS }, (_, index) => {
      const angle = (index / OUTLINE_STEPS) * Math.PI * 2;
      return [Math.cos(angle) * (p.radiusX ?? 0), Math.sin(angle) * (p.radiusY ?? 0)];
    });
  const halfX = Math.abs(p.width ?? 0) / 2;
  const halfY = Math.abs(p.height ?? 0) / 2;
  const radius = Math.min(1, Math.max(0, p.roundness ?? 0)) * Math.min(halfX, halfY);
  return [
    [1, 1, 0],
    [-1, 1, 0.5],
    [-1, -1, 1],
    [1, -1, 1.5],
  ].flatMap(([sx, sy, start]) =>
    Array.from({ length: radius > 0 ? CORNER_STEPS + 1 : 1 }, (_, step): [number, number] => {
      const angle = (start + (step / CORNER_STEPS) * 0.5) * Math.PI;
      return [sx * (halfX - radius) + radius * Math.cos(angle), sy * (halfY - radius) + radius * Math.sin(angle)];
    }),
  );
};

const turned = (from: ShapeParameters) => {
  const angle = ((from.rotation ?? 0) * Math.PI) / 180;
  return { cos: Math.cos(angle), sin: Math.sin(angle) };
};

const fromLocal = (from: ShapeParameters, lx: number, ly: number): Point => {
  const { cos, sin } = turned(from);
  return { x: from.centerX + lx * cos - ly * sin, y: from.centerY + lx * sin + ly * cos };
};

const toLocal = (from: ShapeParameters, point: Point): Point => {
  const { cos, sin } = turned(from);
  const dx = point.x - from.centerX;
  const dy = point.y - from.centerY;
  return { x: dx * cos + dy * sin, y: dy * cos - dx * sin };
};

function PlaneMaskShape({ rectangle, ...props }: ShapeMaskProps & { rectangle: boolean }) {
  const { parameters: p, cropX, cropY, scale, zoomScale, isSelected, isToolActive, outline, onSelect } = props;
  const plane = p.plane as Homography;
  const inverse = invert(plane);
  const editable = isSelected && !isToolActive && !!inverse;
  const pointerAt = imagePointer(props);
  const toCanvas = ({ x, y }: Point) => {
    const [px, py] = project(plane, x, y) ?? [x, y];
    return { x: (px - cropX) * scale, y: (py - cropY) * scale };
  };
  const toReference = (point: Point): Point => {
    const [x, y] = (inverse && project(inverse, point.x, point.y)) ?? [point.x, point.y];
    return { x, y };
  };

  const moveShape = useDrag<ShapeParameters>(props, (origin, delta, event) => {
    const pointer = pointerAt(event);
    if (!pointer) return;
    const to = toReference(pointer);
    const from = toReference({ x: pointer.x - delta.x, y: pointer.y - delta.y });
    props.onChange({ ...origin, centerX: origin.centerX + to.x - from.x, centerY: origin.centerY + to.y - from.y });
  });

  const moveHandle = useDrag<PlaneDrag>(props, ({ parameters: origin, handle, sx, sy }, _delta, event) => {
    const pointer = pointerAt(event);
    if (!pointer) return;
    const reference = toReference(pointer);
    if (handle === 'rotate') {
      const degrees = (Math.atan2(reference.y - origin.centerY, reference.x - origin.centerX) * 180) / Math.PI + 90;
      props.onChange({ ...origin, rotation: degrees > 180 ? degrees - 360 : degrees });
      return;
    }
    const local = toLocal(origin, reference);
    if (handle === 'axisX') props.onChange({ ...origin, radiusX: Math.max(1, Math.abs(local.x)) });
    else if (handle === 'axisY') props.onChange({ ...origin, radiusY: Math.max(1, Math.abs(local.y)) });
    else {
      const opposite = fromLocal(origin, (-sx * Math.abs(origin.width)) / 2, (-sy * Math.abs(origin.height)) / 2);
      const span = toLocal({ ...origin, centerX: opposite.x, centerY: opposite.y }, reference);
      props.onChange({
        ...origin,
        centerX: (reference.x + opposite.x) / 2,
        centerY: (reference.y + opposite.y) / 2,
        width: Math.max(1, Math.abs(span.x)),
        height: Math.max(1, Math.abs(span.y)),
      });
    }
  });

  const halfX = rectangle ? Math.abs(p.width ?? 0) / 2 : (p.radiusX ?? 0);
  const halfY = rectangle ? Math.abs(p.height ?? 0) / 2 : (p.radiusY ?? 0);
  if (p.isInitialDraw && (halfX * scale < 0.5 || halfY * scale < 0.5)) return null;

  const reach = ROTATE_GAP_PX / Math.max(1e-6, scale * zoomScale * localScale(plane, p.centerX, p.centerY));
  const handleAt = (handle: PlaneHandle, sx: number, sy: number) =>
    toCanvas(fromLocal(p, sx * halfX, handle === 'rotate' ? -halfY - reach : sy * halfY));
  const points = planeOutline(p, rectangle).flatMap(([lx, ly]) => {
    const { x, y } = toCanvas(fromLocal(p, lx, ly));
    return [x, y];
  });
  const top = toCanvas(fromLocal(p, 0, -halfY));
  const knob = handleAt('rotate', 0, -1);

  return (
    <Group>
      <Line
        {...outline}
        points={points}
        closed
        fill="transparent"
        listening={!isToolActive}
        onClick={onSelect}
        onTap={onSelect}
        draggable={editable}
        dragBoundFunc={moveShape.dragBoundFunc}
        onDragStart={moveShape.start(p)}
        onDragMove={moveShape.onDragMove}
        onDragEnd={moveShape.onDragEnd}
        {...hoverProps(props, editable ? 'move' : 'pointer')}
      />
      {editable && (
        <Line
          points={[top.x, top.y, knob.x, knob.y]}
          stroke={ACCENT}
          strokeWidth={1}
          strokeScaleEnabled={false}
          listening={false}
        />
      )}
      {editable &&
        PLANE_HANDLES[rectangle ? 'rectangle' : 'ellipse'].map(([handle, sx, sy]) => {
          const at = handleAt(handle, sx, sy);
          return (
            <Circle
              key={`${handle}${sx}${sy}`}
              x={at.x}
              y={at.y}
              radius={PLANE_HANDLE_PX / zoomScale}
              fill={handle === 'rotate' ? ACCENT : 'white'}
              stroke={handle === 'rotate' ? 'white' : ACCENT}
              strokeWidth={1.5}
              strokeScaleEnabled={false}
              draggable
              dragBoundFunc={moveHandle.dragBoundFunc}
              onMouseDown={stopBubble}
              onTouchStart={stopBubble}
              onDragStart={moveHandle.start({ parameters: p, handle, sx, sy })}
              onDragMove={moveHandle.onDragMove}
              onDragEnd={moveHandle.onDragEnd}
              {...hoverProps(props, handle === 'rotate' ? 'grab' : 'pointer')}
            />
          );
        })}
    </Group>
  );
}

export const PlaneRectangleShape = (props: ShapeMaskProps) => <PlaneMaskShape rectangle {...props} />;

export const PlaneEllipseShape = (props: ShapeMaskProps) => <PlaneMaskShape rectangle={false} {...props} />;
