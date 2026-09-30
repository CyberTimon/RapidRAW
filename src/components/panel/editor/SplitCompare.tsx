import { useCallback, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEditorStore } from '../../../store/useEditorStore';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

interface SplitCompareImageProps {
  url: string;
  position: number;
  pixelated: boolean;
}

/** The unedited photo, clipped to the left of the divider. Rendered inside the editor's SVG image layer. */
export function SplitCompareImage({ url, position, pixelated }: SplitCompareImageProps) {
  const clipId = `split-compare-${useId().replace(/:/g, '')}`;
  return (
    <>
      <defs>
        <clipPath id={clipId} clipPathUnits="objectBoundingBox">
          <rect x="0" y="0" width={position} height="1" />
        </clipPath>
      </defs>
      <image
        href={url}
        x="0"
        y="0"
        width="100%"
        height="100%"
        clipPath={`url(#${clipId})`}
        style={{ imageRendering: pixelated ? 'pixelated' : 'auto' }}
      />
    </>
  );
}

interface SplitCompareDividerProps {
  position: number;
  /** Canvas zoom; the divider keeps a constant on-screen size. */
  scale: number;
  box: { left: number; top: number; width: number; height: number };
}

/** Draggable divider over the photo. Pointer input never reaches canvas panning or click-to-zoom. */
export function SplitCompareDivider({ position, scale, box }: SplitCompareDividerProps) {
  const { t } = useTranslation();
  const setEditor = useEditorStore((state) => state.setEditor);
  const areaRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const inverse = 1 / Math.max(scale, 0.01);

  const moveTo = useCallback(
    (clientX: number) => {
      const rect = areaRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      setEditor({ splitComparePosition: clamp01((clientX - rect.left) / rect.width) });
    },
    [setEditor],
  );

  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  const label = (text: string, side: 'left' | 'right') => (
    <span
      className="absolute top-2 rounded bg-black/55 px-2 py-0.5 text-xs font-medium text-white select-none"
      style={{
        [side]: 8 * inverse,
        transform: `scale(${inverse})`,
        transformOrigin: `top ${side}`,
      }}
    >
      {text}
    </span>
  );

  return (
    <div
      ref={areaRef}
      className="absolute pointer-events-none"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height, zIndex: 10 }}
    >
      {position > 0.02 && label(t('editor.splitCompare.before'), 'left')}
      {position < 0.98 && label(t('editor.splitCompare.after'), 'right')}
      <div
        role="slider"
        aria-label={t('editor.splitCompare.divider')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position * 100)}
        tabIndex={0}
        className="absolute top-0 h-full pointer-events-auto cursor-ew-resize flex justify-center"
        style={{ left: `${position * 100}%`, width: 24 * inverse, marginLeft: -12 * inverse, touchAction: 'none' }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          draggingRef.current = true;
          moveTo(event.clientX);
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return;
          event.stopPropagation();
          moveTo(event.clientX);
        }}
        onPointerUp={(event) => {
          draggingRef.current = false;
          event.stopPropagation();
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
        onClick={stop}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setEditor({ splitComparePosition: 0.5 });
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.1 : 0.02;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            const delta = event.key === 'ArrowLeft' ? -step : step;
            setEditor((state) => ({ splitComparePosition: clamp01(state.splitComparePosition + delta) }));
          }
        }}
      >
        <div
          className="h-full bg-white"
          style={{ width: 1.5 * inverse, boxShadow: `0 0 ${3 * inverse}px rgba(0,0,0,0.7)` }}
        />
        <div
          className="absolute top-1/2 flex items-center justify-center rounded-full bg-white text-black shadow-lg"
          style={{ width: 28, height: 28, transform: `translate(0, -50%) scale(${inverse})` }}
        >
          <ChevronLeft size={12} strokeWidth={2.5} />
          <ChevronRight size={12} strokeWidth={2.5} />
        </div>
      </div>
    </div>
  );
}
