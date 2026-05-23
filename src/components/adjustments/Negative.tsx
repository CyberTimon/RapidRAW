import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Info, Loader2, Wand2 } from 'lucide-react';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { Adjustments, INITIAL_NEGATIVE, NegativeAdjustment } from '../../utils/adjustments';
import { useEditorStore } from '../../store/useEditorStore';
import { useShallow } from 'zustand/react/shallow';

interface NegativeProps {
  adjustments: Adjustments;
  setAdjustments(adjustments: Partial<Adjustments> | ((prev: Adjustments) => Partial<Adjustments>)): any;
  onDragStateChange?: (isDragging: boolean) => void;
}

const isAtIdentityBounds = (n: NegativeAdjustment) =>
  n.redMin === INITIAL_NEGATIVE.redMin &&
  n.redMax === INITIAL_NEGATIVE.redMax &&
  n.greenMin === INITIAL_NEGATIVE.greenMin &&
  n.greenMax === INITIAL_NEGATIVE.greenMax &&
  n.blueMin === INITIAL_NEGATIVE.blueMin &&
  n.blueMax === INITIAL_NEGATIVE.blueMax;

export default function NegativePanel({ adjustments, setAdjustments, onDragStateChange }: NegativeProps) {
  const { selectedImage } = useEditorStore(useShallow((state: any) => ({ selectedImage: state.selectedImage })));
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

  const sliderChange = (key: keyof NegativeAdjustment) => (e: any) => {
    patchNegative({ [key]: Number(e.target.value) } as Partial<NegativeAdjustment>);
  };

  return (
    <div className="space-y-4">
      <div className="p-2 bg-bg-tertiary rounded-md">
        <div className="flex items-center justify-between mb-2">
          <Switch
            className="flex-1"
            label="Enable negative inversion"
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
          {isAnalyzing ? 'Analyzing…' : 'Auto-Analyze Bounds'}
        </button>
      </div>

      <div
        className={
          'p-2 bg-bg-tertiary rounded-md transition-opacity duration-150 ' +
          (negative.enabled ? '' : 'opacity-50 pointer-events-none')
        }
      >
        <Text variant={TextVariants.heading} className="mb-2">
          Color Timing
        </Text>
        <Slider
          label="Red (Cyan)"
          min={0.5}
          max={2.0}
          step={0.01}
          defaultValue={1}
          value={negative.redWeight}
          onChange={sliderChange('redWeight')}
          fillOrigin="min"
          onDragStateChange={onDragStateChange}
        />
        <Slider
          label="Green (Magenta)"
          min={0.5}
          max={2.0}
          step={0.01}
          defaultValue={1}
          value={negative.greenWeight}
          onChange={sliderChange('greenWeight')}
          fillOrigin="min"
          onDragStateChange={onDragStateChange}
        />
        <Slider
          label="Blue (Yellow)"
          min={0.5}
          max={2.0}
          step={0.01}
          defaultValue={1}
          value={negative.blueWeight}
          onChange={sliderChange('blueWeight')}
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
          Print Grade
        </Text>
        <Slider
          label="Exposure"
          min={-2}
          max={2}
          step={0.05}
          defaultValue={0}
          value={negative.exposure}
          onChange={sliderChange('exposure')}
          onDragStateChange={onDragStateChange}
        />
        <Slider
          label="Contrast (Grade)"
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
          Curve Shape
        </Text>
        <Slider
          label="Toe"
          min={-1}
          max={1}
          step={0.01}
          defaultValue={0}
          value={negative.toe}
          onChange={sliderChange('toe')}
          onDragStateChange={onDragStateChange}
        />
        <Slider
          label="Toe Width"
          min={0.5}
          max={5}
          step={0.1}
          defaultValue={2.5}
          value={negative.toeWidth}
          onChange={sliderChange('toeWidth')}
          onDragStateChange={onDragStateChange}
        />
        <Slider
          label="Shoulder"
          min={-1}
          max={1}
          step={0.01}
          defaultValue={0}
          value={negative.shoulder}
          onChange={sliderChange('shoulder')}
          onDragStateChange={onDragStateChange}
        />
        <Slider
          label="Shoulder Width"
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
          <p>
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
          </p>
        </div>
      </Text>
    </div>
  );
}
