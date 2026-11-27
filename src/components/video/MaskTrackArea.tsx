import { useRef, useState } from 'react';
import { Circle, Group, Line, Rect } from 'react-konva';
import type Konva from 'konva';
import { useShallow } from 'zustand/react/shallow';
import { Quad } from '../../types/video';
import { useEditorActions } from '../../hooks/useEditorActions';
import { Adjustments } from '../../utils/adjustments';
import { alignHaptic } from '../../utils/haptics';
import { Point } from '../../utils/maskShapes';
import { useVideoStore } from '../../store/useVideoStore';
import { loadMaskSnaps, maskSnapPoints, useVideoMotion } from '../../store/videoMotion';
import { MaskWarp, Trackable, invertWarp, warpPoint, warpQuad } from '../../utils/video/maskTracking';
import { boundsQuad, isConvex, quadBounds, scaleQuad, snapCorner } from '../../utils/video/planar';
import { Region, dragRegion, regionQuad } from '../../utils/video/tracking';
import {
  ACCENT,
  OUTLINE_HIT_PX,
  PLANE_HANDLE_PX,
  ShapeEvent,
  hoverProps,
  imagePointer,
  stopBubble,
  useDrag,
} from '../panel/editor/overlays/ShapeMaskOverlay';
import { useCanvasHover } from './VideoCanvasOverlay';

const AREA_FILL = `${ACCENT}1f`;

const BOX_CORNERS: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

interface Size {
  width: number;
  height: number;
}

interface MaskTrackAreaProps {
  container: Trackable | null | undefined;
  list: 'masks' | 'aiPatches';
  warp: MaskWarp | null;
  frame: Size;
  cropX: number;
  cropY: number;
  scale: number;
  zoomScale: number;
  hidden: boolean;
  disabled: boolean;
  getPointer(stage: Konva.Stage): Point | null;
  setIsMaskHovered(isHovered: boolean): void;
}

interface AreaDrag {
  corner: number | null;
  quad: Quad;
  box: Region;
}

const boxed = (points: Array<[number, number]>) => boundsQuad(quadBounds(points));

