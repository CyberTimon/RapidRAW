import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  RotateCcw,
  Search,
  Check,
  Info,
  Loader,
  Eye,
  EyeOff,
  ZoomIn,
  ZoomOut,
  Maximize,
  SquareDashed,
  CircleDashed,
  Activity,
  Scissors,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import Button from '../ui/Button';
import Slider from '../ui/Slider';
import Dropdown from '../ui/Dropdown';
import Switch from '../ui/Switch';
import throttle from 'lodash.throttle';
import { Adjustments } from '../../utils/adjustments';
import { SelectedImage } from '../ui/AppProperties';
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

interface MyLens {
  maker: string;
  model: string;
}

interface LensParams {
  lensMaker: string | null;
  lensModel: string | null;
  lensDistortionAmount: number;
  lensVignetteAmount: number;
  lensTcaAmount: number;
  lensDistortionEnabled: boolean;
  lensTcaEnabled: boolean;
  lensVignetteEnabled: boolean;
  lensDistortionParams: {
    k1: number;
    k2: number;
    k3: number;
    model: number;
    tca_vr: number;
    tca_vb: number;
    vig_k1: number;
    vig_k2: number;
    vig_k3: number;
  } | null;
}

interface LensCorrectionModalProps {
  isOpen: boolean;
  onClose(): void;
  onApply(newParams: LensParams): void;
  currentAdjustments: Adjustments;
  selectedImage: SelectedImage | null;
}

const DEFAULT_PARAMS: LensParams = {
  lensMaker: null,
  lensModel: null,
  lensDistortionAmount: 100,
  lensVignetteAmount: 100,
  lensTcaAmount: 100,
  lensDistortionEnabled: true,
  lensTcaEnabled: true,
  lensVignetteEnabled: true,
  lensDistortionParams: null,
};

const parseFocalLength = (exif: any): number | null => {
  if (!exif || !exif.FocalLength) return null;
  const val = parseFloat(exif.FocalLength);
  return isNaN(val) ? null : val;
};

const parseAperture = (exif: any): number | null => {
  if (!exif || !exif.FNumber) return null;
  const val = parseFloat(exif.FNumber);
  return isNaN(val) ? null : val;
};

const parseDistance = (exif: any): number | null => {
  if (!exif || !exif.SubjectDistance) return null;
  const val = parseFloat(exif.SubjectDistance);
  return isNaN(val) ? null : val;
};

const SLIDER_DIVISOR = 100.0;

