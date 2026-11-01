import { useState, useMemo, memo, CSSProperties, ReactNode } from 'react';
import { Pipette, Sliders } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import Slider, { SliderChangeEvent } from '../ui/Slider';
import ColorWheel from '../ui/ColorWheel';
import {
  ColorAdjustment,
  ColorCalibration,
  HueSatLum,
  INITIAL_ADJUSTMENTS,
  MonochromeFilm,
  MonochromeToning,
} from '../../utils/adjustments';
import { Adjustments, ColorGrading, getAdjustmentToolOrder, getHiddenAdjustmentTools } from '../../utils/adjustments';
import { AppSettings } from '../ui/AppProperties';
import Text from '../ui/Text';
import AdjustmentSubSection from './AdjustmentSubSection';
import ColorHarmonizer from './ColorHarmonizer';
import { useSettingsStore } from '../../store/useSettingsStore';
import { canvasToolState, useEditorStore } from '../../store/useEditorStore';
import {
  getRelativeWhiteBalance,
  getWhiteBalanceMode,
  kelvinSliderScale,
  MAX_TEMPERATURE,
  MAX_TINT,
  MIN_TEMPERATURE,
  RELATIVE_RANGE,
  resolveWhiteBalance,
  WhiteBalance,
  WhiteBalanceMode,
  withKelvinWhiteBalance,
  withRelativeWhiteBalance,
} from '../../utils/whiteBalance';
import { TextColors, TextWeights } from '../../types/typography';
import { useUIStore } from '../../store/useUIStore';
import { HSL_MIXER_BANDS, HslMixerBand, HslMixerProperty } from '../../utils/hslMixer';
import { areSectionPropsEqual, withToolCollapsed } from '../../utils/adjustments';

interface ColorProps {
  color: string;
  name: string;
  label: string;
}