const regionOf = (quad: Quad): Region => {
  const { left, top, right, bottom } = quadBounds(quad);
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const prefetchSnaps = (hovered: boolean) => {
  if (hovered) void loadMaskSnaps();
};

function AreaEditor({
  container,
  list,
  area,
  warp,
  frame,
  cropX,
  cropY,
  scale,
  zoomScale,
  shown,
  disabled,
  getPointer,
  setIsMaskHovered,
}: Omit<MaskTrackAreaProps, 'hidden'> & { container: Trackable; area: Quad; shown: boolean }) {
  const { planar, busy } = useVideoMotion(
    useShallow((state) => ({ planar: state.trackKind === 'planar', busy: state.tracking !== null })),
  );
  const { setAdjustments } = useEditorActions();
  const [live, setLive] = useState<Quad | null>(null);
  const liveRef = useRef<Quad | null>(null);
  const interactive = shown && !busy && !disabled;
  const hover = useCanvasHover(setIsMaskHovered, interactive);

  const inverse = warp && invertWarp(warp);
  const reference = scaleQuad(planar ? area : boxed(area), frame.width, frame.height);
  const quad = live ?? warpQuad(warp, reference);
  const pointerAt = imagePointer({ getPointer, scale, cropX, cropY });
  const unwarp = (x: number, y: number) => (inverse ? warpPoint(inverse, x, y) : { x, y });
  const toCanvas = ([x, y]: [number, number]) => ({ x: (x - cropX) * scale, y: (y - cropY) * scale });

  const show = (next: Quad | null) => {
    liveRef.current = next;
    setLive(next);
  };

  const snapEnd = (dragged: Quad, value: AreaDrag, free: boolean) => {
    if (!planar || value.corner === null || free) return dragged;
    const next = snapCorner(dragged, value.corner, maskSnapPoints(frame.width, frame.height), scale * zoomScale);
    if (!next) return dragged;
    alignHaptic(value, next[value.corner]);
    return next;
  };

  const begin = (_event: ShapeEvent, value: AreaDrag) => {
    alignHaptic(value);
    if (planar && value.corner !== null) void loadMaskSnaps();
  };

  const commit = (event: ShapeEvent, value: AreaDrag) => {
    const dragged = liveRef.current;
    if (!dragged) return;
    const placed = warpQuad(inverse, snapEnd(dragged, value, event.evt.shiftKey));
    const unmapped = scaleQuad(placed, 1 / frame.width, 1 / frame.height);
    const trackArea = planar ? unmapped : boxed(unmapped);
    show(null);
    setAdjustments((previous: Adjustments) => ({
      ...previous,
      [list]: (previous[list] as Array<Trackable>).map((entry) =>
        entry.id === container.id ? { ...entry, trackArea } : entry,
      ),
    }));
  };

  const drag = useDrag<AreaDrag>(
    { cropX, cropY, scale, getPointer, onInteractionStart: begin, onInteractionEnd: commit },
    ({ corner, quad: startQuad, box: startBox }, delta, event) => {
      if (planar) {
        const next = startQuad.map(([x, y], index) =>
          corner === null || index === corner ? [x + delta.x, y + delta.y] : [x, y],
        ) as Quad;
        if (corner === null || isConvex(next)) show(next);
        return;
      }
      const pointer = pointerAt(event);
      if (!pointer) return;
      const to = unwarp(pointer.x, pointer.y);
      const from = unwarp(pointer.x - delta.x, pointer.y - delta.y);
      const next = dragRegion(
        startBox,
        corner === null ? null : BOX_CORNERS[corner],
        to.x - from.x,
        to.y - from.y,
        frame,
      );
      show(warpQuad(warp, regionQuad(next)));
    },
  );

  const box = regionOf(reference);
  const dragFrom = (corner: number | null): AreaDrag => ({ corner, quad, box });
  const handle = PLANE_HANDLE_PX / zoomScale;
  const handleProps = {
    fill: 'white',
    stroke: ACCENT,
    strokeWidth: 1.5,
    strokeScaleEnabled: false,
    shadowColor: 'black',
    shadowBlur: 2 / zoomScale,
    shadowOpacity: 0.5,
    visible: interactive,
    draggable: true,
    dragBoundFunc: drag.dragBoundFunc,
    onMouseDown: stopBubble,
    onTouchStart: stopBubble,
    onDragMove: drag.onDragMove,
    onDragEnd: drag.onDragEnd,
  };

  return (
    <Group visible={shown} listening={interactive}>
      <Line
        points={quad.flatMap((corner) => {
          const { x, y } = toCanvas(corner);
          return [x, y];
        })}
        closed
        stroke={ACCENT}
        strokeWidth={2}
        strokeScaleEnabled={false}
        dash={[6, 4]}
        fill={live ? AREA_FILL : undefined}
        hitStrokeWidth={OUTLINE_HIT_PX * 2}
        draggable
        dragBoundFunc={drag.dragBoundFunc}
        onDragStart={drag.start(dragFrom(null))}
        onDragMove={drag.onDragMove}
        onDragEnd={drag.onDragEnd}
        {...hoverProps({ onHover: hover }, 'move')}
      />
      {quad.map((corner, index) => {
        const { x, y } = toCanvas(corner);
        const [cx, cy] = BOX_CORNERS[index];
        return planar ? (
          <Circle
            key={index}
            {...handleProps}
            x={x}
            y={y}
            radius={handle}
            onDragStart={drag.start(dragFrom(index))}
            {...hoverProps({ onHover: hover }, 'crosshair', prefetchSnaps)}
          />
        ) : (
          <Rect
            key={index}
            {...handleProps}
            x={x}
            y={y}
            width={handle * 2}
            height={handle * 2}
            offsetX={handle}
            offsetY={handle}
            cornerRadius={1.5 / zoomScale}
            onDragStart={drag.start(dragFrom(index))}
            {...hoverProps({ onHover: hover }, cx === cy ? 'nwse-resize' : 'nesw-resize')}
          />
        );
      })}
    </Group>
  );
}

export default function MaskTrackArea({ hidden, ...props }: MaskTrackAreaProps) {
  const video = useVideoStore((state) => state.session !== null);
  const playing = useVideoStore((state) => state.isPlaying);
  const area = props.container?.trackArea;
  if (!video || !props.container || !area || props.scale <= 0) return null;
  return <AreaEditor {...props} container={props.container} area={area} shown={!playing && !hidden} />;
}
