import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { RotateCcw, ZoomIn, ZoomOut, Maximize, Save, Loader2, Eye, EyeOff, Info } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Button from '../ui/Button';
import Slider from '../ui/Slider';
import clsx from 'clsx';
import throttle from 'lodash.throttle';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';

import { Pipette, Sparkles } from 'lucide-react';

interface NegativeParams {
  red_weight: number;
  green_weight: number;
  blue_weight: number;
  contrast: number;
  exposure: number;
  film_profile?: string;
  base_mask_r?: number;
  base_mask_g?: number;
  base_mask_b?: number;
  toe_compression?: number;
  shoulder_compression?: number;
  shadow_crossover?: number;
  highlight_crossover?: number;
}

const DEFAULT_PARAMS: NegativeParams = {
  red_weight: 1.0,
  green_weight: 1.0,
  blue_weight: 1.0,
  contrast: 1.0,
  exposure: 0.0,
  film_profile: 'portra_400',
  base_mask_r: 1.0,
  base_mask_g: 1.0,
  base_mask_b: 1.0,
  toe_compression: 0.0,
  shoulder_compression: 0.0,
  shadow_crossover: 0.0,
  highlight_crossover: 0.0,
};

interface NegativeConversionModalProps {
  isOpen: boolean;
  onClose(): void;
  targetPaths: string[];
  onSave(savedPaths: string[]): void;
}

