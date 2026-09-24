import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle,
  XCircle,
  Loader2,
  Save,
  RefreshCw,
  ZoomIn,
  ZoomOut,
  Move,
  Grip,
  Sparkles,
  Wand2,
  Eye,
  ShieldCheck,
  SplitSquareVertical,
  Columns,
  Maximize2,
  Layers,
  Camera,
  Sliders,
  Bookmark,
  Zap,
  Cpu,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import Button from '../ui/Button';
import Dropdown from '../ui/Dropdown';
import Slider from '../ui/Slider';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import { listen } from '@tauri-apps/api/event';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useEditorStore } from '../../store/useEditorStore';
import { Invokes } from '../ui/AppProperties';

interface DenoiseModalProps {
  isOpen: boolean;
  onClose(): void;
  onDenoise(
    intensity: number,
    method: 'ai' | 'bm3d',
    healDust?: boolean,
    visualizeDefects?: boolean,
    protectStars?: boolean,
    preserveDetails?: number,
    chromaIntensity?: number,
    shadowBoost?: number,
    deband?: boolean,
    filmGrain?: number
  ): void;
  onBatchDenoise(
    intensity: number,
    method: 'ai' | 'bm3d',
    paths: string[],
    healDust?: boolean,
    protectStars?: boolean,
    preserveDetails?: number,
    chromaIntensity?: number,
    shadowBoost?: number,
    deband?: boolean,
    filmGrain?: number
  ): Promise<string[]>;
  onSave(): Promise<string>;
  onOpenFile(path: string): void;
  error: string | null;
  previewBase64: string | null;
  originalBase64: string | null;
  isProcessing: boolean;
  progressMessage: string | null;
  aiModelDownloadStatus: string | null;
  isRaw: boolean;
  loadingImageUrl?: string | null;
  targetPaths: string[];
}

interface SnapshotState {
  intensity: number;
  chromaIntensity: number;
  preserveDetails: number;
  shadowBoost: number;
  filmGrain: number;
  deband: boolean;
  protectStars: boolean;
  healDust: boolean;
  method: 'ai' | 'bm3d';
}

