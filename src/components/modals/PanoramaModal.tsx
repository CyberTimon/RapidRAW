import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, Loader2, RefreshCw, Save } from 'lucide-react';
import { motion } from 'framer-motion';
import ReactCrop, { type PercentCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import Button from '../ui/Button';
import Slider, { SliderChangeEvent } from '../ui/Slider';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import {
  panoramaMessage,
  type PanoramaCropRect,
  type PanoramaFrameInfo,
  type PanoramaMessage,
  type PanoramaPreview,
  type PanoramaProjection,
} from '../../utils/panorama';

interface PanoramaModalProps {
  error: PanoramaMessage | null;
  preview: PanoramaPreview | null;
  sourcePaths: string[];
  isOpen: boolean;
  isProcessing: boolean;
  loadingImageUrls: string[];
  onCancelSave(): void;
  onClose(): void;
  onOpenFile(path: string): void;
  onProjectionChange(projection: PanoramaProjection): void;
  onSave(crop: PanoramaCropRect, quality: number): Promise<string>;
  onStitch(): void;
  pendingProjection: PanoramaProjection | null;
  previewError: PanoramaMessage | null;
  progressMessage: PanoramaMessage | null;
  saveProgressMessage: PanoramaMessage | null;
  saveProgressPercent: number | null;
}

const FULL_QUALITY = 1;

function cropToPercent(crop: PanoramaCropRect): PercentCrop {
  return {
    unit: '%',
    x: crop.x * 100,
    y: crop.y * 100,
    width: crop.width * 100,
    height: crop.height * 100,
  };
}

function percentToCrop(crop: PercentCrop): PanoramaCropRect {
  const x = crop.x / 100;
  const y = crop.y / 100;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    width: Math.max(0.01, Math.min(1 - x, crop.width / 100)),
    height: Math.max(0.01, Math.min(1 - y, crop.height / 100)),
  };
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

function landscapeGrid(count: number): { rows: number; cols: number } {
  if (count <= 1) return { rows: 1, cols: 1 };
  if (count <= 3) return { rows: 1, cols: count };
  const target = 1.25;
  let best = { rows: 1, cols: count, score: Number.POSITIVE_INFINITY };
  for (let rows = 1; rows <= count; rows++) {
    const cols = Math.ceil(count / rows);
    const empty = rows * cols - count;
    const ratio = cols / rows;
    const score = empty + 3 * Math.abs(Math.log(ratio / target));
    const longer = Math.max(rows, cols);
    const bestLonger = Math.max(best.rows, best.cols);
    const closer =
      score < best.score - 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 && (longer < bestLonger || (longer === bestLonger && cols > best.cols)));
    if (closer) best = { rows, cols, score };
  }
  return { rows: best.rows, cols: best.cols };
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PrintPlace {
  left: number;
  top: number;
  width: number;
  height: number;
  rotate: number;
  z: number;
}

const PRINT_COVERAGE = 1.45;
const PRINT_JITTER = 0.25;

function placePrints(count: number, landscape: boolean, boxW: number, boxH: number): PrintPlace[] {
  if (count === 0 || boxW <= 0 || boxH <= 0) return [];
  if (count === 1) {
    const aspect = landscape ? 3 / 2 : 2 / 3;
    let width = boxW * 0.86;
    let height = width / aspect;
    if (height > boxH * 0.86) {
      height = boxH * 0.86;
      width = height * aspect;
    }
    const tilt = mulberry32(1)() * 2 - 1;
    return [
      {
        left: (boxW - width) / 2,
        top: (boxH - height) / 2,
        width,
        height,
        rotate: tilt * tilt * tilt * 8,
        z: 1,
      },
    ];
  }
  const grid = landscapeGrid(count);
  const rows = landscape ? grid.rows : grid.cols;
  const cols = landscape ? grid.cols : grid.rows;
  const cellW = boxW / cols;
  const cellH = boxH / rows;
  const photoAspect = landscape ? 3 / 2 : 2 / 3;
  let printW = cellW * PRINT_COVERAGE;
  let printH = printW / photoAspect;
  if (printH < cellH * PRINT_COVERAGE) {
    printH = cellH * PRINT_COVERAGE;
    printW = printH * photoAspect;
  }
  const cap = Math.min(1, (boxW * 0.78) / printW, (boxH * 0.72) / printH);
  printW *= cap;
  printH *= cap;
  const rand = mulberry32(count * 997);
  const cells = Array.from({ length: rows * cols }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  const used = cells.slice(0, count);
  const stack = used.map((_, i) => i);
  for (let i = stack.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [stack[i], stack[j]] = [stack[j], stack[i]];
  }
  return used.map((cell, i) => {
    const col = cell % cols;
    const row = Math.floor(cell / cols);
    const jx = (rand() - 0.5) * 2 * PRINT_JITTER * cellW;
    const jy = (rand() - 0.5) * 2 * PRINT_JITTER * cellH;
    const tilt = rand() * 2 - 1;
    const cx = (col + 0.5) * cellW + jx;
    const cy = (row + 0.5) * cellH + jy;
    return {
      left: cx - printW / 2,
      top: cy - printH / 2,
      width: printW,
      height: printH,
      rotate: tilt * tilt * tilt * 15,
      z: stack[i],
    };
  });
}

function LoadingCollage({ urls }: { urls: string[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [landscape, setLandscape] = useState(true);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const signature = urls.join('\0');
  useEffect(() => {
    let cancelled = false;
    let pending = urls.length;
    if (pending === 0) return;
    let wide = 0;
    let tall = 0;
    const finish = () => {
      pending -= 1;
      if (!cancelled && pending === 0) setLandscape(wide >= tall);
    };
    const images = urls.map((url) => {
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth >= img.naturalHeight) wide += 1;
        else tall += 1;
        finish();
      };
      img.onerror = finish;
      img.src = url;
      return img;
    });
    return () => {
      cancelled = true;
      images.forEach((img) => {
        img.onload = null;
        img.onerror = null;
      });
    };
  }, [signature]);
  const places = useMemo(
    () => placePrints(urls.length, landscape, box.w, box.h),
    [urls.length, landscape, box.w, box.h],
  );
  return (
    <div ref={boxRef} className="absolute inset-0">
      {urls.map((url, i) => {
        const place = places[i];
        if (!place) return null;
        return (
          <div
            key={`${url}-${i}`}
            className="absolute bg-white shadow-[0_8px_18px_rgba(0,0,0,0.45)]"
            style={{
              left: place.left,
              top: place.top,
              width: place.width,
              height: place.height,
              zIndex: place.z,
              padding: 3,
              transform: `rotate(${place.rotate}deg)`,
            }}
          >
            <img src={url} alt="" className="h-full w-full object-contain" />
          </div>
        );
      })}
    </div>
  );
}

const SIDEBAR_FALLBACK_PX = 220;
const DIALOG_PAD = 48;
const COLUMN_GAP = 24;
const ROW_GAP = 8;
const STATUS_ROW = 24;
const BAR_ROW = 40;
const NOTE_ROW = 40;
const FOOTER_PX = ROW_GAP + STATUS_ROW + ROW_GAP + BAR_ROW + ROW_GAP + NOTE_ROW;

function fitPreviewFrame(aspect: number, vw: number, vh: number, sidebarPx: number): { width: number; height: number } {
  const ratio = aspect > 0 && Number.isFinite(aspect) ? aspect : 2;
  const maxW = Math.max(160, vw * 0.8 - sidebarPx - DIALOG_PAD - COLUMN_GAP);
  const maxH = Math.max(160, vh * 0.74 - DIALOG_PAD - FOOTER_PX);
  let height = maxH;
  let width = height * ratio;
  if (width > maxW) {
    width = maxW;
    height = width / ratio;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

export default function PanoramaModal({
  error,
  preview,
  sourcePaths,
  isOpen,
  isProcessing,
  loadingImageUrls,
  onCancelSave,
  onClose,
  onOpenFile,
  onProjectionChange,
  onSave,
  onStitch,
  pendingProjection,
  previewError,
  progressMessage,
  saveProgressMessage,
  saveProgressPercent,
}: PanoramaModalProps) {
  const frames = preview?.frames ?? [];
  const dropped = preview?.dropped ?? [];
  const previewWidth = preview?.width ?? 0;
  const previewHeight = preview?.height ?? 0;
  const recommendedProjection = preview?.recommendedProjection ?? null;
  const { t, i18n } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ w: 1280, h: 800 });
  const [localCrop, setLocalCrop] = useState<PercentCrop | null>(null);
  const [quality, setQuality] = useState(FULL_QUALITY);
  const [hovered, setHovered] = useState<number | null>(null);
  const hoveredFrame: PanoramaFrameInfo | null = hovered != null ? (frames[hovered] ?? null) : null;
  const droppedReason = (name: string) => panoramaMessage(t, dropped.find((d) => d.filename === name)?.reason);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const startedRef = useRef(false);
  const mouseDownTarget = useRef<EventTarget | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [sidebarPx, setSidebarPx] = useState(SIDEBAR_FALLBACK_PX);
  const winnerImgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    }
    setShow(false);
    setSavedPath(null);
    setIsSaving(false);
    setQuality(FULL_QUALITY);
    startedRef.current = false;
    setHovered(null);
    const timer = setTimeout(() => setIsMounted(false), 300);
    return () => clearTimeout(timer);
  }, [isOpen]);
  useEffect(() => {
    const measure = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  useEffect(() => {
    setLocalCrop(preview ? cropToPercent(preview.crop) : null);
  }, [preview]);

  useEffect(() => {
    if (!isOpen || sourcePaths.length < 2 || startedRef.current) return;
    startedRef.current = true;
    onStitch();
  }, [isOpen, sourcePaths.join('\n')]);
  const winnerMap = preview?.winnerMap ?? null;
  useEffect(() => {
    if (!winnerMap) {
      winnerImgRef.current = null;
      return;
    }
    const img = new Image();
    img.onload = () => {
      winnerImgRef.current = img;
    };
    img.src = winnerMap;
    return () => {
      img.onload = null;
    };
  }, [winnerMap]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);
  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    mouseDownTarget.current = e.target;
  };
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && mouseDownTarget.current === e.currentTarget) {
      handleClose();
    }
    mouseDownTarget.current = null;
  };
  const handleSave = async () => {
    if (!localCrop) return;
    setIsSaving(true);
    try {
      const path = await onSave(percentToCrop(localCrop), quality);
      setSavedPath(path);
    } catch (e) {
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };
  const handleOpen = () => {
    if (savedPath) {
      onOpenFile(savedPath);
      handleClose();
    }
  };
  const handlePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!previewRef.current || !winnerImgRef.current || !previewWidth || !previewHeight) {
      setHovered(null);
      return;
    }
    const rect = previewRef.current.getBoundingClientRect();
    const containerAspect = rect.width / rect.height;
    const imageAspect = previewWidth / previewHeight;
    let drawW = rect.width;
    let drawH = rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (containerAspect > imageAspect) {
      drawW = rect.height * imageAspect;
      offsetX = (rect.width - drawW) / 2;
    } else {
      drawH = rect.width / imageAspect;
      offsetY = (rect.height - drawH) / 2;
    }
    const lx = e.clientX - rect.left - offsetX;
    const ly = e.clientY - rect.top - offsetY;
    if (lx < 0 || ly < 0 || lx > drawW || ly > drawH) {
      setHovered(null);
      return;
    }
    const gx = Math.floor((lx / drawW) * winnerImgRef.current.width);
    const gy = Math.floor((ly / drawH) * winnerImgRef.current.height);
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(winnerImgRef.current, gx, gy, 1, 1, 0, 0, 1, 1);
    const pixel = ctx.getImageData(0, 0, 1, 1).data[0];
    if (pixel === 0) {
      setHovered(null);
      return;
    }
    const idx = pixel - 1;
    if (idx >= 0 && idx < frames.length) {
      setHovered(idx);
      setTooltipPos({ x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 20 });
    } else {
      setHovered(null);
    }
  };
  const showingPreview = Boolean(preview) && !isProcessing;
  const showSaveProgress = isSaving || saveProgressPercent != null;
  useLayoutEffect(() => {
    const el = sidebarRef.current;
    if (!showingPreview || !el) return;
    const width = Math.ceil(el.getBoundingClientRect().width);
    if (width > 0) setSidebarPx((prev) => (prev === width ? prev : width));
  }, [showingPreview, i18n.language, recommendedProjection]);
  const percent = saveProgressPercent ?? 0;
  const previewFrame = fitPreviewFrame(
    previewWidth > 0 && previewHeight > 0 ? previewWidth / previewHeight : 2,
    viewport.w,
    viewport.h,
    sidebarPx,
  );
  const renderContent = () => {
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center py-10 h-[460px]">
          <div className="flex items-center justify-center mb-6">
            <XCircle className="w-12 h-12 text-red-500" />
          </div>
          <Text variant={TextVariants.title} className="mb-2 text-center">
            {t('modals.panorama.failed')}
          </Text>
          <Text className="text-left p-4 rounded-lg bg-bg-primary max-w-2xl mt-2 leading-relaxed whitespace-pre-wrap font-mono text-xs max-h-[320px] overflow-y-auto">
            {panoramaMessage(t, error)}
          </Text>
        </div>
      );
    }
    if (preview && localCrop && !isProcessing) {
      return (
        <div
          className="grid w-max items-start"
          style={{
            columnGap: COLUMN_GAP,
            rowGap: ROW_GAP,
            gridTemplateColumns: 'auto max-content',
            gridTemplateRows: `auto ${STATUS_ROW}px ${BAR_ROW}px minmax(${NOTE_ROW}px, auto)`,
          }}
        >
          <div
            ref={previewRef}
            onPointerMove={handlePointer}
            onPointerLeave={() => setHovered(null)}
            className="relative shrink-0 col-start-1 row-start-1 bg-black rounded-lg overflow-hidden border border-black"
          >
            <ReactCrop crop={localCrop} onChange={(_, percent) => setLocalCrop(percent)} keepSelection>
              <div className="relative block" style={{ width: previewFrame.width, height: previewFrame.height }}>
                <img
                  src={preview.image}
                  alt={t('modals.panorama.previewAlt')}
                  className="block"
                  style={{ width: previewFrame.width, height: previewFrame.height }}
                />
                <img
                  src={preview.overlay}
                  alt=""
                  className="absolute inset-0 w-full h-full object-contain pointer-events-none opacity-80"
                />
              </div>
            </ReactCrop>
            {hoveredFrame && (
              <div
                className="absolute z-20 bg-black/85 text-white text-xs font-mono px-2 py-1.5 rounded pointer-events-none space-y-0.5 max-w-xs"
                style={{ left: tooltipPos.x, top: tooltipPos.y }}
              >
                <div className="font-semibold truncate">{hoveredFrame.name}</div>
                <div className="text-white/80">{exifLine(hoveredFrame)}</div>
                {hoveredFrame.focalOutlier && <div className="text-amber-300">{t('modals.panorama.focalDiffers')}</div>}
                {hoveredFrame.dropped && <div className="text-amber-300">{droppedReason(hoveredFrame.name)}</div>}
              </div>
            )}
            {pendingProjection && (
              <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/50 text-white">
                <Loader2 className="animate-spin" size={28} />
                <span className="text-xs font-mono">{panoramaMessage(t, progressMessage)}</span>
              </div>
            )}
          </div>
          <div ref={sidebarRef} className="col-start-2 row-start-1 w-max">
            <div>
              <Text variant={TextVariants.small} className="uppercase tracking-wide opacity-60 mb-2">
                {t('modals.panorama.projection')}
              </Text>
              <div className="space-y-2">
                {preview.projections.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-sm cursor-pointer whitespace-nowrap">
                    <input
                      type="radio"
                      name="projection"
                      checked={(pendingProjection ?? preview.selectedProjection) === p}
                      disabled={isSaving}
                      onChange={() => onProjectionChange(p)}
                    />
                    <span className="capitalize whitespace-nowrap">
                      {t(`modals.panorama.projections.${p}`)}
                      {recommendedProjection === p ? ` (${t('modals.panorama.recommended')})` : ''}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div className="w-0 min-w-full">
              {!isSaving && (
                <div className="min-w-0 max-w-full pt-4 pb-1">
                  <Slider
                    defaultValue={FULL_QUALITY * 100}
                    fillOrigin="min"
                    label={t('modals.panorama.quality')}
                    max={FULL_QUALITY * 100}
                    min={preview.minQuality * 100}
                    step={5}
                    suffix="%"
                    value={quality * 100}
                    onChange={(e: SliderChangeEvent) => setQuality(Number(e.target.value) / 100)}
                    trackClassName="bg-white/30"
                  />
                  <p className="mt-1.5 text-[11px] leading-snug text-text-tertiary">
                    {t('modals.panorama.qualityHint')}
                  </p>
                </div>
              )}

              {dropped.length > 0 && (
                <div className="p-2 rounded-lg border border-amber-700/40 bg-amber-950/30 text-xs text-amber-200">
                  <div className="font-semibold mb-1">{t('modals.panorama.excluded', { count: dropped.length })}</div>
                  <ul className="space-y-1.5">
                    {dropped.map((d, i) => (
                      <li key={i} className="font-mono">
                        <div className="truncate">{d.filename}</div>
                        <div className="text-amber-200/80 text-[11px] leading-snug">{panoramaMessage(t, d.reason)}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {savedPath && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <Text
                    as="div"
                    variant={TextVariants.heading}
                    color={TextColors.success}
                    className="flex items-center gap-2"
                  >
                    <CheckCircle className="w-5 h-5" />
                    <span>{t('modals.panorama.savedSuccess')}</span>
                  </Text>
                </motion.div>
              )}
            </div>
          </div>
          <div className="col-start-1 row-start-2 flex items-center justify-between gap-3 text-xs text-text-secondary">
            {showSaveProgress && (
              <>
                <span className="truncate font-mono">
                  {panoramaMessage(t, saveProgressMessage) ||
                    t('modals.panorama.savingProgress', { percent: Math.round(percent) })}
                </span>
                <span className="shrink-0 tabular-nums">{Math.round(percent)}%</span>
              </>
            )}
          </div>
          <div className="col-start-1 row-start-3 flex items-center">
            {showSaveProgress && (
              <div className="h-1.5 w-full rounded-full bg-white/20 overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
                  style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
                />
              </div>
            )}
          </div>
          <div className="col-start-2 row-start-3 flex min-w-0 items-center justify-between gap-2 [contain:inline-size]">
            {savedPath ? (
              <>
                <button
                  onClick={handleClose}
                  className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors"
                >
                  {t('modals.panorama.close')}
                </button>
                <Button onClick={handleOpen}>{t('modals.panorama.openInEditor')}</Button>
              </>
            ) : (
              <>
                <button
                  onClick={isSaving ? onCancelSave : handleClose}
                  className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors text-sm"
                >
                  {isSaving ? t('modals.panorama.cancel') : t('modals.panorama.close')}
                </button>
                <Button onClick={handleSave} disabled={isSaving || Boolean(pendingProjection)}>
                  {isSaving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
                  {t('modals.panorama.save')}
                </Button>
              </>
            )}
          </div>
          <div className="col-start-1 row-start-4 min-w-0">
            {previewError && (
              <Text variant={TextVariants.small} color={TextColors.error} className="whitespace-pre-line">
                {panoramaMessage(t, previewError)}
              </Text>
            )}
          </div>
        </div>
      );
    }
    if (isProcessing) {
      return (
        <div className="flex h-[460px] overflow-hidden rounded-lg border border-surface">
          <div className="w-2/5 relative overflow-hidden shrink-0 bg-[#0a0a0a]">
            {loadingImageUrls && loadingImageUrls.length > 0 ? (
              <LoadingCollage urls={loadingImageUrls} />
            ) : (
              <div className="w-full h-full bg-surface/50" />
            )}
          </div>
          <div className="flex-1 flex flex-col items-center justify-center px-12 bg-bg-primary">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1, duration: 0.4 }}
              className="flex flex-col items-center w-full"
            >
              <Text variant={TextVariants.title} className="mb-2 text-center">
                {t('modals.panorama.stitchingProgress')}
              </Text>
              <Text className="text-center font-mono h-6 flex justify-center items-center">
                {panoramaMessage(t, progressMessage) || t('modals.panorama.initializing')}
              </Text>
              <div className="mt-8 w-64 relative">
                <div className="h-1 bg-surface rounded-full overflow-hidden relative w-full shadow-xs">
                  <motion.div
                    className="absolute inset-y-0 w-[80%] bg-linear-to-r from-transparent via-accent to-transparent mix-blend-screen"
                    style={{ filter: 'blur(3px)' }}
                    animate={{ x: ['-150%', '150%'] }}
                    transition={{ repeat: Infinity, duration: 1.5, ease: [0.4, 0, 0.2, 1] }}
                  />
                </div>
              </div>
              <Text variant={TextVariants.small} className="mt-6 text-center max-w-xs opacity-60">
                {t('modals.panorama.speedNotice')}
              </Text>
            </motion.div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center py-10 h-[460px]">
        <Text variant={TextVariants.small} className="text-text-secondary">
          {t('modals.panorama.initializing')}
        </Text>
      </div>
    );
  };
  const renderButtons = () => (
    <div className="w-full flex items-center justify-end gap-2">
      <button
        onClick={handleClose}
        className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors text-sm"
      >
        {error ? t('modals.panorama.close') : t('modals.panorama.cancel')}
      </button>
      {error && (
        <Button onClick={onStitch}>
          <RefreshCw className="mr-2" size={16} />
          {t('modals.panorama.retry')}
        </Button>
      )}
    </div>
  );
  if (!isMounted) return null;
  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/40 backdrop-blur-xs transition-opacity duration-300 ease-in-out ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div
        className={`bg-surface rounded-xl shadow-2xl p-6 transform transition-all duration-300 ease-out ${
          showingPreview ? 'w-max' : 'w-full max-w-5xl'
        } ${show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'}`}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={`flex flex-col ${showingPreview ? 'w-max' : ''}`}>
          {renderContent()}
          {!(showingPreview && !error) && (
            <div className="mt-4 flex w-full pt-4 border-t border-surface/50">{renderButtons()}</div>
          )}
        </div>
      </div>
    </div>
  );
}
