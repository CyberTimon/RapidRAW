import React, { useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Palette, Upload, Wand2, Check, Sparkles, X, Image as ImageIcon, Loader2 } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Button from '../ui/Button';
import Text from '../ui/Text';
import Slider from '../ui/Slider';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import { useEditorStore } from '../../store/useEditorStore';

interface ColorMatcherModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ColorMatchResult {
  adjustments: Record<string, any>;
  extracted_palette: string[];
  reference_tone_curve_summary: string;
}

export const ColorMatcherModal: React.FC<ColorMatcherModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [referenceBase64, setReferenceBase64] = useState<string | null>(null);
  const [intensity, setIntensity] = useState<number>(100);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [matchResult, setMatchResult] = useState<ColorMatchResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setEditor = useEditorStore((state) => state.setEditor);

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
                "Steal the Look" Color & Tone Matcher
              </Text>
            </div>
            <button
              onClick={onClose}
              className="text-text-secondary hover:text-text-primary transition-colors p-1 rounded-md"
            >
              <X size={18} />
            </button>
          </div>

          {/* Body */}
          <div className="p-6 flex flex-col gap-5 text-text-primary">
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
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end items-center gap-2 px-6 py-4 bg-bg-secondary/40 border-t border-border-color">
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
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default ColorMatcherModal;
