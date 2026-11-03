import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import ReactCrop, { type PercentCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { useImageRenderSize } from '../../hooks/useImageRenderSize';
import { TextColors, TEXT_COLOR_KEYS } from '../../types/typography';
import {
  panoramaMessage,
  type PanoramaFrameInfo,
  type PanoramaMessage,
  type PanoramaPreview,
} from '../../utils/panorama';

interface PanoramaPreviewPaneProps {
  crop: PercentCrop;
  onCropChange(crop: PercentCrop): void;
  preview: PanoramaPreview;
  progressMessage: PanoramaMessage | null;
  reprojecting: boolean;
}

interface FrameTooltipProps {
  frameRef: RefObject<HTMLDivElement | null>;
  preview: PanoramaPreview;
  stageRef: RefObject<HTMLDivElement | null>;
}

interface WinnerMap {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface Hover {
  index: number;
  x: number;
  y: number;
}

function exifLine(f: PanoramaFrameInfo): string {
  const m = f.meta;
  if (!m) return '';
  const parts: string[] = [];
  const mm = f.focal35 ?? m.focal35 ?? m.nativeMm;
  if (typeof mm === 'number' && Number.isFinite(mm)) parts.push(`${mm.toFixed(0)}mm`);
  if (m.shutter) parts.push(m.shutter.includes('/') ? m.shutter : `${m.shutter}s`);
  if (typeof m.aperture === 'number') parts.push(`f/${m.aperture}`);
  if (typeof m.iso === 'number') parts.push(`ISO ${m.iso}`);
  return parts.join('  ');
}

function FrameTooltip({ frameRef, preview, stageRef }: FrameTooltipProps) {
  const { t } = useTranslation();
  const mapRef = useRef<WinnerMap | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const frameCount = preview.frames.length;

  useEffect(() => {
    mapRef.current = null;
    setHover(null);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      mapRef.current = {
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        width: canvas.width,
        height: canvas.height,
      };
    };
    img.src = preview.winnerMap;
    return () => {
      img.onload = null;
    };
  }, [preview.winnerMap]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleMove = (e: PointerEvent) => {
      const map = mapRef.current;
      const frame = frameRef.current;
      if (!map || !frame) {
        setHover(null);
        return;
      }
      const rect = frame.getBoundingClientRect();
      const lx = e.clientX - rect.left;
      const ly = e.clientY - rect.top;
      if (lx < 0 || ly < 0 || lx >= rect.width || ly >= rect.height) {
        setHover(null);
        return;
      }
      const gx = Math.floor((lx / rect.width) * map.width);
      const gy = Math.floor((ly / rect.height) * map.height);
      const index = map.data[(gy * map.width + gx) * 4] - 1;
      if (index < 0 || index >= frameCount) {
        setHover(null);
        return;
      }
      const stageRect = stage.getBoundingClientRect();
      setHover({ index, x: e.clientX - stageRect.left + 12, y: e.clientY - stageRect.top - 20 });
    };
    const handleLeave = () => setHover(null);
    stage.addEventListener('pointermove', handleMove);
    stage.addEventListener('pointerleave', handleLeave);
    return () => {
      stage.removeEventListener('pointermove', handleMove);
      stage.removeEventListener('pointerleave', handleLeave);
    };
  }, [stageRef, frameRef, frameCount]);

  const frame = hover ? preview.frames[hover.index] : null;
  if (!hover || !frame) return null;

  return (
    <div
      className="absolute z-20 max-w-xs space-y-0.5 rounded-md border border-text-secondary/10 bg-surface/80 px-2.5 py-1.5 font-mono text-xs text-text-primary shadow-xl backdrop-blur-xs pointer-events-none"
      style={{ left: hover.x, top: hover.y }}
    >
      <div className="font-semibold truncate">{frame.name}</div>
      <div className="text-text-secondary">{exifLine(frame)}</div>
      {frame.focalOutlier && (
        <div className={TEXT_COLOR_KEYS[TextColors.error]}>{t('modals.panorama.focalDiffers')}</div>
      )}
      {frame.dropped && (
        <div className={TEXT_COLOR_KEYS[TextColors.error]}>
          {panoramaMessage(t, preview.dropped.find((d) => d.filename === frame.name)?.reason)}
        </div>
      )}
    </div>
  );
}

export default function PanoramaPreviewPane({
  crop,
  onCropChange,
  preview,
  progressMessage,
  reprojecting,
}: PanoramaPreviewPaneProps) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const size = useImageRenderSize(stageRef, { width: preview.width, height: preview.height });

  return (
    <div
      ref={stageRef}
      className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-bg-primary"
    >
      <ReactCrop crop={crop} onChange={(_, percent) => onCropChange(percent)} keepSelection>
        <div ref={frameRef} className="relative block" style={{ width: size.width, height: size.height }}>
          <img src={preview.image} alt={t('modals.panorama.previewAlt')} className="block h-full w-full" />
          <img src={preview.overlay} alt="" className="pointer-events-none absolute inset-0 h-full w-full opacity-80" />
        </div>
      </ReactCrop>
      <FrameTooltip frameRef={frameRef} preview={preview} stageRef={stageRef} />
      {reprojecting && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-bg-primary/60 text-text-primary">
          <Loader2 className="animate-spin" size={28} />
          <span className="text-xs font-mono">{panoramaMessage(t, progressMessage)}</span>
        </div>
      )}
    </div>
  );
}
