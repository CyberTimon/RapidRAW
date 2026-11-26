import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, RefObject, WheelEvent as ReactWheelEvent } from 'react';
import clsx from 'clsx';
import { useWatermarkStore } from '../../../../store/useWatermarkStore';
import { useWatermarkImage, WatermarkImage } from '../../../../hooks/useWatermarkImage';
import { ImageDimensions, RenderSize } from '../../../../hooks/useImageRenderSize';
import { TransformState } from '../../../../types/editor';
import {
  ExportFrame,
  ExportLayout,
  FrameRect,
  MAX_WATERMARK_SCALE,
  MIN_WATERMARK_SCALE,
  exportFrame,
  placementFromRect,
  snapLines,
  watermarkRect,
  watermarkSource,
} from '../../../../utils/watermark';
import { alignHaptic } from '../../../../utils/haptics';

const SNAP_DISTANCE_PX = 8;
const NUDGE_PERCENT = 0.1;
const NUDGE_LARGE_PERCENT = 1;

type Corner = 'nw' | 'ne' | 'sw' | 'se';

const CORNERS: Array<Corner> = ['nw', 'ne', 'sw', 'se'];

const NUDGES: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

interface Guides {
  x: number | null;
  y: number | null;
}

interface Gesture {
  kind: 'move' | Corner;
  pointerId: number;
  startX: number;
  startY: number;
  unitsPerPixel: number;
  rect: FrameRect;
  moved: FrameRect | null;
}

interface Draft {
  rect: FrameRect;
  guides: Guides;
  resizing: boolean;
}

const percentOf = (value: number, total: number) => `${(value / total) * 100}%`;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

export const rectStyle = (rect: FrameRect, frameWidth: number, frameHeight: number): CSSProperties => ({
  left: percentOf(rect.x, frameWidth),
  top: percentOf(rect.y, frameHeight),
  width: percentOf(rect.width, frameWidth),
  height: percentOf(rect.height, frameHeight),
});

const nearestLine = (value: number, lines: Array<number>, threshold: number) =>
  lines.reduce<number | null>(
    (best, line) =>
      Math.abs(line - value) <= threshold && (best === null || Math.abs(line - value) < Math.abs(best - value))
        ? line
        : best,
    null,
  );

const snapPosition = (position: number, extent: number, size: number, margin: number, threshold: number) => {
  const target = snapLines(extent, size, margin).reduce<{ position: number; guide: number } | null>(
    (best, line) =>
      Math.abs(line.position - position) <= threshold &&
      (best === null || Math.abs(line.position - position) < Math.abs(best.position - position))
        ? line
        : best,
    null,
  );
  return target ? { position: target.position, guide: target.guide } : { position, guide: null };
};

interface WatermarkPlacerProps {
  frameWidth: number;
  frameHeight: number;
  image: WatermarkImage;
  onWheel?(event: ReactWheelEvent<HTMLDivElement>): void;
}