const ImageCompare = ({
  original,
  denoised,
  isHoldingOriginal,
  viewMode = 'split',
  onViewModeChange,
}: {
  original: string;
  denoised: string;
  isHoldingOriginal?: boolean;
  viewMode?: 'split' | 'side-by-side' | 'single';
  onViewModeChange?: (mode: 'split' | 'side-by-side' | 'single') => void;
}) => {
  const { t } = useTranslation();
  const [sliderPosition, setSliderPosition] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const [isDragging, setIsDragging] = useState(false);
  const [isResizingSlider, setIsResizingSlider] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const lastMousePos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!isDragging && !isResizingSlider) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      if (isResizingSlider) {
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const percent = (x / rect.width) * 100;
        setSliderPosition(percent);
      } else if (isDragging) {
        const dx = e.clientX - lastMousePos.current.x;
        const dy = e.clientY - lastMousePos.current.y;
        setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
        lastMousePos.current = { x: e.clientX, y: e.clientY };
      }
    };

    const handleWindowMouseUp = () => {
      setIsDragging(false);
      setIsResizingSlider(false);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [isDragging, isResizingSlider]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (isResizingSlider) return;
    e.preventDefault();
    setIsDragging(true);
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handleSliderMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setIsResizingSlider(true);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    if (!containerRef.current) return;

    const zoomFactor = 1.15;
    let newZoom = zoom;

    if (e.deltaY < 0) {
      newZoom = Math.min(zoom * zoomFactor, 6);
    } else {
      newZoom = Math.max(zoom / zoomFactor, 0.5);
    }

    setZoom(newZoom);
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-[460px] bg-[#0a0a0a] rounded-lg overflow-hidden border border-surface select-none cursor-grab active:cursor-grabbing"
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
    >
      {viewMode === 'side-by-side' ? (
        <div className="w-full h-full flex items-center justify-center relative">
          <div className="w-1/2 h-full relative overflow-hidden border-r border-border-color/60">
            <div
              className="w-full h-full flex items-center justify-center relative"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: 'center center',
              }}
            >
              <img src={original} alt="Original" className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
            </div>
            <span className="absolute top-2 left-2 bg-black/70 px-2 py-0.5 rounded text-[10px] font-mono text-white pointer-events-none">
              Original (Noisy)
            </span>
          </div>
          <div className="w-1/2 h-full relative overflow-hidden">
            <div
              className="w-full h-full flex items-center justify-center relative"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: 'center center',
              }}
            >
              <img src={denoised} alt="Denoised" className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
            </div>
            <span className="absolute top-2 left-2 bg-accent/80 px-2 py-0.5 rounded text-[10px] font-mono text-white pointer-events-none">
              Denoised & Restored
            </span>
          </div>
        </div>
      ) : (
        <div
          className="w-full h-full flex items-center justify-center relative"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            transition: isDragging ? 'none' : 'transform 0.1s ease-out',
          }}
        >
          <img
            src={isHoldingOriginal ? original : denoised}
            alt="Main"
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
          />

          {viewMode === 'split' && !isHoldingOriginal && (
            <div
              className="absolute inset-0 overflow-hidden pointer-events-none"
              style={{ clipPath: `polygon(0 0, ${sliderPosition}% 0, ${sliderPosition}% 100%, 0 100%)` }}
            >
              <img
                src={original}
                alt="Original"
                className="absolute inset-0 w-full h-full object-contain pointer-events-none"
              />
            </div>
          )}
        </div>
      )}

      {viewMode === 'split' && !isHoldingOriginal && (
        <div
          className="absolute top-0 bottom-0 w-1 bg-white cursor-ew-resize z-10 flex items-center justify-center shadow-[0_0_8px_rgba(0,0,0,0.5)]"
          style={{ left: `${sliderPosition}%`, transform: 'translateX(-50%)' }}
          onMouseDown={handleSliderMouseDown}
        >
          <div className="w-6 h-6 rounded-full bg-white text-black flex items-center justify-center shadow-lg border border-neutral-300">
            <Move size={12} />
          </div>
        </div>
      )}

      {/* Floating Toolbar */}
      <div className="absolute bottom-3 left-3 flex items-center gap-1.5 z-20 bg-surface/90 backdrop-blur-md px-2 py-1 rounded-md border border-border-color/50">
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(z * 1.25, 6))}
          className="p-1 hover:bg-card-active rounded text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
          title="Zoom In"
        >
          <ZoomIn size={15} />
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(z / 1.25, 0.5))}
          className="p-1 hover:bg-card-active rounded text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
          title="Zoom Out"
        >
          <ZoomOut size={15} />
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          className="px-1.5 py-0.5 hover:bg-card-active rounded text-text-secondary hover:text-text-primary text-[10px] font-mono transition-colors cursor-pointer"
          title="Fit to Screen"
        >
          FIT
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(2);
            setPan({ x: 0, y: 0 });
          }}
          className="px-1.5 py-0.5 hover:bg-card-active rounded text-text-secondary hover:text-text-primary text-[10px] font-mono transition-colors cursor-pointer"
          title="100% Pixel Peep (1:1)"
        >
          100%
        </button>

        <div className="h-4 w-px bg-border-color/60 mx-0.5" />

        <button
          type="button"
          onClick={() => onViewModeChange?.('split')}
          className={`p-1 rounded transition-colors ${viewMode === 'split' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
          title="Split View (Draggable Divider)"
        >
          <SplitSquareVertical size={14} />
        </button>
        <button
          type="button"
          onClick={() => onViewModeChange?.('side-by-side')}
          className={`p-1 rounded transition-colors ${viewMode === 'side-by-side' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
          title="Side-by-Side Dual Viewport"
        >
          <Columns size={14} />
        </button>
        <button
          type="button"
          onClick={() => onViewModeChange?.('single')}
          className={`p-1 rounded transition-colors ${viewMode === 'single' ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
          title="Single Denoised View"
        >
          <Maximize2 size={14} />
        </button>
      </div>

      <div className="flex justify-between w-full pointer-events-none">
        <Text
          as="span"
          variant={TextVariants.small}
          weight={TextWeights.medium}
          className="absolute top-3 left-3 bg-black/70 backdrop-blur-md px-2.5 py-1 rounded-md text-[11px] font-mono z-10"
        >
          {isHoldingOriginal ? '⚡ ORIGINAL (HOLDING)' : viewMode === 'split' ? 'ORIGINAL (LEFT)' : 'VIEWPORT'}
        </Text>
        <Text
          as="span"
          variant={TextVariants.small}
          weight={TextWeights.medium}
          className="absolute top-3 right-3 bg-accent/90 backdrop-blur-md px-2.5 py-1 rounded-md text-[11px] font-mono z-10"
        >
          DENOISED (RIGHT) · HOLD [ \ ] TO COMPARE
        </Text>
      </div>
    </div>
  );
};

export default function DenoiseModal({
  isOpen,
  onClose,
  onDenoise,
  onBatchDenoise,
  onSave,
  onOpenFile,
  error,
  previewBase64,
  originalBase64,
  isProcessing,
  progressMessage,
  aiModelDownloadStatus,
  isRaw,
  loadingImageUrl,
  targetPaths,
}: DenoiseModalProps) {
  const { t } = useTranslation();
  const selectedImage = useEditorStore((state) => state.selectedImage);
  const imageList = useLibraryStore((state) => state.imageList);

  const activeIso = useMemo(() => {
    const target = (targetPaths[0] && imageList.find((img) => img.path === targetPaths[0])) || selectedImage;
    if (!target?.exif) return null;
    const isoVal = target.exif['PhotographicSensitivity'] || target.exif['ISO'] || target.exif['ISOSpeedRatings'];
    if (!isoVal) return null;
    const parsed = parseInt(isoVal, 10);
    return isNaN(parsed) || parsed <= 0 ? null : parsed;
  }, [targetPaths, imageList, selectedImage]);

  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  // Pro parameters
  const [intensity, setIntensity] = useState<number>(35);
  const [chromaIntensity, setChromaIntensity] = useState<number>(100);
  const [preserveDetails, setPreserveDetails] = useState<number>(25);
  const [shadowBoost, setShadowBoost] = useState<number>(0);
  const [filmGrain, setFilmGrain] = useState<number>(0);
  const [deband, setDeband] = useState<boolean>(false);
  const [method, setMethod] = useState<'ai' | 'bm3d'>('ai');
  const [healDust, setHealDust] = useState(true);
  const [protectStars, setProtectStars] = useState(true);
  const [dustSpotsHealed, setDustSpotsHealed] = useState<number | null>(null);
  const [visualizeDefects, setVisualizeDefects] = useState(false);
  const [empiricalSigma, setEmpiricalSigma] = useState<number | null>(null);
  const [cameraProfile, setCameraProfile] = useState<{ make: string; model: string; sensor_type: string } | null>(null);
  const [autoProfile, setAutoProfile] = useState<{
    sigma: number;
    effective_iso: number;
    snr_db: number;
    make?: string;
    model?: string;
    sensor_type?: string;
    dual_gain_active?: boolean;
    recommended_engine: 'ai' | 'bm3d';
    recommended_intensity: number;
    recommended_chroma: number;
    recommended_details: number;
    recommended_shadow_boost: number;
    recommended_deband: boolean;
    flat_patch_used?: boolean;
    gpu_accelerator?: string;
    pipeline_mode?: string;
    est_speed_sec?: number;
  } | null>(null);

  // Comparison View State
  const [viewMode, setViewMode] = useState<'split' | 'side-by-side' | 'single'>('split');
  const [isHoldingOriginal, setIsHoldingOriginal] = useState(false);
  const [activeTab, setActiveTab] = useState<'basic' | 'pro' | 'presets'>('basic');

  // A / B / C Snapshot Matrix
  const [activeSnapshot, setActiveSnapshot] = useState<'A' | 'B' | 'C'>('A');
  const [snapshots, setSnapshots] = useState<{ [key: string]: SnapshotState | null }>({
    A: null,
    B: null,
    C: null,
  });

  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; path: string } | null>(null);

  // Real-Time Sub-Tile Loupe ROI Preview State (<25ms)
  const [roiPreview, setRoiPreview] = useState<{ original: string; denoised: string } | null>(null);
  const [isRoiLoading, setIsRoiLoading] = useState(false);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const isBatch = targetPaths.length > 1;
  const mouseDownTarget = useRef<EventTarget | null>(null);
  const recommendedEngine: 'ai' | 'bm3d' = useMemo(() => {
    if (isRaw) return 'ai';
    if (activeIso && activeIso >= 800) return 'ai';
    if (empiricalSigma && empiricalSigma > 0.05) return 'ai';
    return 'bm3d';
  }, [isRaw, activeIso, empiricalSigma]);

  const recommendationReason = useMemo(() => {
    if (isRaw) return 'RAW sensor data detected · Neural Deep Denoise reconstructs authentic sensor Bayer patterns';
    if (activeIso && activeIso >= 800) return `High ISO (${activeIso}) · AI Neural model eliminates heavy color noise & grain`;
    return 'Low noise floor / daylight · Guided Wavelet preserves razor-sharp edges with zero hallucination';
  }, [isRaw, activeIso]);

  const methodOptions = useMemo<Array<{ label: string; value: 'ai' | 'bm3d' }>>(
    () => [
      {
        label: `${t('modals.denoise.methodAi')}${recommendedEngine === 'ai' ? ' ✨ (Recommended)' : ''}`,
        value: 'ai',
      },
      {
        label: `${t('modals.denoise.methodBm3d')}${recommendedEngine === 'bm3d' ? ' ✨ (Recommended)' : ''}`,
        value: 'bm3d',
      },
    ],
    [t, recommendedEngine],
  );

  // Global keydown for hold-to-compare and snapshots
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === '\\' || e.code === 'Space') {
        setIsHoldingOriginal(true);
      } else if (e.key === '1') {
        recallSnapshot('A');
      } else if (e.key === '2') {
        recallSnapshot('B');
      } else if (e.key === '3') {
        recallSnapshot('C');
      } else if (e.key.toLowerCase() === 's') {
        setViewMode((m) => (m === 'split' ? 'side-by-side' : 'split'));
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === '\\' || e.code === 'Space') {
        setIsHoldingOriginal(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isOpen, intensity, chromaIntensity, preserveDetails, shadowBoost, filmGrain, deband, protectStars, healDust, method]);

  const saveCurrentSnapshot = (slot: 'A' | 'B' | 'C') => {
    const current: SnapshotState = {
      intensity,
      chromaIntensity,
      preserveDetails,
      shadowBoost,
      filmGrain,
      deband,
      protectStars,
      healDust,
      method,
    };
    setSnapshots((prev) => ({ ...prev, [slot]: current }));
    setActiveSnapshot(slot);
  };

  const recallSnapshot = (slot: 'A' | 'B' | 'C') => {
    const snap = snapshots[slot];
    if (snap) {
      setIntensity(snap.intensity);
      setChromaIntensity(snap.chromaIntensity);
      setPreserveDetails(snap.preserveDetails);
      setShadowBoost(snap.shadowBoost);
      setFilmGrain(snap.filmGrain);
      setDeband(snap.deband);
      setProtectStars(snap.protectStars);
      setHealDust(snap.healDust);
      setMethod(snap.method);
      setActiveSnapshot(slot);
    } else {
      saveCurrentSnapshot(slot);
    }
  };

  const applyPreset = (presetName: string) => {
    setActivePresetId(presetName);
    switch (presetName) {
      case 'astro':
        setIntensity(65);
        setChromaIntensity(100);
        setProtectStars(true);
        setPreserveDetails(35);
        setShadowBoost(20);
        setDeband(true);
        setFilmGrain(0);
        break;
      case 'portrait':
        setIntensity(40);
        setChromaIntensity(100);
        setPreserveDetails(30);
        setShadowBoost(0);
        setFilmGrain(6);
        setDeband(false);
        break;
      case 'wildlife':
        setIntensity(35);
        setChromaIntensity(100);
        setPreserveDetails(50);
        setShadowBoost(30);
        setFilmGrain(0);
        break;
      case 'extreme':
        setIntensity(80);
        setChromaIntensity(100);
        setPreserveDetails(20);
        setShadowBoost(40);
        setDeband(true);
        setFilmGrain(0);
        break;
      case 'analog':
        setIntensity(25);
        setChromaIntensity(80);
        setPreserveDetails(25);
        setFilmGrain(18);
        break;
      default: // auto
        if (empiricalSigma) {
          const autoIntensity = Math.min(85, Math.max(15, Math.round(empiricalSigma * 180)));
          setIntensity(autoIntensity);
        }
        setChromaIntensity(100);
        setPreserveDetails(25);
        setShadowBoost(0);
        setFilmGrain(0);
        break;
    }
  };

  useEffect(() => {
    const unlistenBatch = listen('denoise-batch-progress', (e: any) => {
      setBatchProgress(e.payload);
    });
    const unlistenComplete = listen('denoise-complete', (e: any) => {
      if (e.payload?.dust_spots_healed !== undefined) {
        setDustSpotsHealed(e.payload.dust_spots_healed);
      }
    });
    return () => {
      unlistenBatch.then((f) => f());
      unlistenComplete.then((f) => f());
    };
  }, []);

  const currentStatusText =
    isBatch && batchProgress
      ? t('modals.denoise.batchProgressText', { current: batchProgress.current, total: batchProgress.total })
      : aiModelDownloadStatus?.includes('NIND')
        ? t('modals.denoise.downloadingText', { status: aiModelDownloadStatus })
        : progressMessage || t('modals.denoise.initializing');

  useEffect(() => {
    if (isOpen) {
      const initialEngine = isRaw || (activeIso && activeIso >= 800) ? 'ai' : 'bm3d';
      setMethod(initialEngine);
      const targetPath = targetPaths[0] || selectedImage?.path;

      if (targetPath) {
        invoke<{
          sigma: number;
          iso: number | null;
          effective_iso: number;
          snr_db: number;
          make?: string;
          model?: string;
          sensor_type?: string;
          dual_gain_active?: boolean;
          recommended_engine: 'ai' | 'bm3d';
          recommended_intensity: number;
          recommended_chroma: number;
          recommended_details: number;
          recommended_shadow_boost: number;
          recommended_deband: boolean;
          flat_patch_used?: boolean;
        }>(Invokes.AnalyzeImageNoiseProfile, { path: targetPath, exposure_push: 0.0 })
          .then((profile) => {
            if (profile?.sigma !== undefined) {
              setEmpiricalSigma(profile.sigma);
              setAutoProfile(profile);
              if (profile.recommended_intensity) {
                setIntensity(profile.recommended_intensity);
              }
              if (profile.recommended_chroma !== undefined) {
                setChromaIntensity(profile.recommended_chroma);
              }
              if (profile.recommended_details !== undefined) {
                setPreserveDetails(profile.recommended_details);
              }
              if (profile.recommended_shadow_boost !== undefined) {
                setShadowBoost(profile.recommended_shadow_boost);
              }
              if (profile.recommended_deband !== undefined) {
                setDeband(profile.recommended_deband);
              }
              if (profile.recommended_engine) {
                setMethod(profile.recommended_engine);
              }
              if (profile.make || profile.model) {
                setCameraProfile({
                  make: profile.make || 'Universal',
                  model: profile.model || 'CMOS',
                  sensor_type: profile.sensor_type || 'Universal CMOS Sensor',
                });
              }
            }
          })
          .catch((e) => {
            console.warn('Fast noise profiling fallback:', e);
            if (activeIso) {
              const autoIntensity = Math.min(85, Math.max(15, Math.round(Math.log2(activeIso / 100) * 12 + 20)));
              setIntensity(autoIntensity);
            } else {
              setIntensity(isRaw ? 50 : 15);
            }
          });
      } else if (activeIso) {
        const autoIntensity = Math.min(85, Math.max(15, Math.round(Math.log2(activeIso / 100) * 12 + 20)));
        setIntensity(autoIntensity);
      } else {
        setIntensity(isRaw ? 50 : 15);
      }

      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setSavedPath(null);
        setIsSaving(false);
        setBatchProgress(null);
        setEmpiricalSigma(null);
        setCameraProfile(null);
        setAutoProfile(null);
        setRoiPreview(null);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen, isRaw, activeIso, targetPaths, selectedImage]);

  // Real-time Sub-Tile Loupe ROI Preview Debounce (<25ms)
  useEffect(() => {
    if (!isOpen || isBatch || isProcessing) return;
    const targetPath = targetPaths[0] || selectedImage?.path;
    if (!targetPath) return;

    const timer = setTimeout(async () => {
      setIsRoiLoading(true);
      try {
        const res = await invoke<{ original_roi: string; denoised_roi: string }>(Invokes.PreviewDenoisedRoi, {
          path: targetPath,
          centerX: 0.5,
          centerY: 0.5,
          cropSize: 512,
          intensity: intensity / 100,
          chromaIntensity: chromaIntensity / 100,
          preserveDetails: preserveDetails / 100,
          shadowBoost: shadowBoost / 100,
          deband,
          protectStars,
          filmGrain: filmGrain / 100,
          method,
        });
        if (res?.original_roi && res?.denoised_roi) {
          setRoiPreview({ original: res.original_roi, denoised: res.denoised_roi });
        }
      } catch (e) {
        console.warn('Real-time Loupe ROI preview failed:', e);
      } finally {
        setIsRoiLoading(false);
      }
    }, 120);

    return () => clearTimeout(timer);
  }, [
    isOpen,
    isBatch,
    isProcessing,
    targetPaths,
    selectedImage,
    intensity,
    chromaIntensity,
    preserveDetails,
    shadowBoost,
    deband,
    protectStars,
    filmGrain,
    method,
  ]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    onClose();
  }, [onClose, isSaving]);

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    mouseDownTarget.current = e.target;
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && mouseDownTarget.current === e.currentTarget) {
      handleClose();
    }
    mouseDownTarget.current = null;
  };

  const handleRunDenoise = async () => {
    setSavedPath(null);
    if (isBatch) {
      setIsSaving(true);
      try {
        await onBatchDenoise(
          intensity / 100,
          method,
          targetPaths,
          healDust,
          protectStars,
          preserveDetails / 100,
          chromaIntensity / 100,
          shadowBoost / 100,
          deband,
          filmGrain / 100
        );
        onClose();
      } catch (e) {
        console.error('Batch denoise failed:', e);
      } finally {
        setIsSaving(false);
        setBatchProgress(null);
      }
    } else {
      onDenoise(
        intensity / 100,
        method,
        healDust,
        visualizeDefects,
        protectStars,
        preserveDetails / 100,
        chromaIntensity / 100,
        shadowBoost / 100,
        deband,
        filmGrain / 100
      );
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const path = await onSave();
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

  const renderContent = () => {
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center py-6 h-[260px] md:h-[340px]">
          <div className="flex items-center justify-center mb-6">
            <XCircle className="w-12 h-12 text-red-500" />
          </div>
          <Text variant={TextVariants.title} className="mb-2 text-center">
            {t('modals.denoise.processingFailed')}
          </Text>
          <Text className="text-center p-4 rounded-lg bg-bg-primary max-w-md mt-2 leading-relaxed">
            {String(error)}
          </Text>
        </div>
      );
    }

    const activePreview = previewBase64 || roiPreview?.denoised;
    const activeOriginal = originalBase64 || roiPreview?.original;

    if (activePreview && activeOriginal && !isProcessing && !isBatch) {
      return (
        <div className="w-full h-[300px] md:h-[400px] relative">
          <ImageCompare
            original={activeOriginal}
            denoised={activePreview}
            isHoldingOriginal={isHoldingOriginal}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
          />
          {!previewBase64 && roiPreview && (
            <div className="absolute top-3 right-3 z-30 pointer-events-none flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface/90 backdrop-blur-md border border-accent/30 text-accent text-[11px] font-mono shadow-md">
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
              <span>100% Loupe Live ROI (512x512)</span>
              {isRoiLoading && <Loader2 size={11} className="animate-spin text-accent" />}
            </div>
          )}
          {savedPath && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
              <Text
                as="div"
                variant={TextVariants.heading}
                color={TextColors.success}
                className="flex items-center justify-center gap-2 mt-4"
              >
                <CheckCircle className="w-5 h-5" />
                <span>{t('modals.denoise.saveSuccess')}</span>
              </Text>
            </motion.div>
          )}
        </div>
      );
    }

    if (isProcessing || (isBatch && isSaving)) {
      return (
        <div className="flex flex-col items-center justify-center py-6 h-[260px] md:h-[340px]">
          <Loader2 className="w-12 h-12 animate-spin text-accent mb-4" />
          <Text variant={TextVariants.title} className="mb-2">
            {currentStatusText}
          </Text>
          <Text color={TextColors.secondary}>{t('modals.denoise.waitText', 'This may take a moment depending on resolution...')}</Text>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center py-4 h-[260px] md:h-[340px] text-center">
        <div className="relative mb-4">
          <div className="w-20 h-20 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
            <Sparkles size={36} />
          </div>
          {cameraProfile && (
            <span className="absolute -bottom-2 -right-2 px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[9px] font-mono">
              {cameraProfile.make}
            </span>
          )}
        </div>
        <Text variant={TextVariants.heading} weight={TextWeights.semibold} className="mb-1">
          {isBatch ? t('modals.denoise.titleBatch', 'Batch RAW Denoise') : 'Professional Studio Denoise Engine'}
        </Text>
        <Text color={TextColors.secondary} className="max-w-md text-sm leading-relaxed mb-4">
          {isBatch
            ? t('modals.denoise.descBatch', `Batch denoise ${targetPaths.length} selected images`)
            : 'AI Neural + Wavelet BM3D joint engine. Erases high-ISO color blotches while preserving organic pores, eyelashes, and pinpoint stars.'}
        </Text>
        <div className="flex flex-wrap items-center justify-center gap-2 max-w-xl">
          {cameraProfile && (
            <span
              className="px-2.5 py-1 rounded-md bg-blue-500/10 text-blue-300 text-[11px] font-mono border border-blue-500/30 flex items-center gap-1.5 shadow-sm"
              title={cameraProfile.sensor_type}
            >
              <Camera size={12} className="text-blue-400" />
              <span>{cameraProfile.make} {cameraProfile.model}</span>
            </span>
          )}
          {autoProfile?.gpu_accelerator && (
            <span
              className="px-2.5 py-1 rounded-md bg-cyan-500/10 text-cyan-300 text-[11px] font-mono border border-cyan-500/30 flex items-center gap-1.5 shadow-sm"
              title={`Hardware Acceleration: ${autoProfile.gpu_accelerator}`}
            >
              <Cpu size={12} className="text-cyan-400" />
              <span>{autoProfile.gpu_accelerator}</span>
            </span>
          )}
          {autoProfile?.pipeline_mode && (
            <span
              className="px-2.5 py-1 rounded-md bg-purple-500/10 text-purple-300 text-[11px] font-mono border border-purple-500/30 flex items-center gap-1.5 shadow-sm"
              title={`Pipeline Architecture: ${autoProfile.pipeline_mode}`}
            >
              <Layers size={12} className="text-purple-400" />
              <span>{autoProfile.pipeline_mode}</span>
              {autoProfile.est_speed_sec ? ` (~${autoProfile.est_speed_sec}s)` : ''}
            </span>
          )}
          {empiricalSigma !== null && (
            <span
              className="px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-300 text-[11px] font-mono border border-emerald-500/30 flex items-center gap-1.5 shadow-sm"
              title={autoProfile ? `Effective ISO ${autoProfile.effective_iso} · SNR ${autoProfile.snr_db} dB · Base noise ${(empiricalSigma * 100).toFixed(2)}%` : undefined}
            >
              <Zap size={12} className="text-emerald-400" />
              <span>
                {autoProfile ? `ISO ${autoProfile.effective_iso}` : activeIso ? `ISO ${activeIso}` : 'Auto'}
                {autoProfile ? ` · SNR ${autoProfile.snr_db}dB` : ''}
                {` · σ = ${(empiricalSigma * 100).toFixed(1)}%`}
                {autoProfile?.dual_gain_active ? ' · ⚡ DCG' : ''}
                {autoProfile?.flat_patch_used ? ' · 🎯 Flat' : ''}
              </span>
            </span>
          )}
          {autoProfile && (
            <button
              type="button"
              onClick={() => {
                setIntensity(autoProfile.recommended_intensity);
                setChromaIntensity(autoProfile.recommended_chroma);
                setPreserveDetails(autoProfile.recommended_details);
                setShadowBoost(autoProfile.recommended_shadow_boost);
                setDeband(autoProfile.recommended_deband);
                setMethod(autoProfile.recommended_engine);
              }}
              className="px-2 py-1 rounded-md bg-accent/20 hover:bg-accent/30 text-accent text-[11px] font-mono font-medium border border-accent/30 flex items-center gap-1 transition-colors"
              title="Reset all sliders to physical sensor auto-calibrated values"
            >
              <Sparkles size={11} />
              <span>Re-Auto</span>
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderButtons = () => {
    if (savedPath) {
      return (
        <>
          <button
            onClick={handleClose}
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors"
          >
            {t('modals.denoise.close')}
          </button>
          <Button onClick={handleOpen}>{t('modals.denoise.openInEditor')}</Button>
        </>
      );
    }

    const disabled = isProcessing || isSaving;

    return (
      <div className={`w-full flex flex-col gap-3 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
        {/* Navigation Tabs */}
        <div className="flex items-center justify-between border-b border-border-color/40 pb-2">
          <div className="flex items-center gap-1 bg-bg-secondary/60 p-0.5 rounded-lg border border-border-color/30">
            <button
              type="button"
              onClick={() => setActiveTab('basic')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === 'basic' ? 'bg-accent text-white shadow-sm' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <Sliders size={12} />
              <span>Core Adjustments</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('pro')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === 'pro' ? 'bg-accent text-white shadow-sm' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <Layers size={12} />
              <span>Pro Sliders</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('presets')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === 'presets' ? 'bg-accent text-white shadow-sm' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <Bookmark size={12} />
              <span>Style Presets</span>
            </button>
          </div>

          {/* Snapshot A/B/C Matrix */}
          <div className="flex items-center gap-1.5" title="Snapshot Comparison: Click an empty slot (A/B/C) to save current slider settings; click a filled slot to recall. Hotkeys: 1, 2, 3">
            <span className="text-[11px] font-mono text-text-secondary uppercase">Snapshots:</span>
            {(['A', 'B', 'C'] as const).map((slot, idx) => {
              const hasData = snapshots[slot] !== null;
              const isActive = activeSnapshot === slot;
              return (
                <button
                  key={slot}
                  type="button"
                  onClick={() => recallSnapshot(slot)}
                  className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold border transition-all ${
                    isActive
                      ? 'bg-accent text-white border-accent shadow-sm ring-1 ring-accent/50'
                      : hasData
                        ? 'bg-surface/80 border-accent/40 text-accent hover:bg-accent/20'
                        : 'bg-surface/40 border-border-color/30 text-text-secondary hover:text-text-primary'
                  }`}
                  title={
                    hasData
                      ? `Snapshot ${slot} [Hotkey: ${idx + 1}] — Filled (Click to recall settings)`
                      : `Snapshot ${slot} [Hotkey: ${idx + 1}] — Empty (Click to save current settings)`
                  }
                >
                  {slot}
                  {hasData && <span className="ml-1 text-[8px] opacity-75">●</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Tab Contents */}
        {activeTab === 'basic' && (
          <div className="flex items-center gap-6">
            <div className="flex flex-col gap-1 w-[260px] shrink-0">
              <div className="flex items-center justify-between">
                <Text variant={TextVariants.small} weight={TextWeights.medium}>
                  {t('modals.denoise.methodLabel')}
                </Text>
                <span className="px-1.5 py-0.2 rounded bg-accent/20 text-accent font-bold text-[9px] uppercase tracking-wide">
                  {method === recommendedEngine ? '✨ Recommended Mode' : '⚡ Custom Mode'}
                </span>
              </div>
              <Dropdown
                options={methodOptions}
                value={method}
                direction="up"
                onChange={(val) => {
                  setMethod(val);
                  setIntensity(val === 'ai' ? 50 : 15);
                }}
              />
              <span className="text-[10px] text-text-secondary leading-tight mt-0.5" title={recommendationReason}>
                💡 {recommendationReason}
              </span>
            </div>

            <div className="flex-1 max-w-[360px]">
              <div className="flex items-center justify-between mb-1">
                <Text variant={TextVariants.small} weight={TextWeights.medium}>
                  Luminance Denoise: {intensity}%
                </Text>
                {empiricalSigma !== null && (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-mono font-bold border border-emerald-500/30">
                    ⚡ Auto (σ={(empiricalSigma * 100).toFixed(1)}%{activeIso ? ` · ISO ${activeIso}` : ''})
                  </span>
                )}
              </div>
              <Slider
                label="Luminance Strength"
                value={intensity}
                min={0}
                max={100}
                step={1}
                defaultValue={35}
                onChange={(e) => setIntensity(Number(e.target.value))}
                trackClassName="bg-bg-secondary"
                fillOrigin="min"
              />
              <div className="flex items-center gap-1.5 mt-1.5">
                <button
                  type="button"
                  onClick={() => setIntensity(20)}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                    intensity <= 25 ? 'bg-accent/20 border-accent text-accent' : 'bg-surface/60 border-border-color/40 text-text-secondary hover:text-text-primary'
                  }`}
                >
                  Subtle (20%)
                </button>
                <button
                  type="button"
                  onClick={() => setIntensity(45)}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                    intensity > 25 && intensity <= 55 ? 'bg-accent/20 border-accent text-accent' : 'bg-surface/60 border-border-color/40 text-text-secondary hover:text-text-primary'
                  }`}
                >
                  Balanced (45%)
                </button>
                <button
                  type="button"
                  onClick={() => setIntensity(75)}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                    intensity > 55 ? 'bg-accent/20 border-accent text-accent' : 'bg-surface/60 border-border-color/40 text-text-secondary hover:text-text-primary'
                  }`}
                >
                  Heavy (75%)
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'pro' && (
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="flex justify-between mb-1">
                <Text variant={TextVariants.small} weight={TextWeights.medium}>
                  Color (Chroma) Noise: {chromaIntensity}%
                </Text>
              </div>
              <Slider
                label="Color Noise"
                value={chromaIntensity}
                min={0}
                max={100}
                step={1}
                defaultValue={100}
                onChange={(e) => setChromaIntensity(Number(e.target.value))}
                fillOrigin="min"
              />
              <span className="text-[10px] text-text-secondary">Erases purple/green blotches at 100% without softening.</span>
            </div>

            <div>
              <div className="flex justify-between mb-1">
                <Text variant={TextVariants.small} weight={TextWeights.medium}>
                  Detail Recovery: {preserveDetails}%
                </Text>
              </div>
              <Slider
                label="Detail Recovery"
                value={preserveDetails}
                min={0}
                max={100}
                step={1}
                defaultValue={25}
                onChange={(e) => setPreserveDetails(Number(e.target.value))}
                fillOrigin="min"
              />
              <span className="text-[10px] text-text-secondary">Anti-plastic skin: Re-injects organic micro-structures.</span>
            </div>

            <div>
              <div className="flex justify-between mb-1">
                <Text variant={TextVariants.small} weight={TextWeights.medium}>
                  Shadows Boost: {shadowBoost}%
                </Text>
              </div>
              <Slider
                label="Shadows Boost"
                value={shadowBoost}
                min={0}
                max={100}
                step={1}
                defaultValue={0}
                onChange={(e) => setShadowBoost(Number(e.target.value))}
                fillOrigin="min"
              />
              <span className="text-[10px] text-text-secondary">Denoises deep shadow zones while leaving highlights untouched.</span>
            </div>
          </div>
        )}

        {activeTab === 'presets' && (
          <div className="flex flex-wrap items-center gap-2">
            {([
              { id: 'auto', label: '⚡ Auto AI Calibrated', desc: 'Optimal empirical balance' },
              { id: 'astro', label: '🌌 Astro Pinpoint Stars', desc: 'Protects stars, debands shadows' },
              { id: 'portrait', label: '👰 Wedding & Portrait', desc: 'Smooth skin with pore recovery' },
              { id: 'wildlife', label: '🦅 Wildlife Feathers', desc: 'Maximum micro-texture preservation' },
              { id: 'extreme', label: '🌙 Extreme Low-Light (6400+)', desc: 'Heavy dual-channel cleanup' },
              { id: 'analog', label: '🎞️ 35mm Analog Grain', desc: 'Subtle denoise with film texture' },
            ] as const).map((preset) => {
              const isActive = activePresetId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset.id)}
                  className={`px-3 py-1.5 rounded-lg border text-left transition-all cursor-pointer ${
                    isActive
                      ? 'bg-accent/15 border-accent text-accent ring-1 ring-accent shadow-sm'
                      : 'bg-surface/80 hover:bg-card-active border-border-color/40 text-text-primary'
                  }`}
                >
                  <div className={`text-xs font-medium ${isActive ? 'text-accent font-semibold' : 'text-text-primary'}`}>
                    {preset.label}
                  </div>
                  <div className="text-[10px] text-text-secondary">{preset.desc}</div>
                </button>
              );
            })}
          </div>
        )}

        {/* Feature Toggles */}
        <div className="flex flex-wrap items-center justify-between pt-2 border-t border-border-color/30">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={protectStars}
                onChange={(e) => setProtectStars(e.target.checked)}
                className="rounded border-border-color bg-surface text-accent focus:ring-0"
              />
              <span className="text-text-primary text-[11px] font-medium flex items-center gap-1">
                <ShieldCheck size={12} className="text-blue-400" />
                Star & Specular Protection
              </span>
            </label>

            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={deband}
                onChange={(e) => setDeband(e.target.checked)}
                className="rounded border-border-color bg-surface text-accent focus:ring-0"
              />
              <span className="text-text-primary text-[11px] font-medium">Deband Sensor Stripes</span>
            </label>

            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={healDust}
                onChange={(e) => setHealDust(e.target.checked)}
                className="rounded border-border-color bg-surface text-accent focus:ring-0"
              />
              <span className="text-text-primary text-[11px] font-medium flex items-center gap-1">
                <Sparkles size={12} className="text-amber-400" />
                Auto-Heal Dust
              </span>
              {dustSpotsHealed !== null && dustSpotsHealed > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-emerald-500/20 text-emerald-300 font-mono text-[9px]">
                  {dustSpotsHealed} healed
                </span>
              )}
            </label>

            <button
              type="button"
              onClick={() => setVisualizeDefects(!visualizeDefects)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium border transition-all cursor-pointer ${
                visualizeDefects
                  ? 'bg-amber-500/20 border-amber-500 text-amber-300 ring-1 ring-amber-500/40 shadow-sm'
                  : 'bg-surface/60 border-border-color/40 text-text-secondary hover:text-text-primary'
              }`}
              title="Toggle High-Contrast Defect Inspection HUD (Active during Denoise rendering)"
            >
              <Eye size={12} />
              <span>Defects HUD</span>
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleClose}
              className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors text-sm cursor-pointer"
            >
              {previewBase64 ? t('modals.denoise.close') : t('modals.denoise.cancel')}
            </button>

            <Button
              onClick={handleRunDenoise}
              disabled={isProcessing || isSaving}
              variant={previewBase64 && !isBatch ? 'secondary' : 'primary'}
            >
              {isProcessing || (isBatch && isSaving) ? (
                <Loader2 className="animate-spin mr-2" size={16} />
              ) : previewBase64 && !isBatch ? (
                <RefreshCw className="mr-2" size={16} />
              ) : (
                <Grip className="mr-2" size={16} />
              )}
              {isBatch
                ? t('modals.denoise.btnBatchDenoise')
                : previewBase64
                  ? t('modals.denoise.btnRetry')
                  : t('modals.denoise.btnStart')}
            </Button>

            {previewBase64 && !isBatch && (
              <Button onClick={handleSave} disabled={isSaving || isProcessing}>
                {isSaving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
                {t('modals.denoise.btnSave')}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (!isMounted) return null;

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/50 backdrop-blur-xs transition-opacity duration-300 ease-in-out ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div
        className={`bg-surface rounded-xl shadow-2xl p-5 md:p-6 w-full max-w-5xl max-h-[90vh] flex flex-col transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
      >
        <div className="flex-1 overflow-y-auto pr-1 min-h-0">
          {renderContent()}
        </div>
        <div className={`mt-3 pt-3 flex justify-end gap-3 shrink-0 ${savedPath ? '' : 'border-t border-surface/50'}`}>
          {renderButtons()}
        </div>
      </div>
    </div>
  );
}
