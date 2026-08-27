import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useEditorStore } from '../../../store/useEditorStore';
import { GripVertical, GripHorizontal } from 'lucide-react';
import clsx from 'clsx';

interface SplitCompareOverlayProps {
  imageWidth: number;
  imageHeight: number;
  offsetX: number;
  offsetY: number;
  originalSrc: string | null;
  adjustedSrc: string | null;
  isMaxZoom?: boolean;
}

export const SplitCompareOverlay: React.FC<SplitCompareOverlayProps> = ({
  imageWidth,
  imageHeight,
  offsetX,
  offsetY,
  originalSrc,
  adjustedSrc,
  isMaxZoom = false,
}) => {
  const compareMode = useEditorStore((state) => state.compareMode);
  const splitPosition = useEditorStore((state) => state.splitPosition);
  const setEditor = useEditorStore((state) => state.setEditor);

  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    setIsDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();

      if (compareMode === 'vertical_split') {
        const relativeX = e.clientX - rect.left;
        const newPos = Math.max(0.05, Math.min(0.95, relativeX / rect.width));
        setEditor({ splitPosition: newPos });
      } else if (compareMode === 'horizontal_split') {
        const relativeY = e.clientY - rect.top;
        const newPos = Math.max(0.05, Math.min(0.95, relativeY / rect.height));
        setEditor({ splitPosition: newPos });
      }
    },
    [isDragging, compareMode, setEditor]
  );

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isDragging) {
      setIsDragging(false);
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch (_) {}
    }
  };

  if (compareMode !== 'vertical_split' && compareMode !== 'horizontal_split') {
    return null;
  }

  const splitPercent = splitPosition * 100;

  // Clip paths:
  // For vertical split: Original is visible on the left [0 to splitPercent]
  const originalClipPath =
    compareMode === 'vertical_split'
      ? `polygon(0 0, ${splitPercent}% 0, ${splitPercent}% 100%, 0 100%)`
      : `polygon(0 0, 100% 0, 100% ${splitPercent}%, 0 ${splitPercent}%)`;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-auto select-none"
      style={{
        left: `${offsetX}px`,
        top: `${offsetY}px`,
        width: `${imageWidth}px`,
        height: `${imageHeight}px`,
        zIndex: 25,
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* Original Image Layer with Clip Path */}
      {originalSrc && (
        <img
          src={originalSrc}
          alt="Before Split"
          className="absolute inset-0 w-full h-full object-contain pointer-events-none"
          style={{
            clipPath: originalClipPath,
            imageRendering: isMaxZoom ? 'pixelated' : 'auto',
          }}
        />
      )}

      {/* Divider Bar & Grabber Handle */}
      {compareMode === 'vertical_split' ? (
        <div
          className="absolute top-0 bottom-0 flex items-center justify-center cursor-ew-resize group"
          style={{
            left: `${splitPercent}%`,
            transform: 'translateX(-50%)',
            width: '24px',
            zIndex: 30,
          }}
          onPointerDown={handlePointerDown}
        >
          {/* Glowing Center Line */}
          <div className="w-[2px] h-full bg-white shadow-[0_0_8px_rgba(0,0,0,0.8)] transition-all group-hover:w-[3px] group-hover:bg-accent" />

          {/* Center Pill Grip */}
          <div className="absolute top-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-10 rounded-full bg-[#18181b]/90 border border-white/40 shadow-2xl text-white backdrop-blur-md transition-transform group-hover:scale-110">
            <GripVertical size={14} className="text-white/80" />
          </div>

          {/* Badges */}
          <div className="absolute top-4 -translate-x-[calc(50%+30px)] px-2 py-0.5 rounded bg-black/70 border border-white/20 text-[10px] font-mono text-white/90 backdrop-blur-md pointer-events-none">
            BEFORE
          </div>
          <div className="absolute top-4 translate-x-[calc(50%+30px)] px-2 py-0.5 rounded bg-accent/90 border border-accent text-[10px] font-mono text-black font-bold backdrop-blur-md pointer-events-none">
            AFTER
          </div>
        </div>
      ) : (
        <div
          className="absolute left-0 right-0 flex items-center justify-center cursor-ns-resize group"
          style={{
            top: `${splitPercent}%`,
            transform: 'translateY(-50%)',
            height: '24px',
            zIndex: 30,
          }}
          onPointerDown={handlePointerDown}
        >
          {/* Glowing Center Line */}
          <div className="h-[2px] w-full bg-white shadow-[0_0_8px_rgba(0,0,0,0.8)] transition-all group-hover:h-[3px] group-hover:bg-accent" />

          {/* Center Pill Grip */}
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center justify-center w-10 h-6 rounded-full bg-[#18181b]/90 border border-white/40 shadow-2xl text-white backdrop-blur-md transition-transform group-hover:scale-110">
            <GripHorizontal size={14} className="text-white/80" />
          </div>

          {/* Badges */}
          <div className="absolute left-4 -translate-y-[calc(50%+20px)] px-2 py-0.5 rounded bg-black/70 border border-white/20 text-[10px] font-mono text-white/90 backdrop-blur-md pointer-events-none">
            BEFORE
          </div>
          <div className="absolute left-4 translate-y-[calc(50%+20px)] px-2 py-0.5 rounded bg-accent/90 border border-accent text-[10px] font-mono text-black font-bold backdrop-blur-md pointer-events-none">
            AFTER
          </div>
        </div>
      )}
    </div>
  );
};

export default SplitCompareOverlay;