export function WatermarkPlacer({ frameWidth, frameHeight, image, onWheel }: WatermarkPlacerProps) {
  const watermark = useWatermarkStore((state) => state.watermark);
  const setWatermark = useWatermarkStore((state) => state.setWatermark);
  const [draft, setDraft] = useState<Draft | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef({ x: 0, y: 0 });

  const shortSide = Math.min(frameWidth, frameHeight);
  const margin = (shortSide * watermark.margin) / 100;
  const rect = draft?.rect ?? watermarkRect(frameWidth, frameHeight, image.aspect, watermark);

  const commit = useCallback(
    (next: FrameRect) => setWatermark(placementFromRect(frameWidth, frameHeight, next)),
    [frameWidth, frameHeight, setWatermark],
  );

  const startGesture = (kind: Gesture['kind']) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const box = boxRef.current;
    const frame = box?.parentElement?.getBoundingClientRect();
    if (!box || !frame?.width) return;
    box.focus({ preventScroll: true });
    box.setPointerCapture(event.pointerId);
    gestureRef.current = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      unitsPerPixel: frameWidth / frame.width,
      rect,
      moved: null,
    };
  };

  const moveGesture = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = (event.clientX - gesture.startX) * gesture.unitsPerPixel;
    const dy = (event.clientY - gesture.startY) * gesture.unitsPerPixel;
    const threshold = event.altKey ? 0 : SNAP_DISTANCE_PX * gesture.unitsPerPixel;
    const start = gesture.rect;
    const show = (next: Draft) => {
      gesture.moved = next.rect;
      setDraft(next);
    };

    if (gesture.kind === 'move') {
      const x = snapPosition(
        clamp(start.x + dx, 0, frameWidth - start.width),
        frameWidth,
        start.width,
        margin,
        threshold,
      );
      const y = snapPosition(
        clamp(start.y + dy, 0, frameHeight - start.height),
        frameHeight,
        start.height,
        margin,
        threshold,
      );
      alignHaptic(gesture, x.guide, y.guide);
      show({
        rect: { ...start, x: x.position, y: y.position },
        guides: { x: x.guide, y: y.guide },
        resizing: false,
      });
      return;
    }

    const west = gesture.kind.endsWith('w');
    const north = gesture.kind.startsWith('n');
    const fixedX = west ? start.x + start.width : start.x;
    const fixedY = north ? start.y + start.height : start.y;
    const pointerX = (west ? start.x : start.x + start.width) + dx;
    const pointerY = (north ? start.y : start.y + start.height) + dy;
    const minWidth = (shortSide * MIN_WATERMARK_SCALE) / 100;
    const maxWidth = Math.min(
      (shortSide * MAX_WATERMARK_SCALE) / 100,
      west ? fixedX : frameWidth - fixedX,
      (north ? fixedY : frameHeight - fixedY) * image.aspect,
    );
    let width = clamp(
      Math.max(
        west ? fixedX - pointerX : pointerX - fixedX,
        (north ? fixedY - pointerY : pointerY - fixedY) * image.aspect,
      ),
      minWidth,
      maxWidth,
    );

    const linesX = [0, margin, frameWidth / 2, frameWidth - margin, frameWidth];
    const linesY = [0, margin, frameHeight / 2, frameHeight - margin, frameHeight];
    const edgeX = west ? fixedX - width : fixedX + width;
    const edgeY = north ? fixedY - width / image.aspect : fixedY + width / image.aspect;
    const snapX = nearestLine(edgeX, linesX, threshold);
    const snapY = nearestLine(edgeY, linesY, threshold);
    const guides: Guides = { x: null, y: null };
    if (snapX !== null && (snapY === null || Math.abs(snapX - edgeX) <= Math.abs(snapY - edgeY) * image.aspect)) {
      width = clamp(Math.abs(snapX - fixedX), minWidth, maxWidth);
      guides.x = snapX;
    } else if (snapY !== null) {
      width = clamp(Math.abs(snapY - fixedY) * image.aspect, minWidth, maxWidth);
      guides.y = snapY;
    }
    const height = width / image.aspect;
    alignHaptic(gesture, guides.x, guides.y);
    show({
      rect: { x: west ? fixedX - width : fixedX, y: north ? fixedY - height : fixedY, width, height },
      guides,
      resizing: true,
    });
  };

  const endGesture = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (gesture.moved) commit(gesture.moved);
    setDraft(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      gestureRef.current = null;
      setDraft(null);
      event.currentTarget.blur();
      return;
    }
    const nudge = NUDGES[event.key];
    if (!nudge || gestureRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const step = (shortSide * (event.shiftKey ? NUDGE_LARGE_PERCENT : NUDGE_PERCENT)) / 100;
    const current = watermarkRect(frameWidth, frameHeight, image.aspect, useWatermarkStore.getState().watermark);
    commit({
      ...current,
      x: clamp(current.x + nudge[0] * step, 0, frameWidth - current.width),
      y: clamp(current.y + nudge[1] * step, 0, frameHeight - current.height),
    });
  };

  const guides = draft?.guides ?? { x: null, y: null };
  if (guides.x !== null) guideRef.current.x = guides.x;
  if (guides.y !== null) guideRef.current.y = guides.y;
  const isActive = !!draft;

  return (
    <>
      <div
        className={clsx(
          'absolute top-0 bottom-0 w-px -translate-x-1/2 bg-accent pointer-events-none transition-opacity duration-150',
          guides.x === null ? 'opacity-0' : 'opacity-90',
        )}
        style={{ left: percentOf(guideRef.current.x, frameWidth) }}
      />
      <div
        className={clsx(
          'absolute left-0 right-0 h-px -translate-y-1/2 bg-accent pointer-events-none transition-opacity duration-150',
          guides.y === null ? 'opacity-0' : 'opacity-90',
        )}
        style={{ top: percentOf(guideRef.current.y, frameHeight) }}
      />
      <div
        ref={boxRef}
        tabIndex={0}
        className="group absolute pointer-events-auto touch-none cursor-move outline-none"
        style={rectStyle(rect, frameWidth, frameHeight)}
        onPointerDown={startGesture('move')}
        onPointerMove={moveGesture}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onKeyDown={handleKeyDown}
        onWheel={onWheel}
      >
        <img
          alt=""
          src={image.url}
          draggable={false}
          className="absolute inset-0 w-full h-full select-none pointer-events-none"
          style={{ opacity: watermark.opacity / 100 }}
        />
        <div
          className={clsx(
            'absolute -inset-px border border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.35)] pointer-events-none transition-opacity duration-150',
            isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus:opacity-100',
          )}
        />
        {CORNERS.map((corner) => (
          <div
            key={corner}
            className={clsx(
              'absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center transition-opacity duration-150',
              corner === 'nw' || corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize',
              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus:opacity-100',
            )}
            style={{ left: corner.endsWith('w') ? '0%' : '100%', top: corner.startsWith('n') ? '0%' : '100%' }}
            onPointerDown={startGesture(corner)}
          >
            <div className="w-2.5 h-2.5 rounded-[2px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" />
          </div>
        ))}
        {draft?.resizing && (
          <div className="absolute left-1/2 top-full mt-2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-black/70 text-white text-[11px] tabular-nums whitespace-nowrap pointer-events-none">
            {`${((draft.rect.width / shortSide) * 100).toFixed(1)}%`}
          </div>
        )}
      </div>
    </>
  );
}

