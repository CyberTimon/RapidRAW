import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Check, RotateCcw, Grid3X3, Eye, EyeOff, Info, LineChart, ZoomIn, ZoomOut, Maximize, Compass, Wand2, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Button from '../ui/Button';
import Slider from '../ui/Slider';
import throttle from 'lodash.throttle';
import { Adjustments } from '../../utils/adjustments';
import clsx from 'clsx';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';

interface GeometryParams {
  distortion: number;
  vertical: number;
  horizontal: number;
  rotate: number;
  aspect: number;
  scale: number;
  x_offset: number;
  y_offset: number;
  lens_distortion_amount: number;
  lens_vignette_amount: number;
  lens_tca_amount: number;
  lens_dist_k1: number;
  lens_dist_k2: number;
  lens_dist_k3: number;
  lens_model: number;
  tca_vr: number;
  tca_vb: number;
  vig_k1: number;
  vig_k2: number;
  vig_k3: number;
  lens_distortion_enabled: boolean;
  lens_tca_enabled: boolean;
  lens_vignette_enabled: boolean;
}

type TransformParams = Omit<
  GeometryParams,
  | 'lens_distortion_amount'
  | 'lens_vignette_amount'
  | 'lens_tca_amount'
  | 'lens_dist_k1'
  | 'lens_dist_k2'
  | 'lens_dist_k3'
  | 'lens_model'
  | 'tca_vr'
  | 'tca_vb'
  | 'vig_k1'
  | 'vig_k2'
  | 'vig_k3'
  | 'lens_distortion_enabled'
  | 'lens_tca_enabled'
  | 'lens_vignette_enabled'
>;

interface TransformModalProps {
  isOpen: boolean;
  onClose(): void;
  onApply(newParams: TransformParams): void;
  currentAdjustments: Adjustments;
}

const DEFAULT_PARAMS: TransformParams = {
  distortion: 0,
  vertical: 0,
  horizontal: 0,
  rotate: 0,
  aspect: 0,
  scale: 100,
  x_offset: 0,
  y_offset: 0,
};

const SLIDER_DIVISOR = 100.0;