interface ColorPanelProps {
  adjustments: Adjustments;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  appSettings: AppSettings | null;
  asShotWhiteBalance?: WhiteBalance;
  isForMask?: boolean;
  isSectionOpen?: boolean;
  isWbPickerActive?: boolean;
  toggleWbPicker?: () => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

interface HeaderToggleButtonProps {
  isActive: boolean;
  onClick: () => void;
  tooltip: string;
  children: ReactNode;
}

const MIXER_SWATCHES: Record<HslMixerBand, { color: string; hue: number }> = {
  reds: { color: '#f87171', hue: 0 },
  oranges: { color: '#fb923c', hue: 30 },
  yellows: { color: '#facc15', hue: 60 },
  greens: { color: '#4ade80', hue: 120 },
  aquas: { color: '#2dd4bf', hue: 180 },
  blues: { color: '#60a5fa', hue: 240 },
  purples: { color: '#a78bfa', hue: 300 },
  magentas: { color: '#f472b6', hue: 340 },
};

const MIXER_TRACK_PREFIX: Record<HslMixerProperty, string> = { hue: 'hue', saturation: 'sat', luminance: 'lum' };

const MIXER_TAB_ICONS: Record<HslMixerProperty, string> = {
  hue: 'conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
  saturation: 'linear-gradient(135deg, #f43f5e 50%, #777 50%)',
  luminance: 'linear-gradient(135deg, #fff 50%, #111 50%)',
};

const tabPillClassName = (isActive: boolean) =>
  `w-7 h-7 rounded-full flex items-center justify-center transition-all focus:outline-none ${
    isActive
      ? 'ring-2 ring-offset-2 ring-offset-surface ring-accent text-text-primary'
      : 'bg-bg-secondary text-text-secondary hover:text-text-primary hover:bg-bg-secondary/80'
  }`;

const HeaderToggleButton = ({ isActive, onClick, tooltip, children }: HeaderToggleButtonProps) => (
  <button
    onClick={onClick}
    className={`min-w-6 h-6 px-1 flex items-center justify-center rounded-md text-xs font-semibold whitespace-nowrap transition-colors ${
      isActive ? 'bg-accent text-button-text' : 'hover:bg-bg-secondary text-text-secondary'
    }`}
    data-tooltip={tooltip}
  >
    {children}
  </button>
);

interface ColorSwatchProps {
  color: string;
  isActive: boolean;
  name: string;
  ariaLabel: string;
  tooltip?: string;
  onClick: (name: string) => void;
}

export const ColorSwatch = ({ color, name, isActive, ariaLabel, tooltip, onClick }: ColorSwatchProps) => {
  const [isPressed, setIsPressed] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseDown = () => {
    setIsPressed(true);
  };

  const handleMouseUp = () => {
    setIsPressed(false);
  };

  const handleMouseLeave = () => {
    setIsPressed(false);
    setIsHovered(false);
  };

  const handleMouseEnter = () => {
    setIsHovered(true);
  };

  const handleClick = () => {
    onClick(name);
  };

  const getTransform = () => {
    if (isPressed) return 'scale(0.95)';
    if (isActive) return 'scale(1.1)';
    if (isHovered) return 'scale(1.08)';
    return 'scale(1)';
  };

  return (
    <button
      aria-label={ariaLabel}
      data-tooltip={tooltip}
      className="relative w-6 h-6 focus:outline-hidden group"
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      onMouseEnter={handleMouseEnter}
      onTouchStart={handleMouseDown}
      onTouchEnd={handleMouseUp}
    >
      <div
        className={`absolute inset-0 rounded-full border-2 transition-all duration-200 ease-out ${
          isActive ? 'border-white opacity-100' : 'scale-100 border-transparent opacity-0'
        }`}
        style={{
          transform: isActive ? (isPressed ? 'scale(1.1)' : 'scale(1.25)') : undefined,
          transition: isPressed
            ? 'transform 100ms cubic-bezier(0.4, 0, 0.2, 1), opacity 200ms ease-out'
            : 'transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 200ms ease-out',
        }}
      />

      <div
        className={`absolute inset-0 rounded-full transition-all duration-150 ease-out ${
          isActive ? 'shadow-lg' : 'shadow-md'
        }`}
        style={{
          background: color,
          transform: getTransform(),
          transition: isPressed
            ? 'transform 100ms cubic-bezier(0.4, 0, 0.2, 1)'
            : 'transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      />
    </button>
  );
};

const ColorGradingPanel = ({ adjustments, setAdjustments, onDragStateChange }: ColorPanelProps) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'3way' | 'global'>('3way');
  const isExpanded = useUIStore((state) => state.isColorGradingExpanded);
  const colorGrading = adjustments.colorGrading || INITIAL_ADJUSTMENTS.colorGrading;

  const handleChange = (grading: ColorGrading, newValue: HueSatLum) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      colorGrading: {
        ...(prev.colorGrading || INITIAL_ADJUSTMENTS.colorGrading),
        [grading]: newValue,
      },
    }));
  };

  const handleColorGradingSliderChange = (grading: ColorGrading, value: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      colorGrading: {
        ...(prev.colorGrading || INITIAL_ADJUSTMENTS.colorGrading),
        [grading]: parseFloat(value),
      },
    }));
  };

  const tabs = useMemo(
    () => [
      {
        id: '3way',
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="6" r="4.5" />
            <circle cx="5" cy="18" r="4.5" />
            <circle cx="19" cy="18" r="4.5" />
          </svg>
        ),
      },
      {
        id: 'global',
        icon: (
          <div className="w-3.5 h-3.5 rounded-full" style={{ background: 'linear-gradient(to top, #666, #fff)' }} />
        ),
      },
    ],
    [],
  );

  return (
    <div>
      <div className="flex items-center justify-start gap-2 mb-4 mt-2 px-1">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as '3way' | 'global')}
              className={tabPillClassName(isActive)}
            >
              {tab.icon}
            </button>
          );
        })}
      </div>

      <div className="relative w-full mb-4">
        <AnimatePresence mode="wait">
          {activeTab === '3way' ? (
            <motion.div
              key="3way"
              initial={{ opacity: 0, x: -15 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -15 }}
              transition={{ duration: 0.2 }}
              className="w-full"
            >
              <div className="flex justify-center mb-4">
                <div className="w-[calc(50%-0.5rem)]">
                  <ColorWheel
                    defaultValue={INITIAL_ADJUSTMENTS.colorGrading.midtones}
                    label={t('adjustments.color.grading.midtones')}
                    onChange={(val: HueSatLum) => handleChange(ColorGrading.Midtones, val)}
                    value={colorGrading.midtones}
                    onDragStateChange={onDragStateChange}
                    isExpanded={isExpanded}
                  />
                </div>
              </div>
              <div className="flex justify-between mb-2 gap-4">
                <div className="w-full flex-1 min-w-0">
                  <ColorWheel
                    defaultValue={INITIAL_ADJUSTMENTS.colorGrading.shadows}
                    label={t('adjustments.color.grading.shadows')}
                    onChange={(val: HueSatLum) => handleChange(ColorGrading.Shadows, val)}
                    value={colorGrading.shadows}
                    onDragStateChange={onDragStateChange}
                    isExpanded={isExpanded}
                  />
                </div>
                <div className="w-full flex-1 min-w-0">
                  <ColorWheel
                    defaultValue={INITIAL_ADJUSTMENTS.colorGrading.highlights}
                    label={t('adjustments.color.grading.highlights')}
                    onChange={(val: HueSatLum) => handleChange(ColorGrading.Highlights, val)}
                    value={colorGrading.highlights}
                    onDragStateChange={onDragStateChange}
                    isExpanded={isExpanded}
                  />
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="global"
              initial={{ opacity: 0, x: 15 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 15 }}
              transition={{ duration: 0.2 }}
              className="w-full flex justify-center pb-2"
            >
              <div className="w-full max-w-70">
                <ColorWheel
                  defaultValue={INITIAL_ADJUSTMENTS.colorGrading.global}
                  label={t('adjustments.color.grading.global')}
                  onChange={(val: HueSatLum) => handleChange(ColorGrading.Global, val)}
                  value={colorGrading.global || INITIAL_ADJUSTMENTS.colorGrading.global}
                  onDragStateChange={onDragStateChange}
                  isExpanded={isExpanded}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div>
        <Slider
          defaultValue={50}
          label={t('adjustments.color.grading.blending')}
          max={100}
          min={0}
          onChange={(e: any) => handleColorGradingSliderChange(ColorGrading.Blending, e.target.value)}
          step={1}
          value={colorGrading.blending}
          onDragStateChange={onDragStateChange}
        />
        <Slider
          defaultValue={0}
          label={t('adjustments.color.grading.balance')}
          max={100}
          min={-100}
          onChange={(e: any) => handleColorGradingSliderChange(ColorGrading.Balance, e.target.value)}
          step={1}
          value={colorGrading.balance}
          onDragStateChange={onDragStateChange}
        />
      </div>
    </div>
  );
};

