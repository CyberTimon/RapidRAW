import { useState, useEffect } from 'react';
import { Pipette, Sliders, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Slider from '../ui/Slider';
import RangeSlider from '../ui/RangeSlider';
import ColorWheel from '../ui/ColorWheel';
import { ColorAdjustment, ColorCalibration, HueSatLum, INITIAL_ADJUSTMENTS, Qualifier } from '../../utils/adjustments';
import { Adjustments, ColorGrading } from '../../utils/adjustments';
import { AppSettings } from '../ui/AppProperties';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import { v4 as uuidv4 } from 'uuid';

interface ColorProps {
  color: string;
  name: string;
}

interface ColorPanelProps {
  adjustments: Adjustments;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  appSettings: AppSettings | null;
  isForMask?: boolean;
  isWbPickerActive?: boolean;
  toggleWbPicker?: () => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

interface ColorSwatchProps {
  color: string;
  isActive: boolean;
  name: string;
  onClick: any;
}

const HSL_COLORS: Array<ColorProps> = [
  { name: 'reds', color: '#f87171' },
  { name: 'oranges', color: '#fb923c' },
  { name: 'yellows', color: '#facc15' },
  { name: 'greens', color: '#4ade80' },
  { name: 'aquas', color: '#2dd4bf' },
  { name: 'blues', color: '#60a5fa' },
  { name: 'purples', color: '#a78bfa' },
  { name: 'magentas', color: '#f472b6' },
];

const ColorSwatch = ({ color, name, isActive, onClick }: ColorSwatchProps) => {
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
      aria-label={`Select ${name} color`}
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
          backgroundColor: color,
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
  const [activeTab, setActiveTab] = useState<'3way' | 'global'>('3way');
  const [isExpanded, setIsExpanded] = useState(false);
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

  const handleGlobalChange = (grading: ColorGrading, value: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      colorGrading: {
        ...(prev.colorGrading || INITIAL_ADJUSTMENTS.colorGrading),
        [grading]: parseFloat(value),
      },
    }));
  };

  const tabs = [
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
      icon: <div className="w-3.5 h-3.5 rounded-full" style={{ background: 'linear-gradient(to top, #666, #fff)' }} />,
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-start gap-2 mb-4 mt-2">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as '3way' | 'global')}
              className={`w-7 h-7 rounded-full flex items-center justify-center transition-all focus:outline-none
                ${
                  isActive
                    ? 'ring-2 ring-offset-2 ring-offset-surface ring-accent text-text-primary'
                    : 'bg-bg-secondary text-text-secondary hover:text-text-primary hover:bg-bg-secondary/80'
                }`}
            >
              {tab.icon}
            </button>
          );
        })}

        <div className="w-px h-5 bg-text-secondary/20 mx-1" />

        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={`w-7 h-7 rounded-full flex items-center justify-center transition-all focus:outline-none
            ${
              isExpanded
                ? 'bg-accent text-button-text'
                : 'bg-bg-secondary text-text-secondary hover:text-text-primary hover:bg-bg-secondary/80'
            }`}
          data-tooltip="Toggle Sliders"
        >
          <Sliders size={14} />
        </button>
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
                    label="Midtones"
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
                    label="Shadows"
                    onChange={(val: HueSatLum) => handleChange(ColorGrading.Shadows, val)}
                    value={colorGrading.shadows}
                    onDragStateChange={onDragStateChange}
                    isExpanded={isExpanded}
                  />
                </div>
                <div className="w-full flex-1 min-w-0">
                  <ColorWheel
                    defaultValue={INITIAL_ADJUSTMENTS.colorGrading.highlights}
                    label="Highlights"
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
                  label="Global"
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
          label="Blending"
          max={100}
          min={0}
          onChange={(e: any) => handleGlobalChange(ColorGrading.Blending, e.target.value)}
          step={1}
          value={colorGrading.blending}
          onDragStateChange={onDragStateChange}
        />
        <Slider
          defaultValue={0}
          label="Balance"
          max={100}
          min={-100}
          onChange={(e: any) => handleGlobalChange(ColorGrading.Balance, e.target.value)}
          step={1}
          value={colorGrading.balance}
          onDragStateChange={onDragStateChange}
        />
      </div>
    </div>
  );
};

