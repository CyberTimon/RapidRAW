import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle,
  XCircle,
  Loader2,
  Save,
  RefreshCw,
  Images,
  Sparkles,
  ShieldCheck,
  ShieldAlert,
  Sliders,
  ChevronDown,
  ChevronUp,
  Columns,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import Button from '../ui/Button';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import { Invokes } from '../ui/AppProperties';

interface BracketHealthReport {
  is_perfect: boolean;
  aperture_match: boolean;
  highlight_safe: boolean;
  motion_level: number;
  status_badge: string;
  status_message: string;
  dynamic_range_ev: number;
}

interface HdrModalProps {
  detectedScene?: string | null;
  error: string | null;
  finalImageBase64: string | null;
  imageCount?: number;
  sourcePaths?: string[];
  isOpen: boolean;
  isProcessing: boolean;
  loadingImageUrl?: string | null;
  onClose(): void;
  onOpenFile(path: string): void;
  onSave(format?: string): Promise<string>;
  onMerge(options?: {
    profile?: 'natural' | 'vivid' | 'interior' | 'dramatic' | 'portra' | 'velvia' | 'cinestill' | 'monochromeHdr';
    deghostSensitivity?: 'off' | 'low' | 'medium' | 'high';
    autoSemantic?: boolean;
    exposureBias?: number;
    highlightRecovery?: number;
    shadowLift?: number;
    detailBoost?: number;
  }): void;
  progressMessage: string | null;
}

export type HdrExportFormat = 'jpeg' | 'ultrahdr' | 'dng' | 'tiff';

