import { useEffect, useRef, useState } from 'react';
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
  const winnerImgRef = useRef<HTMLImageElement | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const size = useImageRenderSize(stageRef, { width: preview.width, height: preview.height });
  const hoveredFrame = hovered != null ? (preview.frames[hovered] ?? null) : null;

  useEffect(() => {
    winnerImgRef.current = null;
    const img = new Image();
    img.onload = () => {
      winnerImgRef.current = img;
    };
    img.src = preview.winnerMap;
    return () => {
      img.onload = null;
    };
  }, [preview.winnerMap]);

  const handlePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    const frame = frameRef.current;
    const map = winnerImgRef.current;
    if (!stage || !frame || !map) {
      setHovered(null);
      return;
    }
    const rect = frame.getBoundingClientRect();
    const lx = e.clientX - rect.left;
    const ly = e.clientY - rect.top;
    if (lx < 0 || ly < 0 || lx >= rect.width || ly >= rect.height) {
      setHovered(null);
      return;
    }
    const gx = Math.floor((lx / rect.width) * map.width);
    const gy = Math.floor((ly / rect.height) * map.height);
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(map, gx, gy, 1, 1, 0, 0, 1, 1);
    const idx = ctx.getImageData(0, 0, 1, 1).data[0] - 1;
    if (idx < 0 || idx >= preview.frames.length) {
      setHovered(null);
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    setHovered(idx);
    setTooltipPos({ x: e.clientX - stageRect.left + 12, y: e.clientY - stageRect.top - 20 });
  };

  return (
    <div
      ref={stageRef}
      onPointerMove={handlePointer}
      onPointerLeave={() => setHovered(null)}
      className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-bg-primary"
    >
      <ReactCrop crop={crop} onChange={(_, percent) => onCropChange(percent)} keepSelection>
        <div ref={frameRef} className="relative block" style={{ width: size.width, height: size.height }}>
          <img src={preview.image} alt={t('modals.panorama.previewAlt')} className="block h-full w-full" />
          <img src={preview.overlay} alt="" className="pointer-events-none absolute inset-0 h-full w-full opacity-80" />
        </div>
      </ReactCrop>
      {hoveredFrame && (
        <div
          className="absolute z-20 max-w-xs space-y-0.5 rounded-md border border-text-secondary/10 bg-surface/80 px-2.5 py-1.5 font-mono text-xs text-text-primary shadow-xl backdrop-blur-xs pointer-events-none"
          style={{ left: tooltipPos.x, top: tooltipPos.y }}
        >
          <div className="font-semibold truncate">{hoveredFrame.name}</div>
          <div className="text-text-secondary">{exifLine(hoveredFrame)}</div>
          {hoveredFrame.focalOutlier && (
            <div className={TEXT_COLOR_KEYS[TextColors.error]}>{t('modals.panorama.focalDiffers')}</div>
          )}
          {hoveredFrame.dropped && (
            <div className={TEXT_COLOR_KEYS[TextColors.error]}>
              {panoramaMessage(t, preview.dropped.find((d) => d.filename === hoveredFrame.name)?.reason)}
            </div>
          )}
        </div>
      )}
      {reprojecting && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-bg-primary/60 text-text-primary">
          <Loader2 className="animate-spin" size={28} />
          <span className="text-xs font-mono">{panoramaMessage(t, progressMessage)}</span>
        </div>
      )}
    </div>
  );
}