const ColorCalibrationPanel = ({ adjustments, setAdjustments, onDragStateChange }: ColorPanelProps) => {
  const [activePrimary, setActivePrimary] = useState('red');
  const colorCalibration = adjustments.colorCalibration || INITIAL_ADJUSTMENTS.colorCalibration;

  const PRIMARY_COLORS = [
    { name: 'red', color: '#f87171' },
    { name: 'green', color: '#4ade80' },
    { name: 'blue', color: '#60a5fa' },
  ];

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
    <div className="p-2 bg-bg-tertiary rounded-md mt-4">
      <Text variant={TextVariants.heading} className="mb-2">
        Color Calibration
      </Text>
      <div>
        <Text color={TextColors.primary} weight={TextWeights.medium} className="mb-1">
          Shadows
        </Text>
        <Slider
          label="Tint"
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
          Primaries
        </Text>
        <div className="flex justify-center gap-6 mb-4 px-1">
          {PRIMARY_COLORS.map(({ name, color }) => (
            <ColorSwatch
              color={color}
              isActive={activePrimary === name}
              key={name}
              name={name}
              onClick={setActivePrimary}
            />
          ))}
        </div>
        <Slider
          label="Hue"
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
          label="Saturation"
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

interface QualifierItemProps {
  qualifier: Qualifier;
  index: number;
  onUpdate: (qualifier: Qualifier) => void;
  onDelete: () => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

const QualifierItem = ({ qualifier, index, onUpdate, onDelete, onDragStateChange }: QualifierItemProps) => {
  const [isExpanded, setIsExpanded] = useState(true);

  const formatShift = (val: number, unit: string) => `${val > 0 ? '+' : ''}${Math.round(val)}${unit}`;

  const hueGradientColors = [
    '#ff0000', '#ff8800', '#ffff00', '#88ff00', '#00ff00',
    '#00ff88', '#00ffff', '#0088ff', '#0000ff', '#8800ff',
    '#ff00ff', '#ff0088', '#ff0000'
  ];

  const satGradientColors = ['#444444', '#666666', '#888888', '#aaaaaa', '#cccccc', '#ffffff'];

  const lumGradientColors = ['#000000', '#333333', '#666666', '#999999', '#cccccc', '#ffffff'];

  return (
    <div className="border-b border-border-color pb-3 mb-3 last:border-b-0 last:pb-0 last:mb-0">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-text-secondary hover:text-text-primary transition-colors"
          >
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          <Text variant={TextVariants.small} weight={TextWeights.medium}>
            Qualifier {index + 1}
          </Text>
        </div>
        <button
          onClick={onDelete}
          className="p-1 hover:text-red-500 text-text-secondary transition-colors"
          data-tooltip="Delete Qualifier"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {isExpanded && (
        <div className="space-y-4 mt-3 w-full">
          <RangeSlider
            label="Hue Range"
            minLimit={0}
            maxLimit={360}
            min={qualifier.hue.min}
            max={qualifier.hue.max}
            onChange={(values) => onUpdate({
              ...qualifier,
              hue: values
            })}
            onDragStateChange={onDragStateChange}
            gradientColors={hueGradientColors}
          />

          <RangeSlider
            label="Saturation Range"
            minLimit={0}
            maxLimit={100}
            min={qualifier.saturation.min}
            max={qualifier.saturation.max}
            onChange={(values) => onUpdate({
              ...qualifier,
              saturation: values
            })}
            onDragStateChange={onDragStateChange}
            gradientColors={satGradientColors}
          />

          <RangeSlider
            label="Luminance Range"
            minLimit={0}
            maxLimit={100}
            min={qualifier.luminance.min}
            max={qualifier.luminance.max}
            onChange={(values) => onUpdate({
              ...qualifier,
              luminance: values
            })}
            onDragStateChange={onDragStateChange}
            gradientColors={lumGradientColors}
          />

          <div className="border-t border-border-color my-2" />

          <div className="space-y-4">
            <Slider
              label="Hue Shift"
              min={-180}
              max={180}
              step={1}
              value={qualifier.hueShift}
              onChange={(e: any) => onUpdate({ ...qualifier, hueShift: e.target.value })}
              onDragStateChange={onDragStateChange}
            />
            <Slider
              label="Saturation Shift"
              min={-100}
              max={100}
              step={1}
              value={qualifier.satShift}
              onChange={(e: any) => onUpdate({ ...qualifier, satShift: e.target.value })}
              onDragStateChange={onDragStateChange}
            />
            <Slider
              label="Luminance Shift"
              min={-100}
              max={100}
              step={1}
              value={qualifier.lumShift}
              onChange={(e: any) => onUpdate({ ...qualifier, lumShift: e.target.value })}
              onDragStateChange={onDragStateChange}
            />
          </div>
        </div>
      )}
    </div>
  );
};

interface QualifiersPanelProps {
  qualifiers: Array<Qualifier>;
  onChange: (qualifiers: Array<Qualifier>) => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

const QualifiersPanel = ({ qualifiers, onChange, onDragStateChange }: QualifiersPanelProps) => {
  const addQualifier = () => {
    const newQualifier: Qualifier = {
      id: uuidv4(),
      enabled: true,
      hue: { min: 0, max: 360 },
      saturation: { min: 0, max: 100 },
      luminance: { min: 0, max: 100 },
      hueShift: 0,
      satShift: 0,
      lumShift: 0,
    };
    onChange([...qualifiers, newQualifier]);
  };

  const updateQualifier = (index: number, updated: Qualifier) => {
    const newList = [...qualifiers];
    newList[index] = updated;
    onChange(newList);
  };

  const deleteQualifier = (index: number) => {
    onChange(qualifiers.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <Text variant={TextVariants.heading}>Qualifiers</Text>
        <button
          onClick={addQualifier}
          className="p-1.5 rounded-md bg-accent/20 hover:bg-accent/30 text-accent transition-colors"
          data-tooltip="Add Qualifier"
        >
          <Plus size={14} />
        </button>
      </div>

      {qualifiers.length === 0 ? (
        <div className="text-center py-8">
          <Text variant={TextVariants.small} color={TextColors.secondary}>
            No qualifiers added. Click + to create one.
          </Text>
        </div>
      ) : (
        qualifiers.map((qualifier, index) => (
          <QualifierItem
            key={qualifier.id}
            qualifier={qualifier}
            index={index}
            onUpdate={(q) => updateQualifier(index, q)}
            onDelete={() => deleteQualifier(index)}
            onDragStateChange={onDragStateChange}
          />
        ))
      )}
    </div>
  );
};

export default function ColorPanel({
  adjustments,
  setAdjustments,
  appSettings,
  isForMask = false,
  isWbPickerActive = false,
  toggleWbPicker,
  onDragStateChange,
}: ColorPanelProps) {
  const [activeColor, setActiveColor] = useState('reds');
  const adjustmentVisibility = appSettings?.adjustmentVisibility || {};
  const isWgpuEnabled = appSettings?.useWgpuRenderer !== false;

  const colorHueMap: Record<string, number> = {
    reds: 0,
    oranges: 30,
    yellows: 60,
    greens: 120,
    aquas: 180,
    blues: 240,
    purples: 300,
    magentas: 340,
  };

  const currentHsl = adjustments?.hsl?.[activeColor] || { hue: 0, saturation: 0, luminance: 0 };
  const baseHue = colorHueMap[activeColor] || 0;
  const effectiveHue = baseHue + (currentHsl.hue || 0);

  useEffect(() => {
    const normalizedHue = ((effectiveHue % 360) + 360) % 360;
    const effectiveSaturation = (currentHsl.saturation + 100) / 2;

    document.documentElement.style.setProperty(`--hsl-mixer-hue-${activeColor}`, normalizedHue.toString());
    document.documentElement.style.setProperty(`--hsl-mixer-sat-${activeColor}`, `${effectiveSaturation}%`);
  }, [effectiveHue, currentHsl.saturation, activeColor]);

  const handleGlobalChange = (key: ColorAdjustment, value: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: parseFloat(value) }));
  };

  const handleHslChange = (key: ColorAdjustment, value: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      hsl: {
        ...(prev.hsl || {}),
        [activeColor]: {
          ...(prev.hsl?.[activeColor] || {}),
          [key]: parseFloat(value),
        },
      },
    }));
  };

  const hue_slider = `hue-slider-${activeColor}`;
  const saturation_slider = `sat-slider-${activeColor}`;
  const luminance_slider = `lum-slider-${activeColor}`;

  return (
    <div className="space-y-4">
      <div className="p-2 bg-bg-tertiary rounded-md">
        <div className="flex justify-between items-center mb-2">
          <Text variant={TextVariants.heading}>White Balance</Text>
          {!isForMask && toggleWbPicker && (
            <button
              onClick={toggleWbPicker}
              disabled={isWgpuEnabled}
              className={`p-1.5 rounded-md transition-colors ${
                isWgpuEnabled
                  ? 'cursor-not-allowed text-text-secondary hover:bg-transparent'
                  : isWbPickerActive
                    ? 'bg-accent text-button-text'
                    : 'hover:bg-bg-secondary text-text-secondary'
              }`}
              data-tooltip={isWgpuEnabled ? 'WB Picker: Disable WGPU in Settings.' : 'White Balance Picker'}
            >
              <Pipette size={16} />
            </button>
          )}
        </div>
        <Slider
          label="Temperature"
          max={100}
          min={-100}
          onChange={(e: any) => handleGlobalChange(ColorAdjustment.Temperature, e.target.value)}
          step={1}
          value={adjustments.temperature || 0}
          trackClassName="temperature-gradient-track"
          onDragStateChange={onDragStateChange}
        />
        <Slider
          label="Tint"
          max={100}
          min={-100}
          onChange={(e: any) => handleGlobalChange(ColorAdjustment.Tint, e.target.value)}
          step={1}
          value={adjustments.tint || 0}
          trackClassName="tint-gradient-track"
          onDragStateChange={onDragStateChange}
        />
      </div>

      <div className="p-2 bg-bg-tertiary rounded-md">
        <Text variant={TextVariants.heading} className="mb-2">
          Presence
        </Text>
        <Slider
          label="Vibrance"
          max={100}
          min={-100}
          onChange={(e: any) => handleGlobalChange(ColorAdjustment.Vibrance, e.target.value)}
          step={1}
          value={adjustments.vibrance || 0}
          onDragStateChange={onDragStateChange}
        />
        <Slider
          label="Saturation"
          max={100}
          min={-100}
          onChange={(e: any) => handleGlobalChange(ColorAdjustment.Saturation, e.target.value)}
          step={1}
          value={adjustments.saturation || 0}
          onDragStateChange={onDragStateChange}
        />
      </div>

      <div className="p-2 bg-bg-tertiary rounded-md">
        <Text variant={TextVariants.heading} className="mb-3">
          Color Grading
        </Text>
        <ColorGradingPanel
          adjustments={adjustments}
          setAdjustments={setAdjustments}
          appSettings={appSettings}
          onDragStateChange={onDragStateChange}
        />
      </div>

      <div className="p-2 bg-bg-tertiary rounded-md">
        <Text variant={TextVariants.heading} className="mb-3">
          Color Mixer
        </Text>
        <div className="flex justify-between mb-4 px-1">
          {HSL_COLORS.map(({ name, color }) => (
            <ColorSwatch
              color={color}
              isActive={activeColor === name}
              key={name}
              name={name}
              onClick={setActiveColor}
            />
          ))}
        </div>
        <Slider
          label="Hue"
          max={100}
          min={-100}
          onChange={(e: any) => handleHslChange(ColorAdjustment.Hue, e.target.value)}
          step={1}
          value={currentHsl.hue}
          trackClassName={hue_slider}
          onDragStateChange={onDragStateChange}
        />
        <Slider
          label="Saturation"
          max={100}
          min={-100}
          onChange={(e: any) => handleHslChange(ColorAdjustment.Saturation, e.target.value)}
          step={1}
          value={currentHsl.saturation}
          trackClassName={saturation_slider}
          onDragStateChange={onDragStateChange}
        />
        <Slider
          label="Luminance"
          max={100}
          min={-100}
          onChange={(e: any) => handleHslChange(ColorAdjustment.Luminance, e.target.value)}
          step={1}
          value={currentHsl.luminance}
          trackClassName={luminance_slider}
          onDragStateChange={onDragStateChange}
        />
      </div>

      <div className="p-2 bg-bg-tertiary rounded-md">
        <QualifiersPanel
          qualifiers={adjustments.qualifiers || []}
          onChange={(newQualifiers) => setAdjustments((prev: Adjustments) => ({ 
            ...prev, 
            qualifiers: newQualifiers 
          }))}
          onDragStateChange={onDragStateChange}
        />
      </div>

      {!isForMask && adjustmentVisibility.colorCalibration !== false && (
        <ColorCalibrationPanel
          adjustments={adjustments}
          setAdjustments={setAdjustments}
          appSettings={appSettings}
          onDragStateChange={onDragStateChange}
        />
      )}
    </div>
  );
}
