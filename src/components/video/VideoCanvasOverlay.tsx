import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import clsx from 'clsx';
import { Panel } from '../../types/ui';
import { Animated, MediaInfo, Quad, Ticks, Transform, VideoProject, VisualItem } from '../../types/video';
import { Homography, invert, project } from '../../utils/video/planar';
import { useUIStore } from '../../store/useUIStore';
import { editProject, getVideo, selectItems, useVideoStore } from '../../store/useVideoStore';
import { useProgramCanvas } from '../../store/videoView';
import { editPin, setTrackingQuad, setTrackingRegion, useVideoMotion } from '../../store/videoMotion';
import { localTime, setValueAt, valueAt } from '../../utils/video/animation';
import { updateItem, visualItemsAt } from '../../utils/video/edit';
import { contentSize } from '../../utils/video/layouts';
import { invertSimilarity, mapPoint, planeAt, sameCorners } from '../../utils/video/maskTracking';
import { frameTicks, ticksToSeconds } from '../../utils/video/time';
import { alignHaptic } from '../../utils/haptics';
import { ROTATE_RING_PX, rotateCursor } from '../../utils/rotateCursor';
import { Region, dragRegion, layerSimilarity, layerSurface, pinnedQuad, placementAt } from '../../utils/video/tracking';
import { PlaneOutline, QuadEditor } from './PlaneOverlay';
import { focusInspectorText } from './inspector/InspectorControls';

const SNAP_PX = 6;
const HANDLE = 9;

interface VideoCanvasOverlayProps {
  style: CSSProperties;
  imageWidth: number;
  imageHeight: number;
  transformScale: number;
  setIsMaskHovered(isHovered: boolean): void;
}

interface Box {
  item: VisualItem;
  trackIndex: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotation: number;
  quad: Quad | null;
  plane: Quad | null;
  surface: Homography | null;
}

type DragMode = 'move' | 'scale' | 'rotate';

interface Drag {
  mode: DragMode;
  box: Box;
  pointerX: number;
  pointerY: number;
  startScale: number;
  startRotation: number;
}

const boxFor = (
  project: VideoProject,
  item: VisualItem,
  trackIndex: number,
  time: number,
  media: Record<string, MediaInfo>,
): Box | null => {
  if (item.type === 'adjustment') return null;
  const size = contentSize(project, item, media);
  const { width, height } = project.settings;
  const local = time - item.start;
  const placed = placementAt(item.transform, local, width, height);
  return {
    item,
    trackIndex,
    centerX: placed.x,
    centerY: placed.y,
    width: size.width * placed.scale,
    height: size.height * placed.scale,
    rotation: placed.rotation,
    quad: pinnedQuad(item.transform, local, width, height),
    plane: planeAt(item.transform.track, ticksToSeconds(local), width, height),
    surface: layerSurface(item.transform, local, width, height),
  };
};

const NO_BOXES: Array<Box> = [];

const sameBox = (a: Box, b: Box) =>
  a.item === b.item &&
  a.trackIndex === b.trackIndex &&
  a.centerX === b.centerX &&
  a.centerY === b.centerY &&
  a.width === b.width &&
  a.height === b.height &&
  a.rotation === b.rotation &&
  sameCorners(a.quad, b.quad) &&
  sameCorners(a.plane, b.plane) &&
  (a.surface === b.surface ||
    (!!a.surface && !!b.surface && a.surface.every((value, index) => value === b.surface![index])));

const pointOn = (warp: Homography | null, point: { x: number; y: number }) => {
  const mapped = warp && project(warp, point.x, point.y);
  return mapped ? { x: mapped[0], y: mapped[1] } : point;
};

const surfaceCss = (m: Homography, unit: number) =>
  `matrix3d(${[m[0], m[3], 0, m[6] / unit, m[1], m[4], 0, m[7] / unit, 0, 0, 1, 0, m[2] * unit, m[5] * unit, 0, m[8]].join(',')})`;

const boxesAt = (project: VideoProject, playhead: Ticks, media: Record<string, MediaInfo>) =>
  visualItemsAt(project, playhead)
    .map(({ item, trackIndex }) => boxFor(project, item, trackIndex, playhead, media))
    .filter((box): box is Box => !!box);

