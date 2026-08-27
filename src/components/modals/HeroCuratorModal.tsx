import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Trophy, Star, Sparkles, Check, X, Loader2, Gauge, Zap } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Button from '../ui/Button';
import Text from '../ui/Text';
import Switch from '../ui/Switch';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

interface HeroShotScore {
  file_path: string;
  file_name: string;
  overall_score: number;
  sharpness_score: number;
  eye_face_clarity_score: number;
  exposure_balance_score: number;
  is_winner: boolean;
}

interface HeroCuratorSummary {
  total_analyzed: number;
  winner_path: string;
  winner_score: number;
  scores: HeroShotScore[];
}

interface HeroCuratorModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedPaths: string[];
  onSelectWinner?: (path: string) => void;
}

export const HeroCuratorModal: React.FC<HeroCuratorModalProps> = ({
  isOpen,
  onClose,
  selectedPaths,
  onSelectWinner,
}) => {
  const [autoRateWinner, setAutoRateWinner] = useState<boolean>(true);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [progress, setProgress] = useState<{ current: number; total: number; percentage: number } | null>(null);
  const [result, setResult] = useState<HeroCuratorSummary | null>(null);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenComplete: (() => void) | undefined;

    if (isOpen) {
      setResult(null);
      setProgress(null);
      setIsAnalyzing(false);

      listen<{ current: number; total: number; percentage: number }>('hero-curator-progress', (event) => {
        setProgress(event.payload);
      }).then((un) => (unlistenProgress = un));

      listen<HeroCuratorSummary>('hero-curator-complete', (event) => {
        setResult(event.payload);
        setIsAnalyzing(false);
      }).then((un) => (unlistenComplete = un));
    }

    return () => {
      if (unlistenProgress) unlistenProgress();
      if (unlistenComplete) unlistenComplete();
    };
  }, [isOpen]);

  const handleStartCuration = async () => {
    if (selectedPaths.length === 0) return;
    setIsAnalyzing(true);
    setResult(null);

    try {
      await invoke('curate_hero_shots', {
        paths: selectedPaths,
        autoRateWinner,
      });
    } catch (err) {
      console.error('Hero curation failed:', err);
      setIsAnalyzing(false);
    }
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
          className="relative w-full max-w-[620px] bg-surface rounded-xl border border-border-color shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-color">
            <div className="flex items-center gap-2">
              <Trophy className="text-amber-400" size={20} />
              <Text variant={TextVariants.heading} weight={TextWeights.semibold}>
                AI Hero-Shot Curator
              </Text>
            </div>
            {!isAnalyzing && (
              <button
                onClick={onClose}
                className="text-text-secondary hover:text-text-primary transition-colors p-1 rounded-md"
              >
                <X size={18} />
              </button>
            )}
          </div>

          {/* Body */}
          <div className="p-6 flex flex-col gap-5 text-text-primary overflow-y-auto">
            {/* Description */}
            <div className="flex items-start gap-3 p-3.5 rounded-lg bg-bg-secondary border border-border-color/60">
              <div className="p-2 rounded-md bg-amber-500/10 text-amber-400 mt-0.5 shrink-0">
                <Sparkles size={20} />
              </div>
              <div>
                <Text variant={TextVariants.body} weight={TextWeights.semibold}>
                  Pick the #1 Winner Frame in Bursts & Sequences
                </Text>
                <Text variant={TextVariants.small} color={TextColors.secondary} className="mt-1 leading-relaxed">
                  Evaluates edge focus sharpness, subject eye clarity, and exposure balance across <b>{selectedPaths.length}</b> shots to pinpoint the ultimate hero shot.
                </Text>
              </div>
            </div>

            {!result ? (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between p-3 rounded-lg bg-bg-secondary border border-border-color">
                  <div className="flex items-center gap-2">
                    <Star size={16} className="text-amber-400 fill-amber-400" />
                    <div>
                      <Text variant={TextVariants.small} weight={TextWeights.medium}>
                        Auto-Assign 5-Star Rating to Winner
                      </Text>
                      <Text variant={TextVariants.small} color={TextColors.secondary} className="text-[11px]">
                        Marks the winning frame in the catalog for instant export
                      </Text>
                    </div>
                  </div>
                  <Switch label="" checked={autoRateWinner} onChange={setAutoRateWinner} />
                </div>

                {/* Progress bar */}
                {isAnalyzing && progress && (
                  <div className="flex flex-col gap-2 p-3 bg-bg-secondary rounded-lg border border-border-color">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-text-secondary">Evaluating burst sharpness...</span>
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
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300">
                  <Trophy size={20} className="text-amber-400 shrink-0" />
                  <div className="flex flex-col">
                    <span className="font-bold text-xs">Winner Found!</span>
                    <span className="font-mono text-[11px] truncate">
                      {result.scores.find((s) => s.is_winner)?.file_name} • Score: {Math.round(result.winner_score)}/100
                    </span>
                  </div>
                </div>

                {/* Scores List */}
                <div className="flex flex-col gap-2 max-h-60 overflow-y-auto pr-1">
                  {result.scores.map((score, idx) => (
                    <div
                      key={score.file_path}
                      className={`flex items-center justify-between p-2.5 rounded-lg border text-xs transition-all ${
                        score.is_winner
                          ? 'bg-amber-500/10 border-amber-500/40 text-amber-200'
                          : 'bg-bg-secondary border-border-color text-text-secondary'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="font-mono font-bold w-5">{idx + 1}.</span>
                        <span className="font-medium text-text-primary truncate max-w-[200px]">
                          {score.file_name}
                        </span>
                        {score.is_winner && (
                          <span className="px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-400 font-bold text-[10px] uppercase">
                            Winner 🏆
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 font-mono">
                        <span title="Sharpness">Sharp: {Math.round(score.sharpness_score)}</span>
                        <span title="Clarity">Clarity: {Math.round(score.eye_face_clarity_score)}</span>
                        <span className="font-bold text-accent">
                          {Math.round(score.overall_score)} pts
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end items-center gap-2 px-6 py-4 bg-bg-secondary/40 border-t border-border-color">
            <button
              type="button"
              onClick={onClose}
              disabled={isAnalyzing}
              className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors text-sm disabled:opacity-50"
            >
              {result ? 'Done' : 'Cancel'}
            </button>

            {!result ? (
              <Button onClick={handleStartCuration} disabled={isAnalyzing || selectedPaths.length === 0}>
                {isAnalyzing ? (
                  <>
                    <Loader2 size={16} className="animate-spin mr-2" />
                    Analyzing Shots...
                  </>
                ) : (
                  <>
                    <Zap size={16} className="mr-2 text-amber-300" />
                    Find Winner ({selectedPaths.length})
                  </>
                )}
              </Button>
            ) : (
              <Button
                onClick={() => {
                  if (onSelectWinner && result.winner_path) {
                    onSelectWinner(result.winner_path);
                  }
                  onClose();
                }}
              >
                <Check size={16} className="mr-2 text-emerald-400" />
                Open Winner in Editor
              </Button>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default HeroCuratorModal;