const ringStrips = (outer: FrameRect, inner: FrameRect): Array<FrameRect> =>
  [
    { x: outer.x, y: outer.y, width: outer.width, height: inner.y - outer.y },
    {
      x: outer.x,
      y: inner.y + inner.height,
      width: outer.width,
      height: outer.y + outer.height - inner.y - inner.height,
    },
    { x: outer.x, y: inner.y, width: inner.x - outer.x, height: inner.height },
    {
      x: inner.x + inner.width,
      y: inner.y,
      width: outer.x + outer.width - inner.x - inner.width,
      height: inner.height,
    },
  ].filter((strip) => strip.width > 1e-6 && strip.height > 1e-6);

export function ExportFrameFill({ frame, layout }: { frame: ExportFrame; layout: ExportLayout }) {
  const outer = { x: 0, y: 0, width: frame.width, height: frame.height };
  const rings: Array<[FrameRect, FrameRect, string | undefined]> = [
    [outer, frame.box, layout.pad?.color],
    [frame.box, frame.photo, layout.border?.color],
  ];
  return (
    <>
      {rings.flatMap(([from, to, color], ring) =>
        color
          ? ringStrips(from, to).map((strip, index) => (
              <div
                key={`${ring}-${index}`}
                className="absolute pointer-events-none"
                style={{ ...rectStyle(strip, frame.width, frame.height), backgroundColor: color }}
              />
            ))
          : [],
      )}
    </>
  );
}

export function useWatermarkFitFrame(photo: ImageDimensions | null, suspended: boolean): ImageDimensions | null {
  const layout = useWatermarkStore((state) => state.exportLayout);
  return useMemo(() => {
    if (suspended || !photo || !layout || (!layout.border && !layout.pad)) return null;
    const frame = exportFrame(photo.width, photo.height, layout.border, layout.pad);
    return frame.width > photo.width || frame.height > photo.height
      ? { width: frame.width, height: frame.height }
      : null;
  }, [layout, photo, suspended]);
}

interface WatermarkCanvasOverlayProps {
  imageRenderSize: RenderSize;
  subscribeViewTransform(listener: (state: TransformState) => void): () => void;
  containerRef: RefObject<HTMLDivElement | null>;
  hidden: boolean;
}

export default function WatermarkCanvasOverlay({
  imageRenderSize,
  subscribeViewTransform,
  containerRef,
  hidden,
}: WatermarkCanvasOverlayProps) {
  const layout = useWatermarkStore((state) => state.exportLayout);
  const watermark = useWatermarkStore((state) => state.watermark);
  const image = useWatermarkImage(layout ? watermarkSource(watermark) : null);
  const frameRef = useRef<HTMLDivElement>(null);
  const { width, height, offsetX, offsetY } = imageRenderSize;

  const frame = useMemo(
    () => (layout && width > 0 && height > 0 ? exportFrame(width, height, layout.border, layout.pad) : null),
    [layout, width, height],
  );
  const isVisible = !hidden && !!frame && !!image;

  useLayoutEffect(() => {
    if (!isVisible || !frame) return;
    return subscribeViewTransform(({ positionX, positionY, scale }) => {
      const element = frameRef.current;
      if (!element) return;
      element.style.left = `${positionX + (offsetX - frame.photo.x) * scale}px`;
      element.style.top = `${positionY + (offsetY - frame.photo.y) * scale}px`;
      element.style.width = `${frame.width * scale}px`;
      element.style.height = `${frame.height * scale}px`;
    });
  }, [isVisible, frame, offsetX, offsetY, subscribeViewTransform]);

  const forwardWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      const {
        deltaX,
        deltaY,
        deltaZ,
        deltaMode,
        clientX,
        clientY,
        screenX,
        screenY,
        ctrlKey,
        shiftKey,
        altKey,
        metaKey,
      } = event.nativeEvent;
      containerRef.current?.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX,
          deltaY,
          deltaZ,
          deltaMode,
          clientX,
          clientY,
          screenX,
          screenY,
          ctrlKey,
          shiftKey,
          altKey,
          metaKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [containerRef],
  );

  if (!isVisible || !frame || !layout || !image) return null;

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <div ref={frameRef} className="absolute">
        <ExportFrameFill frame={frame} layout={layout} />
        <WatermarkPlacer frameWidth={frame.width} frameHeight={frame.height} image={image} onWheel={forwardWheel} />
      </div>
    </div>
  );
}
