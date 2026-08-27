import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Circle, Eye, Sparkles, X, Loader2, Check, Aperture, Sliders } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Button from '../ui/Button';
import Text from '../ui/Text';
import Slider from '../ui/Slider';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import clsx from 'clsx';
import { useEditorStore } from '../../store/useEditorStore';

interface BokehModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface BokehResult {
  aperture_simulated: string;
  bokeh_shape: string;
  blur_radius_px: number;
  specular_highlights_detected: number;
  preview_base64: string | null;
}

export const BokehModal: React.FC<BokehModalProps> = ({ isOpen, onClose }) => {
  const [aperture, setAperture] = useState<number>(1.4);
  const [bokehShape, setBokehShape] = useState<'circular' | 'sevenBlade' | 'nineBlade' | 'anamorphic' | 'catEyeSwirl'>('circular');
  const [focalDistance, setFocalDistance] = useState<number>(85);
  const [depthRange, setDepthRange] = useState<number>(20);
  const [specularBoost, setSpecularBoost] = useState<number>(50);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [result, setResult] = useState<BokehResult | null>(null);

  const setEditor = useEditorStore((state) => state.setEditor);

  useEffect(() => {
    if (isOpen) {
      runBokehSimulation(aperture, bokehShape, specularBoost, focalDistance, depthRange);
    }
  }, [isOpen]);

  const runBokehSimulation = async (fStop: number, shape: string, spec: number, focusDist: number, dRange: number) => {
    setIsProcessing(true);
    try {
      const res = await invoke<BokehResult>('simulate_optical_bokeh', {
        apertureFStop: fStop,
        bokehShape: shape,
        specularBoost: spec,
        focalDistance: focusDist / 100,
        depthRange: dRange / 100,
      });
      setResult(res);
    } catch (err) {
      console.error('Bokeh simulation failed:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleApertureChange = (newFStop: number) => {
    setAperture(newFStop);
    runBokehSimulation(newFStop, bokehShape, specularBoost, focalDistance, depthRange);
  };

  const handleShapeChange = (shape: 'circular' | 'sevenBlade' | 'nineBlade' | 'anamorphic' | 'catEyeSwirl') => {
    setBokehShape(shape);
    runBokehSimulation(aperture, shape, specularBoost, focalDistance, depthRange);
  };

  const handleFocalDistChange = (newDist: number) => {
    setFocalDistance(newDist);
    runBokehSimulation(aperture, bokehShape, specularBoost, newDist, depthRange);
  };

  const handleDepthRangeChange = (newRange: number) => {
    setDepthRange(newRange);
    runBokehSimulation(aperture, bokehShape, specularBoost, focalDistance, newRange);
  };

  const handleSpecularChange = (newSpec: number) => {
    setSpecularBoost(newSpec);
    runBokehSimulation(aperture, bokehShape, newSpec, focalDistance, depthRange);
  };

  const handleApplyToActive = () => {
    if (result?.preview_base64) {
      setEditor({
        finalPreviewUrl: result.preview_base64,
      });
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
          className="relative w-full max-w-[700px] bg-surface rounded-xl border border-border-color shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-color">
            <div className="flex items-center gap-2">
              <Aperture className="text-amber-400" size={20} />
              <Text variant={TextVariants.heading} weight={TextWeights.semibold}>
                Optical AI Bokeh & Depth Simulator
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
          <div className="p-6 flex flex-col md:flex-row gap-6 text-text-primary overflow-y-auto">
            {/* Left: Preview */}
            <div className="w-full md:w-1/2 flex flex-col gap-3">
              <div className="relative aspect-square w-full rounded-lg overflow-hidden border border-border-color bg-black/40 flex items-center justify-center">
                {result?.preview_base64 ? (
                  <img
                    src={result.preview_base64}
                    alt="Optical Bokeh Simulation"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center text-text-secondary gap-2 p-4 text-center">
                    <Loader2 size={24} className="animate-spin text-accent" />
                    <span className="text-xs">Simulating optical depth-of-field...</span>
                  </div>
                )}

                {isProcessing && (
                  <div className="absolute inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center">
                    <Loader2 size={24} className="animate-spin text-accent" />
                  </div>
                )}
              </div>

              {result && (
                <div className="flex items-center justify-between text-[11px] text-text-secondary px-1">
                  <span>Simulated: <b className="text-amber-400 font-mono">{result.aperture_simulated}</b></span>
                  <span>Highlights: <b className="text-accent font-mono">{result.specular_highlights_detected} pts</b></span>
                </div>
              )}
            </div>

            {/* Right: Optical Controls */}
            <div className="w-full md:w-1/2 flex flex-col gap-4">
              {/* Aperture F-Stop Selector */}
              <div className="flex flex-col gap-1.5">
                <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                  Lens Aperture (Depth of Field):
                </Text>
                <div className="grid grid-cols-5 gap-1">
                  {[1.2, 1.4, 2.0, 2.8, 4.0].map((f) => (
                    <button
                      key={f}
                      onClick={() => handleApertureChange(f)}
                      className={clsx(
                        'py-1.5 px-1 rounded-md text-xs font-mono font-medium border transition-all',
                        aperture === f
                          ? 'bg-amber-500/20 border-amber-500/60 text-amber-300 shadow-xs'
                          : 'bg-bg-secondary border-border-color text-text-secondary hover:text-text-primary'
                      )}
                    >
                      f/{f.toFixed(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Focal Plane Distance */}
              <div className="flex flex-col gap-1">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-text-secondary">Focal Plane Focus Depth:</span>
                  <span className="font-mono text-amber-400 font-medium">{focalDistance}%</span>
                </div>
                <Slider
                  label=""
                  min={0}
                  max={100}
                  step={1}
                  value={focalDistance}
                  onChange={(e: any) => handleFocalDistChange(Number(e.target.value))}
                />
              </div>

              {/* Depth of Field Falloff Range */}
              <div className="flex flex-col gap-1">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-text-secondary">DoF In-Focus Range:</span>
                  <span className="font-mono text-accent font-medium">±{depthRange}%</span>
                </div>
                <Slider
                  label=""
                  min={5}
                  max={80}
                  step={1}
                  value={depthRange}
                  onChange={(e: any) => handleDepthRangeChange(Number(e.target.value))}
                />
              </div>

              {/* Bokeh Diaphragm Geometry */}
              <div className="flex flex-col gap-1.5">
                <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                  Aperture Diaphragm Geometry:
                </Text>
                <div className="flex flex-col gap-1.5">
                  {[
                    { id: 'circular', label: '⭕ Circular', desc: 'Silky smooth spherical prime lens falloff' },
                    { id: 'sevenBlade', label: '⬡ 7-Blade Iris', desc: 'Classic vintage lens polygonal bokeh' },
                    { id: 'nineBlade', label: '⬢ 9-Blade Polygon', desc: 'Modern high-end prime lens diaphragm' },
                    { id: 'anamorphic', label: '🥚 Anamorphic Oval', desc: 'Cinematic widescreen 2x squeeze' },
                    { id: 'catEyeSwirl', label: '🌀 Cat-Eye Swirl', desc: 'Peripheral vintage optical vignetting' },
                  ].map((item) => (
                    <button
                      key={item.id}
                      onClick={() => handleShapeChange(item.id as any)}
                      className={clsx(
                        'flex items-center justify-between p-2.5 rounded-lg border text-left transition-all',
                        bokehShape === item.id
                          ? 'bg-accent/15 border-accent text-accent font-medium'
                          : 'bg-bg-secondary border-border-color text-text-secondary hover:text-text-primary'
                      )}
                    >
                      <div>
                        <div className="text-xs font-medium">{item.label}</div>
                        <div className="text-[10px] text-text-secondary opacity-80">{item.desc}</div>
                      </div>
                      {bokehShape === item.id && <Check size={14} className="shrink-0 text-accent" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Specular Highlight Boost */}
              <div className="flex flex-col gap-1">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-text-secondary flex items-center gap-1">
                    <Sparkles size={13} className="text-amber-400" />
                    Specular Bokeh Ball Boost:
                  </span>
                  <span className="font-mono text-accent font-medium">{specularBoost}%</span>
                </div>
                <Slider
                  label=""
                  min={0}
                  max={100}
                  step={1}
                  value={specularBoost}
                  onChange={(e: any) => handleSpecularChange(Number(e.target.value))}
                />
              </div>
            </div>
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
            <Button onClick={handleApplyToActive} disabled={!result || isProcessing}>
              <Check size={16} className="mr-2 text-amber-300" />
              Apply Optical Bokeh
            </Button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default BokehModal;
