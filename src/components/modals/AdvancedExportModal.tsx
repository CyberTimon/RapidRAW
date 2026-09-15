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
  Settings2,
  Plus,
  Trash2,
  Zap,
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

export interface PhotographicQualityReport {
  overallScore: number;
  haloScore: number;
  highlightScore: number;
  textureScore: number;
  shadowScore: number;
  colorScore: number;
  exposureScore?: number;
  isStudioCertified: boolean;
  diagnosticSummary: string;
}

export interface ExportRecipeItem {
  id: string;
  name: string;
  enabled: boolean;
  format: 'jpeg' | 'tiff' | 'png' | 'webp' | 'ultrahdr';
  quality: number;
  color_space: 'srgb' | 'adobergb' | 'displayp3';
  resize_mode: 'original' | 'long_edge' | 'short_edge' | 'fit' | 'square_crop';
  target_width?: number;
  target_height?: number;
  output_subfolder: string;
  output_sharpening: 'none' | 'screen_standard' | 'screen_high' | 'print_standard' | 'print_high';
  watermark_enabled: boolean;
  watermark_text: string;
  watermark_position: string;
  watermark_opacity: number;
}

const DEFAULT_RECIPES: ExportRecipeItem[] = [
  {
    id: 'print-master',
    name: 'Print Master (16-bit TIFF)',
    enabled: true,
    format: 'tiff',
    quality: 100,
    color_space: 'adobergb',
    resize_mode: 'original',
    output_subfolder: 'Print_Master',
    output_sharpening: 'print_standard',
    watermark_enabled: false,
    watermark_text: '',
    watermark_position: 'bottom-right',
    watermark_opacity: 0.8,
  },
  {
    id: 'web-portfolio',
    name: 'Web Portfolio (2048px JPEG)',
    enabled: true,
    format: 'jpeg',
    quality: 85,
    color_space: 'srgb',
    resize_mode: 'long_edge',
    target_width: 2048,
    output_subfolder: 'Web_2048',
    output_sharpening: 'screen_standard',
    watermark_enabled: true,
    watermark_text: '© RAPIDRAW STUDIO',
    watermark_position: 'bottom-right',
    watermark_opacity: 0.7,
  },
  {
    id: 'instagram-square',
    name: 'Instagram Square (1080px)',
    enabled: false,
    format: 'jpeg',
    quality: 90,
    color_space: 'srgb',
    resize_mode: 'square_crop',
    target_width: 1080,
    output_subfolder: 'Instagram',
    output_sharpening: 'screen_standard',
    watermark_enabled: false,
    watermark_text: '',
    watermark_position: 'bottom-right',
    watermark_opacity: 0.8,
  },
  {
    id: 'ultrahdr-gainmap',
    name: 'UltraHDR Gain Map (ISO 21496-1)',
    enabled: false,
    format: 'ultrahdr',
    quality: 95,
    color_space: 'displayp3',
    resize_mode: 'original',
    output_subfolder: 'HDR_GainMap',
    output_sharpening: 'none',
    watermark_enabled: false,
    watermark_text: '',
    watermark_position: 'bottom-right',
    watermark_opacity: 0.8,
  },
  {
    id: 'proof-webp',
    name: 'Client Proof (1600px WebP)',
    enabled: false,
    format: 'webp',
    quality: 80,
    color_space: 'srgb',
    resize_mode: 'long_edge',
    target_width: 1600,
    output_subfolder: 'Proof_WebP',
    output_sharpening: 'screen_standard',
    watermark_enabled: true,
    watermark_text: '© PROOF FOR REVIEW',
    watermark_position: 'diagonal',
    watermark_opacity: 0.45,
  },
];

