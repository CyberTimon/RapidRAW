import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Check, RotateCcw } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import throttle from 'lodash.throttle';
import Button from '../ui/Button';
import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import { Adjustments, GuideLine } from '../../utils/adjustments';
import { Panel, SelectedImage } from '../ui/AppProperties';
import { useEditorStore } from '../../store/useEditorStore';
import { useUIStore } from '../../store/useUIStore';
import GuidedPerspectiveOverlay, {
  GuidedResultJson,
} from '../panel/editor/overlays/GuidedPerspectiveOverlay';

interface GuidedPerspectiveModalProps {
  isOpen: boolean;
  onClose(): void;
  onApply(): void;
  currentAdjustments: Adjustments;
  selectedImage: SelectedImage | null;
}

const SLIDER_DIVISOR = 100.0;

function buildGuidedParams(adjustments: Adjustments, lines: GuideLine[]) {
  return {
    distortion: 0,
    vertical: 0,
    horizontal: 0,
    rotate: 0,
    aspect: 0,
    scale: 100,
    x_offset: 0,
    y_offset: 0,
    lens_distortion_amount: (adjustments.lensDistortionAmount ?? 100) / SLIDER_DIVISOR,
    lens_vignette_amount: (adjustments.lensVignetteAmount ?? 100) / SLIDER_DIVISOR,
    lens_tca_amount: (adjustments.lensTcaAmount ?? 100) / SLIDER_DIVISOR,
    lens_dist_k1: adjustments.lensDistortionParams?.k1 ?? 0,
    lens_dist_k2: adjustments.lensDistortionParams?.k2 ?? 0,
    lens_dist_k3: adjustments.lensDistortionParams?.k3 ?? 0,
    lens_model: adjustments.lensDistortionParams?.model ?? 0,
    tca_vr: adjustments.lensDistortionParams?.tca_vr ?? 1.0,
    tca_vb: adjustments.lensDistortionParams?.tca_vb ?? 1.0,
    vig_k1: adjustments.lensDistortionParams?.vig_k1 ?? 0,
    vig_k2: adjustments.lensDistortionParams?.vig_k2 ?? 0,
    vig_k3: adjustments.lensDistortionParams?.vig_k3 ?? 0,
    lens_distortion_enabled: adjustments.lensDistortionEnabled ?? true,
    lens_tca_enabled: adjustments.lensTcaEnabled ?? true,
    lens_vignette_enabled: adjustments.lensVignetteEnabled ?? true,
    guided_perspective_enabled: lines.length >= 2,
    guided_lines: lines.map((l) => ({ id: l.id, type: l.type, p1: l.p1, p2: l.p2 })),
  };
}

