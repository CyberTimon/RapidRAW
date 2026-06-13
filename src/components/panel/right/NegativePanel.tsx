import { ComponentProps, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
import { Info, Loader2, Wand2 } from 'lucide-react';
import Slider from '../../ui/Slider';
import Switch from '../../ui/Switch';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { Adjustments, INITIAL_NEGATIVE, NegativeAdjustment } from '../../../utils/adjustments';
import { useEditorStore } from '../../../store/useEditorStore';
import { useEditorActions } from '../../../hooks/useEditorActions';

const isAtIdentityBounds = (n: NegativeAdjustment) =>
  n.redMin === INITIAL_NEGATIVE.redMin &&
  n.redMax === INITIAL_NEGATIVE.redMax &&
  n.greenMin === INITIAL_NEGATIVE.greenMin &&
  n.greenMax === INITIAL_NEGATIVE.greenMax &&
  n.blueMin === INITIAL_NEGATIVE.blueMin &&
  n.blueMax === INITIAL_NEGATIVE.blueMax;

export default function NegativePanel() {
  const { t } = useTranslation();
  const { setAdjustments } = useEditorActions();

  const { adjustments, selectedImage, setEditor } = useEditorStore(
    useShallow((state) => ({
      adjustments: state.adjustments,
      selectedImage: state.selectedImage,
      setEditor: state.setEditor,
    })),
  );

  const onDragStateChange = useCallback(
    (isDragging: boolean) => setEditor({ isSliderDragging: isDragging }),
    [setEditor],
  );

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const autoFiredFor = useRef<string | null>(null);

  const negative: NegativeAdjustment = adjustments.negative || { ...INITIAL_NEGATIVE };

  const patchNegative = useCallback(
    (patch: Partial<NegativeAdjustment>) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        negative: { ...(prev.negative || INITIAL_NEGATIVE), ...patch },
      }));
    },
    [setAdjustments],
  );

  const runAnalysis = useCallback(async () => {
    if (!selectedImage?.path) return;
    setIsAnalyzing(true);
    try {
      const result: number[] = await invoke('analyze_negative_bounds', {
        path: selectedImage.path,
        jsAdjustments: adjustments,
      });
      if (Array.isArray(result) && result.length === 6) {
        patchNegative({
          redMin: result[0],
          redMax: result[1],
          greenMin: result[2],
          greenMax: result[3],
          blueMin: result[4],
          blueMax: result[5],
        });
      }
    } catch (e) {
      console.error('analyze_negative_bounds failed', e);
    } finally {
      setIsAnalyzing(false);
    }
  }, [selectedImage?.path, patchNegative, adjustments]);

  // Auto-fire analysis the first time the user enables this for a given image,
  // but only if bounds are still at their identity defaults.
  useEffect(() => {
    const path = selectedImage?.path;
    if (!path) return;
    if (!negative.enabled) {
      autoFiredFor.current = null;
      return;
    }
    if (autoFiredFor.current === path) return;
    if (!isAtIdentityBounds(negative)) {
      autoFiredFor.current = path;
      return;
    }
    autoFiredFor.current = path;
    runAnalysis();
  }, [negative.enabled, selectedImage?.path, negative, runAnalysis]);

  const sliderChange =
    (key: keyof NegativeAdjustment): ComponentProps<typeof Slider>['onChange'] =>
    (e) => {
      patchNegative({ [key]: Number(e.target.value) } as Partial<NegativeAdjustment>);
    };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('editor.negative.title')}</Text>
      </div>
      <div className="grow overflow-y-auto p-4">
        <div className="space-y-4">
          <div className="p-2 bg-bg-tertiary rounded-md">
            <div className="flex items-center justify-between mb-2">
              <Switch
                className="flex-1"
                label={t('editor.negative.enable')}
                checked={negative.enabled}
                onChange={(val: boolean) => patchNegative({ enabled: val })}
              />
            </div>

            <button
              onClick={runAnalysis}
              disabled={!selectedImage?.path || isAnalyzing}
              className="w-full mt-1 px-3 py-2 rounded-md text-sm flex items-center justify-center gap-2 bg-surface hover:bg-card-active disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isAnalyzing ? <Loader2 className="animate-spin" size={14} /> : <Wand2 size={14} />}
              {isAnalyzing ? t('editor.negative.analyzing') : t('editor.negative.autoAnalyze')}
            </button>
          </div>

          <div
            className={
              'p-2 bg-bg-tertiary rounded-md transition-opacity duration-150 ' +
              (negative.enabled ? '' : 'opacity-50 pointer-events-none')
            }
          >
            <Text variant={TextVariants.heading} className="mb-2">
              {t('editor.negative.dynamicRange')}
            </Text>
            <Slider
              label={t('editor.negative.blackClip')}
              min={-0.5}
              max={0.5}
              step={0.01}
              defaultValue={0}
              value={negative.blackClip}
              onChange={sliderChange('blackClip')}
              onDragStateChange={onDragStateChange}
            />
            <Slider
              label={t('editor.negative.whiteClip')}
              min={-0.5}
              max={0.5}
              step={0.01}
              defaultValue={0}
              value={negative.whiteClip}
              onChange={sliderChange('whiteClip')}
              onDragStateChange={onDragStateChange}
            />
          </div>

          <div
            className={
              'p-2 bg-bg-tertiary rounded-md transition-opacity duration-150 ' +
              (negative.enabled ? '' : 'opacity-50 pointer-events-none')
            }
          >
            <Text variant={TextVariants.heading} className="mb-2">
              {t('modals.negativeConversion.printGrade')}
            </Text>
            <Slider
              label={t('modals.negativeConversion.exposure')}
              min={-2}
              max={2}
              step={0.05}
              defaultValue={0}
              value={negative.exposure}
              onChange={sliderChange('exposure')}
              onDragStateChange={onDragStateChange}
            />
            <Slider
              label={t('modals.negativeConversion.contrast')}
              min={0.5}
              max={2.5}
              step={0.05}
              defaultValue={1}
              value={negative.contrast}
              onChange={sliderChange('contrast')}
              fillOrigin="min"
              onDragStateChange={onDragStateChange}
            />
          </div>

          <div
            className={
              'p-2 bg-bg-tertiary rounded-md transition-opacity duration-150 ' +
              (negative.enabled ? '' : 'opacity-50 pointer-events-none')
            }
          >
            <Text variant={TextVariants.heading} className="mb-2">
              {t('editor.negative.curveShape')}
            </Text>
            <Slider
              label={t('editor.negative.toe')}
              min={-1}
              max={1}
              step={0.01}
              defaultValue={0}
              value={negative.toe}
              onChange={sliderChange('toe')}
              onDragStateChange={onDragStateChange}
            />
            <Slider
              label={t('editor.negative.toeWidth')}
              min={0.5}
              max={5}
              step={0.1}
              defaultValue={2.5}
              value={negative.toeWidth}
              onChange={sliderChange('toeWidth')}
              onDragStateChange={onDragStateChange}
            />
            <Slider
              label={t('editor.negative.shoulder')}
              min={-1}
              max={1}
              step={0.01}
              defaultValue={0}
              value={negative.shoulder}
              onChange={sliderChange('shoulder')}
              onDragStateChange={onDragStateChange}
            />
            <Slider
              label={t('editor.negative.shoulderWidth')}
              min={0.5}
              max={5}
              step={0.1}
              defaultValue={2.5}
              value={negative.shoulderWidth}
              onChange={sliderChange('shoulderWidth')}
              onDragStateChange={onDragStateChange}
            />
          </div>

          <Text
            as="div"
            variant={TextVariants.small}
            className="p-3 bg-surface rounded-md border border-surface flex items-center gap-3"
          >
            <Info size={16} className="shrink-0" />
            <div className="text-xs text-text-tertiary leading-tight space-y-1">
              <Trans
                i18nKey="modals.negativeConversion.noticeText"
                components={[
                  <a href="https://github.com/marcinz606/NegPy" target="_blank" rel="noreferrer" className="underline hover:text-primary transition-colors" />,
                  <a href="https://github.com/marcinz606/NegPy/blob/main/LICENSE" target="_blank" rel="noreferrer" className="underline hover:text-primary transition-colors" />,
                ]}
              />
            </div>
          </Text>
        </div>
      </div>
    </div>
  );
}
