import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { v4 as uuidv4 } from 'uuid';
import Slider from '../../ui/Slider';
import Switch from '../../ui/Switch';
import Button from '../../ui/Button';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import {
  Adjustments,
  Effect,
  INITIAL_ADJUSTMENTS,
  RelightLight,
  RelightQuality,
  DEFAULT_RELIGHT_LIGHT,
  MAX_RELIGHT_LIGHTS,
} from '../../../utils/adjustments';
import { RELIGHT_TEMPERATURE_PRESETS, kelvinToHex } from '../../../utils/relightUtils';
import { useEditorStore } from '../../../store/useEditorStore';
import { useProcessStore } from '../../../store/useProcessStore';
import { useEditorActions } from '../../../hooks/useEditorActions';

const NEW_RELIGHT_LIGHT_TEMPERATURES = [5600, 3200, 8000, 2700, 10000, 4000];

const RELIGHT_ADJUSTMENT_KEYS: Array<keyof Adjustments> = [
  Effect.RelightEnabled,
  Effect.RelightLights,
  Effect.RelightAmbient,
  Effect.RelightSoftness,
  Effect.RelightSpecular,
  Effect.RelightDetail,
  Effect.RelightNormalMap,
  Effect.RelightQuality,
  Effect.RelightDepthMap,
  Effect.RelightDepthScale,
];