export default function LensCorrectionModal({
  isOpen,
  onClose,
  onApply,
  currentAdjustments,
  selectedImage,
}: LensCorrectionModalProps) {
  const [params, setParams] = useState<LensParams>(DEFAULT_PARAMS);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [makers, setMakers] = useState<string[]>([]);
  const [lenses, setLenses] = useState<string[]>([]);
  const [myLenses, setMyLenses] = useState<MyLens[]>([]);
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [detectionStatus, setDetectionStatus] = useState<'idle' | 'detecting' | 'not_found' | 'success'>('idle');

  const [isCompareActive, setIsCompareActive] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMousePos = useRef({ x: 0, y: 0 });

  const focalLength = useMemo(() => parseFocalLength(selectedImage?.exif), [selectedImage?.exif]);
  const aperture = useMemo(() => parseAperture(selectedImage?.exif), [selectedImage?.exif]);
  const distance = useMemo(() => parseDistance(selectedImage?.exif), [selectedImage?.exif]);

  const availability = useMemo(() => {
    if (!params.lensDistortionParams) return { distortion: false, tca: false, vignetting: false };
    const p = params.lensDistortionParams;
    return {
      distortion: Math.abs(p.k1) > 1e-6 || Math.abs(p.k2) > 1e-6 || Math.abs(p.k3) > 1e-6,
      tca: Math.abs(p.tca_vr - 1.0) > 1e-5 || Math.abs(p.tca_vb - 1.0) > 1e-5,
      vignetting: Math.abs(p.vig_k1) > 1e-6 || Math.abs(p.vig_k2) > 1e-6 || Math.abs(p.vig_k3) > 1e-6,
    };
  }, [params.lensDistortionParams]);

  useEffect(() => {
    if (!isDragging) return;
    const handleWindowMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - lastMousePos.current.x;
      const dy = e.clientY - lastMousePos.current.y;
      setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    };
    const handleWindowMouseUp = () => {
      setIsDragging(false);
    };
    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [isDragging]);

  const handleMouseDown = (e: React.MouseEvent) => {
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

  const fetchDistortionParams = async (maker: string, model: string) => {
    try {
      const distParams: any = await invoke('get_lens_distortion_params', {
        maker,
        model,
        focalLength: focalLength,
        aperture: aperture,
        distance: distance,
      });
      return distParams;
    } catch (error) {
      console.error('Failed to fetch lens params', error);
      return null;
    }
  };

  const updatePreview = useCallback(
    throttle(async (currentParams: LensParams) => {
      try {
        const fullParams: GeometryParams = {
          distortion: currentAdjustments.transformDistortion ?? 0,
          vertical: currentAdjustments.transformVertical ?? 0,
          horizontal: currentAdjustments.transformHorizontal ?? 0,
          rotate: currentAdjustments.transformRotate ?? 0,
          aspect: currentAdjustments.transformAspect ?? 0,
          scale: currentAdjustments.transformScale ?? 100,
          x_offset: currentAdjustments.transformXOffset ?? 0,
          y_offset: currentAdjustments.transformYOffset ?? 0,

          lens_distortion_amount: currentParams.lensDistortionAmount / SLIDER_DIVISOR,
          lens_vignette_amount: currentParams.lensVignetteAmount / SLIDER_DIVISOR,
          lens_tca_amount: currentParams.lensTcaAmount / SLIDER_DIVISOR,

          lens_distortion_enabled: currentParams.lensDistortionEnabled,
          lens_vignette_enabled: currentParams.lensVignetteEnabled,
          lens_tca_enabled: currentParams.lensTcaEnabled,

          lens_dist_k1: currentParams.lensDistortionParams?.k1 ?? 0,
          lens_dist_k2: currentParams.lensDistortionParams?.k2 ?? 0,
          lens_dist_k3: currentParams.lensDistortionParams?.k3 ?? 0,
          lens_model: currentParams.lensDistortionParams?.model ?? 0,
          tca_vr: currentParams.lensDistortionParams?.tca_vr ?? 1.0,
          tca_vb: currentParams.lensDistortionParams?.tca_vb ?? 1.0,
          vig_k1: currentParams.lensDistortionParams?.vig_k1 ?? 0,
          vig_k2: currentParams.lensDistortionParams?.vig_k2 ?? 0,
          vig_k3: currentParams.lensDistortionParams?.vig_k3 ?? 0,
        };

        const result: string = await invoke('preview_geometry_transform', {
          params: fullParams,
          jsAdjustments: currentAdjustments,
          showLines: false,
        });
        setPreviewUrl(result);
      } catch (e) {
        console.error('Lens correction preview failed', e);
      }
    }, 50),
    [currentAdjustments],
  );

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);

      invoke('load_settings').then((settings: any) => {
        if (settings?.myLenses) {
          setMyLenses(settings.myLenses);
        }
      });

      const initParams: LensParams = {
        lensMaker: currentAdjustments.lensMaker,
        lensModel: currentAdjustments.lensModel,
        lensDistortionAmount: currentAdjustments.lensDistortionAmount ?? 100,
        lensVignetteAmount: currentAdjustments.lensVignetteAmount ?? 100,
        lensTcaAmount: currentAdjustments.lensTcaAmount ?? 100,
        lensDistortionEnabled: currentAdjustments.lensDistortionEnabled ?? true,
        lensTcaEnabled: currentAdjustments.lensTcaEnabled ?? true,
        lensVignetteEnabled: currentAdjustments.lensVignetteEnabled ?? true,
        lensDistortionParams: currentAdjustments.lensDistortionParams,
      };

      setParams(initParams);
      setDetectionStatus('idle');
      handleResetZoom();
      updatePreview(initParams);

      invoke('get_lensfun_makers')
        .then((m: any) => setMakers(m))
        .catch(console.error);

      if (initParams.lensMaker) {
        invoke('get_lensfun_lenses_for_maker', { maker: initParams.lensMaker })
          .then((l: any) => setLenses(l))
          .catch(console.error);
      }

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

  const handleMakerChange = (maker: string) => {
    const newParams = {
      ...params,
      lensMaker: maker,
      lensModel: null,
      lensDistortionParams: null,
    };
    setParams(newParams);
    setLenses([]);
    setDetectionStatus('idle');

    invoke('get_lensfun_lenses_for_maker', { maker })
      .then((l: any) => setLenses(l))
      .catch(console.error);

    updatePreview(newParams);
  };

  const handleModelChange = async (model: string) => {
    const tempParams = { ...params, lensModel: model };
    setParams(tempParams);
    setDetectionStatus('idle');

    if (params.lensMaker) {
      const distortionParams = await fetchDistortionParams(params.lensMaker, model);
      const finalParams = { ...tempParams, lensDistortionParams: distortionParams };
      setParams(finalParams);
      updatePreview(finalParams);
    }
  };

  const handleMyLensSelect = async (val: string) => {
    if (!val || val === 'none') return;
    const index = parseInt(val);
    const selected = myLenses[index];
    if (!selected) return;

    const tempParams = { ...params, lensMaker: selected.maker, lensModel: selected.model };
    setParams(tempParams);
    setDetectionStatus('idle');

    invoke('get_lensfun_lenses_for_maker', { maker: selected.maker })
      .then((l: any) => setLenses(l))
      .catch(console.error);

    const distortionParams = await fetchDistortionParams(selected.maker, selected.model);
    const finalParams = { ...tempParams, lensDistortionParams: distortionParams };
    setParams(finalParams);
    updatePreview(finalParams);
  };

  const handleAmountChange = (key: keyof LensParams, amount: number) => {
    const newParams = { ...params, [key]: amount };
    setParams(newParams);
    updatePreview(newParams);
  };

  const handleToggleChange = (key: keyof LensParams, val: boolean) => {
    const newParams = { ...params, [key]: val };
    setParams(newParams);
    updatePreview(newParams);
  };

  const handleAutoDetect = async () => {
    if (!selectedImage?.exif) {
      setDetectionStatus('not_found');
      return;
    }
    const exifMaker = selectedImage.exif.Make || '';
    const exifModel = selectedImage.exif.LensModel || '';

    if (!exifModel) {
      setDetectionStatus('not_found');
      return;
    }

    setDetectionStatus('detecting');

    try {
      const result: [string, string] | null = await invoke('autodetect_lens', { maker: exifMaker, model: exifModel });

      if (result) {
        const [detectedMaker, detectedModel] = result;

        if (detectedMaker !== params.lensMaker) {
          await invoke('get_lensfun_lenses_for_maker', { maker: detectedMaker }).then((l: any) => setLenses(l));
        }

        const distortionParams = await fetchDistortionParams(detectedMaker, detectedModel);

        const newParams = {
          ...params,
          lensMaker: detectedMaker,
          lensModel: detectedModel,
          lensDistortionParams: distortionParams,
        };

        setParams(newParams);
        setDetectionStatus('success');
        updatePreview(newParams);

        setTimeout(() => {
          setDetectionStatus('idle');
        }, 2000);
      } else {
        setDetectionStatus('not_found');
      }
    } catch (error) {
      console.error('Autodetection failed with error:', error);
      setDetectionStatus('not_found');
    }
  };

  const handleApply = () => {
    setIsApplying(true);
    onApply(params);
    onClose();
  };

  const handleReset = () => {
    const resetParams = {
      ...DEFAULT_PARAMS,
      lensDistortionEnabled: true,
      lensTcaEnabled: true,
      lensVignetteEnabled: true,
    };
    setParams(resetParams);
    setLenses([]);
    setDetectionStatus('idle');
    updatePreview(resetParams);
  };

  const toggleCompare = (active: boolean) => {
    setIsCompareActive(active);
    if (active) {
      const fullParams: GeometryParams = {
        distortion: currentAdjustments.transformDistortion ?? 0,
        vertical: currentAdjustments.transformVertical ?? 0,
        horizontal: currentAdjustments.transformHorizontal ?? 0,
        rotate: currentAdjustments.transformRotate ?? 0,
        aspect: currentAdjustments.transformAspect ?? 0,
        scale: currentAdjustments.transformScale ?? 100,
        x_offset: currentAdjustments.transformXOffset ?? 0,
        y_offset: currentAdjustments.transformYOffset ?? 0,

        lens_distortion_amount: (currentAdjustments.lensDistortionAmount ?? 100) / SLIDER_DIVISOR,
        lens_vignette_amount: (currentAdjustments.lensVignetteAmount ?? 100) / SLIDER_DIVISOR,
        lens_tca_amount: (currentAdjustments.lensTcaAmount ?? 100) / SLIDER_DIVISOR,

        lens_distortion_enabled: false,
        lens_vignette_enabled: false,
        lens_tca_enabled: false,

        lens_dist_k1: currentAdjustments.lensDistortionParams?.k1 ?? 0,
        lens_dist_k2: currentAdjustments.lensDistortionParams?.k2 ?? 0,
        lens_dist_k3: currentAdjustments.lensDistortionParams?.k3 ?? 0,
        lens_model: currentAdjustments.lensDistortionParams?.model ?? 0,
        tca_vr: currentAdjustments.lensDistortionParams?.tca_vr ?? 1.0,
        tca_vb: currentAdjustments.lensDistortionParams?.tca_vb ?? 1.0,
        vig_k1: currentAdjustments.lensDistortionParams?.vig_k1 ?? 0,
        vig_k2: currentAdjustments.lensDistortionParams?.vig_k2 ?? 0,
        vig_k3: currentAdjustments.lensDistortionParams?.vig_k3 ?? 0,
      };

      invoke('preview_geometry_transform', {
        params: fullParams,
        jsAdjustments: currentAdjustments,
        showLines: false,
      }).then((result: any) => setPreviewUrl(result));
    } else {
      updatePreview(params);
    }
  };

  const imageTransformStyle = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    transition: isDragging ? 'none' : 'transform 0.1s ease-out',
    transformOrigin: 'center center',
  };

  const makerOptions = makers.map((m) => ({ label: m, value: m }));
  const lensOptions = lenses.map((m) => ({ label: m, value: m }));
  const myLensOptions = useMemo(() => {
    if (myLenses.length === 0) {
      return [{ label: 'Manage your lenses in Settings', value: 'none' }];
    }
    return myLenses.map((l, i) => ({
      label: `${l.maker} - ${l.model}`,
      value: i.toString(),
    }));
  }, [myLenses]);

  const autoDetectButtonContent = () => {
    switch (detectionStatus) {
      case 'detecting':
        return (
          <>
            <Loader size={16} className="animate-spin" /> Detecting...
          </>
        );
      case 'not_found':
        return 'Not Found';
      case 'success':
        return (
          <>
            <Check size={16} /> Lens Found
          </>
        );
      default:
        return (
          <>
            <Search size={16} /> Auto-detect Lens
          </>
        );
    }
  };

  const renderControls = () => (
    <div className="w-80 shrink-0 bg-bg-secondary flex flex-col border-l border-surface h-full z-10">
      <div className="p-4 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>Lens Correction</Text>
        <button
          onClick={handleReset}
          data-tooltip="Reset Lens Correction"
          className="p-2 rounded-full hover:bg-surface transition-colors"
        >
          <RotateCcw size={18} />
        </button>
      </div>
      <div className="grow overflow-y-auto p-4 flex flex-col gap-8 text-text-secondary">
        <div>
          <Text variant={TextVariants.heading} className="mb-2">
            Auto Detection
          </Text>
          <div className="space-y-3">
            <button
              onClick={handleAutoDetect}
              className={clsx(
                'w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-semibold rounded-md transition-colors',
                detectionStatus === 'not_found'
                  ? 'bg-red-500/20 text-red-400'
                  : detectionStatus === 'success'
                    ? 'bg-green-500/20 text-green-400'
                    : 'bg-surface hover:bg-card-active',
              )}
              disabled={detectionStatus === 'detecting'}
            >
              {autoDetectButtonContent()}
            </button>

            <AnimatePresence>
              {detectionStatus === 'not_found' && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="p-3 bg-red-900/10 border border-red-500/20 rounded-md"
                >
                  <Text
                    as="div"
                    variant={TextVariants.small}
                    color={TextColors.error}
                    className="flex items-center gap-3"
                  >
                    <Info size={16} className="shrink-0" />
                    <p className="leading-relaxed">
                      Lens correction may not be available for all lenses. Auto-detection relies on EXIF data.
                    </p>
                  </Text>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        <div>
          <Text variant={TextVariants.heading} className="mb-2">
            Manual Selection
          </Text>

          <div className="space-y-4">
            <Dropdown options={myLensOptions} value="" onChange={handleMyLensSelect} placeholder="Choose Saved Lens" />
            <Dropdown
              options={makerOptions}
              value={params.lensMaker}
              onChange={handleMakerChange}
              placeholder="Select Manufacturer"
            />
            {params.lensMaker && (
              <Dropdown
                options={lensOptions}
                value={params.lensModel}
                onChange={handleModelChange}
                placeholder="Select Lens Model"
              />
            )}
          </div>
        </div>

        <div>
          <Text variant={TextVariants.heading} className="mb-2">
            Corrections
          </Text>

          <div className="flex flex-col gap-4">
            <div>
              <div
                className={clsx(
                  'flex items-center gap-3 p-2 rounded-md transition-colors',
                  availability.distortion ? 'bg-surface' : 'bg-surface/30',
                )}
              >
                <Text as="div" className="p-1.5 bg-bg-primary rounded-sm">
                  <SquareDashed size={16} />
                </Text>
                <Switch
                  className="grow"
                  label="Distortion"
                  checked={params.lensDistortionEnabled && availability.distortion}
                  onChange={(val) => handleToggleChange('lensDistortionEnabled', val)}
                  disabled={!availability.distortion}
                />
              </div>
              <AnimatePresence initial={false}>
                {availability.distortion && params.lensDistortionEnabled && (
                  <motion.div
                    initial={{ height: 0, opacity: 0, marginTop: 0 }}
                    animate={{ height: 'auto', opacity: 1, marginTop: 8 }}
                    exit={{ height: 0, opacity: 0, marginTop: 0 }}
                    transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                    className="overflow-hidden px-2"
                  >
                    <Slider
                      label="Amount"
                      value={params.lensDistortionAmount}
                      min={0}
                      max={200}
                      defaultValue={100}
                      step={1}
                      onChange={(e) => handleAmountChange('lensDistortionAmount', Number(e.target.value))}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div>
              <div
                className={clsx(
                  'flex items-center gap-3 p-2 rounded-md transition-colors',
                  availability.tca ? 'bg-surface' : 'bg-surface/30',
                )}
              >
                <Text as="div" className="p-1.5 bg-bg-primary rounded-sm">
                  <Activity size={16} />
                </Text>
                <Switch
                  className="grow"
                  label="Chromatic Aberration"
                  checked={params.lensTcaEnabled && availability.tca}
                  onChange={(val) => handleToggleChange('lensTcaEnabled', val)}
                  disabled={!availability.tca}
                />
              </div>
              <AnimatePresence initial={false}>
                {availability.tca && params.lensTcaEnabled && (
                  <motion.div
                    initial={{ height: 0, opacity: 0, marginTop: 0 }}
                    animate={{ height: 'auto', opacity: 1, marginTop: 8 }}
                    exit={{ height: 0, opacity: 0, marginTop: 0 }}
                    transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                    className="overflow-hidden px-2"
                  >
                    <Slider
                      label="Amount"
                      value={params.lensTcaAmount}
                      min={0}
                      max={200}
                      defaultValue={100}
                      step={1}
                      onChange={(e) => handleAmountChange('lensTcaAmount', Number(e.target.value))}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div>
              <div
                className={clsx(
                  'flex items-center gap-3 p-2 rounded-md transition-colors',
                  availability.vignetting ? 'bg-surface' : 'bg-surface/30',
                )}
              >
                <Text as="div" className="p-1.5 bg-bg-primary rounded-sm">
                  <CircleDashed size={16} />
                </Text>
                <Switch
                  className="grow"
                  label="Vignetting"
                  checked={params.lensVignetteEnabled && availability.vignetting}
                  onChange={(val) => handleToggleChange('lensVignetteEnabled', val)}
                  disabled={!availability.vignetting}
                />
              </div>
              <AnimatePresence initial={false}>
                {availability.vignetting && params.lensVignetteEnabled && (
                  <motion.div
                    initial={{ height: 0, opacity: 0, marginTop: 0 }}
                    animate={{ height: 'auto', opacity: 1, marginTop: 8 }}
                    exit={{ height: 0, opacity: 0, marginTop: 0 }}
                    transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                    className="overflow-hidden px-2"
                  >
                    <Slider
                      label="Amount"
                      value={params.lensVignetteAmount}
                      min={0}
                      max={200}
                      defaultValue={100}
                      step={1}
                      onChange={(e) => handleAmountChange('lensVignetteAmount', Number(e.target.value))}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        <div className="mt-auto space-y-2">
          {currentAdjustments.masks && currentAdjustments.masks.length > 0 && (
            <Text
              as="div"
              variant={TextVariants.small}
              className="p-3 bg-surface rounded-md border border-surface flex items-center gap-3"
            >
              <Info size={16} className="shrink-0" />
              <p className="leading-relaxed">
                Lens correction updates base geometry. Existing masks may shift, and AI masks must be regenerated.
              </p>
            </Text>
          )}
          <Text
            as="div"
            variant={TextVariants.small}
            className="p-3 bg-surface rounded-md border border-surface flex items-center gap-3"
          >
            <Info size={16} className="shrink-0" />
            <div className="leading-tight space-y-1">
              <p>
                Lens database provided by the{' '}
                <a
                  href="https://lensfun.github.io/"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-primary transition-colors"
                >
                  Lensfun Project
                </a>{' '}
                (
                <a
                  href="https://creativecommons.org/licenses/by-sa/3.0/"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-primary transition-colors"
                >
                  CC BY-SA 3.0
                </a>
                ).
              </p>
            </div>
          </Text>
        </div>
      </div>
    </div>
  );

  const renderContent = () => (
    <div className="flex flex-row h-full w-full overflow-hidden">
      <div className="grow flex flex-col relative min-h-0 bg-[#0f0f0f] overflow-hidden">
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

          {previewUrl && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="origin-center" style={imageTransformStyle}>
                <div className="relative inline-block shadow-2xl">
                  <img
                    src={previewUrl}
                    className="block object-contain"
                    style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto' }}
                    alt="Lens Correction Preview"
                    draggable={false}
                  />
                  {isCompareActive && (
                    <Text
                      as="div"
                      variant={TextVariants.small}
                      color={TextColors.button}
                      className="absolute top-4 left-4 bg-accent px-2 py-1 rounded-sm shadow-lg z-20"
                    >
                      Original
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
              data-tooltip="Zoom Out"
            >
              <ZoomOut size={18} />
            </button>
            <span className="text-xs font-mono text-white/90 w-12 text-center select-none pointer-events-none">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom((z) => Math.min(8, z + 0.25))}
              className="p-2 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors"
              data-tooltip="Zoom In"
            >
              <ZoomIn size={18} />
            </button>
            <button
              onClick={handleResetZoom}
              className="p-2 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors"
              data-tooltip="Reset Zoom"
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
                isCompareActive ? 'bg-accent text-white' : 'text-white/60 hover:bg-white/10 hover:text-white',
              )}
              data-tooltip="Hold to Compare"
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
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <AnimatePresence>
        {show && (
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="bg-surface rounded-lg shadow-xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden"
          >
            <div className="grow min-h-0 overflow-hidden">{renderContent()}</div>
            <div className="shrink-0 p-4 flex justify-end gap-3 border-t border-surface bg-bg-secondary z-20">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
              >
                Cancel
              </button>
              <Button onClick={handleApply} disabled={isApplying || !previewUrl}>
                <Check className="mr-2" size={16} /> Apply
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