export default function HdrModal({
  detectedScene,
  error,
  finalImageBase64,
  imageCount,
  sourcePaths,
  isOpen,
  isProcessing,
  loadingImageUrl,
  onClose,
  onOpenFile,
  onSave,
  onMerge,
  progressMessage,
}: HdrModalProps) {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<HdrExportFormat>('jpeg');

  // Visual Intent Presets: 'natural' | 'interior' | 'dramatic'
  const [selectedIntent, setSelectedIntent] = useState<'natural' | 'interior' | 'dramatic'>('natural');
  const [hdrStrength, setHdrStrength] = useState<number>(65); // 0 to 100%

  // Advanced Controls Accordion
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [deghostSensitivity, setDeghostSensitivity] = useState<'off' | 'low' | 'medium' | 'high'>('medium');
  const [autoSemantic, setAutoSemantic] = useState<boolean>(true);
  const [exposureBias, setExposureBias] = useState<number>(0.0);
  const [highlightRecovery, setHighlightRecovery] = useState<number>(50);
  const [shadowLift, setShadowLift] = useState<number>(30);
  const [microDetail, setMicroDetail] = useState<number>(1.2);

  // Before/After Split Curtain
  const [splitPos, setSplitPos] = useState<number>(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);

  // Pre-flight health diagnostics
  const [healthReport, setHealthReport] = useState<BracketHealthReport | null>(null);

  const mouseDownTarget = useRef<EventTarget | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);

      // Validate bracket health on open
      if (sourcePaths && sourcePaths.length > 0) {
        invoke<BracketHealthReport>(Invokes.ValidateHdrBrackets, { paths: sourcePaths })
          .then(setHealthReport)
          .catch(console.error);
      }

      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setSavedPath(null);
        setIsSaving(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen, sourcePaths]);

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

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const path = await onSave(exportFormat);
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

  const handleTriggerMerge = () => {
    onMerge({
      profile: selectedIntent,
      deghostSensitivity,
      autoSemantic,
      exposureBias,
      highlightRecovery,
      shadowLift,
      detailBoost: microDetail,
    });
  };

  // Split-curtain drag handler
  const handleSplitMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDraggingSplit || !previewContainerRef.current) return;
    const rect = previewContainerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    setSplitPos((x / rect.width) * 100);
  };

  const pctMatch = progressMessage?.match(/(\d+)%/);
  const progressPct = pctMatch ? parseInt(pctMatch[1], 10) : null;

  const renderContent = () => {
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center py-10 h-[480px]">
          <div className="flex items-center justify-center mb-6">
            <XCircle className="w-12 h-12 text-red-500" />
          </div>
          <Text variant={TextVariants.title} className="mb-2 text-center">
            {t('modals.hdr.failed')}
          </Text>
          <Text className="text-center p-4 rounded-lg bg-bg-primary max-w-md mt-2 leading-relaxed">
            {String(error)}
          </Text>
        </div>
      );
    }

    if (finalImageBase64 && !isProcessing) {
      return (
        <div className="w-full flex flex-col gap-3">
          {/* Interactive Split Curtain Preview Canvas */}
          <div
            ref={previewContainerRef}
            onMouseMove={handleSplitMouseMove}
            onMouseUp={() => setIsDraggingSplit(false)}
            onMouseLeave={() => setIsDraggingSplit(false)}
            className="w-full max-h-[460px] h-[360px] md:h-[420px] bg-[#0a0a0a] rounded-lg overflow-hidden border border-neutral-800 flex items-center justify-center relative select-none cursor-ew-resize"
          >
            {/* Left: Original 0 EV SDR Exposure */}
            {loadingImageUrl && (
              <div
                className="absolute inset-0 overflow-hidden flex items-center justify-center pointer-events-none"
                style={{ width: `${splitPos}%` }}
              >
                <img
                  src={loadingImageUrl}
                  alt="Original SDR"
                  className="w-full h-full object-contain max-h-[460px] min-w-full"
                />
                <span className="absolute top-3 left-3 px-2 py-0.5 bg-black/75 backdrop-blur-md rounded text-[10px] font-mono text-neutral-300 border border-neutral-700">
                  Single SDR Exposure
                </span>
              </div>
            )}

            {/* Right: Merged 32-Bit Studio HDR */}
            <div
              className="absolute inset-0 overflow-hidden flex items-center justify-center"
              style={{
                clipPath: loadingImageUrl ? `polygon(${splitPos}% 0%, 100% 0%, 100% 100%, ${splitPos}% 100%)` : undefined,
              }}
            >
              <img
                src={finalImageBase64}
                alt="Merged Studio HDR"
                className="w-full h-full object-contain max-h-[460px]"
              />
              <span className="absolute top-3 right-3 px-2.5 py-0.5 bg-black/75 backdrop-blur-md border border-amber-500/40 rounded-full text-xs font-semibold text-amber-300 flex items-center gap-1.5 shadow-lg">
                <Sparkles size={12} className="text-amber-400" />
                <span>32-Bit Studio HDR</span>
              </span>
            </div>

            {/* Vertical Split Drag Handle */}
            {loadingImageUrl && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-amber-400 z-20 cursor-ew-resize flex items-center justify-center"
                style={{ left: `${splitPos}%` }}
                onMouseDown={() => setIsDraggingSplit(true)}
              >
                <div className="w-5 h-5 bg-amber-500 rounded-full flex items-center justify-center shadow-lg border border-black text-black">
                  <Columns size={11} className="rotate-90" />
                </div>
              </div>
            )}
          </div>

          {savedPath && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
              <Text
                as="div"
                variant={TextVariants.heading}
                color={TextColors.success}
                className="flex items-center justify-center gap-2 mt-2"
              >
                <CheckCircle className="w-5 h-5" />
                <span>{t('modals.hdr.savedSuccess')}</span>
              </Text>
            </motion.div>
          )}
        </div>
      );
    }

    if (isProcessing) {
      return (
        <div className="flex h-[440px] overflow-hidden rounded-lg border border-surface">
          <div className="w-2/5 relative overflow-hidden shrink-0 bg-[#0a0a0a] flex items-center justify-center">
            {loadingImageUrl ? (
              <img src={loadingImageUrl} alt="Source preview" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-surface/50" />
            )}
          </div>
          <div className="flex-1 flex flex-col items-center justify-center px-10 bg-bg-primary">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1, duration: 0.4 }}
              className="flex flex-col items-center w-full"
            >
              <Text variant={TextVariants.title} className="mb-2 text-center">
                Synthesizing Next-Gen Studio HDR
              </Text>
              <Text className="text-center font-mono h-6 flex justify-center items-center text-sm text-text-secondary">
                {progressMessage || t('modals.hdr.initializing')}
              </Text>

              <div className="mt-6 w-72 relative">
                {progressPct !== null ? (
                  <div className="flex flex-col items-center gap-2 w-full">
                    <div className="h-2 bg-neutral-800 rounded-full overflow-hidden w-full relative shadow-inner">
                      <div
                        className="h-full bg-gradient-to-r from-amber-500 to-amber-400 transition-all duration-300 rounded-full"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                    <span className="text-xs font-mono font-bold text-amber-400">{progressPct}% completed</span>
                  </div>
                ) : (
                  <div className="h-1.5 bg-surface rounded-full overflow-hidden relative w-full shadow-xs">
                    <motion.div
                      className="absolute inset-y-0 w-[80%] bg-linear-to-r from-transparent via-accent to-transparent mix-blend-screen"
                      style={{ filter: 'blur(3px)' }}
                      animate={{ x: ['-150%', '150%'] }}
                      transition={{ repeat: Infinity, duration: 1.5, ease: [0.4, 0, 0.2, 1] }}
                    />
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 mt-6 text-xs text-neutral-400">
                <span>✓ Oklab Hue Locking</span>
                <span>•</span>
                <span>✓ PTC Noise Weighting</span>
                <span>•</span>
                <span>✓ ARRI Purity Knee</span>
              </div>
            </motion.div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-3">
        {/* Pre-Flight Health Badge */}
        {healthReport && (
          <div
            className={`px-3 py-2 rounded-lg border flex items-center justify-between text-xs transition-all ${
              healthReport.is_perfect
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : 'bg-amber-950/40 border-amber-500/40 text-amber-300'
            }`}
          >
            <div className="flex items-center gap-2">
              {healthReport.is_perfect ? (
                <ShieldCheck size={16} className="text-emerald-400 shrink-0" />
              ) : (
                <ShieldAlert size={16} className="text-amber-400 shrink-0" />
              )}
              <span className="font-medium">{healthReport.status_message}</span>
            </div>
            <span className="font-mono text-[11px] opacity-80 shrink-0">
              {imageCount ? `${imageCount} RAW Brackets` : '3 RAW Brackets'}
            </span>
          </div>
        )}

        {/* 3 Visual Intent Cards (1-Click Simplicity) */}
        <div className="flex flex-col gap-1.5">
          <Text variant={TextVariants.small} className="text-text-secondary font-medium flex items-center gap-1.5">
            <Sparkles size={13} className="text-amber-400" />
            <span>Visual Intent Style:</span>
          </Text>

          <div className="grid grid-cols-3 gap-2.5 w-full">
            {/* Card 1: Natural / Landscape */}
            <button
              type="button"
              onClick={() => setSelectedIntent('natural')}
              className={`p-3 rounded-xl text-left transition-all cursor-pointer border flex flex-col justify-between h-24 ${
                selectedIntent === 'natural'
                  ? 'bg-amber-500/15 border-amber-500 shadow-md text-amber-300 ring-1 ring-amber-500/30'
                  : 'bg-neutral-900/90 border-neutral-800 text-neutral-300 hover:border-neutral-700 hover:text-white'
              }`}
            >
              <div className="flex items-center justify-between w-full">
                <span className="font-bold text-sm flex items-center gap-1.5">
                  <span>🏞️</span> Natural Landscape
                </span>
                {selectedIntent === 'natural' && (
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                )}
              </div>
              <span className="text-[11px] opacity-75 leading-tight">
                True-to-life filmic contrast, soft sky roll-off & zero halos.
              </span>
            </button>

            {/* Card 2: Real Estate / Interior */}
            <button
              type="button"
              onClick={() => setSelectedIntent('interior')}
              className={`p-3 rounded-xl text-left transition-all cursor-pointer border flex flex-col justify-between h-24 ${
                selectedIntent === 'interior'
                  ? 'bg-amber-500/15 border-amber-500 shadow-md text-amber-300 ring-1 ring-amber-500/30'
                  : 'bg-neutral-900/90 border-neutral-800 text-neutral-300 hover:border-neutral-700 hover:text-white'
              }`}
            >
              <div className="flex items-center justify-between w-full">
                <span className="font-bold text-sm flex items-center gap-1.5">
                  <span>🏡</span> Real Estate
                </span>
                {selectedIntent === 'interior' && (
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                )}
              </div>
              <span className="text-[11px] opacity-75 leading-tight">
                Bright interior rooms with clean, balanced window pulls.
              </span>
            </button>

            {/* Card 3: Cinematic Dynamic */}
            <button
              type="button"
              onClick={() => setSelectedIntent('dramatic')}
              className={`p-3 rounded-xl text-left transition-all cursor-pointer border flex flex-col justify-between h-24 ${
                selectedIntent === 'dramatic'
                  ? 'bg-amber-500/15 border-amber-500 shadow-md text-amber-300 ring-1 ring-amber-500/30'
                  : 'bg-neutral-900/90 border-neutral-800 text-neutral-300 hover:border-neutral-700 hover:text-white'
              }`}
            >
              <div className="flex items-center justify-between w-full">
                <span className="font-bold text-sm flex items-center gap-1.5">
                  <span>🎬</span> Cinematic Punch
                </span>
                {selectedIntent === 'dramatic' && (
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                )}
              </div>
              <span className="text-[11px] opacity-75 leading-tight">
                Deep rich shadows, vibrant sunsets & Ansel Adams micro-contrast.
              </span>
            </button>
          </div>
        </div>

        {/* Master Strength Slider */}
        <div className="bg-neutral-900/60 border border-neutral-800 rounded-lg p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-300 font-medium flex items-center gap-1.5">
              <Sliders size={13} className="text-amber-400" />
              <span>HDR Dynamic Strength:</span>
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-amber-300 font-bold">{hdrStrength}%</span>
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-[11px] text-neutral-400 hover:text-amber-300 flex items-center gap-0.5 ml-2 cursor-pointer transition-colors"
              >
                <span>{showAdvanced ? 'Hide Fine-Tuning' : 'Fine-Tuning'}</span>
                {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            </div>
          </div>

          <input
            type="range"
            min="10"
            max="100"
            step="5"
            value={hdrStrength}
            onChange={(e) => setHdrStrength(parseInt(e.target.value, 10))}
            className="w-full accent-amber-500 h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer"
          />

          {/* Collapsible Pro Fine-Tuning */}
          {showAdvanced && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="pt-3 border-t border-neutral-800 flex flex-col gap-2.5 text-xs"
            >
              <div className="grid grid-cols-2 gap-3">
                {/* Deghosting */}
                <div className="flex flex-col gap-1">
                  <span className="text-neutral-400 text-[11px]">Deghosting Sensitivity:</span>
                  <div className="grid grid-cols-4 gap-1">
                    {(['off', 'low', 'medium', 'high'] as const).map((lvl) => (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() => setDeghostSensitivity(lvl)}
                        className={`py-1 rounded text-[10px] font-medium capitalize border transition-all cursor-pointer ${
                          deghostSensitivity === lvl
                            ? 'bg-amber-500/20 border-amber-500 text-amber-300 font-bold'
                            : 'bg-neutral-900 border-neutral-800 text-neutral-400'
                        }`}
                      >
                        {lvl}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Exposure Bias */}
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between text-[11px] text-neutral-400">
                    <span>Exposure Bias:</span>
                    <span className="font-mono text-amber-300">{exposureBias > 0 ? `+${exposureBias}` : exposureBias} EV</span>
                  </div>
                  <input
                    type="range"
                    min="-2.0"
                    max="2.0"
                    step="0.25"
                    value={exposureBias}
                    onChange={(e) => setExposureBias(parseFloat(e.target.value))}
                    className="w-full accent-amber-500 h-1 bg-neutral-800 rounded-lg appearance-none cursor-pointer"
                  />
                </div>
              </div>
            </motion.div>
          )}
        </div>
      </div>
    );
  };

  const renderButtons = () => {
    if (error) {
      return (
        <Button onClick={handleClose} className="w-full">
          {t('modals.hdr.close')}
        </Button>
      );
    }

    if (savedPath) {
      return (
        <>
          <button
            onClick={handleClose}
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors cursor-pointer"
          >
            {t('modals.hdr.close')}
          </button>
          <Button onClick={handleOpen}>{t('modals.hdr.openInEditor')}</Button>
        </>
      );
    }

    return (
      <div className="w-full flex items-center justify-between gap-2">
        <button
          onClick={handleClose}
          className="px-4 py-2 rounded-md text-neutral-300 hover:text-white hover:bg-neutral-800 transition-colors text-sm font-medium cursor-pointer"
        >
          {finalImageBase64 ? t('modals.hdr.close') : t('modals.hdr.cancel')}
        </button>

        <div className="flex items-center gap-2">
          <Button onClick={handleTriggerMerge} disabled={isProcessing} variant={finalImageBase64 ? 'secondary' : 'primary'}>
            {isProcessing ? (
              <Loader2 className="animate-spin mr-2" size={16} />
            ) : finalImageBase64 ? (
              <RefreshCw className="mr-2" size={16} />
            ) : (
              <Images className="mr-2" size={16} />
            )}
            {finalImageBase64 ? 'Re-Synthesize' : '1-Click Merge HDR'}
          </Button>

          {finalImageBase64 && (
            <div className="flex items-center gap-2">
              <div className="flex items-center bg-neutral-900 border border-neutral-800 rounded-lg p-0.5">
                <button
                  type="button"
                  onClick={() => setExportFormat('jpeg')}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                    exportFormat === 'jpeg' ? 'bg-amber-500 text-black font-bold shadow-xs' : 'text-neutral-400 hover:text-white'
                  }`}
                  title="Compact sRGB JPEG (~4 MB)"
                >
                  ⚡ Quick JPEG (~4 MB)
                </button>
                <button
                  type="button"
                  onClick={() => setExportFormat('ultrahdr')}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                    exportFormat === 'ultrahdr' ? 'bg-amber-500 text-black font-bold shadow-xs' : 'text-neutral-400 hover:text-white'
                  }`}
                  title="ISO 21496-1 Ultra HDR Gain Map for OLED/HDR displays (~7 MB)"
                >
                  💎 Ultra HDR (~7 MB)
                </button>
                <button
                  type="button"
                  onClick={() => setExportFormat('dng')}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                    exportFormat === 'dng' ? 'bg-amber-500 text-black font-bold shadow-xs' : 'text-neutral-400 hover:text-white'
                  }`}
                  title="32-Bit Linear Float RAW DNG (~60 MB)"
                >
                  🎞️ 32-Bit DNG
                </button>
                <button
                  type="button"
                  onClick={() => setExportFormat('tiff')}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                    exportFormat === 'tiff' ? 'bg-amber-500 text-black font-bold shadow-xs' : 'text-neutral-400 hover:text-white'
                  }`}
                  title="32-Bit Float Deflate Compressed TIFF (~40 MB)"
                >
                  🗄️ Master TIFF
                </button>
              </div>

              <Button onClick={handleSave} disabled={isSaving || isProcessing}>
                {isSaving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
                {exportFormat === 'dng'
                  ? 'Save DNG'
                  : exportFormat === 'jpeg'
                  ? 'Save JPEG'
                  : exportFormat === 'ultrahdr'
                  ? 'Save Ultra HDR'
                  : 'Save TIFF'}
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  };

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
        className={`bg-surface rounded-xl shadow-2xl p-5 md:p-6 w-full max-w-4xl max-h-[90vh] flex flex-col transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
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
