import { motion } from 'framer-motion';
import clsx from 'clsx';
import { Sparkles, Heart, Flower2, ChevronDown, Check, Zap, Loader2, Sun } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import Slider from '../ui/Slider';
import { Adjustments, BasicAdjustment } from '../../utils/adjustments';
import { useEffect, useRef, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

interface BasicAdjustmentsProps {
  adjustments: Adjustments;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  isForMask?: boolean;
  onDragStateChange?: (isDragging: boolean) => void;
  appSettings?: any;
}

interface ToneMapperSwitchProps {
  selectedMapper: string;
  onMapperChange: (mapper: string) => void;
  exposureValue: number;
  onExposureChange: (value: number) => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

const ToneMapperSwitch = ({
  selectedMapper,
  onMapperChange,
  exposureValue,
  onExposureChange,
  onDragStateChange,
}: ToneMapperSwitchProps) => {
  const { t } = useTranslation();
  const [bubbleStyle, setBubbleStyle] = useState({});
  const isInitialAnimation = useRef(true);
  const [isLabelHovered, setIsLabelHovered] = useState(false);

  const toneMapperOptions = useMemo(
    () => [
      {
        id: 'basic',
        label: t('adjustments.basic.mappers.basic'),
        title: t('adjustments.basic.mappers.basicDesc'),
      },
      {
        id: 'agx',
        label: t('adjustments.basic.mappers.agx'),
        title: t('adjustments.basic.mappers.agxDesc'),
      },
      {
        id: 'oklab',
        label: t('adjustments.basic.mappers.oklab'),
        title: t('adjustments.basic.mappers.oklabDesc'),
      },
    ],
    [t],
  );

  const handleReset = () => {
    onMapperChange('basic');
    onExposureChange(0);
  };

  useEffect(() => {
    const selectedIndex = toneMapperOptions.findIndex((m) => m.id === selectedMapper);
    const safeIndex = selectedIndex >= 0 ? selectedIndex : 0;

    const widthPercent = 100 / toneMapperOptions.length;
    const targetX = `${safeIndex * 100}%`;
    const targetWidth = `${widthPercent}%`;

    if (isInitialAnimation.current) {
      let initialX;
      if (selectedMapper === 'agx') {
        initialX = `${toneMapperOptions.length * 100}%`;
      } else {
        initialX = '-25%';
      }

      setBubbleStyle({
        x: [initialX, targetX],
        width: targetWidth,
      });
      isInitialAnimation.current = false;
    } else {
      setBubbleStyle({
        x: targetX,
        width: targetWidth,
      });
    }
  }, [selectedMapper, toneMapperOptions]);

  return (
    <div className="group mb-3">
      <div className="flex justify-between items-center mb-2">
        <div
          className="grid cursor-pointer"
          onClick={handleReset}
          onDoubleClick={handleReset}
          onMouseEnter={() => setIsLabelHovered(true)}
          onMouseLeave={() => setIsLabelHovered(false)}
        >
          <span
            aria-hidden={isLabelHovered}
            className={`col-start-1 row-start-1 text-sm font-medium text-text-secondary select-none transition-opacity duration-200 ease-in-out ${
              isLabelHovered ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {t('adjustments.basic.toneMapper')}
          </span>
          <span
            aria-hidden={!isLabelHovered}
            className={`col-start-1 row-start-1 text-sm font-medium text-text-primary select-none transition-opacity duration-200 ease-in-out pointer-events-none ${
              isLabelHovered ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {t('adjustments.basic.reset')}
          </span>
        </div>
      </div>
      <div className="w-full p-2 pb-1 bg-card-active rounded-md">
        <div className="relative flex w-full">
          <motion.div
            className="absolute top-0 bottom-0 z-0 bg-accent"
            style={{ borderRadius: 6 }}
            animate={bubbleStyle}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
          />
          {toneMapperOptions.map((mapper) => (
            <button
              key={mapper.id}
              data-tooltip={mapper.title}
              onClick={() => onMapperChange(mapper.id)}
              className={clsx(
                'relative flex-1 flex items-center justify-center gap-2 px-3 p-1.5 text-sm font-medium rounded-md transition-colors',
                {
                  'text-text-primary hover:bg-surface': selectedMapper !== mapper.id,
                  'text-button-text': selectedMapper === mapper.id,
                },
              )}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <span className="relative z-10 flex items-center">{mapper.label}</span>
            </button>
          ))}
        </div>
        <div className="mt-2.5 px-1">
          <Slider
            label={t('adjustments.basic.exposure')}
            max={5}
            min={-5}
            onChange={(e: any) => onExposureChange(parseFloat(e.target.value))}
            step={0.01}
            value={exposureValue}
            trackClassName="bg-surface"
            onDragStateChange={onDragStateChange}
          />
        </div>
      </div>
    </div>
  );
};

type WeddingScene = 'master' | 'bridalGlow' | 'ceremony' | 'goldenHour' | 'reception';
type MacroScene = 'master' | 'droplets' | 'insects' | 'botanical' | 'jewelry';
type AstroScene = 'master' | 'milkyWay' | 'starryLandscape' | 'deepSky' | 'moonlitAurora';

export default function BasicAdjustments({
  adjustments,
  setAdjustments,
  isForMask = false,
  onDragStateChange,
  appSettings,
}: BasicAdjustmentsProps) {
  const { t } = useTranslation();
  const [isWeddingMenuOpen, setIsWeddingMenuOpen] = useState(false);
  const [selectedWeddingScene, setSelectedWeddingScene] = useState<WeddingScene>('master');
  const weddingMenuRef = useRef<HTMLDivElement>(null);

  const [isMacroMenuOpen, setIsMacroMenuOpen] = useState(false);
  const [selectedMacroScene, setSelectedMacroScene] = useState<MacroScene>('master');
  const macroMenuRef = useRef<HTMLDivElement>(null);

  const [isAstroMenuOpen, setIsAstroMenuOpen] = useState(false);
  const [selectedAstroScene, setSelectedAstroScene] = useState<AstroScene>('master');
  const astroMenuRef = useRef<HTMLDivElement>(null);

  const [selectedSkyPreset, setSelectedSkyPreset] = useState<string>('polar');
  const [isSkyMenuOpen, setIsSkyMenuOpen] = useState<boolean>(false);
  const skyMenuRef = useRef<HTMLDivElement>(null);

  const [isAutoAnalyzing, setIsAutoAnalyzing] = useState(false);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (weddingMenuRef.current && !weddingMenuRef.current.contains(event.target as Node)) {
        setIsWeddingMenuOpen(false);
      }
      if (macroMenuRef.current && !macroMenuRef.current.contains(event.target as Node)) {
        setIsMacroMenuOpen(false);
      }
      if (astroMenuRef.current && !astroMenuRef.current.contains(event.target as Node)) {
        setIsAstroMenuOpen(false);
      }
      if (skyMenuRef.current && !skyMenuRef.current.contains(event.target as Node)) {
        setIsSkyMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const [detectedSceneBadge, setDetectedSceneBadge] = useState<string | null>(null);

  const handleSkySculpt = async (preset: string = selectedSkyPreset) => {
    setSelectedSkyPreset(preset);
    setIsSkyMenuOpen(false);
    try {
      const res: any = await invoke('apply_ai_sky_sculpt', { preset, intensity: 100 });
      if (res && res.mask_adjustments) {
        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          ...res.mask_adjustments,
        }));
        setDetectedSceneBadge(`🌅 Sky Sculpted: ${res.preset_name}`);
        setTimeout(() => setDetectedSceneBadge(null), 5000);
      }
    } catch (err) {
      console.error('Sky sculpt error:', err);
    }
  };

  const handleAutoEnhance = async () => {
    try {
      setIsAutoAnalyzing(true);
      const res: any = await invoke('analyze_and_polish_active_image', {
        intensity: 100,
        autoStraighten: true,
        toneStyle: 'filmic',
        skinProtection: true,
      });
      if (res && res.adjustments) {
        setDetectedSceneBadge(res.sceneName || null);
        const adj = res.adjustments;
        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          ...adj,
        }));
        setTimeout(() => setDetectedSceneBadge(null), 5000);
      }
    } catch (err) {
      console.error('Semantic AI polish error:', err);
      // Fallback to basic auto adjustments
      try {
        const results: any = await invoke('calculate_auto_adjustments');
        if (results) {
          setAdjustments((prev: Partial<Adjustments>) => ({
            ...prev,
            exposure: typeof results.exposure === 'number' ? results.exposure : prev.exposure,
            contrast: typeof results.contrast === 'number' ? results.contrast : prev.contrast,
            highlights: typeof results.highlights === 'number' ? results.highlights : prev.highlights,
            shadows: typeof results.shadows === 'number' ? results.shadows : prev.shadows,
            whites: typeof results.whites === 'number' ? results.whites : prev.whites,
            blacks: typeof results.blacks === 'number' ? results.blacks : prev.blacks,
            clarity: typeof results.clarity === 'number' ? results.clarity : prev.clarity,
            dehaze: typeof results.dehaze === 'number' ? results.dehaze : prev.dehaze,
            vibrance: typeof results.vibrance === 'number' ? results.vibrance : prev.vibrance,
            vignetteAmount: typeof results.vignetteAmount === 'number' ? results.vignetteAmount : prev.vignetteAmount,
          }));
        }
      } catch (e) {
        console.error('Fallback auto enhance error:', e);
      }
    } finally {
      setIsAutoAnalyzing(false);
    }
  };

  const handleAdjustmentChange = (key: BasicAdjustment, value: any) => {
    const numericValue = parseFloat(value);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: numericValue }));
  };

  const handleToneMapperChange = (mapper: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      toneMapper: mapper as 'basic' | 'agx' | 'oklab',
    }));
  };

  const handleWeddingMagic = (scene: WeddingScene = selectedWeddingScene) => {
    setSelectedWeddingScene(scene);
    setIsWeddingMenuOpen(false);

    setAdjustments((prev: Partial<Adjustments>) => {
      let expShift = 0.12;
      let contrast = 14;
      let highlights = -24;
      let whites = 12;
      let shadows = 18;
      let blacks = -8;
      let tempShift = 3;
      let tintShift = 2;
      let clarity = -6;
      let sharpening = 32;
      let halation = 14;
      let colorDenoise = (prev as any).colorNoiseReduction || 0;
      let lumaDenoise = (prev as any).lumaNoiseReduction || 0;
      let grainAmount = (prev as any).grainAmount || 0;
      let grainSize = (prev as any).grainSize || 1.0;
      let grainRoughness = (prev as any).grainRoughness || 20;

      let orangeHsl = { hue: 2, saturation: -8, luminance: 12 };
      let redHsl = { hue: 4, saturation: -4, luminance: 4 };
      let greenHsl = { hue: 22, saturation: -28, luminance: -8 };
      let yellowHsl = { hue: -8, saturation: -10, luminance: 6 };
      let blueHsl = { hue: 6, saturation: 10, luminance: -4 };

      let highlightGrading = { hue: 42, saturation: 18, luminance: 6 };
      let shadowGrading = { hue: 215, saturation: 12, luminance: -4 };

      let blueCalibration = 12;
      let redCalibration = 4;

      if (scene === 'bridalGlow') {
        expShift = 0.22;
        contrast = 10;
        highlights = -18;
        whites = 16;
        shadows = 22;
        blacks = -4;
        tempShift = 4;
        clarity = -8;
        sharpening = 35;
        halation = 18;
        orangeHsl = { hue: 3, saturation: -6, luminance: 16 };
        redHsl = { hue: 4, saturation: -4, luminance: 6 };
        greenHsl = { hue: 20, saturation: -24, luminance: -6 };
        highlightGrading = { hue: 38, saturation: 16, luminance: 8 };
        blueCalibration = 14;
      } else if (scene === 'ceremony') {
        expShift = 0.08;
        contrast = 16;
        highlights = -32;
        whites = 14;
        shadows = 16;
        blacks = -10;
        tempShift = -2;
        tintShift = 3;
        clarity = -4;
        sharpening = 30;
        lumaDenoise = 12;
        colorDenoise = 20;
        halation = 10;
        orangeHsl = { hue: 2, saturation: -10, luminance: 10 };
        redHsl = { hue: 6, saturation: -6, luminance: 2 };
        yellowHsl = { hue: -12, saturation: -14, luminance: 4 };
        blueCalibration = 10;
      } else if (scene === 'goldenHour') {
        expShift = 0.16;
        contrast = 18;
        highlights = -22;
        whites = 10;
        shadows = 18;
        blacks = -8;
        tempShift = 6;
        clarity = -6;
        sharpening = 32;
        halation = 16;
        orangeHsl = { hue: 2, saturation: -6, luminance: 12 };
        greenHsl = { hue: 26, saturation: -32, luminance: -10 };
        yellowHsl = { hue: -6, saturation: -8, luminance: 8 };
        blueHsl = { hue: 4, saturation: 14, luminance: -6 };
        highlightGrading = { hue: 44, saturation: 24, luminance: 6 };
        shadowGrading = { hue: 212, saturation: 14, luminance: -4 };
        blueCalibration = 16;
        redCalibration = 6;
      } else if (scene === 'reception') {
        expShift = 0.14;
        contrast = 20;
        highlights = -20;
        whites = 12;
        shadows = 14;
        blacks = -12;
        tempShift = 2;
        clarity = 4;
        sharpening = 28;
        colorDenoise = 36;
        lumaDenoise = 16;
        grainAmount = 16;
        grainSize = 1.2;
        grainRoughness = 35;
        halation = 8;
        highlightGrading = { hue: 40, saturation: 14, luminance: 4 };
        shadowGrading = { hue: 220, saturation: 10, luminance: -6 };
      }

      return {
        ...prev,
        exposure: (prev.exposure || 0) + expShift,
        contrast,
        highlights,
        whites,
        shadows,
        blacks,
        temperature: (prev.temperature || 0) + tempShift,
        tint: (prev.tint || 0) + tintShift,
        clarity,
        sharpening,
        toneMapper: 'agx',
        halationAmount: halation,
        colorNoiseReduction: colorDenoise,
        lumaNoiseReduction: lumaDenoise,
        grainAmount,
        grainSize,
        grainRoughness,
        hsl: {
          ...(prev.hsl || ({} as any)),
          oranges: orangeHsl,
          reds: redHsl,
          greens: greenHsl,
          yellows: yellowHsl,
          blues: blueHsl,
        } as any,
        colorGrading: {
          ...(prev.colorGrading || ({} as any)),
          highlights: highlightGrading,
          shadows: shadowGrading,
        } as any,
        colorCalibration: {
          ...(prev.colorCalibration || ({} as any)),
          blueHue: blueCalibration,
          redHue: redCalibration,
        } as any,
      };
    });
  };

  const handleMacroMagic = (scene: MacroScene = selectedMacroScene) => {
    setSelectedMacroScene(scene);
    setIsMacroMenuOpen(false);

    setAdjustments((prev: Partial<Adjustments>) => {
      let expShift = 0.08;
      let contrast = 18;
      let highlights = -38;
      let whites = 16;
      let shadows = 14;
      let blacks = -6;
      let tempShift = 1;
      let tintShift = 0;
      let clarity = 16;
      let structure = 18;
      let sharpening = 42;
      let sharpnessThreshold = 55;
      let caRedCyan = -8;
      let caBlueYellow = 6;
      let vibrance = 20;
      let saturation = 6;
      let halation = 0;
      let lumaDenoise = 10;
      let colorDenoise = 24;

      let yellowHsl = { hue: -4, saturation: 12, luminance: 10 };
      let greenHsl = { hue: 14, saturation: -12, luminance: -6 };
      let aquaHsl = { hue: 8, saturation: 14, luminance: 4 };
      let redHsl = { hue: 2, saturation: 8, luminance: 4 };
      let orangeHsl = { hue: 2, saturation: 6, luminance: 8 };

      let highlightGrading = (prev.colorGrading as any)?.highlights || { hue: 0, saturation: 0, luminance: 0 };
      let shadowGrading = (prev.colorGrading as any)?.shadows || { hue: 0, saturation: 0, luminance: 0 };

      if (scene === 'droplets') {
        expShift = 0.10;
        contrast = 20;
        highlights = -44;
        whites = 18;
        shadows = 16;
        blacks = -8;
        clarity = 22;
        structure = 20;
        sharpening = 40;
        sharpnessThreshold = 50;
        caRedCyan = -12;
        caBlueYellow = 8;
        aquaHsl = { hue: 10, saturation: 22, luminance: 6 };
        greenHsl = { hue: 16, saturation: -10, luminance: -4 };
      } else if (scene === 'insects') {
        expShift = 0.06;
        contrast = 22;
        highlights = -36;
        whites = 14;
        shadows = 18;
        blacks = -10;
        clarity = 20;
        structure = 24;
        sharpening = 48;
        sharpnessThreshold = 60;
        caRedCyan = -10;
        caBlueYellow = 6;
        vibrance = 24;
        redHsl = { hue: 4, saturation: 12, luminance: 6 };
        yellowHsl = { hue: -2, saturation: 16, luminance: 12 };
      } else if (scene === 'botanical') {
        expShift = 0.12;
        contrast = 14;
        highlights = -32;
        whites = 14;
        shadows = 20;
        blacks = -4;
        tempShift = 4;
        clarity = 10;
        structure = 14;
        sharpening = 36;
        sharpnessThreshold = 45;
        halation = 12;
        vibrance = 24;
        saturation = 8;
        yellowHsl = { hue: -6, saturation: 18, luminance: 14 };
        redHsl = { hue: 2, saturation: 14, luminance: 8 };
        greenHsl = { hue: 18, saturation: -16, luminance: -8 };
      } else if (scene === 'jewelry') {
        expShift = 0.05;
        contrast = 26;
        highlights = -45;
        whites = 22;
        shadows = 10;
        blacks = -12;
        tempShift = -2;
        clarity = 26;
        structure = 22;
        sharpening = 46;
        sharpnessThreshold = 40;
        caRedCyan = -14;
        caBlueYellow = 10;
        highlightGrading = { hue: 210, saturation: 8, luminance: 4 };
        shadowGrading = { hue: 225, saturation: 14, luminance: -6 };
      }

      return {
        ...prev,
        exposure: (prev.exposure || 0) + expShift,
        contrast,
        highlights,
        whites,
        shadows,
        blacks,
        temperature: (prev.temperature || 0) + tempShift,
        tint: (prev.tint || 0) + tintShift,
        clarity,
        structure,
        sharpening,
        sharpnessThreshold,
        chromaticAberrationRedCyan: caRedCyan,
        chromaticAberrationBlueYellow: caBlueYellow,
        vibrance,
        saturation,
        toneMapper: 'agx',
        halationAmount: halation,
        colorNoiseReduction: colorDenoise,
        lumaNoiseReduction: lumaDenoise,
        hsl: {
          ...(prev.hsl || ({} as any)),
          yellows: yellowHsl,
          greens: greenHsl,
          aquas: aquaHsl,
          reds: redHsl,
          oranges: orangeHsl,
        } as any,
        colorGrading: {
          ...(prev.colorGrading || ({} as any)),
          highlights: highlightGrading,
          shadows: shadowGrading,
        } as any,
      };
    });
  };

  const handleNightSkyMagic = (scene: AstroScene = selectedAstroScene) => {
    setSelectedAstroScene(scene);
    setIsAstroMenuOpen(false);

    setAdjustments((prev: Partial<Adjustments>) => {
      let expShift = 0.25;
      let contrast = 24;
      let highlights = -18;
      let whites = 18;
      let shadows = 14;
      let blacks = -18;
      let tempShift = -8;
      let tintShift = 10;
      let clarity = 22;
      let dehaze = 24;
      let sharpening = 35;
      let sharpnessThreshold = 60;
      let lumaDenoise = 28;
      let colorDenoise = 46;

      let redHsl = { hue: -6, saturation: 18, luminance: 8 };
      let magentaHsl = { hue: 0, saturation: 15, luminance: 4 };
      let yellowHsl = (prev.hsl as any)?.yellows || { hue: 0, saturation: 0, luminance: 0 };
      let greenHsl = (prev.hsl as any)?.greens || { hue: 0, saturation: 0, luminance: 0 };
      let aquaHsl = (prev.hsl as any)?.aquas || { hue: 0, saturation: 0, luminance: 0 };
      let blueHsl = (prev.hsl as any)?.blues || { hue: 0, saturation: 0, luminance: 0 };
      let orangeHsl = (prev.hsl as any)?.oranges || { hue: 0, saturation: 0, luminance: 0 };

      let highlightGrading = { hue: 38, saturation: 22, luminance: 4 };
      let shadowGrading = { hue: 220, saturation: 16, luminance: -6 };

      if (scene === 'milkyWay') {
        expShift = 0.28;
        contrast = 28;
        highlights = -20;
        whites = 20;
        shadows = 16;
        blacks = -20;
        tempShift = -9;
        tintShift = 12;
        clarity = 26;
        dehaze = 26;
        sharpening = 38;
        sharpnessThreshold = 65;
        lumaDenoise = 32;
        colorDenoise = 52;
        redHsl = { hue: -8, saturation: 24, luminance: 10 };
        magentaHsl = { hue: 2, saturation: 20, luminance: 6 };
      } else if (scene === 'starryLandscape') {
        expShift = 0.20;
        contrast = 20;
        highlights = -22;
        whites = 16;
        shadows = 28;
        blacks = -14;
        tempShift = -7;
        tintShift = 8;
        clarity = 18;
        dehaze = 22;
        sharpening = 32;
        sharpnessThreshold = 55;
        lumaDenoise = 26;
        colorDenoise = 44;
      } else if (scene === 'deepSky') {
        expShift = 0.32;
        contrast = 26;
        highlights = -24;
        whites = 16;
        shadows = 18;
        blacks = -22;
        tempShift = -10;
        tintShift = 14;
        clarity = 24;
        dehaze = 28;
        sharpening = 40;
        sharpnessThreshold = 70;
        lumaDenoise = 36;
        colorDenoise = 58;
        redHsl = { hue: -10, saturation: 28, luminance: 12 };
        magentaHsl = { hue: 4, saturation: 24, luminance: 8 };
      } else if (scene === 'moonlitAurora') {
        expShift = 0.15;
        contrast = 18;
        highlights = -34;
        whites = 14;
        shadows = 16;
        blacks = -12;
        tempShift = -5;
        tintShift = 6;
        clarity = 16;
        dehaze = 18;
        sharpening = 30;
        sharpnessThreshold = 50;
        lumaDenoise = 24;
        colorDenoise = 40;
        greenHsl = { hue: 10, saturation: 22, luminance: 10 };
        magentaHsl = { hue: 0, saturation: 22, luminance: 8 };
        shadowGrading = { hue: 215, saturation: 14, luminance: -4 };
      }

      return {
        ...prev,
        exposure: (prev.exposure || 0) + expShift,
        contrast,
        highlights,
        whites,
        shadows,
        blacks,
        temperature: (prev.temperature || 0) + tempShift,
        tint: (prev.tint || 0) + tintShift,
        clarity,
        dehaze,
        sharpening,
        sharpnessThreshold,
        luminanceDenoise: lumaDenoise,
        colorNoiseReduction: colorDenoise,
        lumaNoiseReduction: lumaDenoise,
        hsl: {
          ...(prev.hsl || ({} as any)),
          reds: redHsl,
          magentas: magentaHsl,
          yellows: yellowHsl,
          greens: greenHsl,
          aquas: aquaHsl,
          blues: blueHsl,
          oranges: orangeHsl,
        } as any,
        colorGrading: {
          ...(prev.colorGrading || ({} as any)),
          shadows: shadowGrading,
          highlights: highlightGrading,
        } as any,
      };
    });
  };

  const handleRemoveLightPollution = async () => {
    try {
      setIsAstroMenuOpen(false);
      await invoke('remove_active_light_pollution_gradient', {
        preservePedestal: 0.02,
      });
      // Trigger canvas preview re-render
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        exposure: (prev.exposure || 0) + 0.0001 - 0.0001,
      }));
    } catch (err) {
      console.error('Failed to remove light pollution gradient:', err);
    }
  };

  const hideTonemapper = isForMask || appSettings?.tonemapperOverrideEnabled;

  return (
    <div>
      {!isForMask && (
        <div className="mb-3">
          {detectedSceneBadge && (
            <div className="mb-1.5 px-2 py-1 rounded bg-amber-500/15 border border-amber-500/30 flex items-center justify-between text-[11px] text-amber-300 animate-fadeIn">
              <span className="font-medium">AI Scene: {detectedSceneBadge}</span>
              <span className="text-[10px] text-amber-400/80">Tailored Polish Applied</span>
            </div>
          )}
          <div className="grid grid-cols-5 gap-1">
            {/* 1-Click Auto Enhance Button */}
            <button
              type="button"
              onClick={handleAutoEnhance}
              disabled={isAutoAnalyzing}
              className="flex items-center justify-center gap-1 py-2 px-1 rounded-md bg-surface hover:bg-surface-secondary border border-border-color/50 text-text-primary hover:text-amber-400 font-medium text-xs truncate transition-all shadow-xs disabled:opacity-50"
              title="1-Click Universal AI Polish: Detects scene (portrait, sunset, landscape, pets, architecture), balances dynamic range, and auto-levels horizon."
            >
              {isAutoAnalyzing ? (
                <Loader2 size={12} className="animate-spin text-amber-400 shrink-0" />
              ) : (
                <Zap size={12} className="text-amber-400 shrink-0" />
              )}
              <span className="truncate">Auto</span>
            </button>

            {/* Wedding Magic Button with Scene Menu */}
            <div className="relative" ref={weddingMenuRef}>
              <div className="flex rounded-md bg-surface hover:bg-surface-secondary border border-border-color/50 transition-all shadow-xs group">
                <button
                  type="button"
                  onClick={() => handleWeddingMagic(selectedWeddingScene)}
                  className="flex-1 flex items-center justify-center gap-1 py-2 px-1 text-text-primary hover:text-pink-400 font-medium text-xs truncate"
                  title={String(
                    (t as any)('adjustments.basic.weddingMagicDesc') ||
                      '1-Click Bridal & Portrait Engine: Preserves white gown lace, flatters skin tones, adds bridal veil glow, and neutralizes neon foliage.'
                  )}
                >
                  <Heart size={12} className="text-pink-400 group-hover:scale-110 transition-transform shrink-0" />
                  <span className="truncate">
                    {String((t as any)('adjustments.basic.weddingMagicShort') || 'Wedding')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsWeddingMenuOpen(!isWeddingMenuOpen)}
                  className="px-1 border-l border-border-color/40 text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center"
                  title="Select Wedding Scene Preset"
                >
                  <ChevronDown size={11} className={clsx('transition-transform', isWeddingMenuOpen && 'rotate-180')} />
                </button>
              </div>

              {isWeddingMenuOpen && (
                <div className="absolute top-full left-0 mt-1 py-1 bg-[#18181b] border border-border-color/80 rounded-md shadow-2xl backdrop-blur-xl z-50 text-xs min-w-[150px]">
                  {(
                    [
                      { key: 'master', label: 'Master Wedding Look' },
                      { key: 'bridalGlow', label: '👰 Bridal Glow' },
                      { key: 'ceremony', label: '💒 Ceremony (Lace)' },
                      { key: 'goldenHour', label: '🌅 Golden Hour' },
                      { key: 'reception', label: '🥂 Reception (Film)' },
                    ] as const
                  ).map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleWeddingMagic(key as WeddingScene)}
                      className={clsx(
                        'w-full flex items-center justify-between px-2.5 py-1.5 text-left hover:bg-surface/80 transition-colors',
                        selectedWeddingScene === key ? 'text-pink-400 font-semibold' : 'text-text-secondary'
                      )}
                    >
                      <span className="truncate">{label}</span>
                      {selectedWeddingScene === key && <Check size={12} className="shrink-0 text-pink-400 ml-1" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Macro Magic Button with Scene Menu */}
            <div className="relative" ref={macroMenuRef}>
              <div className="flex rounded-md bg-surface hover:bg-surface-secondary border border-border-color/50 transition-all shadow-xs group">
                <button
                  type="button"
                  onClick={() => handleMacroMagic(selectedMacroScene)}
                  className="flex-1 flex items-center justify-center gap-1 py-2 px-1 text-text-primary hover:text-emerald-400 font-medium text-xs truncate"
                  title={String(
                    (t as any)('adjustments.basic.macroMagicDesc') ||
                      '1-Click Macro & Close-up Engine: Recovers diffraction softness, compresses water droplet reflections, removes LoCA fringing, and enhances biological vibrance.'
                  )}
                >
                  <Flower2 size={12} className="text-emerald-400 group-hover:scale-110 transition-transform shrink-0" />
                  <span className="truncate">
                    {String((t as any)('adjustments.basic.macroMagicShort') || 'Macro')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsMacroMenuOpen(!isMacroMenuOpen)}
                  className="px-1 border-l border-border-color/40 text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center"
                  title="Select Macro Scene Preset"
                >
                  <ChevronDown size={11} className={clsx('transition-transform', isMacroMenuOpen && 'rotate-180')} />
                </button>
              </div>

              {isMacroMenuOpen && (
                <div className="absolute top-full left-0 mt-1 py-1 bg-[#18181b] border border-border-color/80 rounded-md shadow-2xl backdrop-blur-xl z-50 text-xs min-w-[150px]">
                  {(
                    [
                      { key: 'master', label: 'Master Macro Look' },
                      { key: 'droplets', label: '💧 Water Droplets' },
                      { key: 'insects', label: '🐝 Insects & Chitin' },
                      { key: 'botanical', label: '🌸 Botanical & Flora' },
                      { key: 'jewelry', label: '💍 Jewelry & Rings' },
                    ] as const
                  ).map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleMacroMagic(key as MacroScene)}
                      className={clsx(
                        'w-full flex items-center justify-between px-2.5 py-1.5 text-left hover:bg-surface/80 transition-colors',
                        selectedMacroScene === key ? 'text-emerald-400 font-semibold' : 'text-text-secondary'
                      )}
                    >
                      <span className="truncate">{label}</span>
                      {selectedMacroScene === key && <Check size={12} className="shrink-0 text-emerald-400 ml-1" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Night Sky Magic Button with Scene Menu */}
            <div className="relative" ref={astroMenuRef}>
              <div className="flex rounded-md bg-surface hover:bg-surface-secondary border border-border-color/50 transition-all shadow-xs group">
                <button
                  type="button"
                  onClick={() => handleNightSkyMagic(selectedAstroScene)}
                  className="flex-1 flex items-center justify-center gap-1 py-2 px-1 text-text-primary hover:text-accent font-medium text-xs truncate"
                  title={String(
                    (t as any)('adjustments.basic.nightSkyMagicDesc') ||
                      '1-Click Astrophotography Engine: Neutralizes light pollution, stretches nebular contrast, enhances H-alpha emissions, and preserves star colors.'
                  )}
                >
                  <Sparkles size={12} className="text-accent group-hover:scale-110 transition-transform shrink-0" />
                  <span className="truncate">
                    {String((t as any)('adjustments.basic.nightSkyMagicShort') || 'Night Sky')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsAstroMenuOpen(!isAstroMenuOpen)}
                  className="px-1 border-l border-border-color/40 text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center"
                  title="Select Astro Scene Preset"
                >
                  <ChevronDown size={11} className={clsx('transition-transform', isAstroMenuOpen && 'rotate-180')} />
                </button>
              </div>

              {isAstroMenuOpen && (
                <div className="absolute top-full right-0 mt-1 py-1 bg-[#18181b] border border-border-color/80 rounded-md shadow-2xl backdrop-blur-xl z-50 text-xs min-w-[160px]">
                  {(
                    [
                      { key: 'master', label: 'Master Astro Look' },
                      { key: 'milkyWay', label: '🌌 Milky Way Core' },
                      { key: 'starryLandscape', label: '🌠 Starry Landscape' },
                      { key: 'deepSky', label: '☄️ Deep Sky & Nebulae' },
                      { key: 'moonlitAurora', label: '🌙 Moonlit & Aurora' },
                    ] as const
                  ).map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleNightSkyMagic(key as AstroScene)}
                      className={clsx(
                        'w-full flex items-center justify-between px-2.5 py-1.5 text-left hover:bg-surface/80 transition-colors',
                        selectedAstroScene === key ? 'text-accent font-semibold' : 'text-text-secondary'
                      )}
                    >
                      <span className="truncate">{label}</span>
                      {selectedAstroScene === key && <Check size={12} className="shrink-0 text-accent ml-1" />}
                    </button>
                  ))}
                  <div className="border-t border-border-color/50 my-1" />
                  <button
                    type="button"
                    onClick={handleRemoveLightPollution}
                    className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-surface/80 text-amber-400 font-medium transition-colors"
                    title="Extracts and subtracts 2D polynomial background light pollution gradient"
                  >
                    <span className="truncate">⚡ Remove Light Pollution</span>
                  </button>
                </div>
              )}
            </div>

            {/* Sky Sculptor Button with Menu */}
            <div className="relative" ref={skyMenuRef}>
              <div className="flex rounded-md bg-surface hover:bg-surface-secondary border border-border-color/50 transition-all shadow-xs group">
                <button
                  type="button"
                  onClick={() => handleSkySculpt(selectedSkyPreset)}
                  className="flex-1 flex items-center justify-center gap-1 py-2 px-1 text-text-primary hover:text-sky-400 font-medium text-xs truncate"
                  title="AI Sky Sculptor: Deep Polar Blue, Sunset Glow, Stormy Clouds, and Horizon Dehaze"
                >
                  <Sun size={12} className="text-sky-400 group-hover:scale-110 transition-transform shrink-0" />
                  <span className="truncate">Sky</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsSkyMenuOpen(!isSkyMenuOpen)}
                  className="px-1 border-l border-border-color/40 text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center"
                  title="Select Sky Preset"
                >
                  <ChevronDown size={11} className={clsx('transition-transform', isSkyMenuOpen && 'rotate-180')} />
                </button>
              </div>

              {isSkyMenuOpen && (
                <div className="absolute top-full right-0 mt-1 py-1 bg-[#18181b] border border-border-color/80 rounded-md shadow-2xl backdrop-blur-xl z-50 text-xs min-w-[170px]">
                  {[
                    { key: 'polar', label: '🌌 Deep Polar Blue' },
                    { key: 'sunset', label: '🌅 Sunset Amber Glow' },
                    { key: 'stormy', label: '⛈️ Stormy Drama' },
                    { key: 'golden', label: '☀️ Golden Hour Radiance' },
                    { key: 'gentle', label: '🌫️ Clean Horizon Dehaze' },
                  ].map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleSkySculpt(key)}
                      className={clsx(
                        'w-full flex items-center justify-between px-2.5 py-1.5 text-left hover:bg-surface/80 transition-colors',
                        selectedSkyPreset === key ? 'text-accent font-semibold' : 'text-text-secondary'
                      )}
                    >
                      <span className="truncate">{label}</span>
                      {selectedSkyPreset === key && <Check size={12} className="shrink-0 text-accent ml-1" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {hideTonemapper ? (
        <Slider
          label={t('adjustments.basic.exposure')}
          max={5}
          min={-5}
          onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Exposure, e.target.value)}
          step={0.01}
          value={adjustments.exposure}
          onDragStateChange={onDragStateChange}
        />
      ) : (
        <ToneMapperSwitch
          selectedMapper={adjustments.toneMapper || 'agx'}
          onMapperChange={handleToneMapperChange}
          exposureValue={adjustments.exposure}
          onExposureChange={(value) => handleAdjustmentChange(BasicAdjustment.Exposure, value)}
          onDragStateChange={onDragStateChange}
        />
      )}
      <Slider
        label={t('adjustments.basic.contrast')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Contrast, e.target.value)}
        step={1}
        value={adjustments.contrast}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.highlights')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Highlights, e.target.value)}
        step={1}
        value={adjustments.highlights}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.shadows')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Shadows, e.target.value)}
        step={1}
        value={adjustments.shadows}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.whites')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Whites, e.target.value)}
        step={1}
        value={adjustments.whites}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.blacks')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Blacks, e.target.value)}
        step={1}
        value={adjustments.blacks}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.brightness')}
        max={5}
        min={-5}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Brightness, e.target.value)}
        step={0.01}
        value={adjustments.brightness}
        onDragStateChange={onDragStateChange}
      />
    </div>
  );
}
