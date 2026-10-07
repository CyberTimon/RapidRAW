import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { Loader2, Circle, Hexagon, Octagon, Aperture, Plus, X } from 'lucide-react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import {
  Adjustments,
  Effect,
  CreativeAdjustment,
  RelightLight,
  getAdjustmentToolOrder,
  getHiddenAdjustmentTools,
  createRelightLight,
  getRelightLightColor,
} from '../../utils/adjustments';
import Dropdown from '../ui/Dropdown';
import LUTControl from '../ui/LUTControl';
import ColorField, { normalizeHexColor, useParsedTextField } from '../ui/ColorField';
import { ColorSwatch } from './Color';
import { AppSettings } from '../ui/AppProperties';
import Text from '../ui/Text';
import AdjustmentSubSection from './AdjustmentSubSection';
import { TextVariants } from '../../types/typography';
import { DepthRangePicker } from '../ui/DepthRangePicker';
import { useProcessStore } from '../../store/useProcessStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useEditorStore } from '../../store/useEditorStore';

interface EffectsPanelProps {
  adjustments: Adjustments;
  isForMask?: boolean;
  setAdjustments(adjustments: Partial<Adjustments> | ((prev: Adjustments) => Adjustments)): any;
  handleLutSelect(path: string, isSceneReferred: boolean): void;
  onLutHover?: (path: string | null) => void;
  appSettings: AppSettings | null;
  onDragStateChange?: (isDragging: boolean) => void;
}

interface BokehShapeSwitchProps {
  selectedShape: string;
  onShapeChange: (shape: string) => void;
}