export default function RelightPanel() {
  const { t } = useTranslation();
  const { setAdjustments } = useEditorActions();
  const adjustments = useEditorStore((state) => state.adjustments);
  const selectedImage = useEditorStore((state) => state.selectedImage);
  const activeRelightLightId = useEditorStore((state) => state.activeRelightLightId);
  const showRelightNormalMap = useEditorStore((state) => state.showRelightNormalMap);
  const setEditor = useEditorStore((state) => state.setEditor);
  const aiModelDownloadStatus = useProcessStore((state) => state.aiModelDownloadStatus);
  const [isGeneratingNormal, setIsGeneratingNormal] = useState(false);

  const onDragStateChange = useCallback(
    (isDragging: boolean) => setEditor({ isSliderDragging: isDragging }),
    [setEditor],
  );

  const relightQuality: RelightQuality = adjustments.relightQuality ?? 'standard';

  const handleGenerateRelightNormalMap = async (quality: RelightQuality = relightQuality) => {
    setIsGeneratingNormal(true);
    try {
      const maps: { normalMap: string; depthMap: string; depthScale: number } = await invoke('generate_relight_maps', {
        jsAdjustments: adjustments,
        quality,
      });
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        relightNormalMap: maps.normalMap,
        relightQuality: quality,
        relightDepthMap: maps.depthMap,
        relightDepthScale: maps.depthScale,
      }));
    } catch (e) {
      toast.error(`Failed to generate normal map: ${e}`);
      setAdjustments((prev: Adjustments) => ({ ...prev, relightEnabled: false }));
    } finally {
      setIsGeneratingNormal(false);
    }
  };

  const handleSliderChange = (key: keyof Adjustments, value: string | number) => {
    setAdjustments((prev: Adjustments) => ({ ...prev, [key]: Number(value) }));
  };

  const relightLights = adjustments.relightLights ?? [];
  const activeRelightLight = relightLights.find((light) => light.id === activeRelightLightId) ?? relightLights[0];
  const relightColor = (activeRelightLight?.color || '#ffffff').toLowerCase();

  const updateActiveRelightLight = (changes: Partial<RelightLight>) => {
    if (!activeRelightLight) return;
    const id = activeRelightLight.id;
    setAdjustments((prev: Adjustments) => ({
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
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      relightLights: [...(prev.relightLights ?? []), light],
    }));
    setEditor({ activeRelightLightId: light.id });
  };

  const handleRemoveRelightLight = () => {
    if (!activeRelightLight || relightLights.length <= 1) return;
    const id = activeRelightLight.id;
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      relightLights: (prev.relightLights ?? []).filter((light) => light.id !== id),
    }));
    setEditor({ activeRelightLightId: null });
  };

  const handleRelightToggle = (enabled: boolean) => {
    setAdjustments((prev: Adjustments) => ({ ...prev, relightEnabled: enabled }));
    if (enabled && (!adjustments.relightNormalMap || !adjustments.relightDepthMap)) {
      handleGenerateRelightNormalMap();
    }
  };

  const handleReset = () => {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      ...Object.fromEntries(RELIGHT_ADJUSTMENT_KEYS.map((key) => [key, INITIAL_ADJUSTMENTS[key]])),
    }));
    setEditor({ activeRelightLightId: null, showRelightNormalMap: false });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('adjustments.effects.relight')}</Text>
        <button
          className="p-2 rounded-full hover:bg-surface transition-colors disabled:opacity-50"
          onClick={handleReset}
          disabled={!selectedImage || isGeneratingNormal}
          data-tooltip={t('ui.slider.reset')}
        >
          <RotateCcw size={18} />
        </button>
      </div>

      <div className="grow overflow-y-auto p-4">
        {selectedImage ? (
          <>
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
                        onChange={(e) => updateActiveRelightLight({ intensity: Number(e.target.value) })}
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
                        onChange={(e) => updateActiveRelightLight({ depth: Number(e.target.value) })}
                        step={1}
                        value={activeRelightLight?.depth ?? 30}
                        onDragStateChange={onDragStateChange}
                      />

                      <Slider
                        label={t('adjustments.effects.relightRange')}
                        max={100}
                        min={0}
                        defaultValue={60}
                        onChange={(e) => updateActiveRelightLight({ range: Number(e.target.value) })}
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
                        onChange={(e) => handleSliderChange(Effect.RelightAmbient, e.target.value)}
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
                        onChange={(e) => handleSliderChange(Effect.RelightSoftness, e.target.value)}
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
                        onChange={(e) => handleSliderChange(Effect.RelightSpecular, e.target.value)}
                        step={1}
                        value={adjustments.relightSpecular ?? 0}
                        onDragStateChange={onDragStateChange}
                        fillOrigin="min"
                      />

                      <Slider
                        label={t('adjustments.effects.relightDetail')}
                        max={100}
                        min={0}
                        defaultValue={30}
                        onChange={(e) => handleSliderChange(Effect.RelightDetail, e.target.value)}
                        step={1}
                        value={adjustments.relightDetail ?? 30}
                        onDragStateChange={onDragStateChange}
                        fillOrigin="min"
                      />

                      {adjustments.relightNormalMap && (
                        <Switch
                          label={t('adjustments.effects.relightShowNormalMap')}
                          checked={showRelightNormalMap}
                          onChange={(checked: boolean) => setEditor({ showRelightNormalMap: checked })}
                        />
                      )}

                      {adjustments.relightNormalMap && (
                        <img
                          src={adjustments.relightNormalMap}
                          alt={t('adjustments.effects.relightNormalMap')}
                          className="w-full rounded-md bg-bg-primary"
                          draggable={false}
                        />
                      )}

                      <div className="flex flex-col gap-2">
                        <Text variant={TextVariants.label} className="text-text-secondary select-none">
                          {t('adjustments.effects.relightQuality')}
                        </Text>
                        <div className="grid grid-cols-2 gap-1 p-1 bg-bg-primary rounded-md">
                          {(['standard', 'high'] as const).map((quality) => (
                            <button
                              key={quality}
                              onClick={() => quality !== relightQuality && handleGenerateRelightNormalMap(quality)}
                              data-tooltip={
                                quality === 'high' ? t('adjustments.effects.relightQualityHighTooltip') : undefined
                              }
                              className={clsx(
                                'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                                quality === relightQuality
                                  ? 'bg-accent text-button-text'
                                  : 'text-text-secondary hover:text-text-primary hover:bg-surface',
                              )}
                            >
                              {quality === 'high'
                                ? t('adjustments.effects.relightQualityHigh')
                                : t('adjustments.effects.relightQualityStandard')}
                            </button>
                          ))}
                        </div>
                      </div>

                      <Button className="w-full" onClick={() => handleGenerateRelightNormalMap()}>
                        {adjustments.relightNormalMap
                          ? t('adjustments.effects.relightRegenerateNormalMap')
                          : t('adjustments.effects.relightGenerateNormalMap')}
                      </Button>
                    </>
                  )}
                </div>
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
