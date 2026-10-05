import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { Loader2, Circle, Hexagon, Octagon, Aperture, Plus, Trash2 } from 'lucide-react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import Button from '../ui/Button';
import {
  Adjustments,
  Effect,
  CreativeAdjustment,
  getAdjustmentToolOrder,
  getHiddenAdjustmentTools,
  RelightLight,
  DEFAULT_RELIGHT_LIGHT,
  MAX_RELIGHT_LIGHTS,
} from '../../utils/adjustments';
import LUTControl from '../ui/LUTControl';
import { AppSettings } from '../ui/AppProperties';
import Text from '../ui/Text';
import AdjustmentSubSection from './AdjustmentSubSection';
import { TextVariants } from '../../types/typography';
import { DepthRangePicker } from '../ui/DepthRangePicker';
import { useProcessStore } from '../../store/useProcessStore';
import { RELIGHT_TEMPERATURE_PRESETS, kelvinToHex } from '../../utils/relightUtils';
import { useEditorStore } from '../../store/useEditorStore';
import { v4 as uuidv4 } from 'uuid';

const NEW_RELIGHT_LIGHT_TEMPERATURES = [5600, 3200, 8000, 2700, 10000, 4000];

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
  const [isGeneratingNormal, setIsGeneratingNormal] = useState(false);
  const aiModelDownloadStatus = useProcessStore((state) => state.aiModelDownloadStatus);

  const handleGenerateLensBlurDepthMap = async () => {
    setIsGeneratingDepth(true);
    try {
      const b64: string = await invoke('generate_full_image_depth_map', { jsAdjustments: adjustments });
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
    setIsGeneratingNormal(true);
    try {
      const maps: { normalMap: string; depthMap: string; depthScale: number } = await invoke('generate_relight_maps', {
        jsAdjustments: adjustments,
      });
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        relightNormalMap: maps.normalMap,
        relightDepthMap: maps.depthMap,
        relightDepthScale: maps.depthScale,
      }));
    } catch (e: any) {
      toast.error(`Failed to generate normal map: ${e}`);
      setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, relightEnabled: false }));
    } finally {
      setIsGeneratingNormal(false);
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

  const relightLights = adjustments.relightLights ?? [];
  const activeRelightLightId = useEditorStore((state) => state.activeRelightLightId);
  const setEditor = useEditorStore((state) => state.setEditor);
  const activeRelightLight = relightLights.find((light) => light.id === activeRelightLightId) ?? relightLights[0];
  const relightColor = (activeRelightLight?.color || '#ffffff').toLowerCase();

  const updateActiveRelightLight = (changes: Partial<RelightLight>) => {
    if (!activeRelightLight) return;
    const id = activeRelightLight.id;
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      relightLights: (prev.relightLights ?? []).map((light) => (light.id === id ? { ...light, ...changes } : light)),
    }));
  };

  const handleRelightColorChange = (color: string) => {
    updateActiveRelightLight({ color: color.toLowerCase() });
  };

  const handleAddRelightLight = () => {
    if (relightLights.length >= MAX_RELIGHT_LIGHTS) return;
    // Each new light starts somewhere else and with another tint, so it is easy to tell apart.
    const index = relightLights.length;
    const light: RelightLight = {
      ...DEFAULT_RELIGHT_LIGHT,
      id: uuidv4(),
      x: [0.7, 0.5, 0.3, 0.7, 0.5][index % 5],
      y: [0.3, 0.7, 0.7, 0.7, 0.2][index % 5],
      color: kelvinToHex(NEW_RELIGHT_LIGHT_TEMPERATURES[index % NEW_RELIGHT_LIGHT_TEMPERATURES.length]),
    };
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      relightLights: [...(prev.relightLights ?? []), light],
    }));
    setEditor({ activeRelightLightId: light.id });
  };

  const handleRemoveRelightLight = () => {
    if (!activeRelightLight || relightLights.length <= 1) return;
    const id = activeRelightLight.id;
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      relightLights: (prev.relightLights ?? []).filter((light) => light.id !== id),
    }));
    setEditor({ activeRelightLightId: null });
  };

  const handleRelightToggle = (enabled: boolean) => {
    handleAdjustmentChange(Effect.RelightEnabled, enabled);
    if (enabled && (!adjustments.relightNormalMap || !adjustments.relightDepthMap)) {
      handleGenerateRelightNormalMap();
    }
  };

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
          {!hiddenTools.includes('lensBlur') && (
            <AdjustmentSubSection
              id="lensBlur"
              order={toolOrder.indexOf('lensBlur')}
              title={t('adjustments.effects.lensBlur')}
            >
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
                  <div className="space-y-4 pt-4 pb-1">
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
            </AdjustmentSubSection>
          )}

          {!hiddenTools.includes('relight') && (
            <AdjustmentSubSection
              id="relight"
              order={toolOrder.indexOf('relight')}
              title={t('adjustments.effects.relight')}
            >
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
                  <div className="space-y-4 pt-4 pb-1">
                    {isGeneratingNormal ? (
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
                        <div className="flex flex-col gap-2">
                          <Text variant={TextVariants.label} className="text-text-secondary select-none">
                            {t('adjustments.effects.relightLights')}
                          </Text>
                          <div className="flex items-center gap-2 flex-wrap">
                            {relightLights.map((light) => (
                              <button
                                key={light.id}
                                onClick={() => setEditor({ activeRelightLightId: light.id })}
                                className={clsx(
                                  'w-7 h-7 rounded-full border-2 transition-transform hover:scale-110',
                                  light.id === activeRelightLight?.id ? 'border-accent' : 'border-surface',
                                )}
                                style={{
                                  background: `radial-gradient(circle at 35% 30%, #ffffff 0%, ${light.color} 45%, color-mix(in srgb, ${light.color} 45%, #000000) 100%)`,
                                  WebkitTapHighlightColor: 'transparent',
                                }}
                              />
                            ))}
                            {relightLights.length < MAX_RELIGHT_LIGHTS && (
                              <button
                                onClick={handleAddRelightLight}
                                data-tooltip={t('adjustments.effects.relightAddLight')}
                                className="w-7 h-7 rounded-full flex items-center justify-center bg-bg-primary text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
                              >
                                <Plus size={14} />
                              </button>
                            )}
                            {relightLights.length > 1 && (
                              <button
                                onClick={handleRemoveRelightLight}
                                data-tooltip={t('adjustments.effects.relightRemoveLight')}
                                className="w-7 h-7 ml-auto rounded-full flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </div>

                        <Slider
                          label={t('adjustments.effects.relightIntensity')}
                          max={100}
                          min={0}
                          defaultValue={50}
                          onChange={(e: any) => updateActiveRelightLight({ intensity: parseInt(e.target.value, 10) })}
                          step={1}
                          value={activeRelightLight?.intensity ?? 50}
                          onDragStateChange={onDragStateChange}
                          fillOrigin="min"
                        />

                        <Slider
                          label={t('adjustments.effects.relightDepth')}
                          max={100}
                          min={-100}
                          defaultValue={30}
                          onChange={(e: any) => updateActiveRelightLight({ depth: parseInt(e.target.value, 10) })}
                          step={1}
                          value={activeRelightLight?.depth ?? 30}
                          onDragStateChange={onDragStateChange}
                        />

                        <Slider
                          label={t('adjustments.effects.relightRange')}
                          max={100}
                          min={0}
                          defaultValue={60}
                          onChange={(e: any) => updateActiveRelightLight({ range: parseInt(e.target.value, 10) })}
                          step={1}
                          value={activeRelightLight?.range ?? 60}
                          onDragStateChange={onDragStateChange}
                          fillOrigin="min"
                        />

                        <div className="flex flex-col gap-2">
                          <Text variant={TextVariants.label} className="text-text-secondary select-none">
                            {t('adjustments.effects.relightColor')}
                          </Text>
                          <div className="grid grid-cols-4 gap-1">
                            {RELIGHT_TEMPERATURE_PRESETS.map((kelvin) => {
                              const presetColor = kelvinToHex(kelvin);
                              return (
                                <button
                                  key={kelvin}
                                  onClick={() => handleRelightColorChange(presetColor)}
                                  className={clsx(
                                    'h-7 rounded-md border-2 text-xs font-medium text-black/70 transition-colors',
                                    relightColor === presetColor
                                      ? 'border-accent'
                                      : 'border-transparent hover:border-text-secondary',
                                  )}
                                  style={{ backgroundColor: presetColor, WebkitTapHighlightColor: 'transparent' }}
                                >
                                  {`${kelvin}K`}
                                </button>
                              );
                            })}
                          </div>
                          <label className="flex items-center gap-2 bg-bg-primary p-2 rounded-md cursor-pointer">
                            <input
                              aria-label={t('adjustments.effects.relightCustomColor')}
                              className="w-8 h-8 p-0 border-none rounded-sm cursor-pointer bg-transparent"
                              onChange={(e) => handleRelightColorChange(e.target.value)}
                              type="color"
                              value={relightColor}
                            />
                            <Text variant={TextVariants.label} className="text-text-secondary select-none">
                              {t('adjustments.effects.relightCustomColor')}
                            </Text>
                            <Text variant={TextVariants.small} className="ml-auto uppercase text-text-secondary">
                              {relightColor}
                            </Text>
                          </label>
                        </div>

                        <Slider
                          label={t('adjustments.effects.relightAmbient')}
                          max={100}
                          min={0}
                          defaultValue={80}
                          onChange={(e: any) => handleAdjustmentChange(Effect.RelightAmbient, e.target.value)}
                          step={1}
                          value={adjustments.relightAmbient ?? 80}
                          onDragStateChange={onDragStateChange}
                          fillOrigin="min"
                        />

                        <Slider
                          label={t('adjustments.effects.relightSoftness')}
                          max={100}
                          min={0}
                          defaultValue={30}
                          onChange={(e: any) => handleAdjustmentChange(Effect.RelightSoftness, e.target.value)}
                          step={1}
                          value={adjustments.relightSoftness ?? 30}
                          onDragStateChange={onDragStateChange}
                          fillOrigin="min"
                        />

                        <Slider
                          label={t('adjustments.effects.relightSpecular')}
                          max={100}
                          min={0}
                          defaultValue={0}
                          onChange={(e: any) => handleAdjustmentChange(Effect.RelightSpecular, e.target.value)}
                          step={1}
                          value={adjustments.relightSpecular ?? 0}
                          onDragStateChange={onDragStateChange}
                          fillOrigin="min"
                        />

                        {adjustments.relightNormalMap && (
                          <img
                            src={adjustments.relightNormalMap}
                            alt={t('adjustments.effects.relightNormalMap')}
                            className="w-full rounded-md bg-bg-primary"
                            draggable={false}
                          />
                        )}

                        <Button className="w-full" onClick={handleGenerateRelightNormalMap}>
                          {adjustments.relightNormalMap
                            ? t('adjustments.effects.relightRegenerateNormalMap')
                            : t('adjustments.effects.relightGenerateNormalMap')}
                        </Button>
                      </>
                    )}
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
