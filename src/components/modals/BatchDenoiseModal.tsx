import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { Grip, FolderOpen, CheckCircle, XCircle, X, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Button from '../ui/Button';
import Dropdown from '../ui/Dropdown';
import Slider from '../ui/Slider';
import Text from '../ui/Text';
import { TextVariants, TextWeights } from '../../types/typography';
import { Invokes } from '../ui/AppProperties';

type Phase = 'settings' | 'processing' | 'done';

interface BatchDenoiseProgress {
  current: number;
  total: number;
  currentFile: string;
}

interface BatchDenoiseResult {
  total: number;
  errors: string[];
}

interface BatchDenoiseModalProps {
  isOpen: boolean;
  onClose(): void;
  targetPaths: string[];
  aiModelDownloadStatus: string | null;
  onComplete?(): void;
}

const methodOptions: Array<{ label: string; value: 'ai' | 'bm3d' }> = [
  { label: 'NIND (AI – Best for RAW)', value: 'ai' },
  { label: 'BM3D (Traditional – All formats)', value: 'bm3d' },
];

export default function BatchDenoiseModal({
  isOpen,
  onClose,
  targetPaths,
  aiModelDownloadStatus,
  onComplete,
}: BatchDenoiseModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  const [phase, setPhase] = useState<Phase>('settings');
  const [method, setMethod] = useState<'ai' | 'bm3d'>('ai');
  const [intensity, setIntensity] = useState(50);
  const [suffix, setSuffix] = useState('_Denoised');
  const [outputFolder, setOutputFolder] = useState<string | null>(null);
  const [copyAdjustments, setCopyAdjustments] = useState(true);

  const [progress, setProgress] = useState<BatchDenoiseProgress | null>(null);
  const [result, setResult] = useState<BatchDenoiseResult | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const mouseDownTarget = useRef<EventTarget | null>(null);

  /* ── Mount / unmount animation ── */
  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const t = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(t);
    } else {
      setShow(false);
      const t = setTimeout(() => {
        setIsMounted(false);
        // Reset for next open
        setPhase('settings');
        setProgress(null);
        setResult(null);
        setCancelled(false);
        setStartError(null);
      }, 300);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  /* ── Default method based on file types ── */
  useEffect(() => {
    if (isOpen && targetPaths.length > 0) {
      const hasRaw = targetPaths.some((p) => {
        const ext = p.split('.').pop()?.toLowerCase() ?? '';
        return [
          'arw',
          'nef',
          'cr2',
          'cr3',
          'raf',
          'dng',
          'rw2',
          'orf',
          'pef',
          'srw',
          'raw',
          '3fr',
          'mef',
          'mrw',
        ].includes(ext);
      });
      setMethod(hasRaw ? 'ai' : 'bm3d');
      setIntensity(hasRaw ? 50 : 15);
    }
  }, [isOpen, targetPaths]);

  /* ── Tauri event listeners ── */
  useEffect(() => {
    const unlistenProgress = listen<BatchDenoiseProgress>('batch-denoise-progress', (e) => {
      setProgress(e.payload);
    });

    const unlistenComplete = listen<BatchDenoiseResult>('batch-denoise-complete', (e) => {
      setResult(e.payload);
      setPhase('done');
      onComplete?.();
    });

    const unlistenCancelled = listen('batch-denoise-cancelled', () => {
      setCancelled(true);
      setPhase('done');
    });

    return () => {
      unlistenProgress.then((f) => f());
      unlistenComplete.then((f) => f());
      unlistenCancelled.then((f) => f());
    };
  }, [onComplete]);

  /* ── Handlers ── */
  const handlePickFolder = async () => {
    const chosen = await open({ directory: true, title: 'Select Output Folder' });
    if (chosen) setOutputFolder(chosen as string);
  };

  const handleStart = useCallback(async () => {
    if (!outputFolder) return;
    setStartError(null);
    setPhase('processing');
    setProgress(null);
    try {
      await invoke(Invokes.BatchDenoiseImages, {
        paths: targetPaths,
        intensity: intensity / 100,
        method,
        outputFolder,
        suffix,
        copyAdjustments,
      });
    } catch (err) {
      setStartError(String(err));
      setPhase('settings');
    }
  }, [outputFolder, targetPaths, intensity, method, suffix]);

  const handleCancel = useCallback(async () => {
    try {
      await invoke(Invokes.CancelBatchDenoise);
    } catch {
      /* ignore */
    }
  }, []);

  const handleClose = useCallback(() => {
    if (phase === 'processing') return; // prevent accidental close during processing
    onClose();
  }, [phase, onClose]);

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    mouseDownTarget.current = e.target;
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && mouseDownTarget.current === e.currentTarget) {
      handleClose();
    }
    mouseDownTarget.current = null;
  };

  /* ── Render helpers ── */
  const progressPercent = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  const currentStatusText = aiModelDownloadStatus?.includes('NIND')
    ? `Downloading ${aiModelDownloadStatus}...`
    : progress
      ? `${progress.currentFile}`
      : 'Initializing…';

  const renderSettings = () => (
    <div className="flex flex-col gap-6 py-2">
      {/* Method + Intensity row */}
      <div className="flex items-start gap-6">
        <div className="flex flex-col gap-1 w-[260px] shrink-0">
          <Text variant={TextVariants.body} weight={TextWeights.medium}>
            Denoise Method
          </Text>
          <Dropdown
            options={methodOptions}
            value={method}
            onChange={(val) => {
              setMethod(val);
              setIntensity(val === 'ai' ? 50 : 15);
            }}
          />
        </div>
        <div className="flex-1">
          <Slider
            label={method === 'ai' ? 'Quality / Tile Size' : 'Strength'}
            value={intensity}
            min={0}
            max={100}
            step={1}
            defaultValue={method === 'ai' ? 50 : 15}
            onChange={(e) => setIntensity(Number(e.target.value))}
            trackClassName="bg-bg-secondary"
          />
        </div>
      </div>

      {/* Suffix */}
      <div className="flex flex-col gap-1">
        <Text variant={TextVariants.body} weight={TextWeights.medium}>
          Output Filename Suffix
        </Text>
        <input
          type="text"
          value={suffix}
          onChange={(e) => setSuffix(e.target.value)}
          placeholder="_Denoised"
          className="w-full bg-bg-primary border border-surface rounded-md px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent/60"
        />
        <Text variant={TextVariants.small} className="text-text-tertiary">
          Files will be saved as{' '}
          <span className="font-mono text-accent">filename{suffix || '_Denoised'}.png/.tiff</span>
        </Text>
      </div>

      {/* Output folder */}
      <div className="flex flex-col gap-1">
        <Text variant={TextVariants.body} weight={TextWeights.medium}>
          Output Folder
        </Text>
        <div className="flex items-center gap-2">
          <div
            className="flex-1 bg-bg-primary border border-surface rounded-md px-3 py-2 text-sm truncate cursor-pointer hover:border-accent/60 transition-colors"
            title={outputFolder ?? undefined}
            onClick={handlePickFolder}
          >
            {outputFolder ? (
              <span className="text-text-primary font-mono">{outputFolder}</span>
            ) : (
              <span className="text-text-tertiary">No folder selected…</span>
            )}
          </div>
          <button
            onClick={handlePickFolder}
            className="flex items-center gap-2 px-3 py-2 rounded-md bg-surface hover:bg-card-active transition-colors text-sm shrink-0"
          >
            <FolderOpen size={15} />
            Browse
          </button>
        </div>
      </div>

      {/* Copy adjustments */}
      <label className="flex items-center gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={copyAdjustments}
          onChange={(e) => setCopyAdjustments(e.target.checked)}
          className="w-4 h-4 accent-accent cursor-pointer shrink-0"
        />
        <div>
          <Text variant={TextVariants.body} weight={TextWeights.medium}>
            Copy adjustments &amp; properties
          </Text>
          <Text variant={TextVariants.small} className="text-text-tertiary">
            Copies the <span className="font-mono">.rrdata</span> sidecar so your edits stay non-destructively applied
            to the denoised output.
          </Text>
        </div>
      </label>

      {/* Info row */}
      <div className="flex items-center gap-2 px-3 py-2 bg-bg-primary rounded-md border border-surface text-sm text-text-secondary">
        <Grip size={14} className="text-accent shrink-0" />
        <span>
          {targetPaths.length} image{targetPaths.length !== 1 ? 's' : ''} selected
          {method === 'ai' && <span className="ml-2 opacity-60">— NIND AI may take several minutes per image</span>}
        </span>
      </div>

      {startError && (
        <div className="flex items-center gap-2 text-red-400 text-sm">
          <AlertTriangle size={14} />
          {startError}
        </div>
      )}
    </div>
  );

  const renderProcessing = () => (
    <div className="flex h-[340px] overflow-hidden">
      {/* Left decorative panel */}
      <div className="w-2/5 relative overflow-hidden shrink-0 bg-[#0a0a0a] flex items-center justify-center rounded-lg border border-surface mr-6">
        <div
          className="absolute inset-0 opacity-10 pointer-events-none"
          style={{ backgroundImage: 'radial-gradient(#444 1px, transparent 1px)', backgroundSize: '24px 24px' }}
        />
        <Grip className="w-16 h-16 text-accent opacity-30" />
      </div>

      {/* Right: progress info */}
      <div className="flex-1 flex flex-col items-center justify-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, duration: 0.4 }}
          className="flex flex-col items-center w-full"
        >
          <Text variant={TextVariants.title} className="mb-2 text-center">
            Denoising in Progress
          </Text>

          {progress && (
            <Text variant={TextVariants.body} className="mb-1 text-accent font-medium">
              {progress.current} / {progress.total}
            </Text>
          )}

          <Text className="text-center font-mono h-6 flex justify-center items-center text-sm text-text-secondary mb-6 max-w-xs truncate">
            {currentStatusText}
          </Text>

          {/* Progress bar */}
          <div className="w-64 relative">
            <div className="h-1 bg-surface rounded-full overflow-hidden relative w-full shadow-xs">
              {progress ? (
                <div
                  className="h-full bg-accent rounded-full transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              ) : (
                <>
                  <motion.div
                    className="absolute inset-y-0 w-[80%] bg-linear-to-r from-transparent via-accent to-transparent mix-blend-screen"
                    style={{ filter: 'blur(3px)' }}
                    animate={{ x: ['-150%', '150%'] }}
                    transition={{ repeat: Infinity, duration: 1.5, ease: [0.4, 0, 0.2, 1] }}
                  />
                  <motion.div
                    className="absolute inset-y-0 w-[40%] bg-linear-to-r from-transparent via-white/90 to-transparent"
                    style={{ filter: 'blur(1px)' }}
                    animate={{ x: ['-250%', '250%'] }}
                    transition={{ repeat: Infinity, duration: 1.5, ease: [0.4, 0, 0.2, 1] }}
                  />
                </>
              )}
            </div>
            {progress && (
              <Text variant={TextVariants.small} className="mt-2 text-center text-text-tertiary">
                {progressPercent}%
              </Text>
            )}
          </div>

          <Text variant={TextVariants.small} className="mt-6 text-center max-w-xs opacity-60">
            Processing images sequentially. This may take a while for large batches.
          </Text>
        </motion.div>
      </div>
    </div>
  );

  const renderDone = () => {
    if (cancelled) {
      return (
        <div className="flex flex-col items-center justify-center h-[340px] gap-4">
          <XCircle className="w-12 h-12 text-text-secondary" />
          <Text variant={TextVariants.title} className="text-center">
            Batch Denoise Cancelled
          </Text>
          <Text className="text-center text-text-secondary max-w-sm">
            The operation was cancelled.{' '}
            {progress ? `${progress.current - 1} of ${progress.total} images were processed.` : ''}
          </Text>
        </div>
      );
    }

    if (!result) return null;

    const succeeded = result.total - result.errors.length;

    return (
      <div className="flex flex-col items-center h-[340px] pt-10 gap-4">
        <AnimatePresence>
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="flex flex-col items-center gap-3"
          >
            <CheckCircle className="w-12 h-12 text-green-400" />
            <Text variant={TextVariants.title} className="text-center">
              Batch Denoise Complete
            </Text>
            <Text className="text-text-secondary text-center">
              {succeeded} of {result.total} image{result.total !== 1 ? 's' : ''} denoised successfully.
            </Text>
          </motion.div>
        </AnimatePresence>

        {result.errors.length > 0 && (
          <div className="w-full max-w-lg bg-red-500/10 border border-red-500/30 rounded-md p-3 mt-2">
            <div className="flex items-center gap-2 mb-2 text-red-400">
              <AlertTriangle size={14} />
              <Text variant={TextVariants.small} className="text-red-400 font-medium">
                {result.errors.length} error{result.errors.length !== 1 ? 's' : ''} occurred:
              </Text>
            </div>
            <ul className="space-y-1 max-h-32 overflow-y-auto">
              {result.errors.map((err, i) => (
                <li key={i} className="text-xs text-red-300 font-mono truncate" title={err}>
                  {err}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  };

  /* ── Main render ── */
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
        className={`bg-surface rounded-xl shadow-2xl p-6 w-full max-w-2xl transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <Grip size={20} className="text-accent" />
            <Text variant={TextVariants.title}>{phase === 'done' ? 'Batch Denoise Complete' : 'Batch Denoise'}</Text>
            {phase === 'settings' && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-accent/20 text-accent font-medium">
                {targetPaths.length} image{targetPaths.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          {phase !== 'processing' && (
            <button
              onClick={handleClose}
              className="p-1.5 rounded-md text-text-secondary hover:bg-card-active transition-colors"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Body */}
        {phase === 'settings' && renderSettings()}
        {phase === 'processing' && renderProcessing()}
        {phase === 'done' && renderDone()}

        {/* Footer */}
        <div className="mt-6 flex justify-end gap-3 pt-4 border-t border-surface/50">
          {phase === 'settings' && (
            <>
              <button
                onClick={handleClose}
                className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors text-sm"
              >
                Cancel
              </button>
              <Button onClick={handleStart} disabled={!outputFolder || targetPaths.length === 0}>
                <Grip className="mr-2" size={16} />
                Start Batch Denoise
              </Button>
            </>
          )}

          {phase === 'processing' && (
            <button
              onClick={handleCancel}
              className="flex items-center gap-2 px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors text-sm"
            >
              <X size={14} />
              Cancel
            </button>
          )}

          {phase === 'done' && <Button onClick={onClose}>Close</Button>}
        </div>
      </div>
    </div>
  );
}