const useBoxes = () => {
  const epoch = useVideoMotion((state) => state.followEpoch);
  const cache = useRef({
    project: null as VideoProject | null,
    playhead: 0,
    media: null as Record<string, MediaInfo> | null,
    epoch,
    boxes: NO_BOXES,
  });
  return useVideoStore((state) => {
    const project = state.isPlaying ? null : state.project;
    const last = cache.current;
    if (
      project === last.project &&
      epoch === last.epoch &&
      (!project || (state.playhead === last.playhead && state.media === last.media))
    )
      return last.boxes;
    const next = project ? boxesAt(project, state.playhead, state.media) : NO_BOXES;
    const same = next.length === last.boxes.length && next.every((box, index) => sameBox(box, last.boxes[index]));
    cache.current = { project, playhead: state.playhead, media: state.media, epoch, boxes: same ? last.boxes : next };
    return cache.current.boxes;
  });
};

const CORNERS = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;

function TrackingBox({
  region,
  canvas,
  unit,
  zoom,
  disabled,
}: {
  region: Region;
  canvas: { width: number; height: number };
  unit: number;
  zoom: number;
  disabled: boolean;
}) {
  const dragRef = useRef<{ corner: [number, number] | null; pointerX: number; pointerY: number; start: Region } | null>(
    null,
  );
  const handleSize = HANDLE / zoom;

  const begin = (event: ReactPointerEvent, corner: [number, number] | null) => {
    if (event.button !== 0 || disabled) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { corner, pointerX: event.clientX, pointerY: event.clientY, start: region };
  };

  const move = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.pointerX) / (unit * zoom);
    const dy = (event.clientY - drag.pointerY) / (unit * zoom);
    setTrackingRegion(dragRegion(drag.start, drag.corner, dx, dy, canvas));
  };

  const end = () => {
    dragRef.current = null;
  };

  return (
    <div
      className={clsx(
        'absolute pointer-events-auto border-dashed border-accent bg-accent/15',
        disabled ? 'cursor-default opacity-60' : 'cursor-move',
      )}
      style={{
        left: region.x * unit,
        top: region.y * unit,
        width: region.width * unit,
        height: region.height * unit,
        borderWidth: 2 / zoom,
      }}
      onPointerDown={(event) => begin(event, null)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div
        className="absolute left-1/2 top-1/2 rounded-full bg-accent"
        style={{ width: 6 / zoom, height: 6 / zoom, marginLeft: -3 / zoom, marginTop: -3 / zoom }}
      />
      {!disabled &&
        CORNERS.map(([x, y]) => (
          <div
            key={`${x}${y}`}
            className="absolute bg-white border border-accent rounded-xs"
            style={{
              left: `calc(${x * 100}% - ${handleSize / 2}px)`,
              top: `calc(${y * 100}% - ${handleSize / 2}px)`,
              width: handleSize,
              height: handleSize,
              cursor: x === y ? 'nwse-resize' : 'nesw-resize',
            }}
            onPointerDown={(event) => begin(event, [x, y])}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          />
        ))}
    </div>
  );
}

export const useCanvasHover = (setIsMaskHovered: (isHovered: boolean) => void, active: boolean) => {
  const hoveredRef = useRef(false);

  useEffect(
    () => () => {
      if (hoveredRef.current) setIsMaskHovered(false);
    },
    [setIsMaskHovered],
  );

  useEffect(() => {
    if (!active && hoveredRef.current) {
      hoveredRef.current = false;
      setIsMaskHovered(false);
    }
  }, [active, setIsMaskHovered]);

  return (isHovered: boolean) => {
    hoveredRef.current = isHovered;
    setIsMaskHovered(isHovered);
  };
};

const snap = (value: number, targets: Array<number>, tolerance: number) => {
  const target = targets.find((candidate) => Math.abs(candidate - value) <= tolerance);
  return target ?? value;
};