const ColorCalibrationPanel = ({ adjustments, setAdjustments, onDragStateChange }: ColorPanelProps) => {
  const { t } = useTranslation();
  const [activePrimary, setActivePrimary] = useState('red');
  const colorCalibration = adjustments.colorCalibration || INITIAL_ADJUSTMENTS.colorCalibration;

  const PRIMARY_COLORS = useMemo(
    () => [
      { name: 'red', color: '#f87171', label: t('adjustments.color.calibration.colors.red') },
      { name: 'green', color: '#4ade80', label: t('adjustments.color.calibration.colors.green') },
      { name: 'blue', color: '#60a5fa', label: t('adjustments.color.calibration.colors.blue') },
    ],
    [t],
  );

  const handleShadowsChange = (value: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      colorCalibration: {
        ...(prev.colorCalibration || INITIAL_ADJUSTMENTS.colorCalibration),
        shadowsTint: parseFloat(value),
      },
    }));
  };

  const handlePrimaryChange = (key: 'Hue' | 'Saturation', value: string) => {
    const fullKey = `${activePrimary}${key}` as keyof ColorCalibration;
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      colorCalibration: {
        ...(prev.colorCalibration || INITIAL_ADJUSTMENTS.colorCalibration),
        [fullKey]: parseFloat(value),
      },
    }));
  };

  const currentValues = {
    hue: colorCalibration[`${activePrimary}Hue` as keyof ColorCalibration] || 0,
    saturation: colorCalibration[`${activePrimary}Saturation` as keyof ColorCalibration] || 0,
  };

  const trackSuffix = `${activePrimary}s`;

  return (
    <div>
      <div>
        <Text color={TextColors.primary} weight={TextWeights.medium} className="mb-1">
          {t('adjustments.color.calibration.shadows')}
        </Text>
        <Slider
          label={t('adjustments.color.calibration.tint')}
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          value={colorCalibration.shadowsTint}
          onChange={(e: any) => handleShadowsChange(e.target.value)}
          onDragStateChange={onDragStateChange}
          trackClassName="tint-gradient-track"
        />
      </div>
      <div className="mt-3">
        <Text color={TextColors.primary} weight={TextWeights.medium} className="mb-3">
          {t('adjustments.color.calibration.primaries')}
        </Text>
        <div className="flex justify-center gap-6 mb-4 px-1">
          {PRIMARY_COLORS.map(({ name, color, label }) => (
            <ColorSwatch
              color={color}
              isActive={activePrimary === name}
              key={name}
              name={name}
              onClick={setActivePrimary}
              ariaLabel={t('adjustments.color.ariaSelectColor', { name: label })}
            />
          ))}
        </div>
        <Slider
          label={t('adjustments.color.calibration.hue')}
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          value={currentValues.hue}
          onChange={(e: any) => handlePrimaryChange('Hue', e.target.value)}
          onDragStateChange={onDragStateChange}
          trackClassName={`hue-slider-${trackSuffix}`}
        />
        <Slider
          label={t('adjustments.color.calibration.saturation')}
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          value={currentValues.saturation}
          onChange={(e: any) => handlePrimaryChange('Saturation', e.target.value)}
          onDragStateChange={onDragStateChange}
          trackClassName={`sat-slider-${trackSuffix}`}
        />
      </div>
    </div>
  );
};

const MONOCHROME_FILTERS = [
  { name: 'none', color: '#8a8a8a', hue: 0, strength: 0 },
  { name: 'red', color: '#f87171', hue: 0, strength: 100 },
  { name: 'orange', color: '#fb923c', hue: 30, strength: 85 },
  { name: 'yellow', color: '#facc15', hue: 55, strength: 60 },
  { name: 'green', color: '#4ade80', hue: 120, strength: 70 },
  { name: 'blue', color: '#60a5fa', hue: 225, strength: 80 },
] as const;

