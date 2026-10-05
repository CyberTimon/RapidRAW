import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Coord, RelightLight } from '../../../../utils/adjustments';
import { RenderSize } from '../../../../hooks/useImageRenderSize';
import { RelightGeometry, relightDisplayToUv, relightUvToDisplay } from '../../../../utils/relightUtils';

interface RelightHandleProps {
  light: RelightLight;
  isActive: boolean;
  geometry: RelightGeometry;
  imageRenderSize: RenderSize;
  inverseScale: number;
  onSelect(id: string): void;
  onChange(id: string, changes: Partial<RelightLight>): void;
}

const HANDLE_SIZE = 30;
const WHEEL_DEPTH_STEP = 4;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export default function RelightHandle({
  light,
  isActive,
  geometry,
  imageRenderSize,
  inverseScale,
  onSelect,
  onChange,
}: RelightHandleProps) {
  const { t } = useTranslation();
  const handleRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const pendingUvRef = useRef<Coord | null>(null);
  const depthRef = useRef(light.depth);
  const [dragUv, setDragUv] = useState<Coord | null>(null);

  depthRef.current = light.depth;

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // The editor zooms with a native wheel listener, so this has to be native too to get in first.
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const step = e.deltaY < 0 ? WHEEL_DEPTH_STEP : -WHEEL_DEPTH_STEP;
      const depth = Math.max(-100, Math.min(100, depthRef.current + step));
      depthRef.current = depth;
      onSelect(light.id);
      onChange(light.id, { depth });
    };

    handle.addEventListener('wheel', handleWheel, { passive: false });
    return () => handle.removeEventListener('wheel', handleWheel);
  }, [light.id, onSelect, onChange]);

  const commitUv = useCallback(
    (uv: Coord) => {
      pendingUvRef.current = uv;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const next = pendingUvRef.current;
        if (!next) return;
        onChange(light.id, { x: next.x, y: next.y });
      });
    },
    [light.id, onChange],
  );

  const pointerToUv = useCallback(
    (clientX: number, clientY: number): Coord | null => {
      const container = handleRef.current?.parentElement;
      if (!container || !container.offsetWidth || !imageRenderSize.scale) return null;

      // The container sits inside the zoom/pan transform, so undo its on-screen scale.
      const rect = container.getBoundingClientRect();
      const zoom = rect.width / container.offsetWidth || 1;
      const localX = (clientX - rect.left) / zoom;
      const localY = (clientY - rect.top) / zoom;

      const uv = relightDisplayToUv(
        {
          x: (localX - imageRenderSize.offsetX) / imageRenderSize.scale,
          y: (localY - imageRenderSize.offsetY) / imageRenderSize.scale,
        },
        geometry,
      );
      return { x: clamp01(uv.x), y: clamp01(uv.y) };
    },
    [geometry, imageRenderSize],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect(light.id);
    setDragUv({ x: light.x, y: light.y });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragUv) return;
    e.stopPropagation();
    const uv = pointerToUv(e.clientX, e.clientY);
    if (!uv) return;
    setDragUv(uv);
    commitUv(uv);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragUv) return;
    e.stopPropagation();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragUv(null);
  };

  const uv = dragUv ?? { x: light.x, y: light.y };
  const display = relightUvToDisplay(uv, geometry);
  const color = light.color || '#ffffff';
  const depth = Math.max(-100, Math.min(100, light.depth));
  // Closer lights look bigger; a light behind the subject gets a dashed outline.
  const depthScale = 0.7 + 0.6 * ((depth + 100) / 200);
  const isBehind = depth < 0;
  const outline = isActive ? '0 0 0 2.5px var(--color-accent, #ffffff), ' : '';

  return (
    <div
      ref={handleRef}
      className="absolute pointer-events-auto rounded-full"
      data-relight-handle
      data-tooltip={dragUv ? undefined : t('adjustments.effects.relightDragLight')}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        left: display.x * imageRenderSize.scale + imageRenderSize.offsetX,
        top: display.y * imageRenderSize.scale + imageRenderSize.offsetY,
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
        transform: `translate(-50%, -50%) scale(${inverseScale * depthScale})`,
        transformOrigin: 'center',
        cursor: dragUv ? 'grabbing' : 'grab',
        touchAction: 'none',
        zIndex: isActive ? 1 : 0,
        background: `radial-gradient(circle at 35% 30%, #ffffff 0%, ${color} 38%, color-mix(in srgb, ${color} 45%, #000000) 100%)`,
        border: `1.5px ${isBehind ? 'dashed' : 'solid'} rgba(255, 255, 255, 0.9)`,
        opacity: isBehind ? 0.75 : 1,
        boxShadow: `${outline}0 0 0 1px rgba(0, 0, 0, 0.45), 0 0 14px 4px color-mix(in srgb, ${color} 55%, transparent), 0 2px 6px rgba(0, 0, 0, 0.5)`,
      }}
    />
  );
}
