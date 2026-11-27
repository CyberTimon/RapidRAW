import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Aperture,
  FlipHorizontal,
  FlipVertical,
  Grid3x3,
  RotateCcw,
  RotateCw,
  Ruler,
  Scan,
  ChevronDown,
  ChevronRight,
  Cuboid,
  Check,
  Loader,
  SquareDashed,
  Activity,
  CircleDashed,
  Minus,
  Trash2,
  Info,
  Ban,
  ScanLine,
} from 'lucide-react';
import { useTranslation, Trans } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Adjustments } from '../../../utils/adjustments';
import { getDefaultAdjustments, getOpenImageDefaults } from '../../../utils/developDefaults';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import Text from '../../ui/Text';
import AspectRatioPicker from '../../ui/AspectRatioPicker';
import PanelHeader from '../../ui/PanelHeader';
import Slider from '../../ui/Slider';
import Switch from '../../ui/Switch';
import Dropdown from '../../ui/Dropdown';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { useEditorStore } from '../../../store/useEditorStore';
import { useEditorActions } from '../../../hooks/useEditorActions';
import { useShortcuts } from '../../../hooks/useShortcuts';
import {
  calculateAreaPreservingCrop,
  calculateCenteredCrop,
  getOrientedDimensions,
  MAX_FINE_ROTATION,
  resolveAspectRatio,
} from '../../../utils/cropUtils';
import { Crop } from 'react-image-crop';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '../../../store/useUIStore';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { OverlayMode } from '../../../types/editor';

interface LensCorrectionInfo {
  maker: string;
  model: string;
  distortion: boolean;
  tca: boolean;
  vignetting: boolean;
}

interface OverlayOption {
  id: OverlayMode;
  name: string;
  tooltip: string;
}