const MONOCHROME_TONINGS = [
  { name: 'none', color: '#8a8a8a', toning: { highlightSaturation: 0, shadowSaturation: 0 } },
  {
    name: 'sepia',
    color: '#a9825a',
    toning: { highlightHue: 40, highlightSaturation: 30, shadowHue: 30, shadowSaturation: 35, balance: 0 },
  },
  {
    name: 'selenium',
    color: '#7d6a78',
    toning: { highlightHue: 40, highlightSaturation: 0, shadowHue: 310, shadowSaturation: 22, balance: 0 },
  },
  {
    name: 'platinum',
    color: '#b4a58f',
    toning: { highlightHue: 42, highlightSaturation: 12, shadowHue: 32, shadowSaturation: 16, balance: 0 },
  },
  {
    name: 'gold',
    color: '#7f93a8',
    toning: { highlightHue: 215, highlightSaturation: 14, shadowHue: 215, shadowSaturation: 20, balance: 0 },
  },
  {
    name: 'cyanotype',
    color: '#3f6f9e',
    toning: { highlightHue: 210, highlightSaturation: 50, shadowHue: 210, shadowSaturation: 60, balance: 0 },
  },
  {
    name: 'split',
    color: 'linear-gradient(135deg, #d0a060 50%, #5a7fa8 50%)',
    toning: { highlightHue: 45, highlightSaturation: 25, shadowHue: 215, shadowSaturation: 25, balance: 0 },
  },
] as const satisfies ReadonlyArray<{ name: string; color: string; toning: Partial<MonochromeToning> }>;

const MonochromePanel = ({ adjustments, setAdjustments, onDragStateChange }: ColorPanelProps) => {
  const { t } = useTranslation();
  const filterHue = adjustments.monochromeFilterHue ?? 0;
  const filterStrength = adjustments.monochromeFilterStrength ?? 0;

  const activeFilm = adjustments.monochromeFilm ?? MonochromeFilm.Neutral;

  const handleChange = (key: keyof Adjustments, value: number | string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: value }));
  };

  const handleFilterSelect = (name: string) => {
    const filter = MONOCHROME_FILTERS.find((f) => f.name === name);
    if (!filter) {
      return;
    }
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      monochromeFilterHue: filter.strength > 0 ? filter.hue : prev.monochromeFilterHue,
      monochromeFilterStrength: filter.strength,
    }));
  };

  const isFilterActive = (filter: (typeof MONOCHROME_FILTERS)[number]) =>
    filter.strength === 0 ? filterStrength === 0 : filterHue === filter.hue && filterStrength === filter.strength;

  return (
    <div>
      <Text color={TextColors.primary} weight={TextWeights.medium} className="mb-2">
        {t('adjustments.color.monochrome.film')}
      </Text>
      <div className="grid grid-cols-2 gap-1.5">
        {Object.values(MonochromeFilm).map((film) => (
          <button
            key={film}
            onClick={() => handleChange('monochromeFilm', film)}
            className={`px-2 py-1.5 rounded-md text-xs text-left truncate transition-colors ${
              activeFilm === film
                ? 'bg-accent text-button-text font-semibold'
                : 'bg-bg-secondary text-text-secondary hover:text-text-primary hover:bg-bg-secondary/80'
            }`}
            data-tooltip={t(`adjustments.color.monochrome.filmDescriptions.${film}`)}
          >
            {t(`adjustments.color.monochrome.films.${film}`)}
          </button>
        ))}
      </div>
      <div className="mt-4">
        <Text color={TextColors.primary} weight={TextWeights.medium} className="mb-3">
          {t('adjustments.color.monochrome.filter')}
        </Text>
        <div className="flex justify-between mb-4 px-1">
          {MONOCHROME_FILTERS.map((filter) => (
            <ColorSwatch
              color={filter.color}
              isActive={isFilterActive(filter)}
              key={filter.name}
              name={filter.name}
              onClick={handleFilterSelect}
              ariaLabel={t(`adjustments.color.monochrome.filters.${filter.name}`)}
              tooltip={t(`adjustments.color.monochrome.filters.${filter.name}`)}
            />
          ))}
        </div>
        <Slider
          label={t('adjustments.color.monochrome.hue')}
          max={360}
          min={0}
          step={1}
          defaultValue={0}
          value={filterHue}
          onChange={(e: SliderChangeEvent) => handleChange('monochromeFilterHue', Number(e.target.value))}
          onDragStateChange={onDragStateChange}
          trackClassName="hue-range-track"
        />
        <Slider
          label={t('adjustments.color.monochrome.strength')}
          max={100}
          min={0}
          step={1}
          defaultValue={0}
          value={filterStrength}
          onChange={(e: SliderChangeEvent) => handleChange('monochromeFilterStrength', Number(e.target.value))}
          onDragStateChange={onDragStateChange}
          fillOrigin="min"
        />
      </div>
    </div>
  );
};

interface MonochromeMixPanelProps {
  colors: Array<ColorProps>;
  values: Record<string, number>;
  onChange(name: string, value: number | string): void;
  onDragStateChange?: (isDragging: boolean) => void;
  animateValueChanges?: boolean;
}

const MonochromeMixPanel = ({
  colors,
  values,
  onChange,
  onDragStateChange,
  animateValueChanges,
}: MonochromeMixPanelProps) => {
  const trackStyle = Object.fromEntries(colors.map(({ name }) => [`--hsl-mixer-sat-${name}`, '60%'])) as CSSProperties;

  return (
    <div style={trackStyle}>
      {colors.map(({ name, label }) => (
        <Slider
          animateValueChanges={animateValueChanges}
          key={name}
          label={label}
          max={100}
          min={-100}
          step={1}
          defaultValue={0}
          value={values[name] ?? 0}
          onChange={(e: SliderChangeEvent) => onChange(name, e.target.value)}
          onDragStateChange={onDragStateChange}
          trackClassName={`lum-slider-${name}`}
        />
      ))}
    </div>
  );
};