export default function GuidedPerspectiveModal({
  isOpen,
  onClose,
  onApply,
  currentAdjustments,
  selectedImage,
}: GuidedPerspectiveModalProps) {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const guidedLines = useEditorStore((s) => s.guidedLines);
  const selectedGuideLineId = useEditorStore((s) => s.selectedGuideLineId);
  const guidedResult = useEditorStore((s) => s.guidedResult);
  const guidedPreviewUrl = useEditorStore((s) => s.guidedPreviewUrl);
  const guidedAutoCrop = useEditorStore((s) => s.guidedAutoCrop);
  const setEditor = useEditorStore((s) => s.setEditor);

  const solveGen = useRef(0);
  const compositeInFlight = useRef(false);
  const compositePending = useRef(false);
  const compositeGen = useRef(0);

  const measure = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    setStageSize({ width: el.clientWidth, height: el.clientHeight });
  }, []);

  useEffect(() => {
    const el = imgRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, guidedPreviewUrl, fallbackUrl]);

  const throttledGuidedSolve = useMemo(
    () =>
      throttle(
        (lines: GuideLine[], width: number, height: number) => {
          const gen = ++solveGen.current;
          invoke<GuidedResultJson>('calculate_guided_perspective', { lines, width, height })
            .then((res) => {
              if (gen !== solveGen.current) return;
              if (!useEditorStore.getState().isGuidedPerspectiveActive) return;
              useEditorStore.getState().setEditor({ guidedResult: res });
            })
            .catch(() => {});
        },
        50,
        { leading: true, trailing: true },
      ),
    [],
  );

  useEffect(() => {
    if (!isOpen || !selectedImage?.width) return;
    throttledGuidedSolve(guidedLines, selectedImage.width, selectedImage.height);
  }, [isOpen, guidedLines, selectedImage, throttledGuidedSolve]);

  const runComposite = useCallback(
    (lines: GuideLine[]) => {
      if (!isOpen) return;
      if (compositeInFlight.current) {
        compositePending.current = true;
        return;
      }
      compositeInFlight.current = true;
      const gen = ++compositeGen.current;
      const fullParams = buildGuidedParams(currentAdjustments, lines);
      invoke<string>('preview_geometry_transform', {
        params: fullParams,
        jsAdjustments: currentAdjustments,
        showLines: false,
      })
        .then((result) => {
          if (gen !== compositeGen.current) return;
          if (!useEditorStore.getState().isGuidedPerspectiveActive) return;
          useEditorStore.getState().setEditor({ guidedPreviewUrl: result });
          if (lines.length < 2) {
            setFallbackUrl(result);
          }
        })
        .catch(() => {})
        .finally(() => {
          compositeInFlight.current = false;
          if (compositePending.current && gen === compositeGen.current) {
            compositePending.current = false;
            runComposite(useEditorStore.getState().guidedLines);
          }
        });
    },
    [isOpen, currentAdjustments],
  );

  useEffect(() => {
    if (!isOpen) {
      compositeGen.current += 1;
      if (useEditorStore.getState().guidedPreviewUrl) {
        useEditorStore.getState().setEditor({ guidedPreviewUrl: null });
      }
      return;
    }
    runComposite(guidedLines);
  }, [isOpen, guidedLines, currentAdjustments, runComposite]);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    }
    setShow(false);
    const timer = setTimeout(() => {
      setIsMounted(false);
      setFallbackUrl(null);
    }, 300);
    return () => clearTimeout(timer);
  }, [isOpen]);

  useEffect(
    () => () => {
      throttledGuidedSolve.cancel();
      solveGen.current += 1;
      compositeGen.current += 1;
      if (
        useEditorStore.getState().isGuidedPerspectiveActive &&
        useUIStore.getState().activePanel !== Panel.Crop
      ) {
        onClose();
      }
    },
    [],
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
            <div className="grow min-h-0 overflow-hidden">
              <div className="modal-preview-adjustments flex flex-row h-full w-full overflow-hidden">
                <div className="modal-preview-pane grow flex items-center justify-center relative min-h-0 bg-[#0f0f0f] overflow-hidden">
                  <div className="relative inline-block shadow-2xl max-h-full max-w-full">
                    <img
                      ref={imgRef}
                      src={guidedPreviewUrl || fallbackUrl || undefined}
                      alt=""
                      className="block object-contain"
                      style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto' }}
                      draggable={false}
                      onLoad={measure}
                    />
                    <GuidedPerspectiveOverlay
                      lines={guidedLines}
                      selectedLineId={selectedGuideLineId}
                      result={guidedResult}
                      autoCrop={guidedAutoCrop}
                      imageWidth={selectedImage?.width ?? 0}
                      imageHeight={selectedImage?.height ?? 0}
                      stageWidth={stageSize.width}
                      stageHeight={stageSize.height}
                      orientationSteps={currentAdjustments.orientationSteps || 0}
                      flipHorizontal={!!currentAdjustments.flipHorizontal}
                      flipVertical={!!currentAdjustments.flipVertical}
                      onLinesChange={(next) => setEditor({ guidedLines: next })}
                      onSelectLine={(id) => setEditor({ selectedGuideLineId: id })}
                    />
                  </div>
                </div>
                <div className="modal-adjustments-pane w-80 shrink-0 bg-bg-secondary flex flex-col border-l border-surface h-full z-10">
                  <div className="p-4 flex justify-between items-center shrink-0 border-b border-surface">
                    <Text variant={TextVariants.title}>{t('modals.guidedPerspective.title')}</Text>
                    <button
                      onClick={() =>
                        setEditor({
                          guidedLines: [],
                          guidedResult: null,
                          guidedPreviewUrl: null,
                          selectedGuideLineId: null,
                        })
                      }
                      data-tooltip={t('modals.guidedPerspective.resetTooltip')}
                      className="p-2 rounded-full hover:bg-surface transition-colors"
                    >
                      <RotateCcw size={18} />
                    </button>
                  </div>
                  <div className="grow overflow-y-auto p-4 flex flex-col gap-6">
                    <Text variant={TextVariants.body} color={TextColors.secondary}>
                      {t('editor.guided.hint')}
                    </Text>
                    <Text variant={TextVariants.body}>
                      {t('editor.guided.lineCount', { count: guidedLines.length })}
                    </Text>
                    <Switch
                      label={t('editor.guided.constrainCrop')}
                      checked={guidedAutoCrop}
                      onChange={() => setEditor({ guidedAutoCrop: !guidedAutoCrop })}
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className="shrink-0 p-4 flex justify-end gap-3 border-t border-surface bg-bg-secondary z-20">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
              >
                {t('modals.guidedPerspective.cancel')}
              </button>
              <Button onClick={onApply} disabled={!guidedResult?.valid}>
                <Check className="mr-2" size={16} />
                {t('modals.guidedPerspective.apply')}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