export default function CropPanel() {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const adjustments = useEditorStore((s) => s.adjustments);
  const isStraightenActive = useEditorStore((s) => s.isStraightenActive);
  const isAutoStraightening = useEditorStore((s) => s.isAutoStraightening);
  const isGuidedPerspectiveActive = useEditorStore((s) => s.isGuidedPerspectiveActive);
  const activeOverlay = useEditorStore((s) => s.overlayMode);
  const liveRotation = useEditorStore((s) => s.liveRotation);
  const setEditor = useEditorStore((s) => s.setEditor);
  const { setAdjustments, handleRotate, handleAutoStraighten } = useEditorActions();
  const shortcut = useShortcuts();

  const [isRotationActive, setIsRotationActive] = useState(false);
  const [resetCount, setResetCount] = useState(0);
  const [makers, setMakers] = useState<string[]>([]);
  const [lenses, setLenses] = useState<string[]>([]);
  const [myLenses, setMyLenses] = useState<any[]>([]);
  const [lensInfo, setLensInfo] = useState<LensCorrectionInfo | null | undefined>(undefined);
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
      { id: 'center', name: t('editor.crop.overlays.center.name'), tooltip: t('editor.crop.overlays.center.desc') },
    ],
    [t],
  );

  const updateLocalRotation = useCallback(
    (val: number | null) => {
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

  const { rotation = 0, flipHorizontal = false, flipVertical = false, orientationSteps = 0 } = adjustments;
  const originalDimensions =
    selectedImage?.width && selectedImage?.height
      ? getOrientedDimensions(selectedImage.width, selectedImage.height, orientationSteps)
      : null;

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
    if (!selectedImage?.path) {
      setLensInfo(null);
      return;
    }
    let active = true;
    invoke<LensCorrectionInfo | null>('get_lens_correction_info', {
      path: selectedImage.path,
      selection: { lensCorrectionMode: lensMode, lensMaker: adjustments.lensMaker, lensModel: adjustments.lensModel },
    })
      .then((info) => active && setLensInfo(info))
      .catch(() => active && setLensInfo(null));
    return () => {
      active = false;
    };
  }, [selectedImage?.path, lensMode, adjustments.lensMaker, adjustments.lensModel]);

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

  const applyAspectRatio = useCallback(
    (newAspectRatio: number | null) => {
      if (newAspectRatio === null) {
        setAdjustments((prev: Adjustments) => ({ ...prev, aspectRatio: null }));
        return;
      }
      let newCrop: Crop | null = null;
      if (selectedImage?.width && selectedImage?.height) {
        const ratio = resolveAspectRatio(newAspectRatio, selectedImage, orientationSteps);
        newCrop =
          calculateAreaPreservingCrop(
            selectedImage.width,
            selectedImage.height,
            orientationSteps,
            ratio,
            rotation,
            adjustments.crop,
          ) ?? calculateCenteredCrop(selectedImage.width, selectedImage.height, orientationSteps, ratio, rotation);
      }
      setAdjustments((prev: Adjustments) => ({ ...prev, aspectRatio: newAspectRatio, crop: newCrop }));
    },
    [selectedImage, orientationSteps, rotation, adjustments.crop, setAdjustments],
  );

  const handleReset = async () => {
    updateLocalRotation(null);

    setOverlay('thirds');

    const defaults = await getOpenImageDefaults();
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aspectRatio: defaults.aspectRatio,
      crop: defaults.crop,
      flipHorizontal: defaults.flipHorizontal ?? false,
      flipVertical: defaults.flipVertical ?? false,
      orientationSteps: defaults.orientationSteps ?? 0,
      rotation: defaults.rotation ?? 0,
      transformDistortion: defaults.transformDistortion ?? 0,
      transformVertical: defaults.transformVertical ?? 0,
      transformHorizontal: defaults.transformHorizontal ?? 0,
      transformRotate: defaults.transformRotate ?? 0,
      transformAspect: defaults.transformAspect ?? 0,
      transformScale: defaults.transformScale ?? 100,
      transformXOffset: defaults.transformXOffset ?? 0,
      transformYOffset: defaults.transformYOffset ?? 0,
      guidedPerspective: defaults.guidedPerspective,
      lensMaker: defaults.lensMaker,
      lensModel: defaults.lensModel,
      lensDistortionAmount: defaults.lensDistortionAmount,
      lensVignetteAmount: defaults.lensVignetteAmount,
      lensTcaAmount: defaults.lensTcaAmount,
      lensDistortionEnabled: defaults.lensDistortionEnabled,
      lensTcaEnabled: defaults.lensTcaEnabled,
      lensVignetteEnabled: defaults.lensVignetteEnabled,
      lensCorrectionMode: defaults.lensCorrectionMode,
    }));
    setResetCount((count) => count + 1);
  };

  const fineRotation = useMemo(() => {
    return rotation || 0;
  }, [rotation]);

  const displayRotation = liveRotation ?? fineRotation;

  const handleFineRotationChange = (e: { target: { value: number | string } }) => {
    const newFineRotation = parseFloat(String(e.target.value));
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
    return t('editor.crop.tooltips.overlayName', { name: current.name });
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

  const handleMakerChange = useCallback(
    (maker: string) => {
      setAdjustments((prev) => ({ ...prev, lensMaker: maker, lensModel: null }));
      setLenses([]);
    },
    [setAdjustments],
  );

  const handleModelChange = useCallback(
    (model: string) => setAdjustments((prev) => ({ ...prev, lensModel: model })),
    [setAdjustments],
  );

  const handleMyLensSelect = useCallback(
    (val: string) => {
      if (!val || val === 'none') return;
      const selected = myLenses[parseInt(val)];
      if (!selected) return;

      invoke('get_lensfun_lenses_for_maker', { maker: selected.maker })
        .then((l: any) => setLenses(l))
        .catch(console.error);

      setAdjustments((prev) => ({ ...prev, lensMaker: selected.maker, lensModel: selected.model }));
    },
    [myLenses, setAdjustments],
  );

  const hasDistortion = !!lensInfo?.distortion;
  const hasTca = !!lensInfo?.tca;
  const hasVignetting = !!lensInfo?.vignetting;

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
    (mode: 'auto' | 'manual') => setAdjustments((prev) => ({ ...prev, lensCorrectionMode: mode })),
    [setAdjustments],
  );

  const handleTransformContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const handleResetTransform = () => {
      setEditor({ isGuidedPerspectiveActive: false });
      const defaults = getDefaultAdjustments();
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        transformDistortion: defaults.transformDistortion ?? 0,
        transformVertical: defaults.transformVertical ?? 0,
        transformHorizontal: defaults.transformHorizontal ?? 0,
        transformRotate: defaults.transformRotate ?? 0,
        transformAspect: defaults.transformAspect ?? 0,
        transformScale: defaults.transformScale ?? 100,
        transformXOffset: defaults.transformXOffset ?? 0,
        transformYOffset: defaults.transformYOffset ?? 0,
        guidedPerspective: defaults.guidedPerspective,
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

    const handleResetLens = async () => {
      setLenses([]);
      const defaults = await getOpenImageDefaults();
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        lensMaker: defaults.lensMaker,
        lensModel: defaults.lensModel,
        lensDistortionAmount: defaults.lensDistortionAmount,
        lensVignetteAmount: defaults.lensVignetteAmount,
        lensTcaAmount: defaults.lensTcaAmount,
        lensDistortionEnabled: defaults.lensDistortionEnabled,
        lensTcaEnabled: defaults.lensTcaEnabled,
        lensVignetteEnabled: defaults.lensVignetteEnabled,
        lensCorrectionMode: defaults.lensCorrectionMode,
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
      <PanelHeader title={t('editor.crop.title')}>
        <button
          className="p-2 rounded-full hover:bg-surface transition-colors"
          onClick={handleReset}
          data-tooltip={t('editor.crop.resetTooltip')}
        >
          <RotateCcw size={18} />
        </button>
      </PanelHeader>

      <div className="grow overflow-y-auto p-3 space-y-6 custom-scrollbar">
        {selectedImage ? (
          <>
            <AspectRatioPicker
              key={resetCount}
              title={t('editor.crop.aspectRatioHeading')}
              value={adjustments.aspectRatio}
              original={originalDimensions}
              allowFree
              resetKey={selectedImage.path}
              onChange={applyAspectRatio}
              actions={
                <button
                  className="p-1.5 rounded-md hover:bg-surface transition-colors"
                  onClick={handleOverlayCycle}
                  data-tooltip={getOverlayTooltip()}
                >
                  <Grid3x3 size={16} />
                </button>
              }
            />

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
                        {...shortcut('toggle_crop')}
                      >
                        <Ruler size={14} />
                      </button>
                      <button
                        onClick={handleAutoStraighten}
                        className="p-1.5 rounded-md text-text-secondary transition-colors cursor-pointer hover:bg-card-active hover:text-text-primary disabled:cursor-wait"
                        data-tooltip={t('editor.crop.tooltips.autoStraighten')}
                        {...shortcut('auto_straighten')}
                        disabled={isAutoStraightening}
                      >
                        {isAutoStraightening ? <Loader size={14} className="animate-spin" /> : <ScanLine size={14} />}
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
                  min={-MAX_FINE_ROTATION}
                  max={MAX_FINE_ROTATION}
                  step={0.1}
                  value={displayRotation}
                  defaultValue={0}
                  suffix="°"
                  onChange={handleFineRotationChange}
                  onDragStateChange={handleDragStateChange}
                  speedEditId="rotation"
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
                  {...shortcut('rotate_left')}
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
                  {...shortcut('rotate_right')}
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
                                    {`${adjustments.guidedPerspective.lines.length} / 4`}
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
                                          className="truncate select-none text-xs"
                                        >
                                          {t(
                                            line.type === 'horizontal'
                                              ? 'editor.guided.horizontalLine'
                                              : 'editor.guided.verticalLine',
                                            { index: idx + 1 },
                                          )}
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
                              resetKey="transformDistortion"
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
                              resetKey="transformVertical"
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
                              resetKey="transformHorizontal"
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
                              resetKey="transformRotate"
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
                              resetKey="transformAspect"
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
                              resetKey="transformScale"
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
                              resetKey="transformXOffset"
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
                              resetKey="transformYOffset"
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
                              lensInfo === null
                                ? 'bg-red-500/10 text-red-400 border-red-500/20'
                                : lensInfo
                                  ? 'bg-green-500/10 text-green-400 border-green-500/20'
                                  : 'bg-bg-primary border-surface text-text-secondary',
                            )}
                          >
                            {lensInfo === undefined ? (
                              <>
                                <Loader size={16} className="animate-spin" /> {t('modals.lensCorrection.detectingExif')}
                              </>
                            ) : lensInfo === null ? (
                              t('modals.lensCorrection.lensProfileNotFound')
                            ) : (
                              <>
                                <Check size={16} /> {lensInfo.maker} - {lensInfo.model}
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
                                    resetKey="lensDistortionAmount"
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
                                    resetKey="lensTcaAmount"
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
                                    resetKey="lensVignetteAmount"
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