const MonochromeToningPanel = ({ adjustments, setAdjustments, onDragStateChange }: ColorPanelProps) => {
  const { t } = useTranslation();
  const toning = adjustments.monochromeToning || INITIAL_ADJUSTMENTS.monochromeToning;

  const handleToningChange = (key: keyof MonochromeToning, value: number | string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      monochromeToning: {
        ...(prev.monochromeToning || INITIAL_ADJUSTMENTS.monochromeToning),
        [key]: Number(value),
      },
    }));
  };

  const handlePresetSelect = (name: string) => {
    const preset = MONOCHROME_TONINGS.find((p) => p.name === name);
    if (!preset) {
      return;
    }
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      monochromeToning: {
        ...(prev.monochromeToning || INITIAL_ADJUSTMENTS.monochromeToning),
        ...preset.toning,
      },
    }));
  };

  const isPresetActive = (preset: (typeof MONOCHROME_TONINGS)[number]) =>
    Object.entries(preset.toning).every(([key, value]) => toning[key as keyof MonochromeToning] === value);

  const renderTone = (tone: 'highlight' | 'shadow') => {
    const hueKey = `${tone}Hue` as const;
    const saturationKey = `${tone}Saturation` as const;
    return (
      <div style={{ '--toning-hue': toning[hueKey] } as CSSProperties}>
        <Text color={TextColors.primary} weight={TextWeights.medium} className="mb-1">
          {t(`adjustments.color.monochrome.${tone}s`)}
        </Text>
        <Slider
          label={t('adjustments.color.monochrome.hue')}
          max={360}
          min={0}
          step={1}
          defaultValue={INITIAL_ADJUSTMENTS.monochromeToning[hueKey]}
          value={toning[hueKey]}
          onChange={(e: SliderChangeEvent) => handleToningChange(hueKey, e.target.value)}
          onDragStateChange={onDragStateChange}
          trackClassName="hue-range-track"
        />
        <Slider
          label={t('adjustments.color.monochrome.saturation')}
          max={100}
          min={0}
          step={1}
          defaultValue={0}
          value={toning[saturationKey]}
          onChange={(e: SliderChangeEvent) => handleToningChange(saturationKey, e.target.value)}
          onDragStateChange={onDragStateChange}
          trackClassName="toning-saturation-track"
          fillOrigin="min"
        />
      </div>
    );
  };

  return (
    <div>
      <div className="flex justify-between mb-4 px-1">
        {MONOCHROME_TONINGS.map((preset) => (
          <ColorSwatch
            color={preset.color}
            isActive={isPresetActive(preset)}
            key={preset.name}
            name={preset.name}
            onClick={handlePresetSelect}
            ariaLabel={t(`adjustments.color.monochrome.tonings.${preset.name}`)}
            tooltip={t(`adjustments.color.monochrome.tonings.${preset.name}`)}
          />
        ))}
      </div>
      {renderTone('highlight')}
      <Slider
        label={t('adjustments.color.monochrome.balance')}
        max={100}
        min={-100}
        step={1}
        defaultValue={0}
        value={toning.balance}
        onChange={(e: SliderChangeEvent) => handleToningChange('balance', e.target.value)}
        onDragStateChange={onDragStateChange}
      />
      <div className="mt-3">{renderTone('shadow')}</div>
    </div>
  );
};

