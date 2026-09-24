import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Sparkles, Wand2, Check, Layers, Compass, Loader2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Button from '../ui/Button';
import Text from '../ui/Text';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

interface BatchPolishModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedPaths: string[];
  onComplete?: () => void;
}

interface ProgressEvent {
  current: number;
  total: number;
  filename?: string;
  scene?: string;
  percentage: number;
}

interface CompleteEvent {
  totalProcessed: number;
  sceneBreakdown: Record<string, number>;
  elapsedMs: number;
}

export const BatchPolishModal: React.FC<BatchPolishModalProps> = ({
  isOpen,
  onClose,
  selectedPaths,
  onComplete,
}) => {
  const [intensity, setIntensity] = useState<number>(100);
  const [harmonize, setHarmonize] = useState<boolean>(true);
  const [autoStraighten, setAutoStraighten] = useState<boolean>(true);
  const [enableXmpSync, setEnableXmpSync] = useState<boolean>(true);
  const [toneStyle, setToneStyle] = useState<'filmic' | 'punchy' | 'soft'>('filmic');
  const [skinProtection, setSkinProtection] = useState<boolean>(true);

  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [result, setResult] = useState<CompleteEvent | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenComplete: (() => void) | undefined;

    if (isOpen) {
      setResult(null);
      setProgress(null);
      setErrorMessage(null);
      setIsProcessing(false);

      listen<ProgressEvent>('batch-polish-progress', (event) => {
        setProgress(event.payload);
      }).then((un) => {
        unlistenProgress = un;
      });

      listen<CompleteEvent>('batch-polish-complete', (event) => {
        setResult(event.payload);
        setIsProcessing(false);
      }).then((un) => {
        unlistenComplete = un;
      });
    }

    return () => {
      if (unlistenProgress) unlistenProgress();
      if (unlistenComplete) unlistenComplete();
    };
  }, [isOpen]);

  const handleStartPolish = async () => {
    if (selectedPaths.length === 0) return;
    setIsProcessing(true);
    setResult(null);
    setErrorMessage(null);

    try {
      const summary: any = await invoke('batch_polish_photoshoot', {
        paths: selectedPaths,
        intensity,
        harmonize,
        autoStraighten,
        enableXmpSync,
        toneStyle,
        skinProtection,
      });
      if (summary) {
        setResult(summary);
      }
    } catch (err: any) {
      console.error('Failed to batch polish photoshoot:', err);
      setErrorMessage(typeof err === 'string' ? err : err?.message || 'Batch polish failed.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFinishAndClose = () => {
    if (onComplete) onComplete();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className="relative w-full max-w-[560px] bg-surface rounded-xl border border-border-color shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-color">
            <div className="flex items-center gap-2">
              <Sparkles className="text-amber-400" size={18} />
              <Text variant={TextVariants.heading} weight={TextWeights.semibold}>
                Universal AI Shoot Polish
              </Text>
            </div>
            {!isProcessing && (
              <button
                onClick={onClose}
                className="text-text-secondary hover:text-text-primary transition-colors p-1 rounded-md cursor-pointer"
              >
                <X size={18} />
              </button>
            )}
          </div>

          {/* Body */}
          <div className="p-6 flex flex-col gap-5 text-text-primary max-h-[80vh] overflow-y-auto">
            <div className="flex items-start gap-3 p-3.5 rounded-lg bg-bg-secondary border border-border-color/60">
              <div className="p-2 rounded-md bg-amber-500/10 text-amber-400 mt-0.5 shrink-0">
                <Wand2 size={20} />
              </div>
              <div>
                <Text variant={TextVariants.body} weight={TextWeights.semibold}>
                  Intelligent Multi-Frame Shoot Harmonization
                </Text>
                <Text variant={TextVariants.small} color={TextColors.secondary} className="mt-1 leading-relaxed text-[12px]">
                  Analyzes <b>{selectedPaths.length}</b> photos, detects scenes & anchor hero frames, eliminates batch exposure flicker, straightens horizons, and protects authentic skin tones with OKLab color science.
                </Text>
              </div>
            </div>

            {errorMessage && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
                <span className="font-bold">Error:</span>
                <span>{errorMessage}</span>
              </div>
            )}

            {!result ? (
              <div className="flex flex-col gap-4">
                {/* Master Vibe Slider */}
                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <Text variant={TextVariants.small} weight={TextWeights.medium}>
                      Master Polish Intensity: {intensity}%
                    </Text>
                    <Text variant={TextVariants.small} color={TextColors.secondary}>
                      {intensity <= 50 ? 'Subtle Documentary' : intensity <= 100 ? 'Studio Balanced' : 'Editorial Punch'}
                    </Text>
                  </div>
                  <Slider
                    label="Intensity"
                    value={intensity}
                    min={20}
                    max={150}
                    step={5}
                    onChange={(e) => setIntensity(Number(e.target.value))}
                    defaultValue={100}
                    fillOrigin="min"
                  />
                </div>

                {/* Tone Curve Profile Selection */}
                <div className="flex flex-col gap-1.5">
                  <Text variant={TextVariants.small} weight={TextWeights.medium}>
                    Tonal Character Profile
                  </Text>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'filmic', label: 'Filmic Dynamic', desc: 'Soft highlights, lifted shadows' },
                      { id: 'punchy', label: 'Punchy Commercial', desc: 'Deep blacks, crisp contrast' },
                      { id: 'soft', label: 'Natural Soft', desc: 'Gentle pastel, low contrast' },
                    ].map((style) => (
                      <button
                        key={style.id}
                        type="button"
                        onClick={() => setToneStyle(style.id as any)}
                        className={`flex flex-col text-left p-2.5 rounded-lg border transition-all cursor-pointer ${
                          toneStyle === style.id
                            ? 'bg-accent/15 border-accent text-text-primary shadow-xs'
                            : 'bg-bg-secondary border-border-color hover:border-text-secondary/40 text-text-secondary'
                        }`}
                      >
                        <span className="text-xs font-semibold text-text-primary">{style.label}</span>
                        <span className="text-[10px] text-text-secondary mt-0.5">{style.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Feature Toggles */}
                <div className="flex flex-col gap-3 pt-2 border-t border-border-color/60">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Layers size={16} className="text-accent" />
                      <div>
                        <Text variant={TextVariants.small} weight={TextWeights.medium}>
                          Harmonize Shoot (Burst Clustering)
                        </Text>
                        <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                          Anchors burst sequences to eliminate accidental shot-to-shot exposure jumps
                        </Text>
                      </div>
                    </div>
                    <Switch label="" checked={harmonize} onChange={setHarmonize} />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles size={16} className="text-amber-400" />
                      <div>
                        <Text variant={TextVariants.small} weight={TextWeights.medium}>
                          OKLab Skin Tone Protection Guard
                        </Text>
                        <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                          Preserves natural human skin locus without turning orange or magenta
                        </Text>
                      </div>
                    </div>
                    <Switch label="" checked={skinProtection} onChange={setSkinProtection} />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Compass size={16} className="text-emerald-400" />
                      <div>
                        <Text variant={TextVariants.small} weight={TextWeights.medium}>
                          Auto-Straighten Horizons
                        </Text>
                        <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                          Automatically levels tilted horizons and perspective planes
                        </Text>
                      </div>
                    </div>
                    <Switch label="" checked={autoStraighten} onChange={setAutoStraighten} />
                  </div>
                </div>

                {/* Progress Display */}
                {isProcessing && progress && (
                  <div className="flex flex-col gap-2 p-3 bg-bg-secondary rounded-lg border border-border-color">
                    <div className="flex justify-between items-center text-xs">
                      <span className="truncate max-w-[300px] text-text-secondary">
                        {progress.filename || 'Processing...'}
                      </span>
                      <span className="font-mono text-accent font-medium">
                        {progress.current} / {progress.total} ({Math.round(progress.percentage)}%)
                      </span>
                    </div>
                    <div className="w-full h-2 bg-surface rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent transition-all duration-150"
                        style={{ width: `${progress.percentage}%` }}
                      />
                    </div>
                    {progress.scene && (
                      <div className="text-[11px] text-text-secondary flex items-center gap-1.5">
                        <span>Detected Scene:</span>
                        <span className="px-1.5 py-0.5 rounded bg-accent/20 text-accent font-medium">
                          {progress.scene}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-4 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                  <Check size={18} />
                  <span>
                    Photoshoot Harmonization Complete! ({result.totalProcessed} photos
                    {(result as any).totalClusters ? `, ${(result as any).totalClusters} burst clusters` : ''})
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                    Scene Distribution:
                  </Text>
                  <div className="grid grid-cols-2 gap-1.5">
                    {Object.entries(result.sceneBreakdown).map(([sceneName, count]) => (
                      <div
                        key={sceneName}
                        className="flex justify-between items-center px-2.5 py-1 rounded bg-surface border border-border-color text-xs"
                      >
                        <span className="truncate">{sceneName}</span>
                        <span className="font-mono font-bold text-accent">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer Actions */}
          <div className="flex justify-end items-center gap-2 px-6 py-4 bg-bg-secondary/40 border-t border-border-color">
            <button
              type="button"
              onClick={result ? handleFinishAndClose : onClose}
              disabled={isProcessing}
              className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors text-sm disabled:opacity-50 cursor-pointer"
            >
              {result ? 'Done' : 'Cancel'}
            </button>

            {!result && (
              <Button onClick={handleStartPolish} disabled={isProcessing || selectedPaths.length === 0}>
                {isProcessing ? (
                  <>
                    <Loader2 size={16} className="animate-spin mr-2" />
                    Polishing Photoshoot...
                  </>
                ) : (
                  <>
                    <Wand2 size={16} className="mr-2" />
                    Polish All ({selectedPaths.length})
                  </>
                )}
              </Button>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default BatchPolishModal;
