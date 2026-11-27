import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { RectangleHorizontal, RectangleVertical, Save, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import Text from './Text';
import { TEXT_COLOR_KEYS, TextColors, TextVariants, type VariantConfig } from '../../types/typography';
import { CustomAspectRatio } from '../../types/settings';
import { Orientation } from '../../types/ui';
import { ORIGINAL_RATIO } from '../../utils/cropUtils';
import { useSettingsStore } from '../../store/useSettingsStore';

const BASE_RATIO = 1.618;

const PANEL_TONES = {
  pill: 'bg-surface hover:bg-card-active',
  box: 'bg-surface',
  input: 'bg-bg-primary border-surface',
  button: 'hover:bg-surface',
};

const CARD_TONES = {
  pill: 'bg-bg-primary hover:bg-card-active',
  box: 'bg-bg-primary',
  input: 'bg-surface border-bg-primary',
  button: 'hover:bg-card-active',
};
const RATIO_TOLERANCE = 0.01;

interface AspectPreset {
  name: string;
  value: number | null;
  tooltip: string;
}

const greatestCommonDivisor = (a: number, b: number): number => (b === 0 ? a : greatestCommonDivisor(b, a % b));

const formatRatioLabel = (width: number, height: number): string => {
  if (Number.isInteger(width) && Number.isInteger(height)) {
    const divisor = greatestCommonDivisor(width, height);
    const reducedWidth = width / divisor;
    const reducedHeight = height / divisor;
    if (reducedWidth <= 99 && reducedHeight <= 99) {
      return `${reducedWidth}:${reducedHeight}`;
    }
  }
  return `${Number((width / height).toFixed(2))}:1`;
};

interface AspectRatioPickerProps {
  title: string;
  titleVariant?: VariantConfig;
  value: number | null;
  original: { width: number; height: number } | null;
  allowFree?: boolean;
  resetKey?: string;
  onCard?: boolean;
  actions?: ReactNode;
  onChange(value: number | null): void;
}

export default function AspectRatioPicker({
  title,
  titleVariant = TextVariants.heading,
  value,
  original,
  allowFree = false,
  resetKey,
  onCard = false,
  actions,
  onChange,
}: AspectRatioPickerProps) {
  const tones = onCard ? CARD_TONES : PANEL_TONES;
  const { t } = useTranslation();
  const { appSettings, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );
  const [customW, setCustomW] = useState('');
  const [customH, setCustomH] = useState('');
  const [preferPortrait, setPreferPortrait] = useState(false);
  const [isEditingCustom, setIsEditingCustom] = useState(false);
  const [isCustomMode, setIsCustomMode] = useState(false);
  const lastSyncedRatio = useRef<number | null>(null);

  const originalRatio = original && original.width > 0 && original.height > 0 ? original.width / original.height : null;
  const aspectRatio = value === ORIGINAL_RATIO ? originalRatio : value;

  const PRESETS = useMemo<Array<AspectPreset>>(
    () => [
      ...(allowFree
        ? [{ name: t('editor.crop.presets.free.name'), value: null, tooltip: t('editor.crop.presets.free.desc') }]
        : []),
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
    [allowFree, t],
  );

  const savedAspectRatios = useMemo<Array<CustomAspectRatio>>(
    () =>
      (appSettings?.customAspectRatios ?? []).filter((ratio: CustomAspectRatio) => ratio.width > 0 && ratio.height > 0),
    [appSettings?.customAspectRatios],
  );

  const SAVED_PRESETS = useMemo<Array<AspectPreset>>(
    () =>
      savedAspectRatios.map((ratio: CustomAspectRatio) => ({
        name: formatRatioLabel(ratio.width, ratio.height),
        value: ratio.width / ratio.height,
        tooltip: t('editor.crop.custom.savedTooltip', { ratio: `${ratio.width}:${ratio.height}` }),
      })),
    [savedAspectRatios, t],
  );

  const ALL_PRESETS = useMemo<Array<AspectPreset>>(() => [...PRESETS, ...SAVED_PRESETS], [PRESETS, SAVED_PRESETS]);

  const activePreset = useMemo(() => {
    if (value === ORIGINAL_RATIO) {
      return PRESETS.find((p: AspectPreset) => p.value === ORIGINAL_RATIO);
    }

    if (aspectRatio === null) {
      return PRESETS.find((p: AspectPreset) => p.value === null);
    }

    const numericPresetMatch = ALL_PRESETS.find(
      (p: AspectPreset) =>
        p.value &&
        p.value !== ORIGINAL_RATIO &&
        (Math.abs(aspectRatio - p.value) < RATIO_TOLERANCE || Math.abs(aspectRatio - 1 / p.value) < RATIO_TOLERANCE),
    );
    if (numericPresetMatch) {
      return numericPresetMatch;
    }

    if (originalRatio && Math.abs(aspectRatio - originalRatio) < RATIO_TOLERANCE) {
      return PRESETS.find((p: AspectPreset) => p.value === ORIGINAL_RATIO);
    }

    return null;
  }, [value, aspectRatio, originalRatio, PRESETS, ALL_PRESETS]);

  let orientation = Orientation.Horizontal;
  if (activePreset && activePreset.value && activePreset.value !== 1) {
    let baseRatio: number | null = activePreset.value;
    if (activePreset.value === ORIGINAL_RATIO) {
      baseRatio = originalRatio;
    }
    if (baseRatio && aspectRatio && Math.abs(aspectRatio - baseRatio) > RATIO_TOLERANCE) {
      orientation = Orientation.Vertical;
    }
  }

  const isCustomActive = aspectRatio !== null && (isCustomMode || !activePreset);
  const selectedPreset = isCustomActive ? null : activePreset;

  useEffect(() => {
    setIsCustomMode(false);
  }, [resetKey]);

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

  const handleCustomInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const { name, value: input } = e.target;
    if (name === 'customW') {
      setCustomW(input);
    } else if (name === 'customH') {
      setCustomH(input);
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
      if (!value || Math.abs(value - newAspectRatio) > RATIO_TOLERANCE) {
        onChange(newAspectRatio);
      }
    }
  };

  const handleCustomInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      handleApplyCustomRatio();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
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

  const customRatioToSave = useMemo(() => {
    const numW = parseFloat(customW);
    const numH = parseFloat(customH);
    if (!(numW > 0) || !(numH > 0)) {
      return null;
    }

    const width = Math.max(numW, numH);
    const height = Math.min(numW, numH);
    const ratio = width / height;
    const isDuplicate = ALL_PRESETS.some(
      (p: AspectPreset) => p.value && p.value !== ORIGINAL_RATIO && Math.abs(ratio - p.value) < RATIO_TOLERANCE,
    );

    return isDuplicate ? null : { width, height };
  }, [customW, customH, ALL_PRESETS]);

  const handleSaveCustomRatio = () => {
    if (!appSettings || !customRatioToSave) {
      return;
    }
    handleSettingsChange({ ...appSettings, customAspectRatios: [...savedAspectRatios, customRatioToSave] });
  };

  const handleRemoveSavedRatio = (index: number) => {
    if (!appSettings) {
      return;
    }
    handleSettingsChange({
      ...appSettings,
      customAspectRatios: savedAspectRatios.filter((_: CustomAspectRatio, i: number) => i !== index),
    });
  };

  const handlePresetClick = (preset: AspectPreset) => {
    setIsCustomMode(false);

    if (preset.value === ORIGINAL_RATIO) {
      onChange(ORIGINAL_RATIO);
      return;
    }

    const targetRatio = preset.value;
    if (selectedPreset === preset && targetRatio && targetRatio !== 1) {
      const newRatio = 1 / (aspectRatio ? aspectRatio : 1);
      setPreferPortrait(newRatio < 1);
      onChange(newRatio);
      return;
    }

    let newAspectRatio = targetRatio;
    if (targetRatio && targetRatio !== 1 && preferPortrait) {
      newAspectRatio = targetRatio > 1 ? 1 / targetRatio : targetRatio;
    }

    onChange(newAspectRatio);
  };

  const handleOrientationToggle = useCallback(() => {
    if (aspectRatio && aspectRatio !== 1) {
      const newRatio = 1 / aspectRatio;
      setPreferPortrait(newRatio < 1);
      onChange(newRatio);
    }
  }, [aspectRatio, onChange]);

  const isPresetActive = (preset: AspectPreset) => preset === selectedPreset;
  const isOrientationToggleDisabled = !aspectRatio || aspectRatio === 1 || selectedPreset?.value === ORIGINAL_RATIO;

  const orientationTooltip = isOrientationToggleDisabled
    ? t('editor.crop.tooltips.switchOrientation')
    : orientation === Orientation.Vertical
      ? t('editor.crop.tooltips.switchToLandscape')
      : t('editor.crop.tooltips.switchToPortrait');

  return (
    <div className="space-y-4">
      <Text variant={titleVariant} className="mb-2 flex items-center justify-between">
        {title}
        <div className="flex items-center gap-2">
          {actions}
          <button
            className={clsx('p-1.5 rounded-md disabled:opacity-50 disabled:cursor-not-allowed', tones.button)}
            disabled={isOrientationToggleDisabled}
            onClick={handleOrientationToggle}
            data-tooltip={orientationTooltip}
          >
            {orientation === Orientation.Vertical ? <RectangleVertical size={16} /> : <RectangleHorizontal size={16} />}
          </button>
        </div>
      </Text>
      <div className="grid grid-cols-3 gap-2">
        {ALL_PRESETS.map((preset: AspectPreset, index: number) => {
          const savedIndex = index - PRESETS.length;
          return (
            <motion.div
              className={clsx(
                'relative group px-2 py-1.5 rounded-md transition-colors text-center cursor-pointer',
                isPresetActive(preset) ? 'bg-accent' : tones.pill,
              )}
              key={savedIndex < 0 ? preset.name : `saved-${savedIndex}`}
              onClick={() => handlePresetClick(preset)}
              data-tooltip={
                preset.value === ORIGINAL_RATIO && original
                  ? `${preset.tooltip} (${formatRatioLabel(original.width, original.height)})`
                  : preset.tooltip
              }
              whileTap={{ scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 400, damping: 17 }}
            >
              <Text color={isPresetActive(preset) ? TextColors.button : TextColors.secondary}>{preset.name}</Text>
              {savedIndex >= 0 && (
                <button
                  className="absolute -top-1 -right-1 z-10 p-0.5 rounded-full bg-card-active text-text-secondary opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-500 transition-all"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveSavedRatio(savedIndex);
                  }}
                  data-tooltip={t('editor.crop.custom.removeTooltip')}
                >
                  <X size={10} />
                </button>
              )}
            </motion.div>
          );
        })}
      </div>
      <div>
        <motion.div
          className={clsx(
            'w-full px-2 py-1.5 rounded-md transition-colors cursor-pointer text-center',
            isCustomActive ? 'bg-accent' : tones.pill,
          )}
          onClick={() => {
            let newAspectRatio = BASE_RATIO;
            if (preferPortrait || (originalRatio && originalRatio < 1)) {
              newAspectRatio = 1 / BASE_RATIO;
            }
            setIsCustomMode(true);
            onChange(newAspectRatio);
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
            'mt-2 p-2 rounded-md transition-opacity',
            tones.box,
            isCustomActive ? 'opacity-100' : 'opacity-50 pointer-events-none',
          )}
        >
          <div className="flex items-center justify-center gap-2">
            <input
              className={clsx(
                'w-full text-center rounded-md p-1 border focus:border-accent focus:ring-accent text-text-secondary focus:text-text-primary',
                tones.input,
              )}
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
              className={clsx(
                'w-full text-center rounded-md p-1 border focus:border-accent focus:ring-accent text-text-secondary focus:text-text-primary',
                tones.input,
              )}
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
            <button
              className="shrink-0 p-1.5 rounded-md text-text-secondary hover:bg-card-active hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              disabled={!appSettings || !customRatioToSave}
              onClick={handleSaveCustomRatio}
              data-tooltip={t('editor.crop.custom.saveTooltip')}
            >
              <Save size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