const snapScale = (scale: number, drag: Drag, canvas: { width: number; height: number }, tolerance: number): number => {
  const { box, startScale } = drag;
  const quarter = Math.round(box.rotation / 90);
  if (Math.abs(box.rotation - quarter * 90) > 0.5 || startScale <= 0) return scale;
  const [boxWidth, boxHeight] = quarter % 2 === 0 ? [box.width, box.height] : [box.height, box.width];
  const fits: Array<[number, Array<number>]> = [
    [boxWidth, [canvas.width, 2 * box.centerX, 2 * (canvas.width - box.centerX)]],
    [boxHeight, [canvas.height, 2 * box.centerY, 2 * (canvas.height - box.centerY)]],
  ];
  let snapped = scale;
  let gap = tolerance;
  fits.forEach(([size, targets]) =>
    targets.forEach((target) => {
      if (size <= 0 || target <= 0) return;
      const edge = Math.abs((size * scale) / startScale - target) / 2;
      if (edge <= gap) {
        gap = edge;
        snapped = (startScale * target) / size;
      }
    }),
  );
  return snapped;
};

export default function VideoCanvasOverlay({
  style,
  imageWidth,
  imageHeight,
  transformScale,
  setIsMaskHovered,
}: VideoCanvasOverlayProps) {
  const { settings, selection, isPlaying } = useVideoStore(
    useShallow((s) => ({ settings: s.project?.settings ?? null, selection: s.selection, isPlaying: s.isPlaying })),
  );
  const boxes = useBoxes();
  const programCanvas = useProgramCanvas();
  const { trackingRegion, trackingQuad, planar, snaps, trackingBusy } = useVideoMotion(
    useShallow((s) => ({
      trackingRegion: s.placing?.region ?? null,
      trackingQuad: s.placing?.quad ?? null,
      planar: s.trackKind === 'planar',
      snaps: s.snaps,
      trackingBusy: s.tracking !== null,
    })),
  );
  const dragRef = useRef<Drag | null>(null);
  const pinMerge = useRef('');
  const [guides, setGuides] = useState<{ x: boolean; y: boolean }>({ x: false, y: false });
  const [picked, setPicked] = useState<string | null>(null);
  const shownPick = picked && selection.includes(picked) ? picked : null;
  useEffect(() => {
    if (picked && !selection.includes(picked)) setPicked(null);
  }, [picked, selection]);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!picked) return;
    const release = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setPicked(null);
    };
    window.addEventListener('pointerdown', release, true);
    return () => window.removeEventListener('pointerdown', release, true);
  }, [picked]);
  const active = !!programCanvas && !!settings && imageWidth > 0 && imageHeight > 0 && !isPlaying;
  const hover = useCanvasHover(setIsMaskHovered, active);

  if (!active || !settings) return null;

  const unit = imageWidth / settings.width;
  const zoom = Math.max(transformScale, 1e-3);
  const selectable = boxes.filter((box) => box.trackIndex > 0 || selection.includes(box.item.id));

  const begin = (event: ReactPointerEvent, box: Box, mode: DragMode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setPicked(box.item.id);
    if (!selection.includes(box.item.id)) {
      selectItems([box.item.id], false);
      useUIStore.getState().setPanel(Panel.Inspector);
    }
    const local = getVideo().playhead - box.item.start;
    const transform = (box.item as { transform: Transform }).transform;
    dragRef.current = {
      mode,
      box,
      pointerX: event.clientX,
      pointerY: event.clientY,
      startScale: valueAt(transform.scale, local),
      startRotation: valueAt(transform.rotation, local),
    };
  };

  const toCanvas = (clientX: number, clientY: number, element: HTMLElement) => {
    const rect = element.closest('[data-video-overlay]')!.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * settings.width,
      y: ((clientY - rect.top) / rect.height) * settings.height,
    };
  };

  const move = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (event.buttons === 0) {
      end();
      return;
    }
    const { box } = drag;
    const { width, height } = settings;
    const { playhead, recordKeyframes: record, recordFrom } = getVideo();
    const local = playhead - box.item.start;
    const frame = frameTicks(settings.fps);
    const tolerance = frame / 2;
    const anchor = recordFrom === null ? null : localTime(recordFrom, box.item.start, box.item.duration, frame);
    const free = event.shiftKey;
    const update = (patch: Partial<Record<'x' | 'y' | 'scale' | 'rotation', number>>) =>
      editProject(
        (next) =>
          updateItem<VisualItem>(next, box.item.id, (item) => {
            if (!('transform' in item)) return item;
            const transform = { ...item.transform };
            (Object.entries(patch) as Array<[keyof typeof patch, number]>).forEach(([key, value]) => {
              transform[key] = setValueAt(transform[key] as Animated, local, value, tolerance, record, anchor);
            });
            return { ...item, transform } as VisualItem;
          }),
        `canvas-${drag.mode}:${box.item.id}`,
      );
    const back = box.surface && invert(box.surface);
    if (drag.mode === 'move') {
      const dx = (event.clientX - drag.pointerX) / (unit * zoom);
      const dy = (event.clientY - drag.pointerY) / (unit * zoom);
      const tolerance = SNAP_PX / (unit * zoom);
      const shown = pointOn(box.surface, { x: box.centerX, y: box.centerY });
      const centerX = shown.x + dx;
      const centerY = shown.y + dy;
      const snappedX = free ? centerX : snap(centerX, [width / 2, box.width / 2, width - box.width / 2], tolerance);
      const snappedY = free ? centerY : snap(centerY, [height / 2, box.height / 2, height - box.height / 2], tolerance);
      setGuides({ x: snappedX === width / 2 && !free, y: snappedY === height / 2 && !free });
      alignHaptic(drag, snappedX !== centerX && snappedX, snappedY !== centerY && snappedY);
      const similarity = layerSimilarity((box.item as { transform: Transform }).transform, local, width, height);
      const center = back
        ? pointOn(back, { x: snappedX, y: snappedY })
        : similarity
          ? mapPoint(invertSimilarity(similarity), snappedX, snappedY)
          : { x: snappedX, y: snappedY };
      update({ x: center.x / width - 0.5, y: center.y / height - 0.5 });
      return;
    }
    const point = pointOn(back, toCanvas(event.clientX, event.clientY, event.currentTarget as HTMLElement));
    const start = pointOn(back, toCanvas(drag.pointerX, drag.pointerY, event.currentTarget as HTMLElement));
    if (drag.mode === 'scale') {
      const distance = Math.hypot(point.x - box.centerX, point.y - box.centerY);
      const initial = Math.max(1, Math.hypot(start.x - box.centerX, start.y - box.centerY));
      const raw = Math.min(10, Math.max(0.02, (drag.startScale * distance) / initial));
      const scale = free || back ? raw : snapScale(raw, drag, settings, SNAP_PX / (unit * zoom));
      alignHaptic(drag, scale !== raw && scale);
      update({ scale });
    } else {
      const angle = (Math.atan2(point.y - box.centerY, point.x - box.centerX) * 180) / Math.PI;
      const initial = (Math.atan2(start.y - box.centerY, start.x - box.centerX) * 180) / Math.PI;
      const raw = box.rotation + angle - initial;
      const snapped = free ? raw : snap(raw, [-180, -90, 0, 90, 180], 3);
      alignHaptic(drag, snapped !== raw && snapped);
      const rotation = snapped - box.rotation + drag.startRotation;
      update({ rotation: ((((rotation + 180) % 360) + 360) % 360) - 180 });
    }
  };

  const end = () => {
    dragRef.current = null;
    setGuides({ x: false, y: false });
  };

  const handleSize = HANDLE / zoom;
  const ring = ROTATE_RING_PX / zoom;

  const showRotateCursor = (event: ReactPointerEvent<HTMLElement>, box: Box) => {
    const back = box.surface && invert(box.surface);
    const point = pointOn(back, toCanvas(event.clientX, event.clientY, event.currentTarget));
    const angle = (Math.atan2(point.y - box.centerY, point.x - box.centerX) * 180) / Math.PI;
    event.currentTarget.style.cursor = rotateCursor(angle);
  };

  if (trackingRegion) {
    return (
      <div
        className="pointer-events-none"
        style={{ ...style, zIndex: 4 }}
        data-video-overlay
        onPointerEnter={() => hover(true)}
        onPointerLeave={() => hover(false)}
      >
        {planar && trackingQuad ? (
          <QuadEditor
            quad={trackingQuad}
            canvas={settings}
            unit={unit}
            zoom={zoom}
            snaps={snaps}
            variant="placing"
            disabled={trackingBusy}
            onChange={setTrackingQuad}
          />
        ) : (
          <TrackingBox region={trackingRegion} canvas={settings} unit={unit} zoom={zoom} disabled={trackingBusy} />
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="pointer-events-none" style={{ ...style, zIndex: 4 }} data-video-overlay>
      {guides.x && <div className="absolute top-0 bottom-0 bg-accent/80" style={{ left: '50%', width: 1 / zoom }} />}
      {guides.y && <div className="absolute left-0 right-0 bg-accent/80" style={{ top: '50%', height: 1 / zoom }} />}
      {selectable.map((box) => {
        const isSelected = shownPick === box.item.id;
        if (isSelected && box.plane && !sameCorners(box.plane, box.quad))
          return (
            <PlaneOutline key={`${box.item.id}:plane`} quad={box.plane} canvas={settings} unit={unit} zoom={zoom} />
          );
        return null;
      })}
      {selectable.map((box) => {
        const isSelected = shownPick === box.item.id;
        if (box.quad)
          return (
            <div
              key={box.item.id}
              className="contents"
              onPointerEnter={() => hover(true)}
              onPointerLeave={() => hover(false)}
            >
              <QuadEditor
                quad={box.quad}
                canvas={settings}
                unit={unit}
                zoom={zoom}
                variant={isSelected ? 'selected' : 'idle'}
                onBegin={(event) => {
                  pinMerge.current = `canvas-pin:${box.item.id}:${event.timeStamp}`;
                  setPicked(box.item.id);
                  if (!selection.includes(box.item.id)) {
                    selectItems([box.item.id], false);
                    useUIStore.getState().setPanel(Panel.Inspector);
                  }
                }}
                onChange={(quad) => editPin(box.item.id, quad, pinMerge.current)}
              />
            </div>
          );
        const width = box.width * unit;
        const height = box.height * unit;
        const rotateRing = isSelected && (
          <div
            key={`${box.item.id}:rotate`}
            className="absolute pointer-events-auto"
            style={{
              left: box.centerX * unit - width / 2 - ring,
              top: box.centerY * unit - height / 2 - ring,
              width: width + ring * 2,
              height: height + ring * 2,
              borderRadius: ring,
              transform: `rotate(${box.rotation}deg)`,
            }}
            onPointerEnter={(event) => {
              hover(true);
              showRotateCursor(event, box);
            }}
            onPointerLeave={() => hover(false)}
            onPointerDown={(event) => begin(event, box, 'rotate')}
            onPointerMove={(event) => {
              showRotateCursor(event, box);
              move(event);
            }}
            onPointerUp={end}
            onPointerCancel={end}
            onMouseDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          />
        );
        const frame = (
          <div
            key={box.item.id}
            className={clsx(
              'absolute pointer-events-auto cursor-move',
              isSelected ? 'outline outline-accent' : 'hover:outline hover:outline-white/50',
            )}
            style={{
              left: box.centerX * unit - width / 2,
              top: box.centerY * unit - height / 2,
              width,
              height,
              transform: `rotate(${box.rotation}deg)`,
              outlineWidth: (isSelected ? 2 : 1) / zoom,
            }}
            onPointerEnter={() => hover(true)}
            onPointerLeave={() => hover(false)}
            onPointerDown={(event) => begin(event, box, 'move')}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onMouseDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (box.item.type !== 'title') return;
              useUIStore.getState().setPanel(Panel.Inspector);
              focusInspectorText('title');
            }}
          >
            {isSelected &&
              CORNERS.map(([x, y]) => (
                <div
                  key={`${x}${y}`}
                  className="absolute bg-white border border-accent rounded-xs"
                  style={{
                    left: `calc(${x * 100}% - ${handleSize / 2}px)`,
                    top: `calc(${y * 100}% - ${handleSize / 2}px)`,
                    width: handleSize,
                    height: handleSize,
                    cursor: x === y ? 'nwse-resize' : 'nesw-resize',
                  }}
                  onPointerDown={(event) => begin(event, box, 'scale')}
                  onPointerMove={move}
                  onPointerUp={end}
                  onPointerCancel={end}
                />
              ))}
          </div>
        );
        if (!box.surface)
          return (
            <div key={box.item.id} className="contents">
              {rotateRing}
              {frame}
            </div>
          );
        return (
          <div
            key={box.item.id}
            className="absolute left-0 top-0 pointer-events-none"
            style={{
              width: settings.width * unit,
              height: settings.height * unit,
              transformOrigin: '0 0',
              transform: surfaceCss(box.surface, unit),
            }}
          >
            {rotateRing}
            {frame}
          </div>
        );
      })}
    </div>
  );
}
