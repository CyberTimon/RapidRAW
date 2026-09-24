import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Telescope,
  CheckCircle,
  XCircle,
  Loader2,
  Save,
  Sparkles,
  Columns,
  FolderOpen,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { invoke } from '@tauri-apps/api/core';
import Button from '../ui/Button';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import { useUIStore } from '../../store/useUIStore';

interface DrizzleModalProps {
  onOpenFile(path: string): void;
}

export default function DrizzleModal({ onOpenFile }: DrizzleModalProps) {
  const { t } = useTranslation();
  const drizzleModalState = useUIStore((s) => s.drizzleModalState);
  const setUI = useUIStore((s) => s.setUI);

  const {
    isOpen,
    isProcessing,
    sourcePaths,
    scaleFactor,
    pixfrac,
    progressMessage,
    error,
    finalImageBase64,
    meta,
  } = drizzleModalState;

  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<'tiff' | 'dng' | 'jpeg' | 'png'>('tiff');
  const [viewMode, setViewMode] = useState<'single' | 'split'>('single');

  const mouseDownTarget = useRef<EventTarget | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setSavedPath(null);
        setIsSaving(false);
        setSaveError(null);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    if (isSaving || isProcessing) return;
    setUI((state) => ({
      drizzleModalState: { ...state.drizzleModalState, isOpen: false },
    }));
  }, [setUI, isSaving, isProcessing]);

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    mouseDownTarget.current = e.target;
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && mouseDownTarget.current === e.currentTarget) {
      handleClose();
    }
    mouseDownTarget.current = null;
  };

  const handleStartDrizzle = () => {
    if (sourcePaths.length < 2) return;
    setUI((state) => ({
      drizzleModalState: {
        ...state.drizzleModalState,
        isProcessing: true,
        error: null,
        progressMessage: 'Initializing Hubble Sub-Pixel Linear Reconstruction...',
      },
    }));

    invoke('drizzle_super_resolution', {
      paths: sourcePaths,
      scaleFactor,
      pixfrac,
    }).catch((err) => {
      setUI((state) => ({
        drizzleModalState: {
          ...state.drizzleModalState,
          isProcessing: false,
          error: String(err),
        },
      }));
    });
  };

  const handleSave = async () => {
    if (sourcePaths.length === 0) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const outPath = await invoke<string>('save_drizzle_image', {
        originalPathStr: sourcePaths[0],
        exportFormat: selectedFormat,
        scaleFactor,
      });
      setSavedPath(outPath);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenSaved = () => {
    if (savedPath) {
      onOpenFile(savedPath);
      handleClose();
    }
  };

  if (!isMounted) return null;

  return (
    <AnimatePresence>
      {show && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 select-none"
          onMouseDown={handleBackdropMouseDown}
          onClick={handleBackdropClick}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ duration: 0.2 }}
            className="relative flex flex-col w-full max-w-5xl h-[88vh] max-h-[850px] bg-bg-surface border border-border-subtle rounded-2xl shadow-2xl overflow-hidden text-text-primary"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle bg-bg-secondary/40">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400">
                  <Telescope className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <Text variant={TextVariants.heading} className="font-semibold tracking-tight">
                      Hubble Sub-Pixel Drizzle Super-Resolution
                    </Text>
                    <span className="px-2 py-0.5 text-[10px] font-medium tracking-wider uppercase rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
                      NASA Linear Reconstruct
                    </span>
                  </div>
                  <Text variant={TextVariants.small} color={TextColors.secondary}>
                    Sub-pixel phase jitter synthesis · Multi-point 4-corner homography alignment · Adaptive inpainting
                  </Text>
                </div>
              </div>

              {/* Close Button */}
              <button
                onClick={handleClose}
                disabled={isProcessing || isSaving}
                className="p-1.5 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content Body */}
            <div className="flex-1 flex flex-col min-h-0 bg-bg-primary overflow-hidden">
              {/* Error State */}
              {error && (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 mb-4">
                    <XCircle className="w-8 h-8" />
                  </div>
                  <Text variant={TextVariants.heading} className="mb-2 font-medium">
                    Drizzle Super-Resolution Failed
                  </Text>
                  <p className="text-sm text-text-secondary max-w-lg mb-6 bg-red-500/5 p-4 rounded-xl border border-red-500/15">
                    {error}
                  </p>
                  <Button variant="secondary" onClick={handleStartDrizzle}>
                    Try Again
                  </Button>
                </div>
              )}

              {/* Processing Spinner State */}
              {isProcessing && !error && (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                  <div className="relative mb-6">
                    <div className="w-16 h-16 rounded-full border-4 border-purple-500/20 border-t-purple-500 animate-spin" />
                    <Telescope className="w-6 h-6 text-purple-400 absolute inset-0 m-auto" />
                  </div>
                  <Text variant={TextVariants.heading} className="mb-2 font-medium">
                    Synthesizing Optical Super-Resolution
                  </Text>
                  <Text variant={TextVariants.body} color={TextColors.secondary} className="max-w-md animate-pulse">
                    {progressMessage || 'Aligning burst frames with sub-pixel phase correlation...'}
                  </Text>
                  <div className="mt-6 flex items-center gap-2 text-xs text-text-tertiary bg-bg-surface px-4 py-2 rounded-full border border-border-subtle">
                    <span>{sourcePaths.length} burst frames loaded</span>
                    <span>•</span>
                    <span>{scaleFactor}x Destination Grid</span>
                    <span>•</span>
                    <span>Drop Pixfrac p = {pixfrac}</span>
                  </div>
                </div>
              )}

              {/* Configuration & Ready State */}
              {!isProcessing && !finalImageBase64 && !error && (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center max-w-2xl mx-auto">
                  <div className="w-16 h-16 rounded-2xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 mb-6">
                    <Sparkles className="w-8 h-8" />
                  </div>
                  <Text variant={TextVariants.heading} className="mb-2 font-semibold">
                    Configure Drizzle Super-Resolution
                  </Text>
                  <Text variant={TextVariants.body} color={TextColors.secondary} className="mb-8 leading-relaxed">
                    Harness micro-vibrations across {sourcePaths.length} burst exposures to bypass sensor Bayer pixel limits, doubling or tripling true optical resolving power while dramatically boosting signal-to-noise ratio.
                  </Text>

                  {/* Scale Factor Selector */}
                  <div className="w-full bg-bg-surface p-5 rounded-2xl border border-border-subtle mb-6 text-left">
                    <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-3">
                      Reconstruction Scale Factor
                    </label>
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { factor: 2, label: '2x Super-Res', desc: '4x Resolution Area (Recommended)' },
                        { factor: 3, label: '3x Deep Sky', desc: '9x Resolution Area (Telescopes)' },
                        { factor: 4, label: '4x Ultra-Res', desc: '16x Resolution Area (High Burst)' },
                      ].map((opt) => (
                        <button
                          key={opt.factor}
                          onClick={() =>
                            setUI((state) => ({
                              drizzleModalState: { ...state.drizzleModalState, scaleFactor: opt.factor },
                            }))
                          }
                          className={clsx(
                            'p-3.5 rounded-xl text-left border transition-all flex flex-col gap-1',
                            scaleFactor === opt.factor
                              ? 'bg-purple-500/15 border-purple-500 text-purple-200 shadow-md shadow-purple-500/10'
                              : 'bg-bg-primary border-border-subtle hover:border-border-muted text-text-secondary'
                          )}
                        >
                          <span className="font-semibold text-sm">{opt.label}</span>
                          <span className="text-[11px] opacity-75">{opt.desc}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Pixfrac Slider Control */}
                  <div className="w-full bg-bg-surface p-5 rounded-2xl border border-border-subtle mb-8 text-left">
                    <div className="flex justify-between items-center mb-2">
                      <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
                        Drop Linear Size (Pixfrac p)
                      </label>
                      <span className="text-xs font-mono font-bold text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20">
                        {pixfrac.toFixed(2)}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0.50"
                      max="1.00"
                      step="0.05"
                      value={pixfrac}
                      onChange={(e) =>
                        setUI((state) => ({
                          drizzleModalState: {
                            ...state.drizzleModalState,
                            pixfrac: parseFloat(e.target.value),
                          },
                        }))
                      }
                      className="w-full accent-purple-500 cursor-pointer"
                    />
                    <div className="flex justify-between text-[11px] text-text-tertiary mt-2">
                      <span>0.50 (Sharper / High Frame Count)</span>
                      <span>0.80 (NASA Benchmark)</span>
                      <span>1.00 (Standard Shift-and-Add)</span>
                    </div>
                  </div>

                  <Button
                    variant="primary"
                    size="lg"
                    onClick={handleStartDrizzle}
                    className="w-full max-w-sm flex items-center justify-center gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 shadow-lg shadow-purple-500/20 font-semibold py-3"
                  >
                    <Telescope className="w-5 h-5" />
                    Reconstruct Super-Resolution
                  </Button>
                </div>
              )}

              {/* Complete Result View */}
              {finalImageBase64 && !isProcessing && (
                <div className="flex-1 flex flex-col min-h-0">
                  {/* Result Metadata Banner */}
                  <div className="flex items-center justify-between px-6 py-2.5 bg-bg-surface border-b border-border-subtle text-xs">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                        <CheckCircle className="w-4 h-4" />
                        Reconstruction Complete
                      </span>
                      {meta && (
                        <>
                          <span className="text-border-muted">|</span>
                          <span className="text-text-secondary">
                            Dimensions: <strong className="text-text-primary">{meta.width} × {meta.height} px</strong>
                          </span>
                          <span className="text-border-muted">|</span>
                          <span className="text-text-secondary">
                            Scale: <strong className="text-purple-400">{meta.scale}x True Optical</strong>
                          </span>
                          <span className="text-border-muted">|</span>
                          <span className="text-text-secondary">
                            SNR Boost: <strong className="text-amber-400">{meta.snr_boost}</strong>
                          </span>
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setViewMode(viewMode === 'single' ? 'split' : 'single')}
                        className={clsx(
                          'flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium border transition-colors',
                          viewMode === 'split'
                            ? 'bg-purple-500/20 border-purple-500 text-purple-300'
                            : 'bg-bg-primary border-border-subtle text-text-secondary hover:text-text-primary'
                        )}
                      >
                        <Columns className="w-3.5 h-3.5" />
                        {viewMode === 'split' ? 'Split View Active' : 'Single View'}
                      </button>
                    </div>
                  </div>

                  {/* Canvas View Area */}
                  <div className="flex-1 relative flex items-center justify-center p-4 bg-black/40 overflow-hidden">
                    <img
                      src={finalImageBase64}
                      alt="Hubble Drizzle Super-Resolution"
                      className="max-w-full max-h-full object-contain rounded-lg shadow-2xl border border-white/10"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer Controls */}
            {finalImageBase64 && !isProcessing && (
              <div className="flex items-center justify-between px-6 py-4 border-t border-border-subtle bg-bg-secondary/40">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-text-secondary">Export Format:</span>
                  <div className="flex items-center gap-1.5 bg-bg-primary p-1 rounded-xl border border-border-subtle">
                    {(['tiff', 'dng', 'jpeg', 'png'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        onClick={() => setSelectedFormat(fmt)}
                        className={clsx(
                          'px-3 py-1 rounded-lg text-xs font-semibold uppercase transition-colors',
                          selectedFormat === fmt
                            ? 'bg-purple-600 text-white shadow-sm'
                            : 'text-text-secondary hover:text-text-primary'
                        )}
                      >
                        {fmt === 'tiff' ? '16-bit TIFF' : fmt === 'dng' ? 'Linear DNG' : fmt}
                      </button>
                    ))}
                  </div>

                  {savedPath && (
                    <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
                      <CheckCircle className="w-3.5 h-3.5" />
                      Saved to disk!
                    </span>
                  )}
                  {saveError && (
                    <span className="text-xs text-red-400 font-medium">
                      {saveError}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  {savedPath ? (
                    <Button
                      variant="secondary"
                      onClick={handleOpenSaved}
                      className="flex items-center gap-2"
                    >
                      <FolderOpen className="w-4 h-4" />
                      Open in Editor
                    </Button>
                  ) : null}

                  <Button
                    variant="primary"
                    onClick={handleSave}
                    disabled={isSaving}
                    className="flex items-center gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 shadow-md shadow-purple-500/20 font-semibold"
                  >
                    {isSaving ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Saving Full-Res Master...
                      </>
                    ) : (
                      <>
                        <Save className="w-4 h-4" />
                        Save Super-Resolution Master
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
