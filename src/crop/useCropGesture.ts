import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { PercentCrop, Crop } from 'react-image-crop';
import { useEditorStore } from '../store/useEditorStore';
import { registerCropGesture } from './lifecycle';
import { angleDelta, constrainRect, resizeRect, type Handle, type Rect } from './geometry';
import { calculateAutoCropForRotation } from '../utils/cropUtils';

export interface CropGestureProps {
  crop: PercentCrop;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  rotation: number;
  aspect: number | null;
  movePhoto: boolean;
  onChange: (pixel: Crop, percent: PercentCrop) => void;
  onComplete: (pixel: Crop, percent: PercentCrop) => void;
}
type Point = { x: number; y: number };
interface Gesture {
  id: number;
  target: HTMLElement;
  start: Point;
  crop: Rect;
  offset: Point;
  kind: 'move' | 'rotate' | Handle;
  angle: number;
  rotation: number;
}
export function useCropGesture(props: CropGestureProps) {
  const latest = useRef(props);
  latest.current = props;
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const gesture = useRef<Gesture | null>(null);
  const pending = useRef<{ x: number; y: number; alt: boolean; shift: boolean } | null>(null);
  const frame = useRef(0);
  const draft = useRef<PercentCrop>(props.crop);
  const liveRotation = useRef<number | null>(null);
  const sourceRect = (crop: PercentCrop, p: CropGestureProps): Rect => ({
    x: (crop.x * p.sourceWidth) / 100,
    y: (crop.y * p.sourceHeight) / 100,
    width: (crop.width * p.sourceWidth) / 100,
    height: (crop.height * p.sourceHeight) / 100,
  });
  const percent = (r: Rect, p: CropGestureProps): PercentCrop => ({
    unit: '%',
    x: (r.x / p.sourceWidth) * 100,
    y: (r.y / p.sourceHeight) * 100,
    width: (r.width / p.sourceWidth) * 100,
    height: (r.height / p.sourceHeight) * 100,
  });
  const cancel = useCallback(() => {
    cancelAnimationFrame(frame.current);
    pending.current = null;
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const p = latest.current,
      crop = percent(g.crop, p);
    p.onChange({ unit: 'px', ...g.crop }, crop);
    setOffset(g.offset);
    liveRotation.current = null;
    useEditorStore.getState().setEditor({ liveRotation: null, isRotationActive: false });
    registerCropGesture(null);
    if (g.target.hasPointerCapture(g.id)) g.target.releasePointerCapture(g.id);
  }, []);
  const apply = () => {
    const g = gesture.current,
      point = pending.current,
      p = latest.current;
    if (!g || !point) return;
    if (g.kind === 'rotate') {
      const box = g.target.getBoundingClientRect();
      const x = box.left + ((g.crop.x + g.crop.width / 2) * p.width) / p.sourceWidth + g.offset.x,
        y = box.top + ((g.crop.y + g.crop.height / 2) * p.height) / p.sourceHeight + g.offset.y;
      const angle = (Math.atan2(point.y - y, point.x - x) * 180) / Math.PI;
      const step = point.shift ? 1 : 0.1;
      const rotation = Math.max(-45, Math.min(45, Math.round((g.rotation + angleDelta(g.angle, angle)) / step) * step));
      liveRotation.current = rotation;
      const crop = calculateAutoCropForRotation(
        p.sourceWidth,
        p.sourceHeight,
        0,
        p.aspect ?? g.crop.width / g.crop.height,
        rotation,
        { unit: 'px', ...g.crop },
        rotation - g.rotation,
      );
      if (crop)
        setOffset({
          x: g.offset.x + ((g.crop.x + g.crop.width / 2 - crop.x - crop.width / 2) * p.width) / p.sourceWidth,
          y: g.offset.y + ((g.crop.y + g.crop.height / 2 - crop.y - crop.height / 2) * p.height) / p.sourceHeight,
        });
      useEditorStore.getState().setEditor({ liveRotation: rotation, isRotationActive: true });
      return;
    }
    const dx = ((point.x - g.start.x) * p.sourceWidth) / p.width,
      dy = ((point.y - g.start.y) * p.sourceHeight) / p.height;
    const direction = p.movePhoto ? -1 : 1;
    const target =
      g.kind === 'move'
        ? { ...g.crop, x: g.crop.x + dx * direction, y: g.crop.y + dy * direction }
        : resizeRect(g.crop, g.kind, dx, dy, p.aspect, point.alt);
    const rect = constrainRect(g.crop, target, {
      width: p.sourceWidth,
      height: p.sourceHeight,
      rotation: p.rotation,
      minimum: 64,
    });
    draft.current = percent(rect, p);
    if (g.kind === 'move' && p.movePhoto)
      setOffset({
        x: g.offset.x + ((g.crop.x - rect.x) * p.width) / p.sourceWidth,
        y: g.offset.y + ((g.crop.y - rect.y) * p.height) / p.sourceHeight,
      });
    p.onChange({ unit: 'px', ...rect }, draft.current);
  };
  const begin = (event: PointerEvent<HTMLElement>, kind: Gesture['kind']) => {
    if (event.button !== 0 || gesture.current) return;
    event.preventDefault();
    event.stopPropagation();
    const p = latest.current,
      target = event.currentTarget;
    const box = target.getBoundingClientRect(),
      o = offsetRef.current;
    gesture.current = {
      id: event.pointerId,
      target,
      start: { x: event.clientX, y: event.clientY },
      crop: sourceRect(p.crop, p),
      offset: o,
      kind,
      rotation: p.rotation,
      angle:
        (Math.atan2(
          event.clientY - box.top - ((p.crop.y + p.crop.height / 2) * p.height) / 100 - o.y,
          event.clientX - box.left - ((p.crop.x + p.crop.width / 2) * p.width) / 100 - o.x,
        ) *
          180) /
        Math.PI,
    };
    draft.current = p.crop;
    target.setPointerCapture(event.pointerId);
    registerCropGesture(cancel, complete);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current?.id !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    pending.current = { x: event.clientX, y: event.clientY, alt: event.altKey, shift: event.shiftKey };
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(apply);
  };
  const complete = () => {
    const g = gesture.current;
    if (!g) return;
    cancelAnimationFrame(frame.current);
    apply();
    pending.current = null;
    gesture.current = null;
    registerCropGesture(null);
    const p = latest.current;
    if (g.kind === 'rotate' && liveRotation.current !== null) {
      const editor = useEditorStore.getState();
      const rotation = liveRotation.current;
      const crop = calculateAutoCropForRotation(
        p.sourceWidth,
        p.sourceHeight,
        0,
        p.aspect ?? g.crop.width / g.crop.height,
        rotation,
        { unit: 'px', ...g.crop },
        rotation - g.rotation,
      );
      editor.setEditor({
        liveRotation: null,
        isRotationActive: false,
        adjustments: { ...editor.adjustments, rotation, crop },
      });
      liveRotation.current = null;
    } else p.onComplete({ unit: 'px', ...sourceRect(draft.current, p) }, draft.current);
    if (g.target.hasPointerCapture(g.id)) g.target.releasePointerCapture(g.id);
  };
  const end = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerId === gesture.current?.id) complete();
  };
  useEffect(() => {
    window.addEventListener('blur', cancel);
    return () => {
      cancel();
      window.removeEventListener('blur', cancel);
    };
  }, [cancel]);
  return { offset, begin, move, end, cancel };
}