const BokehShapeSwitch = ({ selectedShape, onShapeChange }: BokehShapeSwitchProps) => {
  const { t } = useTranslation();
  const [bubbleStyle, setBubbleStyle] = useState({});
  const [isLabelHovered, setIsLabelHovered] = useState(false);
  const isInitialAnimation = useRef(true);

  const shapeOptions = useMemo(
    () => [
      { id: 'circle', icon: Circle, title: t('adjustments.effects.bokehCircular') },
      { id: 'hexagon', icon: Hexagon, title: t('adjustments.effects.bokehHexagonal') },
      { id: 'octagon', icon: Octagon, title: t('adjustments.effects.bokehOctagonal') },
      { id: 'ring', icon: Aperture, title: t('adjustments.effects.bokehRing') },
    ],
    [t],
  );

  useEffect(() => {
    const selectedIndex = shapeOptions.findIndex((m) => m.id === selectedShape);
    const safeIndex = selectedIndex >= 0 ? selectedIndex : 0;

    const widthPercent = 100 / shapeOptions.length;
    const targetX = `${safeIndex * 100}%`;
    const targetWidth = `${widthPercent}%`;

    if (isInitialAnimation.current) {
      setBubbleStyle({
        x: ['-25%', targetX],
        width: targetWidth,
      });
      isInitialAnimation.current = false;
    } else {
      setBubbleStyle({
        x: targetX,
        width: targetWidth,
      });
    }
  }, [selectedShape, shapeOptions]);

  const handleReset = () => {
    onShapeChange('circle');
  };

  return (
    <div className="flex flex-col gap-2 mt-3">
      <div
        className="grid w-fit cursor-pointer"
        onClick={handleReset}
        onMouseEnter={() => setIsLabelHovered(true)}
        onMouseLeave={() => setIsLabelHovered(false)}
      >
        <Text
          variant={TextVariants.label}
          aria-hidden={isLabelHovered}
          className={`col-start-1 row-start-1 text-text-secondary select-none transition-opacity duration-200 ease-in-out ${
            isLabelHovered ? 'opacity-0' : 'opacity-100'
          }`}
        >
          {t('adjustments.effects.bokehShape')}
        </Text>
        <Text
          variant={TextVariants.label}
          aria-hidden={!isLabelHovered}
          className={`col-start-1 row-start-1 text-accent! select-none transition-opacity duration-200 ease-in-out pointer-events-none ${
            isLabelHovered ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {t('ui.slider.reset')}
        </Text>
      </div>

      <div className="w-full p-1 bg-bg-primary rounded-md">
        <div className="relative flex w-full">
          <motion.div
            className="absolute top-0 bottom-0 z-0 bg-accent"
            style={{ borderRadius: 6 }}
            animate={bubbleStyle}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
          />
          {shapeOptions.map((shape) => {
            const Icon = shape.icon;
            return (
              <button
                key={shape.id}
                data-tooltip={shape.title}
                onClick={() => onShapeChange(shape.id)}
                className={clsx(
                  'relative flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                  {
                    'text-text-secondary hover:text-text-primary hover:bg-surface': selectedShape !== shape.id,
                    'text-button-text': selectedShape === shape.id,
                  },
                )}
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <span className="relative z-10 flex items-center">
                  <Icon size={16} strokeWidth={2} />
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default function EffectsPanel({
  adjustments,
  setAdjustments,
  isForMask = false,
  handleLutSelect,
  onLutHover,
  appSettings,
  onDragStateChange,
}: EffectsPanelProps) {
  const { t } = useTranslation();
  const [isGeneratingDepth, setIsGeneratingDepth] = useState(false);
  const [isGeneratingNormals, setIsGeneratingNormals] = useState(false);
  const [isGeneratingFogDepth, setIsGeneratingFogDepth] = useState(false);
  const [hoveredLightId, setHoveredLightId] = useState<string | null>(null);
  const aiModelDownloadStatus = useProcessStore((state) => state.aiModelDownloadStatus);
  const isRelightPickerActive = useEditorStore((state) => state.isRelightPickerActive);
  const activeRelightLightId = useEditorStore((state) => state.activeRelightLightId);
  const setEditor = useEditorStore((state) => state.setEditor);

  const handleGenerateLensBlurDepthMap = async () => {
    setIsGeneratingDepth(true);
    try {
      const b64: string = await invoke('generate_full_image_depth_map');
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        lensBlurDepthMap: b64,
      }));
    } catch (e: any) {
      toast.error(`Failed to generate depth map: ${e}`);
      setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, lensBlurEnabled: false }));
    } finally {
      setIsGeneratingDepth(false);
    }
  };

  const handleGenerateRelightNormalMap = async () => {
    setIsGeneratingNormals(true);
    try {
      const b64: string = await invoke('generate_relight_normal_map');
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        relightNormalMap: b64,
      }));
    } catch (e: any) {
      toast.error(`Failed to generate normal map: ${e}`);
      setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, relightEnabled: false }));
    } finally {
      setIsGeneratingNormals(false);
    }
  };

  const handleGenerateFogDepthMap = async () => {
    setIsGeneratingFogDepth(true);
    try {
      const b64: string = await invoke('generate_full_image_depth_map');
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        fogDepthMap: b64,
      }));
    } catch (e: any) {
      toast.error(`Failed to generate depth map: ${e}`);
      setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, fogEnabled: false }));
    } finally {
      setIsGeneratingFogDepth(false);
    }
  };

  const handleAdjustmentChange = (key: string, value: any) => {
    const numericValue = typeof value === 'boolean' ? value : parseInt(value, 10);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: numericValue }));
  };

  const handleLutIntensityChange = (intensity: number) => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, lutIntensity: intensity }));
  };

  const handleLutClear = () => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      lutPath: null,
      lutName: null,
      lutData: null,
      lutSize: 0,
      lutIntensity: 100,
      lutIsSceneReferred: false,
    }));
  };

  const handleLensBlurToggle = (enabled: boolean) => {
    handleAdjustmentChange(Effect.LensBlurEnabled, enabled);
    if (enabled && !adjustments.lensBlurDepthMap) {
      handleGenerateLensBlurDepthMap();
    }
  };

  const handleFogToggle = (enabled: boolean) => {
    handleAdjustmentChange(Effect.FogEnabled, enabled);
    if (enabled && !adjustments.fogDepthMap) {
      handleGenerateFogDepthMap();
    }
  };

  const handleRelightToggle = (enabled: boolean) => {
    handleAdjustmentChange(Effect.RelightEnabled, enabled);
    if (!enabled) {
      setEditor({ isRelightPickerActive: false });
    }
    if (enabled && !adjustments.relightNormalMap) {
      handleGenerateRelightNormalMap();
    }
  };

  const relightLights: Array<RelightLight> = adjustments.relightLights || [];
  const activeLight = relightLights.find((light) => light.id === activeRelightLightId);

  const handleSelectLight = (id: string) => {
    if (activeLight?.id === id && isRelightPickerActive) {
      setEditor({ isRelightPickerActive: false });
      return;
    }
    setEditor({ activeRelightLightId: id, isRelightPickerActive: true, isWbPickerActive: false });
  };

  const handleAddLight = () => {
    const light = createRelightLight(0.5, 0.5);
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      relightLights: [...(prev.relightLights || []), light],
    }));
    setEditor({ activeRelightLightId: light.id, isRelightPickerActive: true, isWbPickerActive: false });
  };

  const handleLightChange = (key: keyof RelightLight, value: number | string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      relightLights: (prev.relightLights || []).map((light: RelightLight) =>
        light.id === activeRelightLightId ? { ...light, [key]: value } : light,
      ),
    }));
  };

  const lightColorField = useParsedTextField(
    activeLight?.color ?? '#ffffff',
    (color) => handleLightChange('color', color),
    normalizeHexColor,
  );

  const handleRemoveLight = (id: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      relightLights: (prev.relightLights || []).filter((light: RelightLight) => light.id !== id),
    }));
    if (id === activeRelightLightId) {
      setEditor({ activeRelightLightId: null, isRelightPickerActive: false });
    }
  };

  const isAiFree = useSettingsStore((s) => s.appSettings?.aiProvider === 'ai-free');
  const hiddenTools = getHiddenAdjustmentTools(appSettings?.adjustmentLayout);
  const toolOrder = getAdjustmentToolOrder('effects', appSettings?.adjustmentLayout?.toolOrder);

  return (
    <div className="flex flex-col gap-4">
      {!hiddenTools.includes('creative') && (
        <AdjustmentSubSection
          id="creative"
          order={toolOrder.indexOf('creative')}
          title={t('adjustments.effects.creative')}
        >
          <Slider
            label={t('adjustments.effects.glow')}
            max={100}
            min={0}
            onChange={(e: any) => handleAdjustmentChange(CreativeAdjustment.GlowAmount, e.target.value)}
            step={1}
            value={adjustments.glowAmount}
            onDragStateChange={onDragStateChange}
          />

          <Slider
            label={t('adjustments.effects.halation')}
            max={100}
            min={0}
            onChange={(e: any) => handleAdjustmentChange(CreativeAdjustment.HalationAmount, e.target.value)}
            step={1}
            value={adjustments.halationAmount}
            onDragStateChange={onDragStateChange}
          />

          {!isForMask && (
            <Slider
              label={t('adjustments.effects.lightFlares')}
              max={100}
              min={0}
              onChange={(e: any) => handleAdjustmentChange(CreativeAdjustment.FlareAmount, e.target.value)}
              step={1}
              value={adjustments.flareAmount}
              onDragStateChange={onDragStateChange}
            />
          )}
        </AdjustmentSubSection>
      )}

      {!isForMask && (
        <>
          {!isAiFree && !hiddenTools.includes('spatial') && (
            <AdjustmentSubSection
              id="spatial"
              order={toolOrder.indexOf('spatial')}
              title={t('adjustments.effects.spatial')}
            >
              <div className="space-y-3">
                <div>
                  <Switch
                    label={t('adjustments.effects.lensBlur')}
                    checked={!!adjustments.lensBlurEnabled}
                    onChange={handleLensBlurToggle}
                  />

                  <div
                    className={`grid transition-all duration-300 ease-in-out ${
                      adjustments.lensBlurEnabled ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                    }`}
                  >
                    <div className="overflow-hidden">
                      <div className="space-y-4 mt-4 mb-1 pl-2 border-l-2 border-card-active">
                        {isGeneratingDepth ? (
                          <div className="flex flex-col items-center justify-center gap-1 p-4 text-text-secondary text-center">
                            <div className="flex items-center gap-2">
                              <Loader2 size={16} className="animate-spin shrink-0" />
                              <Text variant={TextVariants.label}>
                                {aiModelDownloadStatus
                                  ? t('editor.masks.settings.aiModelDownloading')
                                  : t('editor.ai.generatingDepthMap')}
                              </Text>
                            </div>
                            {aiModelDownloadStatus && (
                              <Text variant={TextVariants.small} className="text-accent">
                                {aiModelDownloadStatus}
                              </Text>
                            )}
                          </div>
                        ) : (
                          <>
                            <Slider
                              label={t('adjustments.effects.amount')}
                              max={100}
                              min={0}
                              defaultValue={40}
                              onChange={(e: any) => handleAdjustmentChange(Effect.LensBlurAmount, e.target.value)}
                              step={1}
                              value={adjustments.lensBlurAmount ?? 50}
                              onDragStateChange={onDragStateChange}
                              fillOrigin="min"
                            />

                            <Slider
                              label={t('adjustments.effects.lensDiffusion')}
                              max={100}
                              min={0}
                              defaultValue={0}
                              onChange={(e: any) => handleAdjustmentChange(Effect.lensBlurDiffusion, e.target.value)}
                              step={1}
                              value={adjustments.lensBlurDiffusion ?? 0}
                              onDragStateChange={onDragStateChange}
                            />

                            <BokehShapeSwitch
                              selectedShape={adjustments.lensBlurShape || 'circle'}
                              onShapeChange={(shapeId) =>
                                setAdjustments((prev: Partial<Adjustments>) => ({
                                  ...prev,
                                  [Effect.LensBlurShape]: shapeId,
                                }))
                              }
                            />

                            <DepthRangePicker
                              minDepth={100 - (adjustments.lensBlurMaxDepth ?? 100)}
                              maxDepth={100 - (adjustments.lensBlurMinDepth ?? 20)}
                              minFade={adjustments.lensBlurMaxFade ?? 20}
                              maxFade={adjustments.lensBlurMinFade ?? 20}
                              defaultMinDepth={0}
                              defaultMaxDepth={80}
                              defaultMinFade={20}
                              defaultMaxFade={20}
                              onChange={(values: {
                                minDepth: number;
                                maxDepth: number;
                                minFade: number;
                                maxFade: number;
                              }) => {
                                setAdjustments((prev: Partial<Adjustments>) => ({
                                  ...prev,
                                  lensBlurMinDepth: 100 - values.maxDepth,
                                  lensBlurMaxDepth: 100 - values.minDepth,
                                  lensBlurMinFade: values.maxFade,
                                  lensBlurMaxFade: values.minFade,
                                }));
                              }}
                              onDragStateChange={onDragStateChange}
                            />
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <div>
                  <Switch
                    label={t('adjustments.effects.relight')}
                    checked={!!adjustments.relightEnabled}
                    onChange={handleRelightToggle}
                  />

                  <div
                    className={`grid transition-all duration-300 ease-in-out ${
                      adjustments.relightEnabled ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                    }`}
                  >
                    <div className="overflow-hidden">
                      <div className="space-y-4 mt-4 mb-1 pl-2 border-l-2 border-card-active">
                        {isGeneratingNormals ? (
                          <div className="flex flex-col items-center justify-center gap-1 p-4 text-text-secondary text-center">
                            <div className="flex items-center gap-2">
                              <Loader2 size={16} className="animate-spin shrink-0" />
                              <Text variant={TextVariants.label}>
                                {aiModelDownloadStatus
                                  ? t('editor.masks.settings.aiModelDownloading')
                                  : t('editor.ai.generatingNormalMap')}
                              </Text>
                            </div>
                            {aiModelDownloadStatus && (
                              <Text variant={TextVariants.small} className="text-accent">
                                {aiModelDownloadStatus}
                              </Text>
                            )}
                          </div>
                        ) : (
                          <>
                            <Slider
                              label={t('adjustments.effects.relightAmbient')}
                              max={100}
                              min={-100}
                              onChange={(e: any) => handleAdjustmentChange(Effect.RelightAmbient, e.target.value)}
                              step={1}
                              value={adjustments.relightAmbient ?? 0}
                              onDragStateChange={onDragStateChange}
                            />

                            <Slider
                              label={t('adjustments.effects.relightSoftness')}
                              max={100}
                              min={0}
                              defaultValue={25}
                              onChange={(e: any) => handleAdjustmentChange(Effect.RelightSoftness, e.target.value)}
                              step={1}
                              value={adjustments.relightSoftness ?? 25}
                              onDragStateChange={onDragStateChange}
                              fillOrigin="min"
                            />

                            <Slider
                              label={t('adjustments.effects.relightShine')}
                              max={100}
                              min={0}
                              onChange={(e: any) => handleAdjustmentChange(Effect.RelightShine, e.target.value)}
                              step={1}
                              value={adjustments.relightShine ?? 0}
                              onDragStateChange={onDragStateChange}
                            />

                            <Switch
                              label={t('adjustments.effects.relightShadows')}
                              checked={!!adjustments.relightShadows}
                              onChange={(enabled: boolean) => handleAdjustmentChange(Effect.RelightShadows, enabled)}
                            />

                            {adjustments.relightShadows && (
                              <Slider
                                label={t('adjustments.effects.relightShadowSoftness')}
                                max={100}
                                min={0}
                                defaultValue={15}
                                onChange={(e: any) =>
                                  handleAdjustmentChange(Effect.RelightShadowSoftness, e.target.value)
                                }
                                step={1}
                                value={adjustments.relightShadowSoftness ?? 15}
                                onDragStateChange={onDragStateChange}
                                fillOrigin="min"
                              />
                            )}

                            <div className="p-3 rounded-md bg-bg-primary space-y-4" data-relight-lights>
                              <div className="flex flex-wrap items-center gap-3 px-1">
                                {relightLights.map((light, index) => (
                                  <div
                                    className="relative flex"
                                    key={light.id}
                                    onMouseEnter={() => setHoveredLightId(light.id)}
                                    onMouseLeave={() => setHoveredLightId(null)}
                                  >
                                    <ColorSwatch
                                      color={getRelightLightColor(light)}
                                      isActive={activeLight?.id === light.id}
                                      name={light.id}
                                      onClick={handleSelectLight}
                                      ariaLabel={t('adjustments.effects.relightLight', { index: index + 1 })}
                                    />
                                    {hoveredLightId === light.id && (
                                      <button
                                        className="absolute -top-1 -right-1 z-10 p-0.5 rounded-full bg-card-active text-text-secondary hover:bg-red-500/20 hover:text-red-500 transition-all"
                                        onClick={(e: React.MouseEvent) => {
                                          e.stopPropagation();
                                          handleRemoveLight(light.id);
                                        }}
                                        data-tooltip={t('adjustments.effects.relightRemoveLight')}
                                      >
                                        <X size={10} />
                                      </button>
                                    )}
                                  </div>
                                ))}
                                <button
                                  aria-label={t('adjustments.effects.relightAddLight')}
                                  data-tooltip={t('adjustments.effects.relightAddLight')}
                                  onClick={handleAddLight}
                                  className="w-6 h-6 flex items-center justify-center rounded-full border-2 border-dashed border-text-secondary text-text-secondary hover:border-text-primary hover:text-text-primary transition-colors"
                                >
                                  <Plus size={14} />
                                </button>
                              </div>

                              {activeLight ? (
                                <>
                                  <div>
                                    <Text variant={TextVariants.label} className="mb-2 block">
                                      {t('adjustments.effects.relightType')}
                                    </Text>
                                    <Dropdown
                                      options={[
                                        { label: t('adjustments.effects.relightTypes.point'), value: 'point' },
                                        { label: t('adjustments.effects.relightTypes.spot'), value: 'spot' },
                                        {
                                          label: t('adjustments.effects.relightTypes.directional'),
                                          value: 'directional',
                                        },
                                      ]}
                                      value={activeLight.type}
                                      onChange={(val) => handleLightChange('type', val)}
                                    />
                                  </div>

                                  <ColorField
                                    color={activeLight.color || '#ffffff'}
                                    disabled={false}
                                    field={lightColorField}
                                    label={t('adjustments.effects.relightColor')}
                                    onColorChange={(color) => handleLightChange('color', color)}
                                  />

                                  <Slider
                                    label={t('adjustments.effects.relightIntensity')}
                                    max={100}
                                    min={0}
                                    defaultValue={60}
                                    onChange={(e: any) => handleLightChange('intensity', parseInt(e.target.value, 10))}
                                    step={1}
                                    value={activeLight.intensity}
                                    onDragStateChange={onDragStateChange}
                                    fillOrigin="min"
                                  />

                                  {activeLight.type !== 'directional' && (
                                    <>
                                      <Slider
                                        label={t('adjustments.effects.relightDepth')}
                                        max={100}
                                        min={0}
                                        defaultValue={0}
                                        onChange={(e: any) => handleLightChange('depth', parseInt(e.target.value, 10))}
                                        step={1}
                                        value={activeLight.depth}
                                        onDragStateChange={onDragStateChange}
                                        fillOrigin="min"
                                      />

                                      <Slider
                                        label={t('adjustments.effects.relightFalloff')}
                                        max={100}
                                        min={0}
                                        defaultValue={30}
                                        onChange={(e: any) => handleLightChange('radius', parseInt(e.target.value, 10))}
                                        step={1}
                                        value={activeLight.radius}
                                        onDragStateChange={onDragStateChange}
                                        fillOrigin="min"
                                      />
                                    </>
                                  )}

                                  {activeLight.type !== 'point' && (
                                    <>
                                      <Slider
                                        label={t('adjustments.effects.relightAngle')}
                                        max={360}
                                        min={0}
                                        defaultValue={135}
                                        onChange={(e: any) => handleLightChange('angle', parseInt(e.target.value, 10))}
                                        step={1}
                                        suffix="°"
                                        value={activeLight.angle}
                                        onDragStateChange={onDragStateChange}
                                        fillOrigin="min"
                                      />

                                      <Slider
                                        label={t('adjustments.effects.relightElevation')}
                                        max={180}
                                        min={-180}
                                        defaultValue={60}
                                        onChange={(e: any) =>
                                          handleLightChange('elevation', parseInt(e.target.value, 10))
                                        }
                                        step={1}
                                        suffix="°"
                                        value={activeLight.elevation}
                                        onDragStateChange={onDragStateChange}
                                      />
                                    </>
                                  )}

                                  {activeLight.type === 'spot' && (
                                    <>
                                      <Slider
                                        label={t('adjustments.effects.relightCone')}
                                        max={100}
                                        min={0}
                                        defaultValue={40}
                                        onChange={(e: any) => handleLightChange('cone', parseInt(e.target.value, 10))}
                                        step={1}
                                        value={activeLight.cone}
                                        onDragStateChange={onDragStateChange}
                                        fillOrigin="min"
                                      />

                                      <Slider
                                        label={t('adjustments.effects.feather')}
                                        max={100}
                                        min={0}
                                        defaultValue={50}
                                        onChange={(e: any) =>
                                          handleLightChange('feather', parseInt(e.target.value, 10))
                                        }
                                        step={1}
                                        value={activeLight.feather}
                                        onDragStateChange={onDragStateChange}
                                        fillOrigin="min"
                                      />
                                    </>
                                  )}

                                  <Slider
                                    label={t('adjustments.color.temperature')}
                                    max={100}
                                    min={-100}
                                    onChange={(e: any) =>
                                      handleLightChange('temperature', parseInt(e.target.value, 10))
                                    }
                                    step={1}
                                    value={activeLight.temperature}
                                    trackClassName="temperature-gradient-track"
                                    onDragStateChange={onDragStateChange}
                                  />

                                  <Slider
                                    label={t('adjustments.color.tint')}
                                    max={100}
                                    min={-100}
                                    onChange={(e: any) => handleLightChange('tint', parseInt(e.target.value, 10))}
                                    step={1}
                                    value={activeLight.tint}
                                    trackClassName="tint-gradient-track"
                                    onDragStateChange={onDragStateChange}
                                  />
                                </>
                              ) : (
                                <Text variant={TextVariants.small} className="text-text-secondary">
                                  {t('adjustments.effects.relightHint')}
                                </Text>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <div>
                  <Switch
                    label={t('adjustments.effects.fog')}
                    checked={!!adjustments.fogEnabled}
                    onChange={handleFogToggle}
                  />

                  <div
                    className={`grid transition-all duration-300 ease-in-out ${
                      adjustments.fogEnabled ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                    }`}
                  >
                    <div className="overflow-hidden">
                      <div className="space-y-4 mt-4 mb-1 pl-2 border-l-2 border-card-active">
                        {isGeneratingFogDepth ? (
                          <div className="flex flex-col items-center justify-center gap-1 p-4 text-text-secondary text-center">
                            <div className="flex items-center gap-2">
                              <Loader2 size={16} className="animate-spin shrink-0" />
                              <Text variant={TextVariants.label}>
                                {aiModelDownloadStatus
                                  ? t('editor.masks.settings.aiModelDownloading')
                                  : t('editor.ai.generatingDepthMap')}
                              </Text>
                            </div>
                            {aiModelDownloadStatus && (
                              <Text variant={TextVariants.small} className="text-accent">
                                {aiModelDownloadStatus}
                              </Text>
                            )}
                          </div>
                        ) : (
                          <>
                            <Slider
                              label={t('adjustments.effects.amount')}
                              max={100}
                              min={0}
                              defaultValue={50}
                              onChange={(e: any) => handleAdjustmentChange(Effect.FogAmount, e.target.value)}
                              step={1}
                              value={adjustments.fogAmount ?? 50}
                              onDragStateChange={onDragStateChange}
                              fillOrigin="min"
                            />

                            <Slider
                              label={t('adjustments.effects.fogStart')}
                              max={100}
                              min={0}
                              defaultValue={0}
                              onChange={(e: any) => handleAdjustmentChange(Effect.FogStart, e.target.value)}
                              step={1}
                              value={adjustments.fogStart ?? 0}
                              onDragStateChange={onDragStateChange}
                              fillOrigin="min"
                            />

                            <Slider
                              label={t('adjustments.effects.fogDensity')}
                              max={100}
                              min={0}
                              defaultValue={50}
                              onChange={(e: any) => handleAdjustmentChange(Effect.FogDensity, e.target.value)}
                              step={1}
                              value={adjustments.fogDensity ?? 50}
                              onDragStateChange={onDragStateChange}
                              fillOrigin="min"
                            />

                            <Slider
                              label={t('adjustments.effects.fogHeight')}
                              max={100}
                              min={0}
                              defaultValue={0}
                              onChange={(e: any) => handleAdjustmentChange(Effect.FogHeight, e.target.value)}
                              step={1}
                              value={adjustments.fogHeight ?? 0}
                              onDragStateChange={onDragStateChange}
                              fillOrigin="min"
                            />

                            <Slider
                              label={t('adjustments.effects.fogVariation')}
                              max={100}
                              min={0}
                              defaultValue={25}
                              onChange={(e: any) => handleAdjustmentChange(Effect.FogVariation, e.target.value)}
                              step={1}
                              value={adjustments.fogVariation ?? 25}
                              onDragStateChange={onDragStateChange}
                              fillOrigin="min"
                            />

                            <Slider
                              label={t('adjustments.effects.glow')}
                              max={100}
                              min={0}
                              defaultValue={25}
                              onChange={(e: any) => handleAdjustmentChange(Effect.FogGlow, e.target.value)}
                              step={1}
                              value={adjustments.fogGlow ?? 25}
                              onDragStateChange={onDragStateChange}
                              fillOrigin="min"
                            />

                            <Slider
                              label={t('adjustments.color.temperature')}
                              max={100}
                              min={-100}
                              onChange={(e: any) => handleAdjustmentChange(Effect.FogTemperature, e.target.value)}
                              step={1}
                              value={adjustments.fogTemperature ?? 0}
                              trackClassName="temperature-gradient-track"
                              onDragStateChange={onDragStateChange}
                            />

                            <Slider
                              label={t('adjustments.color.tint')}
                              max={100}
                              min={-100}
                              onChange={(e: any) => handleAdjustmentChange(Effect.FogTint, e.target.value)}
                              step={1}
                              value={adjustments.fogTint ?? 0}
                              trackClassName="tint-gradient-track"
                              onDragStateChange={onDragStateChange}
                            />
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </AdjustmentSubSection>
          )}

          {!hiddenTools.includes('lut') && (
            <AdjustmentSubSection id="lut" order={toolOrder.indexOf('lut')} title={t('adjustments.effects.lut')}>
              <LUTControl
                lutPath={adjustments.lutPath || null}
                lutName={adjustments.lutName || null}
                lutIntensity={adjustments.lutIntensity || 100}
                onLutSelect={handleLutSelect}
                onLutHover={onLutHover}
                onIntensityChange={handleLutIntensityChange}
                onClear={handleLutClear}
                onDragStateChange={onDragStateChange}
              />
            </AdjustmentSubSection>
          )}

          {!hiddenTools.includes('vignette') && (
            <AdjustmentSubSection
              id="vignette"
              order={toolOrder.indexOf('vignette')}
              title={t('adjustments.effects.vignette')}
            >
              <Slider
                label={t('adjustments.effects.amount')}
                max={100}
                min={-100}
                onChange={(e: any) => handleAdjustmentChange(Effect.VignetteAmount, e.target.value)}
                step={1}
                value={adjustments.vignetteAmount}
                onDragStateChange={onDragStateChange}
              />
              <Slider
                defaultValue={50}
                label={t('adjustments.effects.midpoint')}
                max={100}
                min={0}
                onChange={(e: any) => handleAdjustmentChange(Effect.VignetteMidpoint, e.target.value)}
                step={1}
                value={adjustments.vignetteMidpoint}
                onDragStateChange={onDragStateChange}
                fillOrigin="min"
              />
              <Slider
                label={t('adjustments.effects.roundness')}
                max={100}
                min={-100}
                onChange={(e: any) => handleAdjustmentChange(Effect.VignetteRoundness, e.target.value)}
                step={1}
                value={adjustments.vignetteRoundness}
                onDragStateChange={onDragStateChange}
              />
              <Slider
                defaultValue={50}
                label={t('adjustments.effects.feather')}
                max={100}
                min={0}
                onChange={(e: any) => handleAdjustmentChange(Effect.VignetteFeather, e.target.value)}
                step={1}
                value={adjustments.vignetteFeather}
                onDragStateChange={onDragStateChange}
                fillOrigin="min"
              />
            </AdjustmentSubSection>
          )}

          {!hiddenTools.includes('grain') && (
            <AdjustmentSubSection id="grain" order={toolOrder.indexOf('grain')} title={t('adjustments.effects.grain')}>
              <Slider
                label={t('adjustments.effects.amount')}
                max={100}
                min={0}
                onChange={(e: any) => handleAdjustmentChange(Effect.GrainAmount, e.target.value)}
                step={1}
                value={adjustments.grainAmount}
                onDragStateChange={onDragStateChange}
              />
              <Slider
                defaultValue={25}
                label={t('adjustments.effects.size')}
                max={100}
                min={0}
                onChange={(e: any) => handleAdjustmentChange(Effect.GrainSize, e.target.value)}
                step={1}
                value={adjustments.grainSize}
                onDragStateChange={onDragStateChange}
                fillOrigin="min"
              />
              <Slider
                defaultValue={50}
                label={t('adjustments.effects.roughness')}
                max={100}
                min={0}
                onChange={(e: any) => handleAdjustmentChange(Effect.GrainRoughness, e.target.value)}
                step={1}
                value={adjustments.grainRoughness}
                onDragStateChange={onDragStateChange}
                fillOrigin="min"
              />
            </AdjustmentSubSection>
          )}
        </>
      )}
    </div>
  );
}