function ColorPanel({
  adjustments,
  setAdjustments,
  appSettings,
  isForMask = false,
  isSectionOpen = false,
  isWbPickerActive = false,
  toggleWbPicker,
  onDragStateChange,
  asShotWhiteBalance,
}: ColorPanelProps) {
  const { t } = useTranslation();
  const handleSettingsChange = useSettingsStore((state) => state.handleSettingsChange);
  const [activeColor, setActiveColor] = useState('reds');
  const hiddenTools = getHiddenAdjustmentTools(appSettings?.adjustmentLayout);
  const toolOrder = getAdjustmentToolOrder('color', appSettings?.adjustmentLayout?.toolOrder);

  const HSL_COLORS = useMemo<Array<ColorProps>>(
    () =>
      HSL_MIXER_BANDS.map((name) => ({
        name,
        color: MIXER_SWATCHES[name].color,
        label: t(`adjustments.color.mixerColors.${name}`),
      })),
    [t],
  );

  const hsl = adjustments?.hsl || INITIAL_ADJUSTMENTS.hsl;

  const mixerTrackStyle = useMemo(
    () =>
      Object.fromEntries(
        HSL_MIXER_BANDS.flatMap((name) => [
          [`--hsl-mixer-hue-${name}`, `${(((MIXER_SWATCHES[name].hue + hsl[name].hue) % 360) + 360) % 360}`],
          [`--hsl-mixer-sat-${name}`, `${(hsl[name].saturation + 100) / 2}%`],
        ]),
      ) as CSSProperties,
    [hsl],
  );

  const isGradingExpanded = useUIStore((state) => state.isColorGradingExpanded);
  const isMixerExpanded = useUIStore((state) => state.isColorMixerExpanded);
  const setUI = useUIStore((state) => state.setUI);
  const [localMixerTab, setLocalMixerTab] = useState<HslMixerProperty>('hue');
  const mixerPickerProperty = useEditorStore((state) => state.mixerPickerProperty);
  const mixerTab = mixerPickerProperty ?? localMixerTab;
  const isMixerPickerDragging = useEditorStore((state) => mixerPickerProperty !== null && state.isSliderDragging);
  const setEditor = useEditorStore((state) => state.setEditor);

  const mixerTabs = useMemo<Array<{ id: HslMixerProperty; label: string }>>(
    () => [
      { id: 'hue', label: t('adjustments.color.hue') },
      { id: 'saturation', label: t('adjustments.color.saturation') },
      { id: 'luminance', label: t('adjustments.color.luminance') },
    ],
    [t],
  );

  const toggleMixerExpanded = () => {
    if (isMixerExpanded && mixerPickerProperty) setEditor({ mixerPickerProperty: null });
    setUI({ isColorMixerExpanded: !isMixerExpanded });
  };

  const toggleMixerPicker = () => {
    if (!mixerPickerProperty && appSettings?.adjustmentLayout?.collapsedTools?.includes('colorMixer')) {
      handleSettingsChange(withToolCollapsed(appSettings, 'colorMixer', false));
    }
    setEditor(canvasToolState({ mixerPickerProperty: mixerPickerProperty ? null : mixerTab }));
  };

  const renderMixerPicker = (tooltip: string) => (
    <HeaderToggleButton isActive={mixerPickerProperty !== null} onClick={toggleMixerPicker} tooltip={tooltip}>
      <Pipette size={16} />
    </HeaderToggleButton>
  );

  const selectMixerTab = (tab: HslMixerProperty) => {
    setLocalMixerTab(tab);
    if (mixerPickerProperty) setEditor({ mixerPickerProperty: tab });
  };

  const isMonochromeImage = useEditorStore((state) => !!state.adjustments.monochromeEnabled);
  const isMonochrome = !isForMask && !!adjustments.monochromeEnabled;
  const isMonochromeMask = isForMask && isMonochromeImage;
  const showMonochromeMix = isMonochrome || isMonochromeMask;
  const gradingOrder = toolOrder.indexOf('colorGrading');
  const mixerOrder = toolOrder.indexOf('colorMixer');

  const handleAdjustmentChange = (key: ColorAdjustment, value: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: parseFloat(value) }));
  };

  const toggleMonochrome = () => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, monochromeEnabled: !prev.monochromeEnabled }));
  };

  const monochromeMixValues = isMonochrome
    ? adjustments.monochromeMix || INITIAL_ADJUSTMENTS.monochromeMix
    : Object.fromEntries(HSL_COLORS.map(({ name }) => [name, adjustments.hsl?.[name]?.luminance ?? 0]));

  const handleMonochromeMixChange = (name: string, value: number | string) => {
    setAdjustments((prev: Partial<Adjustments>) =>
      isMonochrome
        ? {
            ...prev,
            monochromeMix: { ...(prev.monochromeMix || INITIAL_ADJUSTMENTS.monochromeMix), [name]: Number(value) },
          }
        : {
            ...prev,
            hsl: { ...(prev.hsl || {}), [name]: { ...(prev.hsl?.[name] || {}), luminance: Number(value) } },
          },
    );
  };

  const kelvinAsShot =
    !isForMask && getWhiteBalanceMode(appSettings) === WhiteBalanceMode.Kelvin ? asShotWhiteBalance : undefined;
  const isKelvinMode = !!kelvinAsShot;
  const displayedWhiteBalance = kelvinAsShot
    ? resolveWhiteBalance(kelvinAsShot, adjustments)
    : getRelativeWhiteBalance(asShotWhiteBalance, adjustments);
  const tintRange = kelvinAsShot ? MAX_TINT : RELATIVE_RANGE;

  const toggleWhiteBalanceMode = () => {
    if (appSettings) {
      handleSettingsChange({
        ...appSettings,
        whiteBalanceMode: isKelvinMode ? WhiteBalanceMode.Relative : WhiteBalanceMode.Kelvin,
      });
    }
  };

  const handleWhiteBalanceChange = (key: keyof WhiteBalance, value: number | string) => {
    setAdjustments((prev: Adjustments) => {
      if (kelvinAsShot) {
        return withKelvinWhiteBalance(prev, { ...resolveWhiteBalance(kelvinAsShot, prev), [key]: Number(value) });
      }
      return prev.whiteBalance
        ? withRelativeWhiteBalance(prev, {
            ...getRelativeWhiteBalance(asShotWhiteBalance, prev),
            [key]: Number(value),
          })
        : { ...prev, [key]: Number(value) };
    });
  };

  const handleHslChange = (color: string, key: HslMixerProperty, value: number | string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      hsl: {
        ...(prev.hsl || {}),
        [color]: {
          ...(prev.hsl?.[color] || {}),
          [key]: Number(value),
        },
      },
    }));
  };

  const renderMixerSlider = (color: string, property: HslMixerProperty, label: string) => (
    <Slider
      animateValueChanges={!isMixerPickerDragging}
      key={`${color}-${property}`}
      label={label}
      max={100}
      min={-100}
      onChange={(e: SliderChangeEvent) => handleHslChange(color, property, e.target.value)}
      step={1}
      value={hsl[color][property]}
      trackClassName={`${MIXER_TRACK_PREFIX[property]}-slider-${color}`}
      onDragStateChange={onDragStateChange}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {!hiddenTools.includes('whiteBalance') && (
        <AdjustmentSubSection
          actions={
            !isForMask && (
              <div className="flex items-center gap-1">
                <HeaderToggleButton
                  isActive={isKelvinMode}
                  onClick={toggleWhiteBalanceMode}
                  tooltip={t('adjustments.color.kelvinModeTooltip')}
                >
                  K
                </HeaderToggleButton>
                {toggleWbPicker && (
                  <HeaderToggleButton
                    isActive={isWbPickerActive}
                    onClick={toggleWbPicker}
                    tooltip={t('adjustments.color.wbPickerTooltip')}
                  >
                    <Pipette size={16} />
                  </HeaderToggleButton>
                )}
              </div>
            )
          }
          id="whiteBalance"
          order={toolOrder.indexOf('whiteBalance')}
          title={t('adjustments.color.whiteBalance')}
        >
          <Slider
            key={isKelvinMode ? 'kelvinTemperature' : 'temperature'}
            defaultValue={kelvinAsShot?.temperature}
            label={t('adjustments.color.temperature')}
            max={kelvinAsShot ? MAX_TEMPERATURE : RELATIVE_RANGE}
            min={kelvinAsShot ? MIN_TEMPERATURE : -RELATIVE_RANGE}
            onChange={(e: SliderChangeEvent) => handleWhiteBalanceChange('temperature', e.target.value)}
            scale={kelvinAsShot ? kelvinSliderScale : undefined}
            speedEditId={ColorAdjustment.Temperature}
            step={kelvinAsShot ? 50 : 1}
            suffix={kelvinAsShot ? 'K' : undefined}
            value={displayedWhiteBalance.temperature}
            trackClassName="temperature-gradient-track"
            onDragStateChange={onDragStateChange}
          />
          <Slider
            key={isKelvinMode ? 'kelvinTint' : 'tint'}
            defaultValue={kelvinAsShot?.tint}
            label={t('adjustments.color.tint')}
            max={tintRange}
            min={-tintRange}
            onChange={(e: SliderChangeEvent) => handleWhiteBalanceChange('tint', e.target.value)}
            speedEditId={ColorAdjustment.Tint}
            step={1}
            value={displayedWhiteBalance.tint}
            trackClassName="tint-gradient-track"
            onDragStateChange={onDragStateChange}
          />
        </AdjustmentSubSection>
      )}

      {!isMonochromeMask && !hiddenTools.includes('colorPresence') && (
        <AdjustmentSubSection
          actions={
            !isForMask && (
              <HeaderToggleButton
                isActive={isMonochrome}
                onClick={toggleMonochrome}
                tooltip={t('adjustments.color.monochrome.blackWhite')}
              >
                {t('adjustments.color.monochrome.badge')}
              </HeaderToggleButton>
            )
          }
          id="colorPresence"
          order={toolOrder.indexOf('colorPresence')}
          title={isMonochrome ? t('adjustments.color.monochrome.blackWhite') : t('adjustments.color.presence')}
        >
          {isMonochrome ? (
            <MonochromePanel
              adjustments={adjustments}
              setAdjustments={setAdjustments}
              appSettings={appSettings}
              onDragStateChange={onDragStateChange}
            />
          ) : (
            <>
              <Slider
                label={t('adjustments.color.vibrance')}
                max={100}
                min={-100}
                onChange={(e: any) => handleAdjustmentChange(ColorAdjustment.Vibrance, e.target.value)}
                speedEditId={ColorAdjustment.Vibrance}
                step={1}
                value={adjustments.vibrance || 0}
                onDragStateChange={onDragStateChange}
              />
              <Slider
                label={t('adjustments.color.saturation')}
                max={100}
                min={-100}
                onChange={(e: any) => handleAdjustmentChange(ColorAdjustment.Saturation, e.target.value)}
                speedEditId={ColorAdjustment.Saturation}
                step={1}
                value={adjustments.saturation || 0}
                onDragStateChange={onDragStateChange}
              />
            </>
          )}
        </AdjustmentSubSection>
      )}

      {!showMonochromeMix && !hiddenTools.includes('hue') && (
        <AdjustmentSubSection
          id="hue"
          order={toolOrder.indexOf('hue')}
          title={isForMask ? t('adjustments.color.localHue') : t('adjustments.color.hue')}
        >
          <Slider
            label={t('adjustments.color.hue')}
            max={180}
            min={-180}
            onChange={(e: any) => handleAdjustmentChange(ColorAdjustment.Hue, e.target.value)}
            step={1}
            value={adjustments.hue || 0}
            trackClassName="hue-range-track"
            onDragStateChange={onDragStateChange}
          />
        </AdjustmentSubSection>
      )}

      {!isMonochromeMask && !hiddenTools.includes('colorGrading') && (
        <AdjustmentSubSection
          actions={
            !isMonochrome && (
              <HeaderToggleButton
                isActive={isGradingExpanded}
                onClick={() => setUI({ isColorGradingExpanded: !isGradingExpanded })}
                tooltip={t('adjustments.color.toggleSliders')}
              >
                <Sliders size={16} />
              </HeaderToggleButton>
            )
          }
          id="colorGrading"
          order={isMonochrome ? Math.max(gradingOrder, mixerOrder) : gradingOrder}
          title={isMonochrome ? t('adjustments.color.monochrome.toning') : t('adjustments.color.colorGrading')}
        >
          {isMonochrome ? (
            <MonochromeToningPanel
              adjustments={adjustments}
              setAdjustments={setAdjustments}
              appSettings={appSettings}
              onDragStateChange={onDragStateChange}
            />
          ) : (
            <ColorGradingPanel
              adjustments={adjustments}
              setAdjustments={setAdjustments}
              appSettings={appSettings}
              onDragStateChange={onDragStateChange}
            />
          )}
        </AdjustmentSubSection>
      )}

      {!hiddenTools.includes('colorMixer') && (
        <AdjustmentSubSection
          actions={
            showMonochromeMix ? (
              renderMixerPicker(t('adjustments.color.monochrome.mixPickerTooltip'))
            ) : (
              <div className="flex items-center gap-1">
                {isMixerExpanded && renderMixerPicker(t('adjustments.color.mixerPickerTooltip'))}
                <HeaderToggleButton
                  isActive={isMixerExpanded}
                  onClick={toggleMixerExpanded}
                  tooltip={t('adjustments.color.toggleSliders')}
                >
                  <Sliders size={16} />
                </HeaderToggleButton>
              </div>
            )
          }
          id="colorMixer"
          order={isMonochrome ? Math.min(gradingOrder, mixerOrder) : mixerOrder}
          title={showMonochromeMix ? t('adjustments.color.monochrome.mix') : t('adjustments.color.colorMixer')}
        >
          {showMonochromeMix ? (
            <MonochromeMixPanel
              colors={HSL_COLORS}
              values={monochromeMixValues}
              onChange={handleMonochromeMixChange}
              onDragStateChange={onDragStateChange}
              animateValueChanges={!isMixerPickerDragging}
            />
          ) : (
            <div style={mixerTrackStyle}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={isMixerExpanded ? 'expanded' : 'swatches'}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  {isMixerExpanded ? (
                    <>
                      <div className="flex items-center h-6 gap-2 mb-4 px-1">
                        {mixerTabs.map(({ id, label }) => (
                          <button
                            key={id}
                            onClick={() => selectMixerTab(id)}
                            className={tabPillClassName(mixerTab === id)}
                            data-tooltip={label}
                          >
                            <div className="w-3.5 h-3.5 rounded-full" style={{ background: MIXER_TAB_ICONS[id] }} />
                          </button>
                        ))}
                      </div>
                      {HSL_COLORS.map(({ name, label }) => renderMixerSlider(name, mixerTab, label))}
                    </>
                  ) : (
                    <>
                      <div className="flex justify-between mb-4 px-1">
                        {HSL_COLORS.map(({ name, color, label }) => (
                          <ColorSwatch
                            color={color}
                            isActive={activeColor === name}
                            key={name}
                            name={name}
                            onClick={setActiveColor}
                            ariaLabel={t('adjustments.color.ariaSelectColor', { name: label })}
                          />
                        ))}
                      </div>
                      {mixerTabs.map(({ id, label }) => renderMixerSlider(activeColor, id, label))}
                    </>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          )}
        </AdjustmentSubSection>
      )}

      {!showMonochromeMix && !hiddenTools.includes('colorHarmonizer') && (
        <AdjustmentSubSection
          id="colorHarmonizer"
          initiallyCollapsed
          order={toolOrder.indexOf('colorHarmonizer')}
          title={t('adjustments.colorHarmonizer.title')}
        >
          {(expanded) => (
            <ColorHarmonizer
              adjustments={adjustments}
              setAdjustments={setAdjustments}
              onDragStateChange={onDragStateChange}
              isOpen={isSectionOpen && expanded}
            />
          )}
        </AdjustmentSubSection>
      )}

      {!isForMask && !isMonochrome && !hiddenTools.includes('colorCalibration') && (
        <AdjustmentSubSection
          id="colorCalibration"
          order={toolOrder.indexOf('colorCalibration')}
          title={t('adjustments.color.calibration.title')}
        >
          <ColorCalibrationPanel
            adjustments={adjustments}
            setAdjustments={setAdjustments}
            appSettings={appSettings}
            onDragStateChange={onDragStateChange}
          />
        </AdjustmentSubSection>
      )}
    </div>
  );
}

export default memo(ColorPanel, areSectionPropsEqual('color'));