export const AdvancedExportModal: React.FC<AdvancedExportModalProps> = ({
  isOpen,
  onClose,
  selectedPaths,
}) => {
  const [activeTab, setActiveTab] = useState<'multi' | 'single'>('multi');
  const [outputDir, setOutputDir] = useState<string>('D:\\RapidRAW_Exports');

  // Multi-recipe state
  const [recipes, setRecipes] = useState<ExportRecipeItem[]>(DEFAULT_RECIPES);
  const [expandedRecipeId, setExpandedRecipeId] = useState<string | null>(null);

  // Single-recipe state
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
    recipes_completed?: number;
    total_operations?: number;
    filename: string;
    percentage: number;
    fps: number;
  } | null>(null);
  const [result, setResult] = useState<ExportSummary | null>(null);
  const [criticReport, setCriticReport] = useState<PhotographicQualityReport | null>(null);
  const [showCriticDetails, setShowCriticDetails] = useState(false);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenComplete: (() => void) | undefined;
    let unlistenMultiProgress: (() => void) | undefined;
    let unlistenMultiComplete: (() => void) | undefined;

    if (isOpen) {
      setResult(null);
      setProgress(null);
      setIsExporting(false);

      if (selectedPaths.length > 0) {
        invoke<PhotographicQualityReport>('get_photographic_critic_report', { path: selectedPaths[0] })
          .then((rep) => setCriticReport(rep))
          .catch((e) => console.warn('Could not load photographic critic report:', e));
      }

      listen<any>('advanced-export-progress', (event) => {
        setProgress(event.payload);
      }).then((un) => (unlistenProgress = un));

      listen<ExportSummary>('advanced-export-complete', (event) => {
        setResult(event.payload);
        setIsExporting(false);
      }).then((un) => (unlistenComplete = un));

      listen<any>('multi-recipe-export-progress', (event) => {
        setProgress(event.payload);
      }).then((un) => (unlistenMultiProgress = un));

      listen<ExportSummary>('multi-recipe-export-complete', (event) => {
        setResult(event.payload);
        setIsExporting(false);
      }).then((un) => (unlistenMultiComplete = un));
    }

    return () => {
      if (unlistenProgress) unlistenProgress();
      if (unlistenComplete) unlistenComplete();
      if (unlistenMultiProgress) unlistenMultiProgress();
      if (unlistenMultiComplete) unlistenMultiComplete();
    };
  }, [isOpen]);

  const activeRecipes = recipes.filter((r) => r.enabled);
  const totalMultiOperations = selectedPaths.length * activeRecipes.length;

  const toggleRecipe = (id: string) => {
    setRecipes((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
  };

  const updateRecipe = (id: string, patch: Partial<ExportRecipeItem>) => {
    setRecipes((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r))
    );
  };

  const addCustomRecipe = () => {
    const newId = `custom-${Date.now()}`;
    const newRecipe: ExportRecipeItem = {
      id: newId,
      name: `Custom Recipe ${recipes.length + 1}`,
      enabled: true,
      format: 'jpeg',
      quality: 90,
      color_space: 'srgb',
      resize_mode: 'original',
      output_subfolder: `Custom_${recipes.length + 1}`,
      output_sharpening: 'none',
      watermark_enabled: false,
      watermark_text: '',
      watermark_position: 'bottom-right',
      watermark_opacity: 0.8,
    };
    setRecipes((prev) => [...prev, newRecipe]);
    setExpandedRecipeId(newId);
  };

  const removeRecipe = (id: string) => {
    setRecipes((prev) => prev.filter((r) => r.id !== id));
  };

  const handleStartExport = async () => {
    if (selectedPaths.length === 0) return;
    setIsExporting(true);
    setResult(null);

    try {
      if (activeTab === 'multi') {
        if (activeRecipes.length === 0) {
          setIsExporting(false);
          return;
        }

        await invoke('execute_multi_recipe_batch_export', {
          config: {
            paths: selectedPaths,
            base_output_dir: outputDir,
            recipes: activeRecipes.map((r) => ({
              name: r.name,
              format: r.format,
              quality: r.quality,
              color_space: r.color_space,
              resize_mode: r.resize_mode,
              target_width: r.target_width,
              target_height: r.target_height,
              output_subfolder: r.output_subfolder,
              watermark_enabled: r.watermark_enabled,
              watermark_text: r.watermark_enabled ? r.watermark_text : undefined,
              watermark_position: r.watermark_position,
              watermark_opacity: r.watermark_opacity,
              output_sharpening: r.output_sharpening !== 'none' ? r.output_sharpening : undefined,
            })),
          },
        });
      } else {
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
      }
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
          className="relative w-full max-w-[780px] bg-surface rounded-xl border border-border-color shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-3.5 border-b border-border-color">
            <div className="flex items-center gap-3">
              <Download className="text-accent" size={20} />
              <div>
                <Text variant={TextVariants.heading} weight={TextWeights.semibold}>
                  Pro Batch Export Studio
                </Text>
                <div className="text-[11px] text-text-secondary">
                  High-throughput multi-core RAW rendering & export engine
                </div>
              </div>
            </div>

            {/* Segmented Tab Switcher */}
            <div className="flex items-center gap-1 bg-surface-secondary/70 p-1 rounded-lg border border-border-color">
              <button
                type="button"
                onClick={() => setActiveTab('multi')}
                className={clsx(
                  'px-3 py-1 text-xs font-semibold rounded-md transition-all flex items-center gap-1.5',
                  activeTab === 'multi'
                    ? 'bg-accent text-black shadow-xs'
                    : 'text-text-secondary hover:text-text-primary'
                )}
              >
                <Layers size={13} />
                Multi-Recipe Studio
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('single')}
                className={clsx(
                  'px-3 py-1 text-xs font-semibold rounded-md transition-all flex items-center gap-1.5',
                  activeTab === 'single'
                    ? 'bg-accent text-black shadow-xs'
                    : 'text-text-secondary hover:text-text-primary'
                )}
              >
                <Sliders size={13} />
                Single Custom
              </button>
            </div>

            {/* Photographic Critic Badge */}
            {criticReport && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowCriticDetails(!showCriticDetails)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/20 transition-all cursor-pointer"
                  title={criticReport.diagnosticSummary}
                >
                  <Shield size={13} className="text-emerald-400" />
                  <span>Critic: {criticReport.overallScore.toFixed(0)}/100</span>
                  <span className="text-[9px] bg-emerald-500/25 px-1.5 py-0.5 rounded-sm uppercase tracking-wider font-bold">
                    {criticReport.isStudioCertified ? 'Certified' : 'Tuned'}
                  </span>
                </button>

                {showCriticDetails && (
                  <div className="absolute right-0 top-full mt-2 z-50 w-72 p-3 bg-surface-secondary/95 border border-border-color rounded-xl shadow-2xl backdrop-blur-md text-xs space-y-2">
                    <div className="flex items-center justify-between font-semibold text-text-primary border-b border-border-color pb-1.5">
                      <span className="flex items-center gap-1.5">
                        <Sparkles size={13} className="text-accent" />
                        Photographic Critic Breakdown
                      </span>
                      <span className="text-emerald-400 font-bold">{criticReport.overallScore.toFixed(1)}/100</span>
                    </div>
                    <div className="space-y-1.5 text-[11px]">
                      <div className="flex justify-between">
                        <span className="text-text-secondary">Edge Halos (Zero-Divergence)</span>
                        <span className="font-mono text-text-primary">{criticReport.haloScore.toFixed(1)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-secondary">Filmic Highlight Rolloff</span>
                        <span className="font-mono text-text-primary">{criticReport.highlightScore.toFixed(1)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-secondary">Optical Texture (Zero-Grunge)</span>
                        <span className="font-mono text-text-primary">{criticReport.textureScore.toFixed(1)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-secondary">Zone 0 Black Depth</span>
                        <span className="font-mono text-text-primary">{criticReport.shadowScore.toFixed(1)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-secondary">OkLab Color Harmony</span>
                        <span className="font-mono text-text-primary">{criticReport.colorScore.toFixed(1)}</span>
                      </div>
                      {criticReport.exposureScore !== undefined && (
                        <div className="flex justify-between">
                          <span className="text-text-secondary">Zone V Midtone Parity</span>
                          <span className="font-mono text-text-primary">{criticReport.exposureScore.toFixed(1)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

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
                {/* Multi-Recipe Tab */}
                {activeTab === 'multi' ? (
                  <div className="flex flex-col gap-4">
                    {/* Architecture Callout Banner */}
                    <div className="flex items-start gap-2.5 p-3 rounded-lg bg-accent/10 border border-accent/25 text-xs">
                      <Zap size={16} className="text-accent shrink-0 mt-0.5" />
                      <div>
                        <span className="font-semibold text-accent">Single-Pass Parallel RAW Branching</span>
                        <p className="text-text-secondary text-[11px] mt-0.5">
                          RapidRAW decodes each raw frame only once into memory, then branches across all selected recipes concurrently via Rayon threads. Zero redundant disk I/O and up to 4× faster than sequential exports.
                        </p>
                      </div>
                    </div>

                    {/* Recipe List */}
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
                          Active Process Recipes ({activeRecipes.length}/{recipes.length})
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setRecipes((prev) => prev.map((r) => ({ ...r, enabled: true })))
                            }
                            className="text-[11px] text-accent hover:underline"
                          >
                            Select All
                          </button>
                          <span className="text-text-secondary text-[11px]">•</span>
                          <button
                            type="button"
                            onClick={addCustomRecipe}
                            className="text-[11px] text-accent hover:underline flex items-center gap-1"
                          >
                            <Plus size={12} /> Add Recipe
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-col gap-2">
                        {recipes.map((r) => {
                          const isExpanded = expandedRecipeId === r.id;
                          return (
                            <div
                              key={r.id}
                              className={clsx(
                                'rounded-lg border transition-all overflow-hidden',
                                r.enabled
                                  ? 'bg-bg-secondary border-border-color'
                                  : 'bg-surface/50 border-border-color/40 opacity-70'
                              )}
                            >
                              {/* Recipe Summary Row */}
                              <div className="flex items-center justify-between p-3 gap-3">
                                <div className="flex items-center gap-3">
                                  <input
                                    type="checkbox"
                                    checked={r.enabled}
                                    onChange={() => toggleRecipe(r.id)}
                                    className="w-4 h-4 rounded text-accent bg-surface border-border-color cursor-pointer accent-accent"
                                  />
                                  <div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-semibold text-text-primary">
                                        {r.name}
                                      </span>
                                      <span className="px-1.5 py-0.5 rounded text-[10px] uppercase font-mono font-bold bg-accent/15 text-accent border border-accent/30">
                                        {r.format}
                                      </span>
                                      {r.output_sharpening !== 'none' && (
                                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-blue-500/15 text-blue-400 border border-blue-500/30">
                                          {r.output_sharpening.replace('_', ' ')}
                                        </span>
                                      )}
                                      {r.watermark_enabled && (
                                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-amber-500/15 text-amber-400 border border-amber-500/30">
                                          © Watermark
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-[11px] text-text-secondary mt-0.5">
                                      Folder: <span className="font-mono text-accent">/{r.output_subfolder}</span> • {r.resize_mode} {r.target_width ? `(${r.target_width}px)` : ''} • {r.color_space.toUpperCase()}
                                    </div>
                                  </div>
                                </div>

                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedRecipeId(isExpanded ? null : r.id)
                                    }
                                    className="p-1.5 text-text-secondary hover:text-text-primary transition-colors rounded hover:bg-surface"
                                    title="Edit Recipe Settings"
                                  >
                                    <Settings2 size={14} />
                                  </button>
                                  {recipes.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() => removeRecipe(r.id)}
                                      className="p-1.5 text-text-secondary hover:text-red-400 transition-colors rounded hover:bg-surface"
                                      title="Delete Recipe"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  )}
                                </div>
                              </div>

                              {/* Expanded Recipe Settings */}
                              {isExpanded && (
                                <div className="p-3 bg-surface border-t border-border-color flex flex-col gap-3 text-xs">
                                  <div className="grid grid-cols-2 gap-3">
                                    <div className="flex flex-col gap-1">
                                      <span className="text-text-secondary">Recipe Name:</span>
                                      <input
                                        type="text"
                                        value={r.name}
                                        onChange={(e) =>
                                          updateRecipe(r.id, { name: e.target.value })
                                        }
                                        className="bg-bg-secondary px-2.5 py-1 rounded border border-border-color text-xs"
                                      />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                      <span className="text-text-secondary">Destination Subfolder:</span>
                                      <input
                                        type="text"
                                        value={r.output_subfolder}
                                        onChange={(e) =>
                                          updateRecipe(r.id, { output_subfolder: e.target.value })
                                        }
                                        className="bg-bg-secondary px-2.5 py-1 rounded border border-border-color text-xs font-mono"
                                      />
                                    </div>
                                  </div>

                                  <div className="grid grid-cols-3 gap-3">
                                    <div className="flex flex-col gap-1">
                                      <span className="text-text-secondary">File Format:</span>
                                      <select
                                        value={r.format}
                                        onChange={(e) =>
                                          updateRecipe(r.id, { format: e.target.value as any })
                                        }
                                        className="bg-bg-secondary px-2.5 py-1 rounded border border-border-color text-xs"
                                      >
                                        <option value="jpeg">JPEG</option>
                                        <option value="tiff">16-bit TIFF</option>
                                        <option value="png">PNG</option>
                                        <option value="webp">WebP</option>
                                        <option value="ultrahdr">UltraHDR Gain Map</option>
                                      </select>
                                    </div>

                                    <div className="flex flex-col gap-1">
                                      <span className="text-text-secondary">Resize Mode:</span>
                                      <select
                                        value={r.resize_mode}
                                        onChange={(e) =>
                                          updateRecipe(r.id, { resize_mode: e.target.value as any })
                                        }
                                        className="bg-bg-secondary px-2.5 py-1 rounded border border-border-color text-xs"
                                      >
                                        <option value="original">Original Full Res</option>
                                        <option value="long_edge">Long Edge Constrain</option>
                                        <option value="short_edge">Short Edge Constrain</option>
                                        <option value="square_crop">Square Crop (1:1)</option>
                                        <option value="fit">Fit Box</option>
                                      </select>
                                    </div>

                                    {r.resize_mode !== 'original' && (
                                      <div className="flex flex-col gap-1">
                                        <span className="text-text-secondary">Target Dimension (px):</span>
                                        <input
                                          type="number"
                                          value={r.target_width || 2048}
                                          onChange={(e) =>
                                            updateRecipe(r.id, {
                                              target_width: Number(e.target.value),
                                              target_height: Number(e.target.value),
                                            })
                                          }
                                          className="bg-bg-secondary px-2.5 py-1 rounded border border-border-color text-xs font-mono"
                                        />
                                      </div>
                                    )}

                                    <div className="flex flex-col gap-1">
                                      <span className="text-text-secondary">Output Sharpening:</span>
                                      <select
                                        value={r.output_sharpening}
                                        onChange={(e) =>
                                          updateRecipe(r.id, {
                                            output_sharpening: e.target.value as any,
                                          })
                                        }
                                        className="bg-bg-secondary px-2.5 py-1 rounded border border-border-color text-xs"
                                      >
                                        <option value="none">None (Standard)</option>
                                        <option value="screen_standard">Screen Standard (0.8px)</option>
                                        <option value="screen_high">Screen High (1.2px)</option>
                                        <option value="print_standard">Print Standard (1.6px)</option>
                                        <option value="print_high">Print High (2.2px)</option>
                                      </select>
                                    </div>
                                  </div>

                                  {/* Watermark toggle */}
                                  <div className="flex items-center justify-between pt-1 border-t border-border-color/50">
                                    <div className="flex items-center gap-2">
                                      <span className="text-text-secondary">Apply Studio Watermark</span>
                                      <Switch
                                        label=""
                                        checked={r.watermark_enabled}
                                        onChange={(checked) =>
                                          updateRecipe(r.id, { watermark_enabled: checked })
                                        }
                                      />
                                    </div>
                                    {r.watermark_enabled && (
                                      <input
                                        type="text"
                                        value={r.watermark_text}
                                        placeholder="Watermark Text..."
                                        onChange={(e) =>
                                          updateRecipe(r.id, { watermark_text: e.target.value })
                                        }
                                        className="bg-bg-secondary px-2.5 py-1 rounded border border-border-color text-xs w-64 font-mono"
                                      />
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Single Recipe Custom Mode */
                  <>
                    {/* Format & Color Space */}
                    <div className="flex flex-col gap-3 p-4 bg-bg-secondary rounded-lg border border-border-color">
                      <div className="flex items-center justify-between">
                        <Text
                          variant={TextVariants.body}
                          weight={TextWeights.semibold}
                          className="flex items-center gap-2"
                        >
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
                      <Text
                        variant={TextVariants.body}
                        weight={TextWeights.semibold}
                        className="flex items-center gap-2"
                      >
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
                          <span className="text-[11px] text-text-secondary">
                            Lanczos3 High-Quality Filter
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Watermark & Branding */}
                    <div className="flex flex-col gap-3 p-4 bg-bg-secondary rounded-lg border border-border-color">
                      <div className="flex items-center justify-between">
                        <Text
                          variant={TextVariants.body}
                          weight={TextWeights.semibold}
                          className="flex items-center gap-2"
                        >
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
                              <span className="font-mono text-accent">
                                {Math.round(watermarkOpacity * 100)}%
                              </span>
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

                    {/* Privacy Guard */}
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
                  </>
                )}

                {/* Output Base Directory */}
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-text-secondary font-medium">Base Export Destination:</span>
                  <div className="flex items-center gap-2 bg-bg-secondary px-3 py-2 rounded-md border border-border-color text-xs font-mono text-text-secondary">
                    <Folder size={14} className="text-accent shrink-0" />
                    <span className="truncate">{outputDir}</span>
                  </div>
                </div>

                {/* Progress Bar */}
                {isExporting && progress && (
                  <div className="flex flex-col gap-2 p-3 bg-bg-secondary rounded-lg border border-border-color">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-text-secondary">
                        {activeTab === 'multi'
                          ? `Exporting Photo ${progress.current} of ${progress.total}...`
                          : `Exporting photo...`}
                      </span>
                      <span className="font-mono text-accent font-medium">
                        {progress.recipes_completed !== undefined
                          ? `${progress.recipes_completed} / ${progress.total_operations || totalMultiOperations} files`
                          : `${progress.current} / ${progress.total}`}{' '}
                        ({Math.round(progress.percentage)}%) • {progress.fps.toFixed(1)} fps
                      </span>
                    </div>
                    <div className="w-full h-2 bg-surface rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent transition-all duration-150"
                        style={{ width: `${progress.percentage}%` }}
                      />
                    </div>
                    {progress.filename && (
                      <div className="text-[11px] text-text-secondary font-mono truncate">
                        File: {progress.filename}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              /* Success Summary Card */
              <div className="flex flex-col gap-3 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
                  <Check size={18} />
                  <span>Batch Export Completed Successfully!</span>
                </div>
                <div className="flex flex-col gap-1 text-xs text-text-secondary">
                  <span>
                    Generated <b>{result.successful_exports}</b> files in{' '}
                    <b>{(result.elapsed_ms / 1000).toFixed(1)}s</b> ({result.throughput_fps.toFixed(1)}{' '}
                    files/sec).
                  </span>
                  <span className="font-mono truncate">Destination: {result.output_directory}</span>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-between items-center px-6 py-4 bg-bg-secondary/40 border-t border-border-color">
            <div className="text-xs text-text-secondary">
              {activeTab === 'multi' ? (
                <span>
                  <b>{selectedPaths.length}</b> photos × <b>{activeRecipes.length}</b> recipes ={' '}
                  <span className="font-mono font-semibold text-accent">{totalMultiOperations}</span> output files
                </span>
              ) : (
                <span>
                  <b>{selectedPaths.length}</b> photos queued for single export
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isExporting}
                className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors text-sm disabled:opacity-50"
              >
                {result ? 'Done' : 'Cancel'}
              </button>

              {!result && (
                <Button
                  onClick={handleStartExport}
                  disabled={
                    isExporting ||
                    selectedPaths.length === 0 ||
                    (activeTab === 'multi' && activeRecipes.length === 0)
                  }
                >
                  {isExporting ? (
                    <>
                      <Loader2 size={16} className="animate-spin mr-2" />
                      Exporting...
                    </>
                  ) : (
                    <>
                      <Download size={16} className="mr-2 text-accent" />
                      {activeTab === 'multi'
                        ? `Start Multi-Recipe Export (${totalMultiOperations} files)`
                        : `Start Export (${selectedPaths.length} photos)`}
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default AdvancedExportModal;