export default function NegativeConversionModal({
  isOpen,
  onClose,
  targetPaths,
  onSave,
}: NegativeConversionModalProps) {
  const { t } = useTranslation();
  const [params, setParams] = useState<NegativeParams>(DEFAULT_PARAMS);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isCompareActive, setIsCompareActive] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const selectedImagePath = targetPaths.length > 0 ? targetPaths[0] : null;

  useEffect(() => {
    const unlisten = listen('negative-batch-progress', (e: any) => {
      setProgress(e.payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

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

  const updatePreview = useCallback(
    throttle(async (currentParams: NegativeParams, isInitialLoad: boolean = false) => {
      if (!selectedImagePath) return;
      try {
        const result: string = await invoke('preview_negative_conversion', {
          path: selectedImagePath,
          params: currentParams,
        });
        setPreviewUrl(result);
        if (isInitialLoad) {
          setIsLoading(false);
        }
      } catch (e) {
        console.error('Negative preview failed', e);
        if (isInitialLoad) {
          setIsLoading(false);
        }
      }
    }, 100),
    [selectedImagePath],
  );

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      setIsLoading(true);
      setTimeout(() => setShow(true), 10);
      updatePreview(DEFAULT_PARAMS, true);

      if (selectedImagePath) {
        invoke('generate_preview_for_path', {
          path: selectedImagePath,
          jsAdjustments: {},
        })
          .then((res: any) => {
            const blob = new Blob([new Uint8Array(res)], { type: 'image/jpeg' });
            setOriginalUrl(URL.createObjectURL(blob));
          })
          .catch(console.error);
      }
    } else {
      setShow(false);
      setTimeout(() => {
        setIsMounted(false);
        setPreviewUrl(null);
        setOriginalUrl(null);
        setParams(DEFAULT_PARAMS);
        setZoom(1);
        setPan({ x: 0, y: 0 });
        setIsLoading(true);
        setProgress(null);
      }, 300);
    }
  }, [isOpen, selectedImagePath, updatePreview]);

  const handleParamChange = (key: keyof NegativeParams, value: number) => {
    const newParams = { ...params, [key]: value };
    setParams(newParams);
    updatePreview(newParams);
  };

  const handleSave = async () => {
    if (targetPaths.length === 0) return;
    setIsSaving(true);
    setProgress(null);
    try {
      const savedPaths: string[] = await invoke('convert_negatives', {
        paths: targetPaths,
        params,
      });
      onSave(savedPaths);
      onClose();
    } catch (e) {
      console.error('Failed to batch save negatives', e);
    } finally {
      setIsSaving(false);
      setProgress(null);
    }
  };

  const imageTransformStyle = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transition: isDragging ? 'none' : 'transform 0.1s ease-out',
    transformOrigin: 'center center',
  };

  const renderControls = () => (
    <div className="modal-adjustments-pane w-80 shrink-0 bg-bg-secondary flex flex-col border-l border-surface h-full z-10">
      <div className="p-4 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('modals.negativeConversion.title')}</Text>
        <button
          onClick={() => {
            setParams(DEFAULT_PARAMS);
            updatePreview(DEFAULT_PARAMS);
          }}
          disabled={isSaving}
          data-tooltip={t('modals.negativeConversion.resetTooltip')}
          className="p-2 rounded-full hover:bg-surface transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RotateCcw size={18} />
        </button>
      </div>

      <div className="grow overflow-y-auto p-4 flex flex-col gap-6">
        {/* Film Emulsion Stock */}
        <div className={clsx('transition-opacity duration-200', isSaving && 'opacity-50 pointer-events-none grayscale')}>
          <div className="flex items-center justify-between mb-2">
            <Text variant={TextVariants.heading} className="flex items-center gap-1.5">
              <Sparkles size={14} className="text-amber-400" />
              Film Stock Profile
            </Text>
          </div>
          <select
            value={params.film_profile || 'portra_400'}
            onChange={(e) => {
              const newParams = { ...params, film_profile: e.target.value };
              setParams(newParams);
              updatePreview(newParams);
            }}
            className="w-full bg-surface border border-border-color text-text-primary text-xs rounded-lg px-3 py-2 outline-hidden focus:border-accent"
          >
            <option value="portra_400">🎞️ Kodak Portra 400 (Golden Skin Tones)</option>
            <option value="portra_160">🎞️ Kodak Portra 160 (Fine Grain Portrait)</option>
            <option value="portra_800">🎞️ Kodak Portra 800 (Rich Warmth)</option>
            <option value="ektar_100">🎞️ Kodak Ektar 100 (Vivid Landscape)</option>
            <option value="gold_200">🎞️ Kodak Gold 200 (Vintage Warm)</option>
            <option value="fuji_400h">🎞️ Fujifilm Pro 400H (Pastel Greens/Cyan)</option>
            <option value="fuji_superia">🎞️ Fujifilm Superia 400 (Vibrant)</option>
            <option value="cinestill_800t">🎬 CineStill 800T (Tungsten Cinema)</option>
            <option value="ilford_hp5">⚪ Ilford HP5 Plus (Classic Silver B&W)</option>
            <option value="kodak_tri_x">⚫ Kodak Tri-X 400 (High Contrast B&W)</option>
          </select>
        </div>

        {/* Orange Base Mask Sampling */}
        <div className={clsx('transition-opacity duration-200', isSaving && 'opacity-50 pointer-events-none grayscale')}>
          <Text variant={TextVariants.heading} className="mb-2">
            Film Base Mask (Orange Tint)
          </Text>
          <div className="flex items-center justify-between p-2.5 bg-surface rounded-lg border border-border-color">
            <div className="flex items-center gap-2">
              <div
                className="w-5 h-5 rounded-md border border-white/20 shadow-xs"
                style={{
                  backgroundColor: `rgb(${Math.round((params.base_mask_r || 1.0) * 180)}, ${Math.round((params.base_mask_g || 1.0) * 120)}, ${Math.round((params.base_mask_b || 1.0) * 80)})`,
                }}
              />
              <span className="text-xs text-text-secondary">Base Mask Compensation</span>
            </div>
            <button
              onClick={async () => {
                if (!selectedImagePath) return;
                try {
                  const sampled: any = await invoke('sample_negative_border_mask', {
                    path: selectedImagePath,
                    normX: 0.05,
                    normY: 0.05,
                    normRadius: 0.03,
                  });
                  if (sampled) {
                    const newParams = {
                      ...params,
                      base_mask_r: sampled.r,
                      base_mask_g: sampled.g,
                      base_mask_b: sampled.b,
                    };
                    setParams(newParams);
                    updatePreview(newParams);
                  }
                } catch (e) {
                  console.error('Border sampling failed', e);
                }
              }}
              className="flex items-center gap-1 text-xs px-2.5 py-1 bg-accent/15 text-accent rounded-md hover:bg-accent/25 transition-colors"
            >
              <Pipette size={13} />
              Sample Border
            </button>
          </div>
        </div>

        {/* Color Timing Weights */}
        <div
          className={clsx('transition-opacity duration-200', isSaving && 'opacity-50 pointer-events-none grayscale')}
        >
          <Text variant={TextVariants.heading} className="mb-2">
            {t('modals.negativeConversion.colorTiming')}
          </Text>
          <div className="space-y-3">
            <Slider
              label={t('modals.negativeConversion.redWeight')}
              value={params.red_weight}
              min={0.5}
              max={2.0}
              step={0.01}
              defaultValue={1}
              onChange={(e) => handleParamChange('red_weight', Number(e.target.value))}
              fillOrigin="min"
            />
            <Slider
              label={t('modals.negativeConversion.greenWeight')}
              value={params.green_weight}
              min={0.5}
              max={2.0}
              step={0.01}
              defaultValue={1}
              onChange={(e) => handleParamChange('green_weight', Number(e.target.value))}
              fillOrigin="min"
            />
            <Slider
              label={t('modals.negativeConversion.blueWeight')}
              value={params.blue_weight}
              min={0.5}
              max={2.0}
              step={0.01}
              defaultValue={1}
              onChange={(e) => handleParamChange('blue_weight', Number(e.target.value))}
              fillOrigin="min"
            />
          </div>
        </div>

        {/* Print Grade Exposure & Contrast */}
        <div
          className={clsx('transition-opacity duration-200', isSaving && 'opacity-50 pointer-events-none grayscale')}
        >
          <Text variant={TextVariants.heading} className="mb-2">
            {t('modals.negativeConversion.printGrade')}
          </Text>
          <div className="space-y-3">
            <Slider
              label={t('modals.negativeConversion.exposure')}
              value={params.exposure}
              min={-2.0}
              max={2.0}
              step={0.05}
              defaultValue={0}
              onChange={(e) => handleParamChange('exposure', Number(e.target.value))}
            />
            <Slider
              label={t('modals.negativeConversion.contrast')}
              value={params.contrast}
              min={0.5}
              max={2.5}
              step={0.05}
              defaultValue={1}
              onChange={(e) => handleParamChange('contrast', Number(e.target.value))}
              fillOrigin="min"
            />
            <Slider
              label="Shadow Toe Roll-off"
              value={params.toe_compression ?? 0}
              min={-0.5}
              max={0.5}
              step={0.02}
              defaultValue={0}
              onChange={(e) => handleParamChange('toe_compression', Number(e.target.value))}
            />
            <Slider
              label="Highlight Shoulder Roll-off"
              value={params.shoulder_compression ?? 0}
              min={-0.5}
              max={0.5}
              step={0.02}
              defaultValue={0}
              onChange={(e) => handleParamChange('shoulder_compression', Number(e.target.value))}
            />
            <Slider
              label="Shadow Color Crossover"
              value={params.shadow_crossover ?? 0}
              min={-0.5}
              max={0.5}
              step={0.02}
              defaultValue={0}
              onChange={(e) => handleParamChange('shadow_crossover', Number(e.target.value))}
            />
            <Slider
              label="Highlight Color Crossover"
              value={params.highlight_crossover ?? 0}
              min={-0.5}
              max={0.5}
              step={0.02}
              defaultValue={0}
              onChange={(e) => handleParamChange('highlight_crossover', Number(e.target.value))}
            />
          </div>
        </div>

        <div className="mt-auto pt-4 space-y-2">
          <Text
            as="div"
            variant={TextVariants.small}
            className="p-3 bg-surface rounded-md border border-surface flex items-center gap-3"
          >
            <Info size={16} className="shrink-0" />
            <div className="text-xs text-text-tertiary leading-tight space-y-1">
              <Trans i18nKey="modals.negativeConversion.noticeText">
                Inversion logic inspired by{' '}
                <a
                  href="https://github.com/marcinz606/NegPy"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-primary transition-colors"
                >
                  NegPy
                </a>{' '}
                created by marcinz606 (
                <a
                  href="https://github.com/marcinz606/NegPy/blob/main/LICENSE"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-primary transition-colors"
                >
                  GPL-3.0
                </a>
                ).
              </Trans>
            </div>
          </Text>
        </div>
      </div>
    </div>
  );

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
            style={{ backgroundImage: 'radial-gradient(#444 1px, transparent 1px)', backgroundSize: '24px 24px' }}
          ></div>

          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/20 z-30">
              <Loader2 className="w-12 h-12 text-accent animate-spin" />
            </div>
          )}

          {(previewUrl || originalUrl) && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="origin-center" style={imageTransformStyle}>
                <div className="relative inline-block shadow-2xl">
                  <img
                    src={isCompareActive && originalUrl ? originalUrl : previewUrl || ''}
                    className="block object-contain"
                    style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto' }}
                    alt="Preview"
                    draggable={false}
                  />
                  {isCompareActive && (
                    <Text
                      as="div"
                      variant={TextVariants.small}
                      color={TextColors.button}
                      className="absolute top-4 left-4 bg-accent px-2 py-1 rounded-sm shadow-lg z-20"
                    >
                      {t('modals.negativeConversion.originalLabel')}
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
              onClick={() => setZoom((z) => Math.max(0.1, z - 0.25))}
              className="p-2 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors"
              data-tooltip={t('modals.negativeConversion.zoomOutTooltip')}
            >
              <ZoomOut size={18} />
            </button>
            <span className="text-xs font-mono text-white/90 w-12 text-center select-none pointer-events-none">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom((z) => Math.min(8, z + 0.25))}
              className="p-2 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors"
              data-tooltip={t('modals.negativeConversion.zoomInTooltip')}
            >
              <ZoomIn size={18} />
            </button>
            <button
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              className="p-2 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors"
              data-tooltip={t('modals.negativeConversion.resetViewTooltip')}
            >
              <Maximize size={16} />
            </button>
            <div className="w-px h-5 bg-white/20 mx-1"></div>
            <button
              onMouseDown={() => setIsCompareActive(true)}
              onMouseUp={() => setIsCompareActive(false)}
              onMouseLeave={() => setIsCompareActive(false)}
              className={clsx(
                'p-2 rounded-full transition-colors select-none',
                isCompareActive ? 'bg-accent text-button-text' : 'text-white/60 hover:bg-white/10 hover:text-white',
              )}
              data-tooltip={t('modals.negativeConversion.compareTooltip')}
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
      className={clsx(
        'fixed inset-0 z-100 flex items-center justify-center bg-black/50 backdrop-blur-xs transition-opacity duration-300',
        show ? 'opacity-100' : 'opacity-0',
      )}
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
                disabled={isSaving}
                onClick={onClose}
                className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('modals.negativeConversion.cancel')}
              </button>
              <Button onClick={handleSave} disabled={isSaving || isLoading || !previewUrl}>
                {isSaving ? (
                  <>
                    <Loader2 className="animate-spin mr-2" size={16} />
                    {progress && progress.total > 1
                      ? t('modals.negativeConversion.convertingProgress', {
                          current: progress.current,
                          total: progress.total,
                        })
                      : t('modals.negativeConversion.converting')}
                  </>
                ) : (
                  <>
                    <Save className="mr-2" size={16} />
                    {targetPaths.length > 1
                      ? t('modals.negativeConversion.convertAndSaveAll', { count: targetPaths.length })
                      : t('modals.negativeConversion.convertAndSave')}
                  </>
                )}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
