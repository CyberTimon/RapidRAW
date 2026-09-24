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
  const [activeTab, setActiveTab] = useState<'bokeh' | 'tiltShift'>('bokeh');

  // Optical Bokeh parameters
  const [aperture, setAperture] = useState<number>(1.4);
  const [bokehShape, setBokehShape] = useState<'circular' | 'sevenBlade' | 'nineBlade' | 'anamorphic' | 'catEyeSwirl'>('circular');
  const [focalDistance, setFocalDistance] = useState<number>(85);
  const [depthRange, setDepthRange] = useState<number>(20);
  const [specularBoost, setSpecularBoost] = useState<number>(50);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [result, setResult] = useState<BokehResult | null>(null);

  // Tilt-Shift parameters
  const [tiltCenterY, setTiltCenterY] = useState<number>(50);
  const [tiltBandHeight, setTiltBandHeight] = useState<number>(25);
  const [tiltAngle, setTiltAngle] = useState<number>(0);
  const [tiltBlur, setTiltBlur] = useState<number>(24);
  const [tiltSpecular, setTiltSpecular] = useState<number>(40);
  const [tiltResultB64, setTiltResultB64] = useState<string | null>(null);

  const setEditor = useEditorStore((state) => state.setEditor);

  useEffect(() => {
    if (isOpen) {
      if (activeTab === 'bokeh') {
        runBokehSimulation(aperture, bokehShape, specularBoost, focalDistance, depthRange);
      } else {
        runTiltShiftSimulation(tiltCenterY, tiltBandHeight, tiltAngle, tiltBlur, tiltSpecular);
      }
    }
  }, [isOpen, activeTab]);

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

  const runTiltShiftSimulation = async (cy: number, band: number, angle: number, blur: number, spec: number) => {
    setIsProcessing(true);
    try {
      const resB64 = await invoke<string>('simulate_tilt_shift', {
        centerYNorm: cy / 100,
        bandHeightNorm: band / 100,
        angleDeg: angle,
        blurAmount: blur,
        specularBoost: spec,
      });
      setTiltResultB64(resB64);
    } catch (err) {
      console.error('Tilt-Shift simulation failed:', err);
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

  const handleTiltCenterChange = (newCy: number) => {
    setTiltCenterY(newCy);
    runTiltShiftSimulation(newCy, tiltBandHeight, tiltAngle, tiltBlur, tiltSpecular);
  };

  const handleTiltBandChange = (newBand: number) => {
    setTiltBandHeight(newBand);
    runTiltShiftSimulation(tiltCenterY, newBand, tiltAngle, tiltBlur, tiltSpecular);
  };

  const handleTiltAngleChange = (newAngle: number) => {
    setTiltAngle(newAngle);
    runTiltShiftSimulation(tiltCenterY, tiltBandHeight, newAngle, tiltBlur, tiltSpecular);
  };

  const handleTiltBlurChange = (newBlur: number) => {
    setTiltBlur(newBlur);
    runTiltShiftSimulation(tiltCenterY, tiltBandHeight, tiltAngle, newBlur, tiltSpecular);
  };

  const handleTiltSpecularChange = (newSpec: number) => {
    setTiltSpecular(newSpec);
    runTiltShiftSimulation(tiltCenterY, tiltBandHeight, tiltAngle, tiltBlur, newSpec);
  };

  const handleApply = () => {
    if (activeTab === 'bokeh' && result?.preview_base64) {
      setEditor({
        finalPreviewUrl: result.preview_base64,
      });
      onClose();
    } else if (activeTab === 'tiltShift' && tiltResultB64) {
      setEditor((state) => ({
        adjustments: {
          ...state.adjustments,
          tiltShiftEnabled: true,
          tiltShiftCenterY: tiltCenterY / 100,
          tiltShiftBandHeight: tiltBandHeight / 100,
          tiltShiftAngleDeg: tiltAngle,
          tiltShiftBlurRadius: tiltBlur,
          tiltShiftSpecularBoost: tiltSpecular,
        },
        finalPreviewUrl: tiltResultB64,
      }));
      onClose();
    }
  };

  if (!isOpen) return null;

  const currentPreview = activeTab === 'bokeh' ? result?.preview_base64 : (tiltResultB64 || result?.preview_base64);

  // SVG guide line coordinates for Tilt-Shift
  const rad = (tiltAngle * Math.PI) / 180;
  const cosT = Math.cos(rad);
  const sinT = Math.sin(rad);
  const length = 70;
  const cx = 50;
  const cy = tiltCenterY;
  const x1 = cx - length * cosT;
  const y1 = cy - length * sinT;
  const x2 = cx + length * cosT;
  const y2 = cy + length * sinT;

  const halfBand = tiltBandHeight / 2;
  const normX = -sinT * halfBand;
  const normY = cosT * halfBand;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          className="relative w-full max-w-[740px] bg-surface rounded-xl border border-border-color shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-color">
            <div className="flex items-center gap-2">
              <Aperture className="text-amber-400" size={20} />
              <Text variant={TextVariants.heading} weight={TextWeights.semibold}>
                Creative Optics & Defocus Studio
              </Text>
            </div>
            <button
              onClick={onClose}
              className="text-text-secondary hover:text-text-primary transition-colors p-1 rounded-md cursor-pointer"
            >
              <X size={18} />
            </button>
          </div>

          {/* Mode Selector Tabs */}
          <div className="flex border-b border-border-color bg-bg-secondary/40 px-6 py-2 gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('bokeh')}
              className={clsx(
                'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer',
                activeTab === 'bokeh'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-xs'
                  : 'text-text-secondary hover:text-text-primary'
              )}
            >
              <Aperture size={14} />
              Optical AI Bokeh
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('tiltShift');
                if (!tiltResultB64) {
                  runTiltShiftSimulation(tiltCenterY, tiltBandHeight, tiltAngle, tiltBlur, tiltSpecular);
                }
              }}
              className={clsx(
                'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer',
                activeTab === 'tiltShift'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-xs'
                  : 'text-text-secondary hover:text-text-primary'
              )}
            >
              <Sliders size={14} />
              Scheimpflug Tilt-Shift
            </button>
          </div>

          {/* Body */}
          <div className="p-6 flex flex-col md:flex-row gap-6 text-text-primary overflow-y-auto">
            {/* Left: Interactive Preview Canvas */}
            <div className="w-full md:w-1/2 flex flex-col gap-3">
              <div className="relative aspect-square w-full rounded-lg overflow-hidden border border-border-color bg-black/40 flex items-center justify-center">
                {currentPreview ? (
                  <div className="relative w-full h-full">
                    <img
                      src={currentPreview}
                      alt="Optical Simulation"
                      className="w-full h-full object-contain"
                    />

                    {/* Tilt-Shift Scheimpflug Interactive Overlay Guides */}
                    {activeTab === 'tiltShift' && (
                      <svg
                        className="absolute inset-0 w-full h-full pointer-events-none"
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                      >
                        {/* Upper Boundary Line */}
                        <line
                          x1={x1 - normX}
                          y1={y1 - normY}
                          x2={x2 - normX}
                          y2={y2 - normY}
                          stroke="#38bdf8"
                          strokeWidth="1.2"
                          strokeDasharray="3,3"
                          strokeOpacity="0.8"
                        />
                        {/* Lower Boundary Line */}
                        <line
                          x1={x1 + normX}
                          y1={y1 + normY}
                          x2={x2 + normX}
                          y2={y2 + normY}
                          stroke="#38bdf8"
                          strokeWidth="1.2"
                          strokeDasharray="3,3"
                          strokeOpacity="0.8"
                        />
                        {/* Central In-Focus Plane Line */}
                        <line
                          x1={x1}
                          y1={y1}
                          x2={x2}
                          y2={y2}
                          stroke="#f59e0b"
                          strokeWidth="1.8"
                          strokeOpacity="0.9"
                        />
                        {/* Center Pivot Point */}
                        <circle cx={cx} cy={cy} r="2" fill="#f59e0b" />
                      </svg>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center text-text-secondary gap-2 p-4 text-center">
                    <Loader2 size={24} className="animate-spin text-accent" />
                    <span className="text-xs">Rendering optical preview...</span>
                  </div>
                )}

                {isProcessing && (
                  <div className="absolute inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center">
                    <Loader2 size={24} className="animate-spin text-accent" />
                  </div>
                )}
              </div>

              {activeTab === 'bokeh' && result && (
                <div className="flex items-center justify-between text-[11px] text-text-secondary px-1">
                  <span>Simulated: <b className="text-amber-400 font-mono">{result.aperture_simulated}</b></span>
                  <span>Highlights: <b className="text-accent font-mono">{result.specular_highlights_detected} pts</b></span>
                </div>
              )}

              {activeTab === 'tiltShift' && (
                <div className="flex items-center justify-between text-[11px] text-text-secondary px-1">
                  <span>Tilt Axis: <b className="text-amber-400 font-mono">{tiltAngle}°</b></span>
                  <span>Focus Depth: <b className="text-accent font-mono">±{Math.round(tiltBandHeight / 2)}%</b></span>
                </div>
              )}
            </div>

            {/* Right: Controls */}
            <div className="w-full md:w-1/2 flex flex-col gap-4">
              {activeTab === 'bokeh' ? (
                <>
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
                            'py-1.5 px-1 rounded-md text-xs font-mono font-medium border transition-all cursor-pointer',
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
                            'flex items-center justify-between p-2.5 rounded-lg border text-left transition-all cursor-pointer',
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
                </>
              ) : (
                <>
                  {/* Tilt-Shift Quick Snap Angles */}
                  <div className="flex flex-col gap-1.5">
                    <Text variant={TextVariants.small} weight={TextWeights.medium} color={TextColors.secondary}>
                      Tilt Axis Orientation:
                    </Text>
                    <div className="grid grid-cols-3 gap-1.5">
                      {[
                        { label: '0° Horizontal', angle: 0 },
                        { label: '45° Diagonal', angle: 45 },
                        { label: '90° Vertical', angle: 90 },
                      ].map((item) => (
                        <button
                          key={item.angle}
                          type="button"
                          onClick={() => handleTiltAngleChange(item.angle)}
                          className={clsx(
                            'py-1.5 px-1 rounded-md text-xs font-medium border transition-all cursor-pointer text-center',
                            tiltAngle === item.angle
                              ? 'bg-amber-500/20 border-amber-500/60 text-amber-300 shadow-xs'
                              : 'bg-bg-secondary border-border-color text-text-secondary hover:text-text-primary'
                          )}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Focal Plane Position (Y) */}
                  <div className="flex flex-col gap-1">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-text-secondary">Focal Plane Position (Center):</span>
                      <span className="font-mono text-amber-400 font-medium">{tiltCenterY}%</span>
                    </div>
                    <Slider
                      label=""
                      min={10}
                      max={90}
                      step={1}
                      value={tiltCenterY}
                      onChange={(e: any) => handleTiltCenterChange(Number(e.target.value))}
                    />
                  </div>

                  {/* Focal Band Height (Thickness) */}
                  <div className="flex flex-col gap-1">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-text-secondary">Sharp Focus Band Width:</span>
                      <span className="font-mono text-accent font-medium">{tiltBandHeight}%</span>
                    </div>
                    <Slider
                      label=""
                      min={5}
                      max={60}
                      step={1}
                      value={tiltBandHeight}
                      onChange={(e: any) => handleTiltBandChange(Number(e.target.value))}
                    />
                  </div>

                  {/* Arbitrary Rotation Angle */}
                  <div className="flex flex-col gap-1">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-text-secondary">Tilt Angle Rotation:</span>
                      <span className="font-mono text-amber-400 font-medium">{tiltAngle}°</span>
                    </div>
                    <Slider
                      label=""
                      min={-90}
                      max={90}
                      step={1}
                      value={tiltAngle}
                      onChange={(e: any) => handleTiltAngleChange(Number(e.target.value))}
                    />
                  </div>

                  {/* Defocus Blur Amount */}
                  <div className="flex flex-col gap-1">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-text-secondary">Defocus Blur Intensity:</span>
                      <span className="font-mono text-accent font-medium">{tiltBlur}px</span>
                    </div>
                    <Slider
                      label=""
                      min={4}
                      max={60}
                      step={1}
                      value={tiltBlur}
                      onChange={(e: any) => handleTiltBlurChange(Number(e.target.value))}
                    />
                  </div>

                  {/* Specular Highlight Bokeh Boost */}
                  <div className="flex flex-col gap-1">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-text-secondary flex items-center gap-1">
                        <Sparkles size={13} className="text-amber-400" />
                        Specular Bokeh Disc Boost:
                      </span>
                      <span className="font-mono text-accent font-medium">{tiltSpecular}%</span>
                    </div>
                    <Slider
                      label=""
                      min={0}
                      max={100}
                      step={1}
                      value={tiltSpecular}
                      onChange={(e: any) => handleTiltSpecularChange(Number(e.target.value))}
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end items-center gap-2 px-6 py-4 bg-bg-secondary/40 border-t border-border-color">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors text-sm cursor-pointer"
            >
              Cancel
            </button>
            <Button
              onClick={handleApply}
              disabled={(activeTab === 'bokeh' ? !result : !tiltResultB64) || isProcessing}
            >
              <Check size={16} className="mr-2 text-amber-300" />
              {activeTab === 'bokeh' ? 'Apply Optical Bokeh' : 'Apply Scheimpflug Tilt-Shift'}
            </Button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};

export default BokehModal;
