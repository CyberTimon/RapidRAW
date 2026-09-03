import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, Loader2, Save, RefreshCw, Layers, Sliders, Sparkles, Copy, Check } from 'lucide-react';
import { motion } from 'framer-motion';
import Button from '../ui/Button';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

export type PanoramaExportFormat = 'jpeg' | 'ultrahdr' | 'dng' | 'tiff' | 'png';

interface PanoramaModalProps {
  error: string | null;
  finalImageBase64: string | null;
  imageCount?: number;
  isOpen: boolean;
  isProcessing: boolean;
  loadingImageUrl?: string | null;
  onClose(): void;
  onOpenFile(path: string): void;
  onSave(format?: string): Promise<string>;
  onStitch(projection?: 'cylindrical' | 'spherical' | 'planar' | 'panini' | 'stereographic', boundaryWarp?: number, isHdr?: boolean): void;
  progressMessage: string | null;
}

export default function PanoramaModal({
  error,
  finalImageBase64,
  imageCount,
  isOpen,
  isProcessing,
  loadingImageUrl,
  onClose,
  onOpenFile,
  onSave,
  onStitch,
  progressMessage,
}: PanoramaModalProps) {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copiedError, setCopiedError] = useState(false);
  const [copiedSaveError, setCopiedSaveError] = useState(false);
  const [projection, setProjection] = useState<'cylindrical' | 'spherical' | 'planar' | 'panini' | 'stereographic'>('cylindrical');
  const [boundaryWarp, setBoundaryWarp] = useState<number>(0.5);
  const [isHdr, setIsHdr] = useState<boolean>(false);
  const [exportFormat, setExportFormat] = useState<PanoramaExportFormat>('jpeg');
  const [loupe, setLoupe] = useState<{ active: boolean; x: number; y: number; px: number; py: number }>({
    active: false,
    x: 0,
    y: 0,
    px: 0,
    py: 0,
  });

  const mouseDownTarget = useRef<EventTarget | null>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!imageContainerRef.current) return;
    const rect = imageContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const px = Math.max(0, Math.min(100, (x / rect.width) * 100));
    const py = Math.max(0, Math.min(100, (y / rect.height) * 100));
    setLoupe({ active: true, x, y, px, py });
  };

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      if (imageCount && imageCount >= 6 && imageCount % 3 === 0) {
        setIsHdr(true);
      }
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setSavedPath(null);
        setSaveError(null);
        setIsSaving(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen, imageCount]);

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
    setSaveError(null);
    try {
      const path = await onSave(exportFormat);
      setSavedPath(path);
    } catch (e: any) {
      console.error('Panorama save error:', e);
      setSaveError(String(e?.message || e));
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
        <div className="flex flex-col items-center justify-center py-10 h-[490px]">
          <div className="flex items-center justify-center mb-4">
            <XCircle className="w-12 h-12 text-red-500" />
          </div>
          <Text variant={TextVariants.title} className="mb-2 text-center text-red-400">
            {t('modals.panorama.failed')}
          </Text>
          <div className="w-full max-w-lg mt-3 flex flex-col items-center">
            <div className="w-full p-4 rounded-lg bg-neutral-900/90 border border-red-500/30 text-xs font-mono select-text cursor-text leading-relaxed text-red-200 max-h-48 overflow-y-auto break-all shadow-inner">
              {String(error)}
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(String(error));
                setCopiedError(true);
                setTimeout(() => setCopiedError(false), 2000);
              }}
              className="mt-3 flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-medium transition-colors cursor-pointer border border-neutral-700 shadow-xs"
            >
              {copiedError ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-neutral-400" />}
              <span>{copiedError ? 'Copied Error' : 'Copy Error Text'}</span>
            </button>
          </div>
        </div>
      );
    }

    if (finalImageBase64 && !isProcessing) {
      return (
        <div className="w-full flex flex-col">
          {saveError && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-3 p-3 bg-red-950/80 border border-red-500/50 rounded-lg flex items-start justify-between gap-3 text-red-200 text-xs shadow-md"
            >
              <div className="flex items-start gap-2.5 overflow-hidden">
                <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <div className="flex flex-col gap-1 overflow-hidden">
                  <span className="font-semibold text-red-300">Save Failed (Select another format below to save without re-stitching):</span>
                  <span className="font-mono select-text cursor-text break-all text-[11px] opacity-90">{saveError}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(saveError);
                    setCopiedSaveError(true);
                    setTimeout(() => setCopiedSaveError(false), 2000);
                  }}
                  className="px-2.5 py-1 bg-red-900/90 hover:bg-red-800 text-white rounded text-xs flex items-center gap-1 transition-colors cursor-pointer border border-red-700/60 shadow-xs"
                  title="Copy error text"
                >
                  {copiedSaveError ? <Check className="w-3 h-3 text-green-300" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedSaveError ? 'Copied' : 'Copy Error'}</span>
                </button>
                <button
                  onClick={() => setSaveError(null)}
                  className="p-1 hover:bg-red-900/60 rounded text-red-400 hover:text-white transition-colors cursor-pointer"
                  title="Dismiss error"
                >
                  ✕
                </button>
              </div>
            </motion.div>
          )}

          <div
            ref={imageContainerRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setLoupe((prev) => ({ ...prev, active: false }))}
            className="w-full max-h-[500px] bg-[#111] rounded-lg overflow-hidden border border-surface flex items-center justify-center relative cursor-crosshair group"
          >
            <img
              src={finalImageBase64}
              alt="Stitched Panorama"
              className="w-full h-full object-contain max-h-[500px] select-none"
            />
            {loupe.active && (
              <div
                className="pointer-events-none absolute w-48 h-48 rounded-full border-2 border-amber-400/90 shadow-2xl overflow-hidden bg-no-repeat z-30"
                style={{
                  left: `${loupe.x - 96}px`,
                  top: `${loupe.y - 96}px`,
                  backgroundImage: `url(${finalImageBase64})`,
                  backgroundPosition: `${loupe.px}% ${loupe.py}%`,
                  backgroundSize: '400%',
                  boxShadow: '0 0 25px rgba(0,0,0,0.8), inset 0 0 10px rgba(0,0,0,0.5)',
                }}
              >
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-3 h-3 border border-amber-400/40 rounded-full" />
                </div>
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] font-mono bg-black/80 px-2 py-0.5 rounded text-amber-300 font-bold border border-amber-400/30">
                  1:1 Loupe
                </div>
              </div>
            )}
            <div className="absolute top-3 right-3 bg-black/70 backdrop-blur-md px-3 py-1 rounded-full text-xs font-medium text-neutral-300 border border-white/10 opacity-70 group-hover:opacity-100 transition-opacity">
              Hover to inspect seams at 100%
            </div>
          </div>
          {savedPath && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
              <Text
                as="div"
                variant={TextVariants.heading}
                color={TextColors.success}
                className="flex items-center justify-center gap-2 mt-4"
              >
                <CheckCircle className="w-5 h-5" />
                <span>{t('modals.panorama.savedSuccess')}</span>
              </Text>
            </motion.div>
          )}
        </div>
      );
    }

    if (isProcessing) {
      const pctMatch = progressMessage?.match(/(\d+)%/);
      const fracMatch = progressMessage?.match(/panel (\d+) of (\d+)/i) || progressMessage?.match(/image (\d+) of (\d+)/i);
      const panoPct = pctMatch
        ? parseInt(pctMatch[1], 10)
        : (fracMatch ? Math.round((parseInt(fracMatch[1], 10) / parseInt(fracMatch[2], 10)) * 100) : 5);

      const steps = [
        { label: 'ORB Matching', active: (panoPct || 0) >= 10 },
        { label: '3D Pose Alignment', active: (panoPct || 0) >= 35 },
        { label: 'APAP Mesh Warping', active: (panoPct || 0) >= 60 },
        { label: 'Multiband Spline Blend', active: (panoPct || 0) >= 85 },
      ];

      return (
        <div className="flex h-[490px] overflow-hidden rounded-lg border border-surface">
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
                {t('modals.panorama.stitchingProgress')}
              </Text>
              <Text className="text-center font-mono h-6 flex justify-center items-center text-sm text-text-secondary">
                {progressMessage || t('modals.panorama.initializing')}
              </Text>

              {/* 4-Stage Visual Stepper */}
              <div className="w-full max-w-sm mt-6 grid grid-cols-4 gap-1">
                {steps.map((st, idx) => (
                  <div key={idx} className="flex flex-col items-center gap-1.5">
                    <div
                      className={`h-1.5 w-full rounded-full transition-colors duration-300 ${
                        st.active ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.5)]' : 'bg-neutral-800'
                      }`}
                    />
                    <span className={`text-[10px] text-center leading-tight font-medium ${st.active ? 'text-amber-300' : 'text-neutral-500'}`}>
                      {st.label}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-8 w-72 relative">
                <div className="flex flex-col items-center gap-2 w-full">
                  <div className="h-2 bg-neutral-800 rounded-full overflow-hidden w-full relative shadow-inner">
                    <div
                      className="h-full bg-gradient-to-r from-amber-500 to-amber-400 transition-all duration-300 rounded-full"
                      style={{ width: `${panoPct}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono font-bold text-amber-400">{panoPct}% completed</span>
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
      <div className="flex flex-col items-center justify-center min-h-[300px] py-2 px-2">
        <div className="flex items-center justify-center mb-3">
          <Layers className="w-10 h-10 text-accent" />
        </div>
        <Text variant={TextVariants.title} className="mb-1 text-center text-sm md:text-base">
          {t('modals.panorama.title')}
        </Text>
        <Text className="text-center max-w-md leading-relaxed text-text-secondary mb-3 text-xs">
          {imageCount ? t('modals.panorama.descCount', { count: imageCount }) : t('modals.panorama.descGeneric')}
        </Text>

        <div className="w-full max-w-lg bg-neutral-900/90 p-3.5 rounded-xl border border-neutral-800 shadow-lg flex flex-col gap-3">
          {/* HDR Multi-Bracket Panorama Toggle */}
          <div className="flex items-center justify-between p-2.5 rounded-lg bg-neutral-950 border border-neutral-800">
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-neutral-200 flex items-center gap-1.5">
                <Sparkles size={13} className="text-amber-400" />
                HDR Multi-Bracket Mode
              </span>
              <span className="text-[10.5px] text-neutral-400">
                {imageCount && imageCount >= 6 && imageCount % 3 === 0
                  ? `Auto-detected ${Math.round(imageCount / 3)} angles × 3 exposure brackets. Fuses linear HDR before stitching.`
                  : 'Fuses bracketed exposures into 32-bit linear radiance before stitching.'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsHdr(!isHdr)}
              className={`px-3 py-1 rounded-full text-xs font-bold transition-all cursor-pointer border ${
                isHdr
                  ? 'bg-amber-500 text-neutral-950 border-amber-400 shadow-md font-bold'
                  : 'bg-neutral-800 text-neutral-400 border-neutral-700 hover:text-white'
              }`}
            >
              {isHdr ? 'HDR Mode ON' : 'HDR Mode OFF'}
            </button>
          </div>

          {/* Projection Selector */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs font-semibold text-neutral-300">
              <span>3D Surface Projection:</span>
              <span className="text-[11px] text-amber-400 font-mono">Ray-Traced Optical Model</span>
            </div>
            <div className="grid grid-cols-5 gap-1.5 bg-neutral-950 p-1.5 rounded-lg border border-neutral-800">
              <button
                onClick={() => setProjection('cylindrical')}
                className={`px-2 py-1.5 rounded-md text-xs font-bold transition-all cursor-pointer text-center ${
                  projection === 'cylindrical'
                    ? 'bg-amber-500 text-neutral-950 shadow-md scale-102'
                    : 'bg-neutral-800/80 text-neutral-300 hover:text-white hover:bg-neutral-700'
                }`}
              >
                Cylindrical
                <span className="block text-[9px] font-normal opacity-80">Landscape</span>
              </button>
              <button
                onClick={() => setProjection('panini')}
                className={`px-2 py-1.5 rounded-md text-xs font-bold transition-all cursor-pointer text-center ${
                  projection === 'panini'
                    ? 'bg-amber-500 text-neutral-950 shadow-md scale-102'
                    : 'bg-neutral-800/80 text-neutral-300 hover:text-white hover:bg-neutral-700'
                }`}
              >
                Panini
                <span className="block text-[9px] font-normal opacity-80">Straight Lines</span>
              </button>
              <button
                onClick={() => setProjection('spherical')}
                className={`px-2 py-1.5 rounded-md text-xs font-bold transition-all cursor-pointer text-center ${
                  projection === 'spherical'
                    ? 'bg-amber-500 text-neutral-950 shadow-md scale-102'
                    : 'bg-neutral-800/80 text-neutral-300 hover:text-white hover:bg-neutral-700'
                }`}
              >
                Spherical
                <span className="block text-[9px] font-normal opacity-80">360° Sphere</span>
              </button>
              <button
                onClick={() => setProjection('stereographic')}
                className={`px-2 py-1.5 rounded-md text-xs font-bold transition-all cursor-pointer text-center ${
                  projection === 'stereographic'
                    ? 'bg-amber-500 text-neutral-950 shadow-md scale-102'
                    : 'bg-neutral-800/80 text-neutral-300 hover:text-white hover:bg-neutral-700'
                }`}
              >
                Little Planet
                <span className="block text-[9px] font-normal opacity-80">Stereographic</span>
              </button>
              <button
                onClick={() => setProjection('planar')}
                className={`px-2 py-1.5 rounded-md text-xs font-bold transition-all cursor-pointer text-center ${
                  projection === 'planar'
                    ? 'bg-amber-500 text-neutral-950 shadow-md scale-102'
                    : 'bg-neutral-800/80 text-neutral-300 hover:text-white hover:bg-neutral-700'
                }`}
              >
                Planar
                <span className="block text-[9px] font-normal opacity-80">Flat Narrow</span>
              </button>
            </div>
          </div>

          {/* Boundary Warp Slider */}
          <div className="flex flex-col gap-1.5 pt-2 border-t border-neutral-800">
            <div className="flex items-center justify-between text-xs font-semibold text-neutral-300">
              <span className="flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-amber-400" />
                <span>Boundary Mesh Warp (Edge Filling):</span>
              </span>
              <span className="font-mono text-amber-400 font-bold">{Math.round(boundaryWarp * 100)}%</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-neutral-400 font-mono">Crop</span>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={Math.round(boundaryWarp * 100)}
                onChange={(e) => setBoundaryWarp(parseFloat(e.target.value) / 100.0)}
                className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
              />
              <span className="text-[10px] text-neutral-400 font-mono">Fill</span>
            </div>
            <span className="text-[10px] text-neutral-400">
              {boundaryWarp === 0
                ? 'Cropped to natural rectangular bounds.'
                : boundaryWarp >= 0.8
                ? 'Fully stretches wavy panorama edges outward to preserve maximal field of view.'
                : 'Balanced spline warp preserving edge details.'}
            </span>
          </div>

          {/* Status Badges */}
          <div className="flex flex-wrap items-center justify-between gap-1 text-[10.5px] text-amber-400/90 font-mono pt-1">
            <span>✓ 2D Graph-Cut + 4-Band Laplacian</span>
            <span>✓ Global Gain Equalizer</span>
          </div>
        </div>
      </div>
    );
  };

  const renderButtons = () => {
    if (error) {
      return (
        <Button onClick={handleClose} className="w-full">
          {t('modals.panorama.close')}
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
            {t('modals.panorama.close')}
          </button>
          <Button onClick={handleOpen}>{t('modals.panorama.openInEditor')}</Button>
        </>
      );
    }

    return (
      <div className="w-full flex items-center justify-end gap-2">
        <button
          onClick={handleClose}
          className="px-4 py-2 rounded-md text-neutral-300 hover:text-white hover:bg-neutral-800 transition-colors text-sm font-medium cursor-pointer"
        >
          {finalImageBase64 ? t('modals.panorama.close') : t('modals.panorama.cancel')}
        </button>

        <Button onClick={() => onStitch(projection, boundaryWarp, isHdr)} disabled={isProcessing} variant={finalImageBase64 ? 'secondary' : 'primary'}>
          {isProcessing ? (
            <Loader2 className="animate-spin mr-2" size={16} />
          ) : finalImageBase64 ? (
            <RefreshCw className="mr-2" size={16} />
          ) : (
            <Layers className="mr-2" size={16} />
          )}
          {finalImageBase64 ? t('modals.panorama.retry') : t('modals.panorama.start')}
        </Button>

        {finalImageBase64 && (
          <div className="flex items-center gap-2">
            <div className="flex items-center bg-neutral-900 border border-neutral-800 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setExportFormat('jpeg')}
                className={`px-2 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                  exportFormat === 'jpeg' ? 'bg-amber-500 text-black font-bold shadow-xs' : 'text-neutral-400 hover:text-white'
                }`}
                title="Compact Tone-Mapped JPEG (~5 MB)"
              >
                JPEG
              </button>
              <button
                type="button"
                onClick={() => setExportFormat('ultrahdr')}
                className={`px-2 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                  exportFormat === 'ultrahdr' ? 'bg-amber-500 text-black font-bold shadow-xs' : 'text-neutral-400 hover:text-white'
                }`}
                title="ISO 21496-1 Ultra HDR Gain Map JPEG (~8 MB)"
              >
                Ultra HDR
              </button>
              <button
                type="button"
                onClick={() => setExportFormat('png')}
                className={`px-2 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                  exportFormat === 'png' ? 'bg-amber-500 text-black font-bold shadow-xs' : 'text-neutral-400 hover:text-white'
                }`}
                title="Lossless PNG with Alpha Transparency (~20 MB)"
              >
                PNG
              </button>
              <button
                type="button"
                onClick={() => setExportFormat('dng')}
                className={`px-2 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                  exportFormat === 'dng' ? 'bg-amber-500 text-black font-bold shadow-xs' : 'text-neutral-400 hover:text-white'
                }`}
                title="32-Bit Linear RAW DNG (~60 MB)"
              >
                32-Bit DNG
              </button>
              <button
                type="button"
                onClick={() => setExportFormat('tiff')}
                className={`px-2 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                  exportFormat === 'tiff' ? 'bg-amber-500 text-black font-bold shadow-xs' : 'text-neutral-400 hover:text-white'
                }`}
                title="32-Bit Float Compressed TIFF (~40 MB)"
              >
                32-Bit TIFF
              </button>
            </div>

            <Button onClick={handleSave} disabled={isSaving || isProcessing}>
              {isSaving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
              {exportFormat === 'jpeg'
                ? 'Save JPEG'
                : exportFormat === 'ultrahdr'
                ? 'Save Ultra HDR'
                : exportFormat === 'png'
                ? 'Save PNG'
                : exportFormat === 'dng'
                ? 'Save DNG'
                : 'Save TIFF'}
            </Button>
          </div>
        )}
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
