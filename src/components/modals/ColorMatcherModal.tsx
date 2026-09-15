import React, { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Palette,
  Upload,
  Wand2,
  Check,
  Sparkles,
  X,
  Loader2,
  Download,
  Film,
  ShieldCheck,
  Camera,
  Layers,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Button from '../ui/Button';
import Text from '../ui/Text';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import { useEditorStore } from '../../store/useEditorStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { save } from '@tauri-apps/plugin-dialog';

interface ColorMatcherModalProps {
  isOpen: boolean;
  onClose: () => void;
  heroPath?: string | null;
  targetPaths?: string[];
  initialMode?: 'matcher' | 'harmonize';
}

interface ColorMatchResult {
  adjustments: Record<string, any>;
  extracted_palette: string[];
  reference_tone_curve_summary: string;
}

export const ColorMatcherModal: React.FC<ColorMatcherModalProps> = ({
  isOpen,
  onClose,
  heroPath,
  targetPaths,
  initialMode = 'matcher',
}) => {
  const [activeTab, setActiveTab] = useState<'matcher' | 'harmonize'>(initialMode);
  const [referenceBase64, setReferenceBase64] = useState<string | null>(null);
  const [intensity, setIntensity] = useState<number>(100);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [matchResult, setMatchResult] = useState<ColorMatchResult | null>(null);
  const [lutSize, setLutSize] = useState<number>(33);
  const [protectSkin, setProtectSkin] = useState<boolean>(true);
  const [isExportingLut, setIsExportingLut] = useState<boolean>(false);
  const [exportSuccessMsg, setExportSuccessMsg] = useState<string | null>(null);

  // Harmonizer state
  const [isHarmonizing, setIsHarmonizing] = useState<boolean>(false);
  const [harmonizeProgress, setHarmonizeProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const [harmonizeSummary, setHarmonizeSummary] = useState<any | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedImage = useEditorStore((state) => state.selectedImage);
  const setEditor = useEditorStore((state) => state.setEditor);
  const multiSelectedPaths = useLibraryStore((state) => state.multiSelectedPaths);

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialMode || 'matcher');
      setHarmonizeSummary(null);
      setHarmonizeProgress(null);
    }
  }, [isOpen, initialMode]);

  const effectiveHeroPath = heroPath || selectedImage?.path || (multiSelectedPaths.length > 0 ? multiSelectedPaths[0] : null);
  const effectiveTargetPaths = targetPaths && targetPaths.length > 0
    ? targetPaths
    : multiSelectedPaths.filter((p) => p !== effectiveHeroPath);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64 = event.target?.result as string;
      setReferenceBase64(base64);
      runColorMatch(base64, intensity);
    };
    reader.readAsDataURL(file);
  };

  const runColorMatch = async (base64: string, intVal: number) => {
    setIsAnalyzing(true);
    try {
      const res = await invoke<ColorMatchResult>('steal_color_look', {
        referenceBase64: base64,
        intensity: intVal,
      });
      setMatchResult(res);
    } catch (err) {
      console.error('Failed to match color look:', err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleIntensityChange = (newIntensity: number) => {
    setIntensity(newIntensity);
    if (referenceBase64) {
      runColorMatch(referenceBase64, newIntensity);
    }
  };

  const handleExportCubeLut = async () => {
    if (!matchResult) return;
    try {
      const selectedPath = await save({
        title: 'Export 3D LUT (.cube)',
        defaultPath: 'RapidRAW_Cinematic_Look.cube',
        filters: [{ name: 'Cube 3D LUT', extensions: ['cube'] }],
      });
      if (!selectedPath) return;

      setIsExportingLut(true);
      const adj = matchResult.adjustments;
      await invoke('export_color_match_as_cube_lut', {
        title: 'RapidRAW Color Match Look',
        exposureEv: Number(adj.exposure || 0),
        tempShift: Number(adj.temperature || 0),
        contrastMult: 1.0 + Number(adj.contrast || 0) / 100.0,
        outputPath: selectedPath,
        highlights: Number(adj.highlights || 0),
        shadows: Number(adj.shadows || 0),
        tint: Number(adj.tint || 0),
        vibrance: Number(adj.vibrance || 0),
        lutSize: lutSize,
        protectSkin: protectSkin,
      });

      setExportSuccessMsg('Pro 3D LUT exported successfully (.cube)!');
      setTimeout(() => setExportSuccessMsg(null), 4000);
    } catch (err) {
      console.error('Failed to export .cube LUT:', err);
    } finally {
      setIsExportingLut(false);
    }
  };

  const handleApplyToActiveImage = () => {
    if (matchResult && matchResult.adjustments) {
      setEditor((state) => ({
        adjustments: {
          ...state.adjustments,
          ...matchResult.adjustments,
        },
      }));
      onClose();
    }
  };

  const handleRunHarmonize = async () => {
    if (!effectiveHeroPath || effectiveTargetPaths.length === 0) return;

    setIsHarmonizing(true);
    setHarmonizeProgress({ current: 0, total: effectiveTargetPaths.length, message: 'Starting photoshoot harmonization...' });
    setHarmonizeSummary(null);

    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<any>('harmonize-progress', (event) => {
        setHarmonizeProgress(event.payload);
      });

      const res = await invoke<any>('harmonize_photoshoot_series', {
        heroPath: effectiveHeroPath,
        targetPaths: effectiveTargetPaths,
      });

      setHarmonizeSummary(res);
    } catch (err: any) {
      console.error('Harmonization failed:', err);
    } finally {
      if (unlisten) unlisten();
      setIsHarmonizing(false);
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
          className="relative w-full max-w-[560px] bg-surface rounded-xl border border-border-color shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-color">
            <div className="flex items-center gap-2">
              <Palette className="text-violet-400" size={20} />
              <Text variant={TextVariants.heading} weight={TextWeights.semibold}>
                Pro Color Studio & Harmonizer
              </Text>
            </div>
            <button
              onClick={onClose}
              className="text-text-secondary hover:text-text-primary transition-colors p-1 rounded-md"
            >
              <X size={18} />
            </button>
          </div>

          {/* Mode Switcher */}
          <div className="px-6 pt-4">
            <div className="flex p-1 bg-bg-secondary rounded-lg border border-border-color/80">
              <button
                type="button"
                onClick={() => setActiveTab('matcher')}
                className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs rounded-md transition-all ${
                  activeTab === 'matcher'
                    ? 'bg-surface text-text-primary font-semibold shadow-xs'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <Palette size={14} className={activeTab === 'matcher' ? 'text-violet-400' : ''} />
                "Steal the Look" (3D LUT)
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('harmonize')}
                className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs rounded-md transition-all ${
                  activeTab === 'harmonize'
                    ? 'bg-surface text-text-primary font-semibold shadow-xs'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                <Wand2 size={14} className={activeTab === 'harmonize' ? 'text-emerald-400' : ''} />
                Photoshoot Series Harmonizer
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="p-6 flex flex-col gap-4 text-text-primary max-h-[70vh] overflow-y-auto">
            {activeTab === 'matcher' ? (
              <>
                {/* Description */}
            <div className="flex items-start gap-3 p-3.5 rounded-lg bg-bg-secondary border border-border-color/60">
              <div className="p-2 rounded-md bg-violet-500/10 text-violet-400 mt-0.5 shrink-0">
                <Wand2 size={20} />
              </div>
              <div>
                <Text variant={TextVariants.body} weight={TextWeights.semibold}>
                  Transfer Cinematic Grading & Color Harmonies
                </Text>
                <Text variant={TextVariants.small} color={TextColors.secondary} className="mt-1 leading-relaxed">
                  Upload any reference image (movie still, vintage film scan, or editorial look). RapidRAW extracts its 3D color moments and tone curve, applying the exact mood to your active RAW image.
                </Text>
              </div>
            </div>

            {/* Reference Upload Dropzone */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileUpload}
            />

            {!referenceBase64 ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="h-40 border-2 border-dashed border-border-color hover:border-accent/60 rounded-xl flex flex-col items-center justify-center gap-2 cursor-pointer bg-bg-secondary/40 hover:bg-surface-secondary/60 transition-all group"
              >
                <div className="p-3 rounded-full bg-surface border border-border-color group-hover:scale-110 transition-transform">
                  <Upload size={22} className="text-accent" />
                </div>
                <Text variant={TextVariants.body} weight={TextWeights.medium}>
                  Click or drag reference photo here
                </Text>
                <Text variant={TextVariants.small} color={TextColors.secondary}>
                  Supports JPEG, PNG, WebP (Cinematic stills, film looks)
                </Text>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                    Reference Image:
                  </Text>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs text-accent hover:underline font-medium"
                  >
                    Change Reference
                  </button>
                </div>

                <div className="relative h-44 rounded-lg overflow-hidden border border-border-color bg-black flex items-center justify-center">
                  <img
                    src={referenceBase64}
                    alt="Reference Look"
                    className="w-full h-full object-contain"
                  />
                  {isAnalyzing && (
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center gap-2 text-white text-xs">
                      <Loader2 size={16} className="animate-spin text-accent" />
                      <span>Extracting color moments & tone curves...</span>
                    </div>
                  )}
                </div>

                {/* Extracted Palette */}
                {matchResult && (
                  <div className="flex flex-col gap-2 p-3 bg-bg-secondary rounded-lg border border-border-color">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-text-secondary font-medium">Extracted Color Palette:</span>
                      <span className="font-mono text-[11px] text-text-secondary">
                        {matchResult.reference_tone_curve_summary}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 h-7">
                      {matchResult.extracted_palette.map((color, idx) => (
                        <div
                          key={color + idx}
                          className="flex-1 h-full rounded-md shadow-xs border border-white/10 flex items-center justify-center text-[9px] font-mono font-bold text-white/90 drop-shadow-sm"
                          style={{ backgroundColor: color }}
                        >
                          {color}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Intensity Slider */}
                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <Text variant={TextVariants.small} weight={TextWeights.medium}>
                      Look Match Intensity: {intensity}%
                    </Text>
                    <Text variant={TextVariants.small} color={TextColors.secondary}>
                      {intensity < 60 ? 'Subtle Tint' : intensity < 110 ? 'Balanced Look' : 'Bold Cinematic'}
                    </Text>
                  </div>
                  <Slider
                    label="Match Intensity"
                    value={intensity}
                    min={10}
                    max={150}
                    step={5}
                    onChange={(e) => handleIntensityChange(Number(e.target.value))}
                    defaultValue={100}
                    fillOrigin="min"
                  />
                </div>

                {/* Pro 3D LUT Studio Controls */}
                {matchResult && (
                  <div className="p-3.5 rounded-lg bg-bg-secondary border border-border-color flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Film size={15} className="text-violet-400" />
                        <span className="text-xs font-semibold text-text-primary">
                          Pro 3D LUT Studio (.cube Export)
                        </span>
                      </div>
                      <div className="flex items-center gap-1 bg-surface p-0.5 rounded border border-border-color/60">
                        <button
                          type="button"
                          onClick={() => setLutSize(33)}
                          className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                            lutSize === 33
                              ? 'bg-accent text-white font-medium shadow-xs'
                              : 'text-text-secondary hover:text-text-primary'
                          }`}
                        >
                          33³ Standard
                        </button>
                        <button
                          type="button"
                          onClick={() => setLutSize(65)}
                          className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                            lutSize === 65
                              ? 'bg-accent text-white font-medium shadow-xs'
                              : 'text-text-secondary hover:text-text-primary'
                          }`}
                        >
                          65³ Master
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-xs pt-1 border-t border-border-color/40">
                      <div className="flex items-center gap-2">
                        <ShieldCheck
                          size={14}
                          className={protectSkin ? 'text-emerald-400' : 'text-text-secondary'}
                        />
                        <span className="text-text-secondary">
                          Skin-Tone Hue Anchor (Oklab Guard)
                        </span>
                      </div>
                      <Switch
                        label=""
                        checked={protectSkin}
                        onChange={(val) => setProtectSkin(val)}
                      />
                    </div>

                    {exportSuccessMsg && (
                      <div className="p-2 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs flex items-center gap-1.5">
                        <Check size={14} />
                        <span>{exportSuccessMsg}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            </>
          ) : (
            /* Harmonizer Tab */
            <div className="flex flex-col gap-4">
              {/* Description */}
              <div className="flex items-start gap-3 p-3.5 rounded-lg bg-bg-secondary border border-border-color/60">
                <div className="p-2 rounded-md bg-emerald-500/10 text-emerald-400 mt-0.5 shrink-0">
                  <Wand2 size={20} />
                </div>
                <div>
                  <Text variant={TextVariants.body} weight={TextWeights.semibold}>
                    One-Click Editorial Exposure & Skin Warmth Harmonizer
                  </Text>
                  <Text variant={TextVariants.small} color={TextColors.secondary} className="mt-1 leading-relaxed">
                    Matches exposure EV, Oklab perceptual luminance, and model skin warmth across an entire photoshoot series to your perfected Hero frame. Oklab skin-locus tracking ensures faces stay balanced even if background scenery changes.
                  </Text>
                </div>
              </div>

              {/* Hero Photo Card */}
              <div className="p-3.5 rounded-lg bg-bg-secondary border border-border-color flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Camera size={15} className="text-emerald-400" />
                    <span className="text-xs font-semibold text-text-primary">Hero Reference Frame</span>
                  </div>
                  <span className="text-[10px] bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded-full font-medium border border-emerald-500/30">
                    Baseline Benchmark
                  </span>
                </div>
                <div className="text-xs text-text-secondary truncate font-mono bg-surface p-2 rounded border border-border-color/60">
                  {effectiveHeroPath ? effectiveHeroPath.split(/[\\/]/).pop() : 'No Hero image selected'}
                </div>
              </div>

              {/* Target Photos Card */}
              <div className="p-3.5 rounded-lg bg-bg-secondary border border-border-color flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Layers size={15} className="text-violet-400" />
                    <span className="text-xs font-semibold text-text-primary">Target Frames to Harmonize</span>
                  </div>
                  <span className="text-xs font-semibold text-accent">
                    {effectiveTargetPaths.length} photos
                  </span>
                </div>
                <Text variant={TextVariants.small} color={TextColors.secondary}>
                  {effectiveTargetPaths.length > 0
                    ? `All ${effectiveTargetPaths.length} selected photos will receive non-destructive sidecar adjustments matching the Hero's exposure EV and skin warmth.`
                    : 'Please select 2 or more photos in the grid/filmstrip to harmonize them to the Hero.'}
                </Text>
              </div>

              {/* Harmonize Progress */}
              {isHarmonizing && harmonizeProgress && (
                <div className="p-3.5 rounded-lg bg-bg-secondary border border-border-color flex flex-col gap-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-text-primary font-medium flex items-center gap-2">
                      <Loader2 size={14} className="animate-spin text-accent" />
                      Harmonizing batch...
                    </span>
                    <span className="text-text-secondary font-mono">
                      {harmonizeProgress.current} / {harmonizeProgress.total}
                    </span>
                  </div>
                  <div className="w-full h-2 bg-surface rounded-full overflow-hidden border border-border-color/60">
                    <div
                      className="h-full bg-accent transition-all duration-150"
                      style={{
                        width: `${Math.round((harmonizeProgress.current / Math.max(1, harmonizeProgress.total)) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="text-[11px] text-text-secondary truncate">
                    {harmonizeProgress.message}
                  </span>
                </div>
              )}

              {/* Harmonize Summary */}
              {harmonizeSummary && (
                <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 font-semibold text-emerald-400">
                    <Check size={16} />
                    <span>Batch Harmonization Complete!</span>
                  </div>
                  <div className="text-[11px] text-emerald-300/80 pl-5">
                    Successfully synchronized {harmonizeSummary.total_harmonized} photos. Hero baseline luminance: {harmonizeSummary.hero_luminance.toFixed(2)}, skin warmth offset: {harmonizeSummary.hero_skin_temp_offset.toFixed(2)}.
                  </div>
                </div>
              )}
            </div>
          )}
          </div>

          {/* Footer */}
          {activeTab === 'matcher' ? (
            <div className="flex justify-between items-center px-6 py-4 bg-bg-secondary/40 border-t border-border-color">
              <div>
                {matchResult && (
                  <Button
                    type="button"
                    onClick={handleExportCubeLut}
                    disabled={isExportingLut || isAnalyzing}
                    className="!bg-surface hover:!bg-surface-secondary text-xs !py-1.5 !px-3 border border-border-color text-text-primary"
                  >
                    {isExportingLut ? (
                      <Loader2 size={14} className="animate-spin text-accent" />
                    ) : (
                      <Download size={14} className="text-accent" />
                    )}
                    Export .cube LUT
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors text-sm"
                >
                  Cancel
                </button>

                <Button
                  onClick={handleApplyToActiveImage}
                  disabled={!matchResult || isAnalyzing}
                >
                  <Sparkles size={16} className="mr-2 text-violet-300" />
                  Apply Look to Active Image
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-between items-center px-6 py-4 bg-bg-secondary/40 border-t border-border-color">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors text-sm"
              >
                Close
              </button>

              <Button
                onClick={handleRunHarmonize}
                disabled={isHarmonizing || effectiveTargetPaths.length === 0 || !effectiveHeroPath}
              >
                {isHarmonizing ? (
                  <Loader2 size={16} className="mr-2 animate-spin text-button-text" />
                ) : (
                  <Wand2 size={16} className="mr-2 text-emerald-300" />
                )}
                Harmonize {effectiveTargetPaths.length} Photos to Hero
              </Button>
            </div>
          )}
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default ColorMatcherModal;
