import { useRef, useEffect, useState, useCallback, type WheelEvent, type MouseEvent } from 'react';
import type { ZoomState } from '../../types/editor';

interface EditorCanvasProps {
  imageUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  zoomState: ZoomState;
  onZoomChange: (state: Partial<ZoomState>) => void;
  showBeforeAfter?: boolean;
  beforeImageUrl?: string | null;
  className?: string;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;
const ZOOM_STEP = 0.1;

export function EditorCanvas({
  imageUrl,
  imageWidth,
  imageHeight,
  zoomState,
  onZoomChange,
  showBeforeAfter = false,
  beforeImageUrl,
  className = '',
}: EditorCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      setContainerSize({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    };

    updateSize();
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !imageUrl || containerSize.width === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = containerSize.width * dpr;
    canvas.height = containerSize.height * dpr;
    canvas.style.width = `${containerSize.width}px`;
    canvas.style.height = `${containerSize.height}px`;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, containerSize.width, containerSize.height);

    const img = new Image();
    img.onload = () => {
      const scale = zoomState.scale;
      const renderWidth = imageWidth * scale;
      const renderHeight = imageHeight * scale;

      const offsetX = (containerSize.width - renderWidth) / 2 + zoomState.positionX;
      const offsetY = (containerSize.height - renderHeight) / 2 + zoomState.positionY;

      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, containerSize.width, containerSize.height);
      ctx.drawImage(img, offsetX, offsetY, renderWidth, renderHeight);
    };
    img.src = imageUrl;
  }, [imageUrl, imageWidth, imageHeight, zoomState, containerSize]);

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.001;
      const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomState.scale + delta));

      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const scaleRatio = newScale / zoomState.scale;
        const centerX = containerSize.width / 2;
        const centerY = containerSize.height / 2;

        const offsetFromCenterX = mouseX - centerX - zoomState.positionX;
        const offsetFromCenterY = mouseY - centerY - zoomState.positionY;

        const newPositionX = zoomState.positionX - offsetFromCenterX * (scaleRatio - 1);
        const newPositionY = zoomState.positionY - offsetFromCenterY * (scaleRatio - 1);

        onZoomChange({
          scale: newScale,
          positionX: newPositionX,
          positionY: newPositionY,
        });
      }
    },
    [zoomState, containerSize, onZoomChange]
  );

  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (e.button === 0 || e.button === 1) {
      setIsPanning(true);
      setLastMousePos({ x: e.clientX, y: e.clientY });
    }
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isPanning) return;

      const dx = e.clientX - lastMousePos.x;
      const dy = e.clientY - lastMousePos.y;

      onZoomChange({
        positionX: zoomState.positionX + dx,
        positionY: zoomState.positionY + dy,
      });

      setLastMousePos({ x: e.clientX, y: e.clientY });
    },
    [isPanning, lastMousePos, zoomState.positionX, zoomState.positionY, onZoomChange]
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const handleDoubleClick = useCallback(() => {
    onZoomChange({
      scale: 1,
      positionX: 0,
      positionY: 0,
    });
  }, [onZoomChange]);

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden ${isPanning ? 'cursor-grabbing' : 'cursor-grab'} ${className}`}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />

      <div className="absolute bottom-4 left-4 bg-bg-primary/80 rounded px-2 py-1 text-xs text-text-secondary">
        {Math.round(zoomState.scale * 100)}%
      </div>
    </div>
  );
}