const CustomGrid = ({ denseVisible, ruleOfThirdsVisible }: { denseVisible: boolean; ruleOfThirdsVisible: boolean }) => (
  <div className="absolute inset-0 pointer-events-none w-full h-full z-10">
    <div
      className={clsx(
        'absolute inset-0 w-full h-full transition-opacity duration-300 ease-in-out',
        ruleOfThirdsVisible ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div className="absolute top-0 bottom-0 border-l border-white/40 left-1/3" />
      <div className="absolute top-0 bottom-0 border-l border-white/40 left-2/3" />
      <div className="absolute left-0 right-0 border-t border-white/40 top-1/3" />
      <div className="absolute left-0 right-0 border-t border-white/40 top-2/3" />
    </div>

    <div
      className={clsx(
        'absolute inset-0 w-full h-full transition-opacity duration-500 ease-in-out',
        denseVisible ? 'opacity-100' : 'opacity-0',
      )}
    >
      {[...Array(17)].map((_, i) => (
        <div
          key={`v-${i}`}
          className="absolute top-0 bottom-0 border-l border-white/40"
          style={{ left: `${(i + 1) * 5.555}%` }}
        />
      ))}
      {[...Array(17)].map((_, i) => (
        <div
          key={`h-${i}`}
          className="absolute left-0 right-0 border-t border-white/40"
          style={{ top: `${(i + 1) * 5.555}%` }}
        />
      ))}
    </div>
  </div>
);

export default function TransformModal({ isOpen, onClose, onApply, currentAdjustments }: TransformModalProps) {
  const { t } = useTranslation();
  const [params, setParams] = useState<TransformParams>(DEFAULT_PARAMS);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showLines, setShowLines] = useState(false);
  const [isCompareActive, setIsCompareActive] = useState(false);
  const [isInteracting, setIsInteracting] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const lastMousePos = useRef({ x: 0, y: 0 });

  // Guided Upright State
  const [isGuidedActive, setIsGuidedActive] = useState(false);
  const [guidedLines, setGuidedLines] = useState<Array<{ id: string; x1: number; y1: number; x2: number; y2: number; orientation: 'vertical' | 'horizontal' }>>([]);
  const [currentLine, setCurrentLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [isSolvingUpright, setIsSolvingUpright] = useState(false);

  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isDragging) return;
    const handleWindowMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - lastMousePos.current.x;
      const dy = e.clientY - lastMousePos.current.y;
      setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    };
    const handleWindowMouseUp = () => setIsDragging(false);
    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    const handleDragEndGlobal = () => {
      if (isInteracting) setIsInteracting(false);
    };

    if (isInteracting) {
      window.addEventListener('mouseup', handleDragEndGlobal);
      window.addEventListener('touchend', handleDragEndGlobal);
    }

    return () => {
      window.removeEventListener('mouseup', handleDragEndGlobal);
      window.removeEventListener('touchend', handleDragEndGlobal);
    };
  }, [isInteracting]);

  const handleInteractionStart = useCallback(() => {
    setIsInteracting(true);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - rect.width / 2;
    const mouseY = e.clientY - rect.top - rect.height / 2;
    const delta = -e.deltaY * 0.001;
    const newZoom = Math.min(Math.max(0.1, zoom + delta), 8);
    const scaleRatio = newZoom / zoom;
    const mouseFromCenterX = mouseX - pan.x;
    const mouseFromCenterY = mouseY - pan.y;
    const newPanX = mouseX - mouseFromCenterX * scaleRatio;
    const newPanY = mouseY - mouseFromCenterY * scaleRatio;
    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  };

  const handleResetZoom = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const updatePreview = useCallback(
    throttle(async (currentParams: TransformParams, linesEnabled: boolean) => {
      try {
        const fullParams: GeometryParams = {
          ...currentParams,
          lens_distortion_amount: (currentAdjustments.lensDistortionAmount ?? 100) / SLIDER_DIVISOR,
          lens_vignette_amount: (currentAdjustments.lensVignetteAmount ?? 100) / SLIDER_DIVISOR,
          lens_tca_amount: (currentAdjustments.lensTcaAmount ?? 100) / SLIDER_DIVISOR,
          lens_dist_k1: currentAdjustments.lensDistortionParams?.k1 ?? 0,
          lens_dist_k2: currentAdjustments.lensDistortionParams?.k2 ?? 0,
          lens_dist_k3: currentAdjustments.lensDistortionParams?.k3 ?? 0,
          lens_model: currentAdjustments.lensDistortionParams?.model ?? 0,
          tca_vr: currentAdjustments.lensDistortionParams?.tca_vr ?? 1.0,
          tca_vb: currentAdjustments.lensDistortionParams?.tca_vb ?? 1.0,
          vig_k1: currentAdjustments.lensDistortionParams?.vig_k1 ?? 0,
          vig_k2: currentAdjustments.lensDistortionParams?.vig_k2 ?? 0,
          vig_k3: currentAdjustments.lensDistortionParams?.vig_k3 ?? 0,
          lens_distortion_enabled: currentAdjustments.lensDistortionEnabled ?? true,
          lens_tca_enabled: currentAdjustments.lensTcaEnabled ?? true,
          lens_vignette_enabled: currentAdjustments.lensVignetteEnabled ?? true,
        };

        const result: string = await invoke('preview_geometry_transform', {
          params: fullParams,
          jsAdjustments: currentAdjustments,
          showLines: linesEnabled,
        });
        setPreviewUrl(result);
      } catch (e) {
        console.error('Preview transform failed', e);
      }
    }, 30),
    [currentAdjustments],
  );

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      const initParams = {
        distortion: currentAdjustments.transformDistortion ?? 0,
        vertical: currentAdjustments.transformVertical ?? 0,
        horizontal: currentAdjustments.transformHorizontal ?? 0,
        rotate: currentAdjustments.transformRotate ?? 0,
        aspect: currentAdjustments.transformAspect ?? 0,
        scale: currentAdjustments.transformScale ?? 100,
        x_offset: currentAdjustments.transformXOffset ?? 0,
        y_offset: currentAdjustments.transformYOffset ?? 0,
      };
      setParams(initParams);
      setShowLines(false);
      handleResetZoom();
      updatePreview(initParams, false);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setPreviewUrl(null);
        setIsApplying(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen, currentAdjustments]);

  const handleChange = (key: keyof typeof DEFAULT_PARAMS, value: number) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    updatePreview(newParams, showLines);
  };

  const handleApply = () => {
    setIsApplying(true);
    try {
      onApply(params);
      onClose();
    } catch (e) {
      console.error('Failed to apply transform', e);
      setIsApplying(false);
    }
  };

  const handleReset = () => {
    setParams(DEFAULT_PARAMS);
    setGuidedLines([]);
    updatePreview(DEFAULT_PARAMS, showLines);
  };

  const handleAutoHorizon = async () => {
    try {
      const angle = await invoke<number>('detect_auto_horizon');
      if (typeof angle === 'number' && !isNaN(angle)) {
        const rounded = Math.round(angle * 10) / 10;
        handleChange('rotate', rounded);
      }
    } catch (e) {
      console.error('Failed to detect auto horizon', e);
    }
  };

  const handleSolveUpright = async () => {
    if (guidedLines.length === 0) return;
    setIsSolvingUpright(true);
    try {
      const result = await invoke<{
        vertical: number;
        horizontal: number;
        rotate: number;
        aspect: number;
        scale: number;
      }>('solve_guided_upright', {
        lines: guidedLines.map((l) => ({
          x1: l.x1,
          y1: l.y1,
          x2: l.x2,
          y2: l.y2,
          orientation: l.orientation,
        })),
        width: 1920,
        height: 1080,
      });

      const newParams = {
        ...params,
        vertical: result.vertical,
        horizontal: result.horizontal,
        rotate: result.rotate,
        scale: result.scale,
      };
      setParams(newParams);
      updatePreview(newParams, showLines);
    } catch (e) {
      console.error('Failed to solve guided upright', e);
    } finally {
      setIsSolvingUpright(false);
    }
  };

  const handleShowLinesToggle = () => {
    const newShowLines = !showLines;
    setShowLines(newShowLines);
    updatePreview(params, newShowLines);
  };

  const toggleCompare = async (active: boolean) => {
    setIsCompareActive(active);
    if (active) {
      const fullParams: GeometryParams = {
        ...DEFAULT_PARAMS,
        lens_distortion_amount: (currentAdjustments.lensDistortionAmount ?? 100) / SLIDER_DIVISOR,
        lens_vignette_amount: (currentAdjustments.lensVignetteAmount ?? 100) / SLIDER_DIVISOR,
        lens_tca_amount: (currentAdjustments.lensTcaAmount ?? 100) / SLIDER_DIVISOR,
        lens_dist_k1: currentAdjustments.lensDistortionParams?.k1 ?? 0,
        lens_dist_k2: currentAdjustments.lensDistortionParams?.k2 ?? 0,
        lens_dist_k3: currentAdjustments.lensDistortionParams?.k3 ?? 0,
        lens_model: currentAdjustments.lensDistortionParams?.model ?? 0,
        tca_vr: currentAdjustments.lensDistortionParams?.tca_vr ?? 1.0,
        tca_vb: currentAdjustments.lensDistortionParams?.tca_vb ?? 1.0,
        vig_k1: currentAdjustments.lensDistortionParams?.vig_k1 ?? 0,
        vig_k2: currentAdjustments.lensDistortionParams?.vig_k2 ?? 0,
        vig_k3: currentAdjustments.lensDistortionParams?.vig_k3 ?? 0,
        lens_distortion_enabled: currentAdjustments.lensDistortionEnabled ?? true,
        lens_tca_enabled: currentAdjustments.lensTcaEnabled ?? true,
        lens_vignette_enabled: currentAdjustments.lensVignetteEnabled ?? true,
      };
      const result: string = await invoke('preview_geometry_transform', {
        params: fullParams,
        jsAdjustments: currentAdjustments,
        showLines: false,
      });
      setPreviewUrl(result);
    } else {
      updatePreview(params, showLines);
    }
  };

  const renderControls = () => (
    <div className="modal-adjustments-pane w-80 shrink-0 bg-bg-secondary flex flex-col border-l border-surface h-full z-10">
      <div className="p-4 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('modals.transform.title')}</Text>
        <button
          onClick={handleReset}
          data-tooltip={t('modals.transform.resetTooltip')}
          className="p-2 rounded-full hover:bg-surface transition-colors"
        >
          <RotateCcw size={18} />
        </button>
      </div>

      <div className="grow overflow-y-auto p-4 flex flex-col gap-6" onPointerDownCapture={handleInteractionStart}>
        {/* Guided Upright & Auto Horizon Card */}
        <div className="p-3 bg-bg-tertiary rounded-xl border border-surface flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-text-primary flex items-center gap-1.5">
              <Compass size={14} className="text-accent" />
              Guided Upright Solver
            </span>
            <button
              type="button"
              onClick={() => setIsGuidedActive(!isGuidedActive)}
              className={clsx(
                'px-2.5 py-1 rounded-full text-xs font-bold transition-all border cursor-pointer',
                isGuidedActive
                  ? 'bg-accent text-white border-accent shadow-sm'
                  : 'bg-surface text-text-secondary border-surface hover:text-white',
              )}
            >
              {isGuidedActive ? 'Guides: ON' : 'Guides: OFF'}
            </button>
          </div>

          <span className="text-[11px] text-text-secondary leading-tight">
            Draw vertical lines on walls & horizontal lines on level edges to calculate perspective homography.
          </span>

          <div className="flex items-center justify-between text-xs font-mono text-text-secondary">
            <span>Guides: {guidedLines.length} / 4</span>
            {guidedLines.length > 0 && (
              <button
                type="button"
                onClick={() => setGuidedLines([])}
                className="text-[11px] text-red-400 hover:underline cursor-pointer"
              >
                Clear Guides
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={handleAutoHorizon}
              className="w-full text-xs font-medium"
            >
              <Wand2 size={13} className="mr-1 text-accent" />
              Auto Level
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={handleSolveUpright}
              disabled={guidedLines.length === 0 || isSolvingUpright}
              className="w-full text-xs font-bold"
            >
              <Sparkles size={13} className="mr-1" />
              Solve Upright
            </Button>
          </div>
        </div>

        <div>
          <Text variant={TextVariants.heading} className="mb-2">
            {t('modals.transform.distortion')}
          </Text>
          <div className="space-y-3">
            <Slider
              label={t('modals.transform.amount')}
              value={params.distortion}
              min={-100}
              max={100}
              defaultValue={0}
              step={1}
              onChange={(e) => handleChange('distortion', Number(e.target.value))}
            />
          </div>
        </div>

        <div>
          <Text variant={TextVariants.heading} className="mb-2">
            {t('modals.transform.perspective')}
          </Text>
          <div className="space-y-3">
            <Slider
              label={t('modals.transform.vertical')}
              value={params.vertical}
              min={-100}
              max={100}
              defaultValue={0}
              step={1}
              onChange={(e) => handleChange('vertical', Number(e.target.value))}
            />
            <Slider
              label={t('modals.transform.horizontal')}
              value={params.horizontal}
              min={-100}
              max={100}
              defaultValue={0}
              step={1}
              onChange={(e) => handleChange('horizontal', Number(e.target.value))}
            />
          </div>
        </div>

        <div>
          <Text variant={TextVariants.heading} className="mb-2">
            {t('modals.transform.title')}
          </Text>
          <div className="space-y-3">
            <Slider
              label={t('modals.transform.rotate')}
              value={params.rotate}
              min={-45}
              max={45}
              step={0.1}
              defaultValue={0}
              onChange={(e) => handleChange('rotate', Number(e.target.value))}
            />
            <Slider
              label={t('modals.transform.aspect')}
              value={params.aspect}
              min={-100}
              max={100}
              defaultValue={0}
              step={1}
              onChange={(e) => handleChange('aspect', Number(e.target.value))}
            />
            <Slider
              label={t('modals.transform.scale')}
              value={params.scale}
              min={50}
              max={150}
              defaultValue={100}
              step={1}
              onChange={(e) => handleChange('scale', Number(e.target.value))}
            />
          </div>
        </div>

        <div>
          <Text variant={TextVariants.heading} className="mb-2">
            {t('modals.transform.offset')}
          </Text>
          <div className="space-y-3">
            <Slider
              label={t('modals.transform.xAxis')}
              value={params.x_offset}
              min={-100}
              max={100}
              defaultValue={0}
              step={1}
              onChange={(e) => handleChange('x_offset', Number(e.target.value))}
            />
            <Slider
              label={t('modals.transform.yAxis')}
              value={params.y_offset}
              min={-100}
              max={100}
              defaultValue={0}
              step={1}
              onChange={(e) => handleChange('y_offset', Number(e.target.value))}
            />
          </div>
        </div>

        <div className="mt-auto">
          {currentAdjustments.masks && currentAdjustments.masks.length > 0 && (
            <Text
              as="div"
              variant={TextVariants.small}
              className="p-3 bg-surface rounded-md border border-surface flex items-center gap-3"
            >
              <Info size={16} className="shrink-0" />
              <p className="leading-relaxed">{t('modals.transform.maskWarning')}</p>
            </Text>
          )}
        </div>
      </div>
    </div>
  );

  const imageTransformStyle = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transition: isDragging ? 'none' : 'transform 0.1s ease-out',
    transformOrigin: 'center center',
  };

  const renderContent = () => (
    <div className="modal-preview-adjustments flex flex-row h-full w-full overflow-hidden">
      <div className="modal-preview-pane grow flex flex-col relative min-h-0 bg-[#0f0f0f] overflow-hidden">
        <div
          ref={containerRef}
          className="flex-1 relative overflow-hidden cursor-grab active:cursor-grabbing select-none"
          onMouseDown={handleMouseDown}
          onWheel={handleWheel}
        >
          <div
            className="absolute inset-0 opacity-20 pointer-events-none"
            style={{
              backgroundImage: 'radial-gradient(#444 1px, transparent 1px)',
              backgroundSize: '24px 24px',
            }}
          ></div>

          {previewUrl && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="origin-center" style={imageTransformStyle}>
                <div className="relative inline-block shadow-2xl">
                  <img
                    ref={imageRef}
                    src={previewUrl}
                    className="block object-contain"
                    style={{
                      maxWidth: '100%',
                      maxHeight: '100%',
                      width: 'auto',
                      height: 'auto',
                    }}
                    alt="Transform Preview"
                    draggable={false}
                  />

                  {!isCompareActive && (
                    <CustomGrid ruleOfThirdsVisible={showGrid} denseVisible={showGrid && isInteracting} />
                  )}

                  {/* Guided Lines Interactive Drawing Layer */}
                  {isGuidedActive && (
                    <svg
                      className="absolute inset-0 w-full h-full cursor-crosshair z-30 pointer-events-auto select-none"
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                        const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
                        setCurrentLine({ x1: x, y1: y, x2: x, y2: y });
                      }}
                      onMouseMove={(e) => {
                        if (!currentLine) return;
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                        const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
                        setCurrentLine((prev) => (prev ? { ...prev, x2: x, y2: y } : null));
                      }}
                      onMouseUp={(e) => {
                        if (!currentLine) return;
                        e.stopPropagation();
                        const dx = Math.abs(currentLine.x2 - currentLine.x1);
                        const dy = Math.abs(currentLine.y2 - currentLine.y1);
                        const length = Math.sqrt(dx * dx + dy * dy);
                        if (length > 0.03 && guidedLines.length < 4) {
                          const orientation = dy >= dx ? 'vertical' : 'horizontal';
                          setGuidedLines((prev) => [
                            ...prev,
                            {
                              id: `guide-${Date.now()}-${Math.random()}`,
                              ...currentLine,
                              orientation,
                            },
                          ]);
                        }
                        setCurrentLine(null);
                      }}
                    >
                      {/* Render Drawn Guided Lines */}
                      {guidedLines.map((line) => {
                        const isVert = line.orientation === 'vertical';
                        const strokeColor = isVert ? '#06b6d4' : '#f59e0b';
                        return (
                          <g key={line.id}>
                            <line
                              x1={`${line.x1 * 100}%`}
                              y1={`${line.y1 * 100}%`}
                              x2={`${line.x2 * 100}%`}
                              y2={`${line.y2 * 100}%`}
                              stroke={strokeColor}
                              strokeWidth="3"
                              strokeDasharray="4 3"
                            />
                            <circle cx={`${line.x1 * 100}%`} cy={`${line.y1 * 100}%`} r="6" fill={strokeColor} stroke="#ffffff" strokeWidth="1.5" />
                            <circle cx={`${line.x2 * 100}%`} cy={`${line.y2 * 100}%`} r="6" fill={strokeColor} stroke="#ffffff" strokeWidth="1.5" />
                          </g>
                        );
                      })}

                      {/* Current Drawing Line */}
                      {currentLine && (
                        <g>
                          <line
                            x1={`${currentLine.x1 * 100}%`}
                            y1={`${currentLine.y1 * 100}%`}
                            x2={`${currentLine.x2 * 100}%`}
                            y2={`${currentLine.y2 * 100}%`}
                            stroke="#38bdf8"
                            strokeWidth="2.5"
                            strokeDasharray="2 2"
                          />
                          <circle cx={`${currentLine.x1 * 100}%`} cy={`${currentLine.y1 * 100}%`} r="5" fill="#38bdf8" stroke="#ffffff" strokeWidth="1" />
                          <circle cx={`${currentLine.x2 * 100}%`} cy={`${currentLine.y2 * 100}%`} r="5" fill="#38bdf8" stroke="#ffffff" strokeWidth="1" />
                        </g>
                      )}
                    </svg>
                  )}

                  {isCompareActive && (
                    <Text
                      as="div"
                      variant={TextVariants.small}
                      color={TextColors.button}
                      className="absolute top-4 left-4 bg-accent px-2 py-1 rounded-sm shadow-lg z-20"
                    >
                      {t('modals.transform.original')}
                    </Text>
                  )}
                </div>
              </div>
            </div>
          )}

          <div
            className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-black/70 backdrop-blur-md p-1.5 rounded-full border border-white/10 shadow-xl z-20 pointer-events-auto"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setShowGrid(!showGrid)}
              className={clsx(
                'p-2 rounded-full transition-colors',
                showGrid ? 'bg-white/20 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white',
              )}
              data-tooltip={t('modals.transform.toggleGridTooltip')}
            >
              <Grid3X3 size={18} />
            </button>
            <button
              onClick={handleShowLinesToggle}
              className={clsx(
                'p-2 rounded-full transition-colors',
                showLines ? 'bg-white/20 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white',
              )}
              data-tooltip={t('modals.transform.toggleHelperLinesTooltip')}
            >
              <LineChart size={18} />
            </button>

            <div className="w-px h-5 bg-white/20 mx-1"></div>

            <button
              onClick={() => setZoom((z) => Math.max(0.1, z - 0.25))}
              className="p-2 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors"
              data-tooltip={t('modals.transform.zoomOutTooltip')}
            >
              <ZoomOut size={18} />
            </button>

            <span className="text-xs font-mono text-white/90 w-12 text-center select-none pointer-events-none">
              {Math.round(zoom * 100)}%
            </span>

            <button
              onClick={() => setZoom((z) => Math.min(8, z + 0.25))}
              className="p-2 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors"
              data-tooltip={t('modals.transform.zoomInTooltip')}
            >
              <ZoomIn size={18} />
            </button>

            <button
              onClick={handleResetZoom}
              className="p-2 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors"
              data-tooltip={t('modals.transform.resetZoomTooltip')}
            >
              <Maximize size={16} />
            </button>

            <div className="w-px h-5 bg-white/20 mx-1"></div>

            <button
              onMouseDown={() => toggleCompare(true)}
              onMouseUp={() => toggleCompare(false)}
              onMouseLeave={() => toggleCompare(false)}
              className={clsx(
                'p-2 rounded-full transition-colors select-none',
                isCompareActive ? 'bg-accent text-button-text' : 'text-white/60 hover:bg-white/10 hover:text-white',
              )}
              data-tooltip={t('modals.transform.compareTooltip')}
            >
              {isCompareActive ? <Eye size={18} /> : <EyeOff size={18} />}
            </button>
          </div>
        </div>
      </div>
      {renderControls()}
    </div>
  );

  if (!isMounted) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs transition-opacity duration-300 ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onMouseDown={onClose}
    >
      <AnimatePresence>
        {show && (
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="bg-surface rounded-lg shadow-xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="grow min-h-0 overflow-hidden">{renderContent()}</div>
            <div className="shrink-0 p-4 flex justify-end gap-3 border-t border-surface bg-bg-secondary z-20">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
              >
                {t('modals.transform.cancel')}
              </button>
              <Button onClick={handleApply} disabled={isApplying || !previewUrl}>
                <Check className="mr-2" size={16} />
                {t('modals.transform.apply')}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
