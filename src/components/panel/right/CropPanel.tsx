import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Aperture,
  FlipHorizontal,
  FlipVertical,
  Grid3x3,
  RectangleHorizontal,
  RectangleVertical,
  RotateCcw,
  RotateCw,
  Ruler,
  Scan,
  X,
  ChevronDown,
  ChevronRight,
  Cuboid,
  Search,
  Check,
  Loader,
  SquareDashed,
  Activity,
  CircleDashed,
  Minus,
  Trash2,
  Info,
  Ban,
} from 'lucide-react';
import { useTranslation, Trans } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../../../utils/adjustments';
import clsx from 'clsx';
import { Orientation } from '../../ui/AppProperties';
import { motion, AnimatePresence } from 'framer-motion';
import Text from '../../ui/Text';
import Slider from '../../ui/Slider';
import Switch from '../../ui/Switch';
import Dropdown from '../../ui/Dropdown';
import Button from '../../ui/Button';
import { TEXT_COLOR_KEYS, TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { useEditorStore } from '../../../store/useEditorStore';
import { useEditorActions } from '../../../hooks/useEditorActions';
import { calculateAreaPreservingCrop, calculateCenteredCrop } from '../../../utils/cropUtils';
import { Crop } from 'react-image-crop';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '../../../store/useUIStore';
import { useContextMenu } from '../../../context/ContextMenuContext';

const BASE_RATIO = 1.618;
const ORIGINAL_RATIO = 0;
const RATIO_TOLERANCE = 0.01;

export type OverlayMode = 'none' | 'thirds' | 'goldenTriangle' | 'goldenSpiral' | 'phiGrid' | 'armature' | 'diagonal';

interface CropPreset {
  name: string;
  value: number | null;
  tooltip: string;
}

interface OverlayOption {
  id: OverlayMode;
  name: string;
  tooltip: string;
}

const parseExifNumber = (val: any): number => {
  if (val === undefined || val === null) return 0;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? 0 : parsed;
};

export default function CropPanel() {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const adjustments = useEditorStore((s) => s.adjustments);
  const isStraightenActive = useEditorStore((s) => s.isStraightenActive);
  const isGuidedPerspectiveActive = useEditorStore((s) => s.isGuidedPerspectiveActive);
  const activeOverlay = useEditorStore((s) => s.overlayMode);
  const setEditor = useEditorStore((s) => s.setEditor);
  const { setAdjustments, handleRotate } = useEditorActions();

  const [customW, setCustomW] = useState('');
  const [customH, setCustomH] = useState('');
  const [isRotationActive, setIsRotationActive] = useState(false);
  const [preferPortrait, setPreferPortrait] = useState(false);
  const [isEditingCustom, setIsEditingCustom] = useState(false);
  const [makers, setMakers] = useState<string[]>([]);
  const [lenses, setLenses] = useState<string[]>([]);
  const [myLenses, setMyLenses] = useState<any[]>([]);
  const [detectionStatus, setDetectionStatus] = useState<'idle' | 'detecting' | 'not_found' | 'success'>('idle');
  const [localRotation, setLocalRotation] = useState<number | null>(null);
  const localRotationRef = useRef<number | null>(null);

  const lensMode = adjustments.lensCorrectionMode || 'manual';

  const [modeBubbleStyle, setModeBubbleStyle] = useState({});
  const isModeInitialAnimation = useRef(true);

  const { cropSectionsState, setUI } = useUIStore(
    useShallow((s) => ({
      cropSectionsState: s.cropSectionsState,
      setUI: s.setUI,
    })),
  );

  const isTransformExpanded = cropSectionsState.transform;
  const isLensExpanded = cropSectionsState.lens;

  const toggleSection = (section: 'transform' | 'lens') => {
    setUI((state) => ({
      cropSectionsState: {
        ...state.cropSectionsState,
        [section]: !state.cropSectionsState[section],
      },
    }));
  };

  const PRESETS = useMemo<Array<CropPreset>>(
    () => [
      { name: t('editor.crop.presets.free.name'), value: null, tooltip: t('editor.crop.presets.free.desc') },
      {
        name: t('editor.crop.presets.original.name'),
        value: ORIGINAL_RATIO,
        tooltip: t('editor.crop.presets.original.desc'),
      },
      { name: t('editor.crop.presets.sq.name'), value: 1, tooltip: t('editor.crop.presets.sq.desc') },
      { name: t('editor.crop.presets.r54.name'), value: 5 / 4, tooltip: t('editor.crop.presets.r54.desc') },
      { name: t('editor.crop.presets.r43.name'), value: 4 / 3, tooltip: t('editor.crop.presets.r43.desc') },
      { name: t('editor.crop.presets.r32.name'), value: 3 / 2, tooltip: t('editor.crop.presets.r32.desc') },
      { name: t('editor.crop.presets.r169.name'), value: 16 / 9, tooltip: t('editor.crop.presets.r169.desc') },
      { name: t('editor.crop.presets.r219.name'), value: 21 / 9, tooltip: t('editor.crop.presets.r219.desc') },
      { name: t('editor.crop.presets.r6524.name'), value: 65 / 24, tooltip: t('editor.crop.presets.r6524.desc') },
    ],
    [t],
  );

  const OVERLAYS = useMemo<Array<OverlayOption>>(
    () => [
      { id: 'none', name: t('editor.crop.overlays.none.name'), tooltip: t('editor.crop.overlays.none.desc') },
      { id: 'thirds', name: t('editor.crop.overlays.thirds.name'), tooltip: t('editor.crop.overlays.thirds.desc') },
      {
        id: 'diagonal',
        name: t('editor.crop.overlays.diagonal.name'),
        tooltip: t('editor.crop.overlays.diagonal.desc'),
      },
      {
        id: 'goldenTriangle',
        name: t('editor.crop.overlays.triangle.name'),
        tooltip: t('editor.crop.overlays.triangle.desc'),
      },
      {
        id: 'goldenSpiral',
        name: t('editor.crop.overlays.spiral.name'),
        tooltip: t('editor.crop.overlays.spiral.desc'),
      },
      { id: 'phiGrid', name: t('editor.crop.overlays.phiGrid.name'), tooltip: t('editor.crop.overlays.phiGrid.desc') },
      {
        id: 'armature',
        name: t('editor.crop.overlays.armature.name'),
        tooltip: t('editor.crop.overlays.armature.desc'),
      },
    ],
    [t],
  );

  const updateLocalRotation = useCallback(
    (val: number | null) => {
      setLocalRotation(val);
      localRotationRef.current = val;
      setEditor({ liveRotation: val });
    },
    [setEditor],
  );

  const setOverlay = useCallback((mode: OverlayMode) => setEditor({ overlayMode: mode }), [setEditor]);

  const setOverlayRotation = useCallback(
    (updater: React.SetStateAction<number>) => {
      setEditor((state) => ({
        overlayRotation: typeof updater === 'function' ? updater(state.overlayRotation) : updater,
      }));
    },
    [setEditor],
  );

  const lastSyncedRatio = useRef<number | null>(null);

  const { aspectRatio, rotation = 0, flipHorizontal = false, flipVertical = false, orientationSteps = 0 } = adjustments;

  useEffect(() => {
    invoke('get_lensfun_makers')
      .then((m: any) => setMakers(m))
      .catch(console.error);

    invoke('load_settings').then((settings: any) => {
      if (settings?.myLenses) setMyLenses(settings.myLenses);
    });
  }, []);

  useEffect(() => {
    if (adjustments.lensMaker) {
      invoke('get_lensfun_lenses_for_maker', { maker: adjustments.lensMaker })
        .then((l: any) => setLenses(l))
        .catch(console.error);
    } else {
      setLenses([]);
    }
  }, [adjustments.lensMaker]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName.toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea') return;

      if (e.ctrlKey || e.metaKey) return;

      if (e.key.toLowerCase() === 'o') {
        e.preventDefault();

        if (e.shiftKey) {
          setOverlayRotation((prev) => (prev + 1) % 4);
        } else {
          const currentIndex = OVERLAYS.findIndex((o) => o.id === activeOverlay);
          const nextIndex = (currentIndex + 1) % OVERLAYS.length;
          setOverlay(OVERLAYS[nextIndex].id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeOverlay, setOverlay, setOverlayRotation, OVERLAYS]);

  useEffect(() => {
    return () => {
      setEditor({ liveRotation: null });
    };
  }, [setEditor]);

  const getEffectiveOriginalRatio = useCallback(() => {
    if (!selectedImage?.width || !selectedImage?.height) {
      return null;
    }
    const isSwapped = orientationSteps === 1 || orientationSteps === 3;
    const W = isSwapped ? selectedImage.height : selectedImage.width;
    const H = isSwapped ? selectedImage.width : selectedImage.height;
    return W > 0 && H > 0 ? W / H : null;
  }, [selectedImage, orientationSteps]);

  const activePreset = useMemo(() => {
    if (aspectRatio === null) {
      return PRESETS.find((p: CropPreset) => p.value === null);
    }

    const numericPresetMatch = PRESETS.find(
      (p: CropPreset) =>
        p.value &&
        p.value !== ORIGINAL_RATIO &&
        (Math.abs(aspectRatio - p.value) < RATIO_TOLERANCE || Math.abs(aspectRatio - 1 / p.value) < RATIO_TOLERANCE),
    );

    if (numericPresetMatch) {
      return numericPresetMatch;
    }

    const originalRatio = getEffectiveOriginalRatio();
    if (originalRatio && Math.abs(aspectRatio - originalRatio) < RATIO_TOLERANCE) {
      return PRESETS.find((p: CropPreset) => p.value === ORIGINAL_RATIO);
    }

    return null;
  }, [aspectRatio, getEffectiveOriginalRatio, PRESETS]);

  let orientation = Orientation.Horizontal;
  if (activePreset && activePreset.value && activePreset.value !== 1) {
    let baseRatio: number | null = activePreset.value;
    if (activePreset.value === ORIGINAL_RATIO) {
      baseRatio = getEffectiveOriginalRatio();
    }
    if (baseRatio && aspectRatio && Math.abs(aspectRatio - baseRatio) > RATIO_TOLERANCE) {
      orientation = Orientation.Vertical;
    }
  }

  const isCustomActive = aspectRatio !== null && !activePreset;

  useEffect(() => {
    if (aspectRatio && aspectRatio !== 1) {
      setPreferPortrait(aspectRatio < 1);
    }
  }, [aspectRatio]);

  useEffect(() => {
    if (isCustomActive && aspectRatio && !isEditingCustom) {
      if (lastSyncedRatio.current === null || Math.abs(lastSyncedRatio.current - aspectRatio) > RATIO_TOLERANCE) {
        const h = 100;
        const w = aspectRatio * h;
        setCustomW(w.toFixed(1).replace(/\.0$/, ''));
        setCustomH(h.toString());
        lastSyncedRatio.current = aspectRatio;
      }
    } else if (!isCustomActive) {
      setCustomW('');
      setCustomH('');
      lastSyncedRatio.current = null;
    }
  }, [isCustomActive, aspectRatio, isEditingCustom]);

  const applyAspectRatio = useCallback(
    (newAspectRatio: number | null) => {
      if (newAspectRatio === null) {
        setAdjustments((prev: Adjustments) => ({ ...prev, aspectRatio: null }));
        return;
      }
      let newCrop: Crop | null = null;
      if (selectedImage?.width && selectedImage?.height) {
        newCrop =
          calculateAreaPreservingCrop(
            selectedImage.width,
            selectedImage.height,
            orientationSteps,
            newAspectRatio,
            rotation,
            adjustments.crop,
          ) ??
          calculateCenteredCrop(selectedImage.width, selectedImage.height, orientationSteps, newAspectRatio, rotation);
      }
      setAdjustments((prev: Adjustments) => ({ ...prev, aspectRatio: newAspectRatio, crop: newCrop }));
    },
    [selectedImage, orientationSteps, rotation, adjustments.crop, setAdjustments],
  );

  useEffect(() => {
    if (activePreset?.value === ORIGINAL_RATIO) {
      const newOriginalRatio = getEffectiveOriginalRatio();
      if (newOriginalRatio !== null && aspectRatio && Math.abs(aspectRatio - newOriginalRatio) > RATIO_TOLERANCE) {
        applyAspectRatio(newOriginalRatio);
      }
    }
  }, [orientationSteps, activePreset, aspectRatio, getEffectiveOriginalRatio, applyAspectRatio]);

  const handleCustomInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    if (name === 'customW') {
      setCustomW(value);
    } else if (name === 'customH') {
      setCustomH(value);
    }
  };

  const handleCustomInputFocus = () => {
    setIsEditingCustom(true);
  };

  const handleApplyCustomRatio = () => {
    setIsEditingCustom(false);
    const numW = parseFloat(customW);
    const numH = parseFloat(customH);

    if (numW > 0 && numH > 0) {
      const newAspectRatio = numW / numH;
      lastSyncedRatio.current = newAspectRatio;
      if (!adjustments?.aspectRatio || Math.abs(adjustments.aspectRatio - newAspectRatio) > RATIO_TOLERANCE) {
        applyAspectRatio(newAspectRatio);
      }
    }
  };

  const handleCustomInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApplyCustomRatio();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      setIsEditingCustom(false);
      if (aspectRatio) {
        const h = 100;
        const w = aspectRatio * h;
        setCustomW(w.toFixed(1).replace(/\.0$/, ''));
        setCustomH(h.toString());
      }
      (e.target as HTMLInputElement).blur();
    }
  };

  const handlePresetClick = (preset: CropPreset) => {
    if (preset.value === ORIGINAL_RATIO) {
      applyAspectRatio(getEffectiveOriginalRatio());
      return;
    }

    const targetRatio = preset.value;
    if (activePreset === preset && targetRatio && targetRatio !== 1) {
      const newRatio = 1 / (adjustments.aspectRatio ? adjustments.aspectRatio : 1);
      setPreferPortrait(newRatio < 1);
      applyAspectRatio(newRatio);
      return;
    }

    let newAspectRatio = targetRatio;
    if (targetRatio && targetRatio !== 1) {
      if (preferPortrait) {
        newAspectRatio = targetRatio > 1 ? 1 / targetRatio : targetRatio;
      } else {
        newAspectRatio = targetRatio > 1 ? targetRatio : targetRatio;
      }
    }

    applyAspectRatio(newAspectRatio);
  };

  const handleOrientationToggle = useCallback(() => {
    if (aspectRatio && aspectRatio !== 1) {
      const newRatio = 1 / aspectRatio;
      setPreferPortrait(newRatio < 1);
      applyAspectRatio(newRatio);
    }
  }, [aspectRatio, applyAspectRatio]);

  const handleReset = () => {
    const originalAspectRatio =
      selectedImage?.width && selectedImage?.height ? selectedImage.width / selectedImage.height : null;

    setPreferPortrait(false);
    setIsEditingCustom(false);
    lastSyncedRatio.current = null;
    updateLocalRotation(null);

    setOverlay('thirds');

    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aspectRatio: originalAspectRatio,
      crop: INITIAL_ADJUSTMENTS.crop,
      flipHorizontal: INITIAL_ADJUSTMENTS.flipHorizontal ?? false,
      flipVertical: INITIAL_ADJUSTMENTS.flipVertical ?? false,
      orientationSteps: INITIAL_ADJUSTMENTS.orientationSteps ?? 0,
      rotation: INITIAL_ADJUSTMENTS.rotation ?? 0,
      transformDistortion: INITIAL_ADJUSTMENTS.transformDistortion ?? 0,
      transformVertical: INITIAL_ADJUSTMENTS.transformVertical ?? 0,
      transformHorizontal: INITIAL_ADJUSTMENTS.transformHorizontal ?? 0,
      transformRotate: INITIAL_ADJUSTMENTS.transformRotate ?? 0,
      transformAspect: INITIAL_ADJUSTMENTS.transformAspect ?? 0,
      transformScale: INITIAL_ADJUSTMENTS.transformScale ?? 100,
      transformXOffset: INITIAL_ADJUSTMENTS.transformXOffset ?? 0,
      transformYOffset: INITIAL_ADJUSTMENTS.transformYOffset ?? 0,
      guidedPerspective: INITIAL_ADJUSTMENTS.guidedPerspective,
      lensMaker: INITIAL_ADJUSTMENTS.lensMaker,
      lensModel: INITIAL_ADJUSTMENTS.lensModel,
      lensDistortionAmount: INITIAL_ADJUSTMENTS.lensDistortionAmount,
      lensVignetteAmount: INITIAL_ADJUSTMENTS.lensVignetteAmount,
      lensTcaAmount: INITIAL_ADJUSTMENTS.lensTcaAmount,
      lensDistortionEnabled: INITIAL_ADJUSTMENTS.lensDistortionEnabled,
      lensTcaEnabled: INITIAL_ADJUSTMENTS.lensTcaEnabled,
      lensVignetteEnabled: INITIAL_ADJUSTMENTS.lensVignetteEnabled,
      lensDistortionParams: INITIAL_ADJUSTMENTS.lensDistortionParams,
      lensCorrectionMode: INITIAL_ADJUSTMENTS.lensCorrectionMode,
    }));
  };

  const isPresetActive = (preset: CropPreset) => preset === activePreset;
  const isOrientationToggleDisabled = !aspectRatio || aspectRatio === 1 || activePreset?.value === ORIGINAL_RATIO;

  const fineRotation = useMemo(() => {
    return rotation || 0;
  }, [rotation]);

  const displayRotation = localRotation !== null ? localRotation : fineRotation;

  const handleFineRotationChange = (e: any) => {
    const newFineRotation = parseFloat(e.target.value);
    if (isRotationActive) {
      updateLocalRotation(newFineRotation);
    } else {
      setAdjustments((prev: Adjustments) => ({ ...prev, rotation: newFineRotation }));
    }
  };

  const resetFineRotation = () => {
    updateLocalRotation(null);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, rotation: 0 }));
  };

  const handleOverlayCycle = () => {
    const currentIndex = OVERLAYS.findIndex((o) => o.id === activeOverlay);
    const nextIndex = (currentIndex + 1) % OVERLAYS.length;
    setOverlay(OVERLAYS[nextIndex].id);
  };

  const getOverlayTooltip = () => {
    const current = OVERLAYS.find((o) => o.id === activeOverlay);
    if (!current) return t('editor.crop.tooltips.compositionOverlay');
    const isRotatable = ['goldenSpiral', 'goldenTriangle'].includes(activeOverlay);
    const rotateHint = isRotatable ? t('editor.crop.tooltips.rotateHint') : '';
    return t('editor.crop.tooltips.overlayDetails', { name: current.name, rotateHint });
  };

  const getOrientationTooltip = () => {
    if (isOrientationToggleDisabled) {
      return t('editor.crop.tooltips.switchOrientation');
    }
    return orientation === Orientation.Vertical
      ? t('editor.crop.tooltips.switchToLandscape')
      : t('editor.crop.tooltips.switchToPortrait');
  };

  const handleDragStateChange = useCallback(
    (isDragging: boolean) => {
      if (isDragging) {
        setIsRotationActive(true);
        setEditor({ isRotationActive: true });
      } else {
        setIsRotationActive(false);
        setEditor({ isRotationActive: false });
        if (localRotationRef.current !== null) {
          const finalRot = localRotationRef.current;
          updateLocalRotation(null);
          setAdjustments((prev: Adjustments) => ({ ...prev, rotation: finalRot }));
        }
      }
    },
    [setEditor, updateLocalRotation, setAdjustments],
  );

  const fetchDistortionParams = useCallback(
    async (maker: string, model: string) => {
      try {
        const distParams: any = await invoke('get_lens_distortion_params', {
          maker,
          model,
          focalLength: parseExifNumber(selectedImage?.exif?.FocalLength),
          aperture: parseExifNumber(selectedImage?.exif?.FNumber),
          distance: parseExifNumber(selectedImage?.exif?.SubjectDistance),
        });
        return distParams;
      } catch (error) {
        console.error('Failed to fetch lens distortion params', error);
        return null;
      }
    },
    [selectedImage?.exif],
  );

  const handleAutoDetectLens = useCallback(async () => {
    const exifMaker = selectedImage?.exif?.Make;
    const exifModel = selectedImage?.exif?.LensModel;
    const exifCameraModel = selectedImage?.exif?.Model;

    // A camera with a fixed lens writes no LensModel. For such a camera the
    // backend falls back to the Lensfun mount of the camera model.
    if (!exifMaker || (!exifModel && !exifCameraModel)) {
      setDetectionStatus('not_found');
      return;
    }

    setDetectionStatus('detecting');
    try {
      const result: [string, string] | null = await invoke('autodetect_lens', {
        maker: exifMaker,
        model: exifModel ?? '',
        cameraModel: exifCameraModel ?? '',
      });

      if (result) {
        const [detectedMaker, detectedModel] = result;
        const distParams = await fetchDistortionParams(detectedMaker, detectedModel);

        setAdjustments((prev) => ({
          ...prev,
          lensMaker: detectedMaker,
          lensModel: detectedModel,
          lensDistortionParams: distParams,
          lensCorrectionMode: 'auto',
        }));

        setDetectionStatus('success');
        setTimeout(() => setDetectionStatus('idle'), 2000);
      } else {
        setDetectionStatus('not_found');
      }
    } catch {
      setDetectionStatus('not_found');
    }
  }, [selectedImage?.exif, fetchDistortionParams, setAdjustments]);

  const handleMakerChange = useCallback(
    (maker: string) => {
      setAdjustments((prev) => ({
        ...prev,
        lensMaker: maker,
        lensModel: null,
        lensDistortionParams: null,
      }));
      setLenses([]);
    },
    [setAdjustments],
  );

  const handleModelChange = useCallback(
    async (model: string) => {
      if (!adjustments.lensMaker) return;
      const distParams = await fetchDistortionParams(adjustments.lensMaker, model);
      setAdjustments((prev) => ({
        ...prev,
        lensModel: model,
        lensDistortionParams: distParams,
      }));
    },
    [adjustments.lensMaker, fetchDistortionParams, setAdjustments],
  );

  const handleMyLensSelect = useCallback(
    async (val: string) => {
      if (!val || val === 'none') return;
      const index = parseInt(val);
      const selected = myLenses[index];
      if (!selected) return;

      invoke('get_lensfun_lenses_for_maker', { maker: selected.maker })
        .then((l: any) => setLenses(l))
        .catch(console.error);

      const distParams = await fetchDistortionParams(selected.maker, selected.model);

      setAdjustments((prev) => ({
        ...prev,
        lensMaker: selected.maker,
        lensModel: selected.model,
        lensDistortionParams: distParams,
      }));
    },
    [myLenses, fetchDistortionParams, setAdjustments],
  );

  const hasDistortion =
    Math.abs(adjustments.lensDistortionParams?.k1 || 0) > 1e-6 ||
    Math.abs(adjustments.lensDistortionParams?.k2 || 0) > 1e-6 ||
    Math.abs(adjustments.lensDistortionParams?.k3 || 0) > 1e-6;
  const hasTca =
    Math.abs((adjustments.lensDistortionParams?.tca_vr || 1) - 1) > 1e-5 ||
    Math.abs((adjustments.lensDistortionParams?.tca_vb || 1) - 1) > 1e-5;
  const hasVignetting =
    Math.abs(adjustments.lensDistortionParams?.vig_k1 || 0) > 1e-6 ||
    Math.abs(adjustments.lensDistortionParams?.vig_k2 || 0) > 1e-6 ||
    Math.abs(adjustments.lensDistortionParams?.vig_k3 || 0) > 1e-6;

  const myLensOptions = useMemo(() => {
    if (myLenses.length === 0) {
      return [{ label: t('modals.lensCorrection.manageLensesPlaceholder'), value: 'none' }];
    }
    return myLenses.map((l, i) => ({
      label: `${l.maker} - ${l.model}`,
      value: i.toString(),
    }));
  }, [myLenses, t]);

  useEffect(() => {
    const selectedIndex = lensMode === 'auto' ? 0 : 1;
    const targetX = `${selectedIndex * 100}%`;
    const targetWidth = '50%';

    if (isModeInitialAnimation.current) {
      const initialX = lensMode === 'manual' ? '100%' : '-25%';
      setModeBubbleStyle({
        x: [initialX, targetX],
        width: targetWidth,
      });
      isModeInitialAnimation.current = false;
    } else {
      setModeBubbleStyle({
        x: targetX,
        width: targetWidth,
      });
    }
  }, [lensMode]);

  const handleModeChange = useCallback(
    (mode: 'auto' | 'manual') => {
      setAdjustments((prev) => ({ ...prev, lensCorrectionMode: mode }));
      if (mode === 'auto') {
        handleAutoDetectLens();
      }
    },
    [handleAutoDetectLens, setAdjustments],
  );

  const handleTransformContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const handleResetTransform = () => {
      setEditor({ isGuidedPerspectiveActive: false });
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        transformDistortion: INITIAL_ADJUSTMENTS.transformDistortion ?? 0,
        transformVertical: INITIAL_ADJUSTMENTS.transformVertical ?? 0,
        transformHorizontal: INITIAL_ADJUSTMENTS.transformHorizontal ?? 0,
        transformRotate: INITIAL_ADJUSTMENTS.transformRotate ?? 0,
        transformAspect: INITIAL_ADJUSTMENTS.transformAspect ?? 0,
        transformScale: INITIAL_ADJUSTMENTS.transformScale ?? 100,
        transformXOffset: INITIAL_ADJUSTMENTS.transformXOffset ?? 0,
        transformYOffset: INITIAL_ADJUSTMENTS.transformYOffset ?? 0,
        guidedPerspective: INITIAL_ADJUSTMENTS.guidedPerspective,
      }));
    };

    showContextMenu(e.clientX, e.clientY, [
      {
        label: t('editor.adjustments.actions.resetSectionSettings', {
          section: t('modals.transform.title'),
        }),
        icon: RotateCcw,
        onClick: handleResetTransform,
      },
    ]);
  };

  const handleLensContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const handleResetLens = () => {
      setDetectionStatus('idle');
      setLenses([]);
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        lensMaker: INITIAL_ADJUSTMENTS.lensMaker,
        lensModel: INITIAL_ADJUSTMENTS.lensModel,
        lensDistortionAmount: INITIAL_ADJUSTMENTS.lensDistortionAmount,
        lensVignetteAmount: INITIAL_ADJUSTMENTS.lensVignetteAmount,
        lensTcaAmount: INITIAL_ADJUSTMENTS.lensTcaAmount,
        lensDistortionEnabled: INITIAL_ADJUSTMENTS.lensDistortionEnabled,
        lensTcaEnabled: INITIAL_ADJUSTMENTS.lensTcaEnabled,
        lensVignetteEnabled: INITIAL_ADJUSTMENTS.lensVignetteEnabled,
        lensDistortionParams: INITIAL_ADJUSTMENTS.lensDistortionParams,
        lensCorrectionMode: INITIAL_ADJUSTMENTS.lensCorrectionMode,
      }));
    };

    showContextMenu(e.clientX, e.clientY, [
      {
        label: t('editor.adjustments.actions.resetSectionSettings', {
          section: t('modals.lensCorrection.title'),
        }),
        icon: RotateCcw,
        onClick: handleResetLens,
      },
    ]);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('editor.crop.title')}</Text>
        <button
          className="p-2 rounded-full hover:bg-surface transition-colors"
          onClick={handleReset}
          data-tooltip={t('editor.crop.resetTooltip')}
        >
          <RotateCcw size={18} />
        </button>
      </div>

      <div className="grow overflow-y-auto p-3 space-y-6 custom-scrollbar">
        {selectedImage ? (
          <>
            <div className="space-y-4">
              <Text variant={TextVariants.heading} className="mb-2 flex items-center justify-between">
                {t('editor.crop.aspectRatioHeading')}
                <div className="flex items-center gap-2">
                  <button
                    className="p-1.5 rounded-md hover:bg-surface transition-colors"
                    onClick={handleOverlayCycle}
                    data-tooltip={getOverlayTooltip()}
                  >
                    <Grid3x3 size={16} />
                  </button>
                  <button
                    className="p-1.5 rounded-md hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={isOrientationToggleDisabled}
                    onClick={handleOrientationToggle}
                    data-tooltip={getOrientationTooltip()}
                  >
                    {orientation === Orientation.Vertical ? (
                      <RectangleVertical size={16} />
                    ) : (
                      <RectangleHorizontal size={16} />
                    )}
                  </button>
                </div>
              </Text>
              <div className="grid grid-cols-3 gap-2">
                {PRESETS.map((preset: CropPreset) => (
                  <motion.div
                    className={clsx(
                      'px-2 py-1.5 rounded-md transition-colors text-center cursor-pointer',
                      isPresetActive(preset) ? 'bg-accent' : 'bg-surface hover:bg-card-active',
                    )}
                    key={preset.name}
                    onClick={() => handlePresetClick(preset)}
                    data-tooltip={preset.tooltip}
                    whileTap={{ scale: 0.98 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                  >
                    <Text color={isPresetActive(preset) ? TextColors.button : TextColors.secondary}>{preset.name}</Text>
                  </motion.div>
                ))}
              </div>
              <div>
                <motion.div
                  className={clsx(
                    'w-full px-2 py-1.5 rounded-md transition-colors cursor-pointer text-center',
                    isCustomActive ? 'bg-accent' : 'bg-surface hover:bg-card-active',
                  )}
                  onClick={() => {
                    const imageRatio = getEffectiveOriginalRatio();
                    let newAspectRatio = BASE_RATIO;
                    if (preferPortrait || (imageRatio && imageRatio < 1)) {
                      newAspectRatio = 1 / BASE_RATIO;
                    }
                    applyAspectRatio(newAspectRatio);
                  }}
                  data-tooltip={t('editor.crop.presets.custom.tooltip')}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                >
                  <Text color={isCustomActive ? TextColors.button : TextColors.secondary}>
                    {t('editor.crop.presets.custom.name')}
                  </Text>
                </motion.div>
                <div
                  className={clsx(
                    'mt-2 bg-surface p-2 rounded-md transition-opacity',
                    isCustomActive ? 'opacity-100' : 'opacity-50 pointer-events-none',
                  )}
                >
                  <div className="flex items-center justify-center gap-2">
                    <input
                      className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent focus:ring-accent text-text-secondary focus:text-text-primary"
                      min="0"
                      name="customW"
                      onBlur={handleApplyCustomRatio}
                      onChange={handleCustomInputChange}
                      onFocus={handleCustomInputFocus}
                      onKeyDown={handleCustomInputKeyDown}
                      placeholder={t('editor.crop.custom.wPlaceholder')}
                      data-tooltip={t('editor.crop.custom.wTooltip')}
                      type="number"
                      value={customW}
                    />
                    <X size={16} className={`shrink-0 ${TEXT_COLOR_KEYS[TextColors.secondary]}`} />
                    <input
                      className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent focus:ring-accent text-text-secondary focus:text-text-primary"
                      min="0"
                      name="customH"
                      onBlur={handleApplyCustomRatio}
                      onChange={handleCustomInputChange}
                      onFocus={handleCustomInputFocus}
                      onKeyDown={handleCustomInputKeyDown}
                      placeholder={t('editor.crop.custom.hPlaceholder')}
                      data-tooltip={t('editor.crop.custom.hTooltip')}
                      type="number"
                      value={customH}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <Text variant={TextVariants.heading} className="mb-2">
                {t('editor.crop.rotationHeading')}
              </Text>
              <div className="bg-surface px-4 pt-3 pb-4 rounded-lg">
                <Slider
                  label={
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setEditor((state) => ({
                            isStraightenActive: !state.isStraightenActive,
                          }));
                        }}
                        className={clsx(
                          'p-1.5 rounded-md transition-colors',
                          isStraightenActive
                            ? 'bg-accent text-button-text'
                            : 'text-text-secondary hover:bg-card-active hover:text-text-primary',
                        )}
                        data-tooltip={t('editor.crop.tooltips.straighten')}
                      >
                        <Ruler size={14} />
                      </button>
                      <button
                        className="p-1.5 rounded-md text-text-secondary transition-colors cursor-pointer hover:bg-card-active hover:text-text-primary"
                        onClick={resetFineRotation}
                        data-tooltip={t('editor.crop.tooltips.resetFineRotation')}
                        disabled={displayRotation === 0}
                      >
                        <RotateCcw size={14} />
                      </button>
                    </div>
                  }
                  min={-45}
                  max={45}
                  step={0.1}
                  value={displayRotation}
                  defaultValue={0}
                  suffix="°"
                  onChange={handleFineRotationChange}
                  onDragStateChange={handleDragStateChange}
                />
              </div>
            </div>

            <div className="space-y-4">
              <Text variant={TextVariants.heading} className="mb-2">
                {t('editor.crop.orientationHeading')}
              </Text>
              <div className="grid grid-cols-2 gap-2">
                <motion.div
                  className="flex flex-col items-center justify-center p-3 cursor-pointer rounded-lg transition-colors bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary"
                  onClick={() => handleRotate(-90)}
                  data-tooltip={t('editor.crop.tooltips.rotateLeft')}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                >
                  <RotateCcw size={20} className="transition-none" />
                  <span className="text-xs mt-2 transition-none">{t('editor.crop.labels.rotateLeft')}</span>
                </motion.div>
                <motion.div
                  className="flex flex-col items-center justify-center p-3 cursor-pointer rounded-lg transition-colors bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary"
                  onClick={() => handleRotate(90)}
                  data-tooltip={t('editor.crop.tooltips.rotateRight')}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                >
                  <RotateCw size={20} className="transition-none" />
                  <span className="text-xs mt-2 transition-none">{t('editor.crop.labels.rotateRight')}</span>
                </motion.div>
                <motion.div
                  className={clsx(
                    'flex flex-col items-center justify-center p-3 cursor-pointer rounded-lg transition-colors',
                    flipHorizontal
                      ? 'bg-accent text-button-text'
                      : 'bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary',
                  )}
                  onClick={() =>
                    setAdjustments((prev: Adjustments) => ({
                      ...prev,
                      flipHorizontal: !prev.flipHorizontal,
                    }))
                  }
                  data-tooltip={t('editor.crop.tooltips.flipHoriz')}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                >
                  <FlipHorizontal size={20} className="transition-none" />
                  <span className="text-xs mt-2 transition-none">{t('editor.crop.labels.flipHoriz')}</span>
                </motion.div>
                <motion.div
                  className={clsx(
                    'flex flex-col items-center justify-center p-3 cursor-pointer rounded-lg transition-colors',
                    flipVertical
                      ? 'bg-accent text-button-text'
                      : 'bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary',
                  )}
                  onClick={() => setAdjustments((prev: Adjustments) => ({ ...prev, flipVertical: !prev.flipVertical }))}
                  data-tooltip={t('editor.crop.tooltips.flipVert')}
                  whileTap={{ scale: 0.98 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                >
                  <FlipVertical size={20} className="transition-none" />
                  <span className="text-xs mt-2 transition-none">{t('editor.crop.labels.flipVert')}</span>
                </motion.div>
              </div>
            </div>

            <div className="space-y-4">
              <Text variant={TextVariants.heading} className="mb-2">
                {t('modals.transform.title')}
              </Text>
              <div className="bg-surface rounded-xl overflow-hidden" onContextMenu={handleTransformContextMenu}>
                <button
                  onClick={() => toggleSection('transform')}
                  className="w-full flex items-center justify-between p-4 text-text-secondary hover:text-text-primary hover:bg-card-active transition-colors"
                >
                  <Text as="span" variant={TextVariants.label} className="flex items-center gap-3">
                    <Scan size={16} /> {t('modals.transform.geometry')}
                  </Text>
                  {isTransformExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>

                <AnimatePresence initial={false}>
                  {isTransformExpanded && (
                    <motion.div
                      key="transform-accordion"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{
                        height: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] },
                        opacity: { duration: 0.25, ease: 'easeOut' },
                      }}
                      style={{ overflow: 'hidden' }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 pb-4 pt-3 border-t border-surface/50 flex flex-col gap-6">
                        <div>
                          <Text variant={TextVariants.heading} className="mb-2">
                            {t('modals.transform.guided')}
                          </Text>
                          <div className="space-y-3">
                            <motion.button
                              type="button"
                              onClick={() => setEditor({ isGuidedPerspectiveActive: !isGuidedPerspectiveActive })}
                              whileTap={{ scale: 0.98 }}
                              transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                              className={clsx(
                                'w-full flex items-center justify-center p-2.5 rounded-lg text-sm font-medium cursor-pointer transition-colors',
                                isGuidedPerspectiveActive
                                  ? 'bg-accent text-button-text group hover:bg-red-600 hover:text-white'
                                  : 'bg-bg-secondary text-text-secondary hover:bg-card-active hover:text-text-primary',
                              )}
                            >
                              {isGuidedPerspectiveActive ? (
                                <>
                                  <span className="flex items-center gap-2 group-hover:hidden">
                                    <Cuboid size={16} />
                                    {t('editor.guided.drawingActive')}
                                  </span>
                                  <span className="hidden items-center gap-2 group-hover:flex">
                                    <Ban size={16} />
                                    {t('editor.guided.cancel')}
                                  </span>
                                </>
                              ) : (
                                <span className="flex items-center gap-2">
                                  <Cuboid size={16} />
                                  {t('modals.transform.guided')}
                                </span>
                              )}
                            </motion.button>

                            {adjustments.guidedPerspective?.lines && adjustments.guidedPerspective.lines.length > 0 && (
                              <div className="p-3 bg-bg-primary rounded-md border border-surface flex flex-col gap-2">
                                <div className="flex justify-between items-center text-xs font-medium">
                                  <span>{t('editor.guided.linesStatus')}</span>
                                  <span
                                    className={clsx(
                                      adjustments.guidedPerspective.lines.length >= 2
                                        ? 'text-accent'
                                        : 'text-text-secondary',
                                    )}
                                  >
                                    {adjustments.guidedPerspective.lines.length} / 4
                                  </span>
                                </div>
                                <div className="flex flex-col gap-1 mt-1">
                                  {adjustments.guidedPerspective.lines.map((line: any, idx: number) => (
                                    <div
                                      key={line.id}
                                      className="flex items-center gap-2 p-2 rounded-md bg-surface transition-colors group"
                                    >
                                      <Text
                                        as="div"
                                        color={TextColors.secondary}
                                        className="p-0.5 rounded transition-colors shrink-0 flex items-center justify-center"
                                      >
                                        <Minus size={16} />
                                      </Text>
                                      <div className="flex-1 min-w-0">
                                        <Text
                                          color={TextColors.primary}
                                          weight={TextWeights.medium}
                                          className="truncate select-none text-xs capitalize"
                                        >
                                          {line.type} Guide #{idx + 1}
                                        </Text>
                                      </div>
                                      <button
                                        className="p-1 hover:text-red-500 text-text-secondary transition-colors"
                                        onClick={() => {
                                          const newLines = adjustments.guidedPerspective!.lines.filter(
                                            (l: any) => l.id !== line.id,
                                          );
                                          setAdjustments((prev) => ({
                                            ...prev,
                                            guidedPerspective: {
                                              ...prev.guidedPerspective,
                                              lines: newLines,
                                              enabled: newLines.length >= 2,
                                            },
                                          }));
                                        }}
                                      >
                                        <Trash2 size={16} />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>

                        <div>
                          <Text variant={TextVariants.heading} className="mb-2">
                            {t('modals.transform.distortion')}
                          </Text>
                          <div className="space-y-3">
                            <Slider
                              label={t('modals.transform.amount')}
                              step={1}
                              value={adjustments.transformDistortion || 0}
                              min={-100}
                              max={100}
                              defaultValue={0}
                              onChange={(e) =>
                                setAdjustments((prev) => ({
                                  ...prev,
                                  transformDistortion: Number(e.target.value),
                                }))
                              }
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
                              step={1}
                              value={adjustments.transformVertical || 0}
                              min={-100}
                              max={100}
                              defaultValue={0}
                              onChange={(e) =>
                                setAdjustments((prev) => ({
                                  ...prev,
                                  transformVertical: Number(e.target.value),
                                }))
                              }
                            />
                            <Slider
                              label={t('modals.transform.horizontal')}
                              step={1}
                              value={adjustments.transformHorizontal || 0}
                              min={-100}
                              max={100}
                              defaultValue={0}
                              onChange={(e) =>
                                setAdjustments((prev) => ({
                                  ...prev,
                                  transformHorizontal: Number(e.target.value),
                                }))
                              }
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
                              step={0.1}
                              value={adjustments.transformRotate || 0}
                              min={-45}
                              max={45}
                              defaultValue={0}
                              onChange={(e) =>
                                setAdjustments((prev) => ({
                                  ...prev,
                                  transformRotate: Number(e.target.value),
                                }))
                              }
                            />
                            <Slider
                              label={t('modals.transform.aspect')}
                              step={1}
                              value={adjustments.transformAspect || 0}
                              min={-100}
                              max={100}
                              defaultValue={0}
                              onChange={(e) =>
                                setAdjustments((prev) => ({
                                  ...prev,
                                  transformAspect: Number(e.target.value),
                                }))
                              }
                            />
                            <Slider
                              label={t('modals.transform.scale')}
                              step={1}
                              value={adjustments.transformScale || 100}
                              min={50}
                              max={150}
                              defaultValue={100}
                              onChange={(e) =>
                                setAdjustments((prev) => ({
                                  ...prev,
                                  transformScale: Number(e.target.value),
                                }))
                              }
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
                              step={1}
                              value={adjustments.transformXOffset || 0}
                              min={-100}
                              max={100}
                              defaultValue={0}
                              onChange={(e) =>
                                setAdjustments((prev) => ({
                                  ...prev,
                                  transformXOffset: Number(e.target.value),
                                }))
                              }
                            />
                            <Slider
                              label={t('modals.transform.yAxis')}
                              step={1}
                              value={adjustments.transformYOffset || 0}
                              min={-100}
                              max={100}
                              defaultValue={0}
                              onChange={(e) =>
                                setAdjustments((prev) => ({
                                  ...prev,
                                  transformYOffset: Number(e.target.value),
                                }))
                              }
                            />
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <div className="space-y-4">
              <Text variant={TextVariants.heading} className="mb-2">
                {t('modals.lensCorrection.title')}
              </Text>
              <div className="bg-surface rounded-xl overflow-hidden mb-6" onContextMenu={handleLensContextMenu}>
                <button
                  onClick={() => toggleSection('lens')}
                  className="w-full flex items-center justify-between p-4 text-text-secondary hover:text-text-primary hover:bg-card-active transition-colors"
                >
                  <Text as="span" variant={TextVariants.label} className="flex items-center gap-3">
                    <Aperture size={16} /> {t('modals.lensCorrection.title')}
                  </Text>
                  {isLensExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>

                <AnimatePresence initial={false}>
                  {isLensExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 pb-4 pt-2 border-t border-surface/50 flex flex-col gap-4">
                        <div className="w-full p-1 bg-card-active rounded-md">
                          <div className="relative flex w-full">
                            <motion.div
                              className="absolute top-0 bottom-0 z-0 bg-accent"
                              style={{ borderRadius: 6 }}
                              animate={modeBubbleStyle}
                              transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
                            />
                            <button
                              onClick={() => handleModeChange('auto')}
                              className={clsx(
                                'relative flex-1 flex items-center justify-center gap-2 px-3 p-1.5 text-sm font-medium rounded-md transition-colors',
                                lensMode === 'auto' ? 'text-button-text' : 'text-text-primary hover:bg-surface/50',
                              )}
                              style={{ WebkitTapHighlightColor: 'transparent' }}
                            >
                              <span className="relative z-10 flex items-center">
                                {t('modals.lensCorrection.modeAuto')}
                              </span>
                            </button>
                            <button
                              onClick={() => handleModeChange('manual')}
                              className={clsx(
                                'relative flex-1 flex items-center justify-center gap-2 px-3 p-1.5 text-sm font-medium rounded-md transition-colors',
                                lensMode === 'manual' ? 'text-button-text' : 'text-text-primary hover:bg-surface/50',
                              )}
                              style={{ WebkitTapHighlightColor: 'transparent' }}
                            >
                              <span className="relative z-10 flex items-center">
                                {t('modals.lensCorrection.modeManual')}
                              </span>
                            </button>
                          </div>
                        </div>

                        {lensMode === 'auto' ? (
                          <div
                            className={clsx(
                              'w-full flex items-center justify-center gap-2 p-3 text-sm rounded-md border transition-colors',
                              detectionStatus === 'not_found'
                                ? 'bg-red-500/10 text-red-400 border-red-500/20'
                                : adjustments.lensMaker
                                  ? 'bg-green-500/10 text-green-400 border-green-500/20'
                                  : 'bg-bg-primary border-surface text-text-secondary',
                            )}
                          >
                            {detectionStatus === 'detecting' ? (
                              <>
                                <Loader size={16} className="animate-spin" /> {t('modals.lensCorrection.detectingExif')}
                              </>
                            ) : detectionStatus === 'not_found' ? (
                              t('modals.lensCorrection.lensProfileNotFound')
                            ) : adjustments.lensMaker && adjustments.lensModel ? (
                              <>
                                <Check size={16} /> {adjustments.lensMaker} - {adjustments.lensModel}
                              </>
                            ) : (
                              <>
                                <Search size={16} /> {t('modals.lensCorrection.waitingAutoDetect')}
                              </>
                            )}
                          </div>
                        ) : (
                          <>
                            <Dropdown
                              options={myLensOptions}
                              value=""
                              onChange={handleMyLensSelect}
                              placeholder={t('modals.lensCorrection.chooseSavedLens')}
                            />
                            <Dropdown
                              options={makers.map((m) => ({ label: m, value: m }))}
                              value={adjustments.lensMaker || ''}
                              onChange={handleMakerChange}
                              placeholder={t('modals.lensCorrection.selectManufacturer')}
                            />
                            {adjustments.lensMaker && (
                              <Dropdown
                                options={lenses.map((l) => ({ label: l, value: l }))}
                                value={adjustments.lensModel || ''}
                                onChange={handleModelChange}
                                placeholder={t('modals.lensCorrection.selectLensModel')}
                              />
                            )}
                          </>
                        )}

                        <div className="flex flex-col gap-3 mt-2">
                          <div
                            className={clsx(
                              'bg-bg-primary p-3 rounded-md border border-surface transition-colors',
                              hasDistortion ? '' : 'opacity-50 grayscale',
                            )}
                          >
                            <div className="flex items-center gap-3">
                              <SquareDashed size={16} className="text-text-secondary shrink-0" />
                              <Switch
                                className="grow"
                                label={t('modals.lensCorrection.distortion')}
                                disabled={!hasDistortion}
                                checked={(adjustments.lensDistortionEnabled ?? true) && hasDistortion}
                                onChange={(v) => setAdjustments((prev) => ({ ...prev, lensDistortionEnabled: v }))}
                              />
                            </div>
                            <AnimatePresence initial={false}>
                              {hasDistortion && (adjustments.lensDistortionEnabled ?? true) && (
                                <motion.div
                                  initial={{ height: 0, opacity: 0, marginTop: 0 }}
                                  animate={{ height: 'auto', opacity: 1, marginTop: 16 }}
                                  exit={{ height: 0, opacity: 0, marginTop: 0 }}
                                  className="px-2 overflow-hidden"
                                >
                                  <Slider
                                    label={t('modals.lensCorrection.amount')}
                                    step={1}
                                    value={adjustments.lensDistortionAmount ?? 100}
                                    min={0}
                                    max={200}
                                    defaultValue={100}
                                    onChange={(e) =>
                                      setAdjustments((prev) => ({
                                        ...prev,
                                        lensDistortionAmount: Number(e.target.value),
                                      }))
                                    }
                                  />
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>

                          <div
                            className={clsx(
                              'bg-bg-primary p-3 rounded-md border border-surface transition-colors',
                              hasTca ? '' : 'opacity-50 grayscale',
                            )}
                          >
                            <div className="flex items-center gap-3">
                              <Activity size={16} className="text-text-secondary shrink-0" />
                              <Switch
                                className="grow"
                                label={t('modals.lensCorrection.chromaticAberration')}
                                disabled={!hasTca}
                                checked={(adjustments.lensTcaEnabled ?? true) && hasTca}
                                onChange={(v) => setAdjustments((prev) => ({ ...prev, lensTcaEnabled: v }))}
                              />
                            </div>
                            <AnimatePresence initial={false}>
                              {hasTca && (adjustments.lensTcaEnabled ?? true) && (
                                <motion.div
                                  initial={{ height: 0, opacity: 0, marginTop: 0 }}
                                  animate={{ height: 'auto', opacity: 1, marginTop: 16 }}
                                  exit={{ height: 0, opacity: 0, marginTop: 0 }}
                                  className="px-2 overflow-hidden"
                                >
                                  <Slider
                                    label={t('modals.lensCorrection.amount')}
                                    step={1}
                                    value={adjustments.lensTcaAmount ?? 100}
                                    min={0}
                                    max={200}
                                    defaultValue={100}
                                    onChange={(e) =>
                                      setAdjustments((prev) => ({
                                        ...prev,
                                        lensTcaAmount: Number(e.target.value),
                                      }))
                                    }
                                  />
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>

                          <div
                            className={clsx(
                              'bg-bg-primary p-3 rounded-md border border-surface transition-colors',
                              hasVignetting ? '' : 'opacity-50 grayscale',
                            )}
                          >
                            <div className="flex items-center gap-3">
                              <CircleDashed size={16} className="text-text-secondary shrink-0" />
                              <Switch
                                className="grow"
                                label={t('modals.lensCorrection.vignetting')}
                                disabled={!hasVignetting}
                                checked={(adjustments.lensVignetteEnabled ?? true) && hasVignetting}
                                onChange={(v) => setAdjustments((prev) => ({ ...prev, lensVignetteEnabled: v }))}
                              />
                            </div>
                            <AnimatePresence initial={false}>
                              {hasVignetting && (adjustments.lensVignetteEnabled ?? true) && (
                                <motion.div
                                  initial={{ height: 0, opacity: 0, marginTop: 0 }}
                                  animate={{ height: 'auto', opacity: 1, marginTop: 16 }}
                                  exit={{ height: 0, opacity: 0, marginTop: 0 }}
                                  className="px-2 overflow-hidden"
                                >
                                  <Slider
                                    label={t('modals.lensCorrection.amount')}
                                    step={1}
                                    value={adjustments.lensVignetteAmount ?? 100}
                                    min={0}
                                    max={200}
                                    defaultValue={100}
                                    onChange={(e) =>
                                      setAdjustments((prev) => ({
                                        ...prev,
                                        lensVignetteAmount: Number(e.target.value),
                                      }))
                                    }
                                  />
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        </div>

                        <Text
                          as="div"
                          variant={TextVariants.small}
                          className="p-3 mt-2 bg-bg-primary rounded-md border border-surface flex items-start gap-3"
                        >
                          <Info size={16} className="shrink-0 mt-0.5" />
                          <div className="leading-tight space-y-1">
                            <Trans
                              i18nKey="modals.lensCorrection.databaseNotice"
                              components={[
                                <a
                                  key="0"
                                  href="https://lensfun.github.io/"
                                  target="_blank"
                                  rel="noreferrer"
                                  className="underline hover:text-primary transition-colors"
                                />,
                                <a
                                  key="1"
                                  href="https://creativecommons.org/licenses/by-sa/3.0/"
                                  target="_blank"
                                  rel="noreferrer"
                                  className="underline hover:text-primary transition-colors"
                                />,
                              ]}
                            />
                          </div>
                        </Text>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <Text
              variant={TextVariants.heading}
              color={TextColors.secondary}
              weight={TextWeights.normal}
              className="text-center"
            >
              {t('editor.ai.noImageSelected')}
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
