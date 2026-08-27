import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Download,
  Check,
  Folder,
  X,
  Loader2,
  Image as ImageIcon,
  Shield,
  Layers,
  Sparkles,
  Sliders,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Button from '../ui/Button';
import Text from '../ui/Text';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import clsx from 'clsx';

interface AdvancedExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedPaths: string[];
}

interface ExportSummary {
  total_photos: number;
  successful_exports: number;
  failed_exports: number;
  output_directory: string;
  elapsed_ms: number;
  throughput_fps: number;
}

export const AdvancedExportModal: React.FC<AdvancedExportModalProps> = ({
  isOpen,
  onClose,
  selectedPaths,
}) => {
  const [outputDir, setOutputDir] = useState<string>('D:\\RapidRAW_Exports');
  const [format, setFormat] = useState<'jpeg' | 'tiff' | 'png' | 'webp'>('jpeg');
  const [quality, setQuality] = useState<number>(95);
  const [colorSpace, setColorSpace] = useState<'srgb' | 'adobergb' | 'displayp3'>('srgb');
  
  const [resizeMode, setResizeMode] = useState<'original' | 'fit' | 'long_edge'>('original');
  const [targetLongEdge, setTargetLongEdge] = useState<number>(2048);

  const [watermarkEnabled, setWatermarkEnabled] = useState<boolean>(false);
  const [watermarkText, setWatermarkText] = useState<string>('© RAPIDRAW STUDIO');
  const [watermarkPosition, setWatermarkPosition] = useState<string>('bottom-right');
  const [watermarkOpacity, setWatermarkOpacity] = useState<number>(0.8);

  const [stripGps, setStripGps] = useState<boolean>(true);
  const [stripSerials, setStripSerials] = useState<boolean>(true);

  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    filename: string;
    percentage: number;
    fps: number;
  } | null>(null);
  const [result, setResult] = useState<ExportSummary | null>(null);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenComplete: (() => void) | undefined;

    if (isOpen) {
      setResult(null);
      setProgress(null);
      setIsExporting(false);

      listen<{
        current: number;
        total: number;
        filename: string;
        percentage: number;
        fps: number;
      }>('advanced-export-progress', (event) => {
        setProgress(event.payload);
      }).then((un) => (unlistenProgress = un));

      listen<ExportSummary>('advanced-export-complete', (event) => {
        setResult(event.payload);
        setIsExporting(false);
      }).then((un) => (unlistenComplete = un));
    }

    return () => {
      if (unlistenProgress) unlistenProgress();
      if (unlistenComplete) unlistenComplete();
    };
  }, [isOpen]);

  const handleStartExport = async () => {
    if (selectedPaths.length === 0) return;
    setIsExporting(true);
    setResult(null);

    try {
      await invoke('execute_advanced_batch_export', {
        config: {
          paths: selectedPaths,
          output_dir: outputDir,
          format,
          quality,
          color_space: colorSpace,
          resize_mode: resizeMode,
          target_width: targetLongEdge,
          target_height: targetLongEdge,
          watermark_enabled: watermarkEnabled,
          watermark_text: watermarkText,
          watermark_position: watermarkPosition,
          watermark_opacity: watermarkOpacity,
          strip_gps: stripGps,
          strip_serials: stripSerials,
        },
      });
    } catch (err) {
      console.error('Batch export failed:', err);
      setIsExporting(false);
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
          className="relative w-full max-w-[720px] bg-surface rounded-xl border border-border-color shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-color">
            <div className="flex items-center gap-2">
              <Download className="text-accent" size={20} />
              <Text variant={TextVariants.heading} weight={TextWeights.semibold}>
                Advanced High-Speed RAW Batch Exporter
              </Text>
            </div>
            {!isExporting && (
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
            {!result ? (
              <>
                {/* Format & Color Space */}
                <div className="flex flex-col gap-3 p-4 bg-bg-secondary rounded-lg border border-border-color">
                  <div className="flex items-center justify-between">
                    <Text variant={TextVariants.body} weight={TextWeights.semibold} className="flex items-center gap-2">
                      <ImageIcon size={16} className="text-blue-400" />
                      Image Format & Color Management
                    </Text>
                  </div>

                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { id: 'jpeg', label: 'JPEG', desc: '8-bit Web / Print' },
                      { id: 'tiff', label: '16-bit TIFF', desc: 'Master Archive' },
                      { id: 'webp', label: 'WebP', desc: 'High Efficiency' },
                      { id: 'png', label: 'PNG', desc: 'Lossless RGBA' },
                    ].map((f) => (
                      <button
                        key={f.id}
                        onClick={() => setFormat(f.id as any)}
                        className={clsx(
                          'p-2 rounded-lg border text-left transition-all',
                          format === f.id
                            ? 'bg-accent/15 border-accent text-accent'
                            : 'bg-surface border-border-color text-text-secondary hover:text-text-primary'
                        )}
                      >
                        <div className="text-xs font-semibold">{f.label}</div>
                        <div className="text-[10px] opacity-80">{f.desc}</div>
                      </button>
                    ))}
                  </div>

                  {format === 'jpeg' && (
                    <div className="flex flex-col gap-1 mt-1">
                      <div className="flex justify-between items-center text-xs">
                        <span className="text-text-secondary">JPEG Quality:</span>
                        <span className="font-mono text-accent font-medium">{quality}%</span>
                      </div>
                      <Slider
                        label=""
                        min={50}
                        max={100}
                        step={1}
                        value={quality}
                        onChange={(e: any) => setQuality(Number(e.target.value))}
                      />
                    </div>
                  )}

                  {/* Color Space */}
                  <div className="flex items-center justify-between pt-2 border-t border-border-color/50 text-xs">
                    <span className="text-text-secondary">Target Color Profile:</span>
                    <div className="flex gap-1">
                      {[
                        { id: 'srgb', label: 'sRGB' },
                        { id: 'adobergb', label: 'AdobeRGB' },
                        { id: 'displayp3', label: 'Display P3' },
                      ].map((cs) => (
                        <button
                          key={cs.id}
                          onClick={() => setColorSpace(cs.id as any)}
                          className={clsx(
                            'px-2.5 py-1 rounded text-xs font-medium border transition-all',
                            colorSpace === cs.id
                              ? 'bg-accent text-black border-accent'
                              : 'bg-surface border-border-color text-text-secondary'
                          )}
                        >
                          {cs.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Sizing & Resampling */}
                <div className="flex flex-col gap-3 p-4 bg-bg-secondary rounded-lg border border-border-color">
                  <Text variant={TextVariants.body} weight={TextWeights.semibold} className="flex items-center gap-2">
                    <Layers size={16} className="text-purple-400" />
                    Resolution & Resampling
                  </Text>

                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'original', label: 'Full Resolution', desc: 'Original sensor pixels' },
                      { id: 'long_edge', label: 'Long Edge Fit', desc: 'Constrain max dimension' },
                      { id: 'fit', label: 'Fit Box', desc: 'Fit within W × H' },
                    ].map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setResizeMode(m.id as any)}
                        className={clsx(
                          'p-2 rounded-lg border text-left transition-all',
                          resizeMode === m.id
                            ? 'bg-accent/15 border-accent text-accent'
                            : 'bg-surface border-border-color text-text-secondary hover:text-text-primary'
                        )}
                      >
                        <div className="text-xs font-semibold">{m.label}</div>
                        <div className="text-[10px] opacity-80">{m.desc}</div>
                      </button>
                    ))}
                  </div>

                  {resizeMode !== 'original' && (
                    <div className="flex items-center gap-3 pt-2 text-xs">
                      <span className="text-text-secondary">Target Dimension (px):</span>
                      <input
                        type="number"
                        value={targetLongEdge}
                        onChange={(e) => setTargetLongEdge(Number(e.target.value))}
                        className="bg-surface text-text-primary px-3 py-1 rounded border border-border-color w-24 font-mono text-xs"
                      />
                      <span className="text-[11px] text-text-secondary">Lanczos3 High-Quality Filter</span>
                    </div>
                  )}
                </div>

                {/* Watermark & Branding */}
                <div className="flex flex-col gap-3 p-4 bg-bg-secondary rounded-lg border border-border-color">
                  <div className="flex items-center justify-between">
                    <Text variant={TextVariants.body} weight={TextWeights.semibold} className="flex items-center gap-2">
                      <Sparkles size={16} className="text-amber-400" />
                      Branding & Watermark Studio
                    </Text>
                    <Switch label="" checked={watermarkEnabled} onChange={setWatermarkEnabled} />
                  </div>

                  {watermarkEnabled && (
                    <div className="flex flex-col gap-3 pt-2 border-t border-border-color/50">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-text-secondary">Watermark Text / Tokens:</span>
                        <input
                          type="text"
                          value={watermarkText}
                          onChange={(e) => setWatermarkText(e.target.value)}
                          className="bg-surface text-text-primary px-3 py-1.5 rounded border border-border-color text-xs font-mono"
                        />
                      </div>

                      <div className="flex items-center justify-between text-xs">
                        <span className="text-text-secondary">Placement:</span>
                        <div className="flex gap-1">
                          {[
                            { id: 'bottom-right', label: 'Bottom Right' },
                            { id: 'bottom-left', label: 'Bottom Left' },
                            { id: 'center', label: 'Center' },
                            { id: 'diagonal', label: 'Diagonal Grid' },
                          ].map((p) => (
                            <button
                              key={p.id}
                              onClick={() => setWatermarkPosition(p.id)}
                              className={clsx(
                                'px-2 py-1 rounded text-[11px] border transition-all',
                                watermarkPosition === p.id
                                  ? 'bg-accent/20 border-accent text-accent font-medium'
                                  : 'bg-surface border-border-color text-text-secondary'
                              )}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="flex flex-col gap-1">
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-text-secondary">Watermark Opacity:</span>
                          <span className="font-mono text-accent">{Math.round(watermarkOpacity * 100)}%</span>
                        </div>
                        <Slider
                          label=""
                          min={10}
                          max={100}
                          step={5}
                          value={watermarkOpacity * 100}
                          onChange={(e: any) => setWatermarkOpacity(Number(e.target.value) / 100)}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Privacy & Destination */}
                <div className="flex flex-col gap-2 p-3 bg-bg-secondary rounded-lg border border-border-color text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-text-secondary flex items-center gap-1.5">
                      <Shield size={14} className="text-emerald-400" />
                      Privacy Guard: Strip GPS Location from EXIF
                    </span>
                    <Switch label="" checked={stripGps} onChange={setStripGps} />
                  </div>
                  <div className="flex items-center justify-between border-t border-border-color/40 pt-2">
                    <span className="text-text-secondary flex items-center gap-1.5">
                      <Shield size={14} className="text-emerald-400" />
                      Sanitize Camera & Lens Serial Numbers
                    </span>
                    <Switch label="" checked={stripSerials} onChange={setStripSerials} />
                  </div>
                </div>

                {/* Output Directory */}
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-text-secondary font-medium">Export Destination:</span>
                  <div className="flex items-center gap-2 bg-bg-secondary px-3 py-2 rounded-md border border-border-color text-xs font-mono text-text-secondary">
                    <Folder size={14} className="text-accent shrink-0" />
                    <span className="truncate">{outputDir}</span>
                  </div>
                </div>

                {/* Progress bar */}
                {isExporting && progress && (
                  <div className="flex flex-col gap-2 p-3 bg-bg-secondary rounded-lg border border-border-color">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-text-secondary">Exporting batch...</span>
                      <span className="font-mono text-accent font-medium">
                        {progress.current} / {progress.total} ({Math.round(progress.percentage)}%) • {progress.fps.toFixed(1)} fps
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
              </>
            ) : (
              <div className="flex flex-col gap-3 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                  <Check size={18} />
                  <span>Batch Export Completed Successfully!</span>
                </div>
                <div className="flex flex-col gap-1 text-xs text-text-secondary">
                  <span>Exported <b>{result.successful_exports}</b> photos in <b>{(result.elapsed_ms / 1000).toFixed(1)}s</b> ({result.throughput_fps.toFixed(1)} photos/sec).</span>
                  <span className="font-mono truncate">Directory: {result.output_directory}</span>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end items-center gap-2 px-6 py-4 bg-bg-secondary/40 border-t border-border-color">
            <button
              type="button"
              onClick={onClose}
              disabled={isExporting}
              className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors text-sm disabled:opacity-50"
            >
              {result ? 'Done' : 'Cancel'}
            </button>

            {!result && (
              <Button onClick={handleStartExport} disabled={isExporting || selectedPaths.length === 0}>
                {isExporting ? (
                  <>
                    <Loader2 size={16} className="animate-spin mr-2" />
                    Exporting {selectedPaths.length} Photos...
                  </>
                ) : (
                  <>
                    <Download size={16} className="mr-2 text-accent" />
                    Start Parallel Export ({selectedPaths.length})
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

export default AdvancedExportModal;
