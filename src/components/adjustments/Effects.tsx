import { useState, useEffect, useRef, useMemo, ReactNode, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { Loader2, Circle, Hexagon, Octagon, Aperture, Plus, X, CopyPlus, Trash2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import Slider, { SliderChangeEvent } from '../ui/Slider';
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
  MotionBlurLayer,
  MotionBlurType,
  areSectionPropsEqual,
} from '../../utils/adjustments';
import Dropdown from '../ui/Dropdown';
import SegmentedControl from '../ui/SegmentedControl';
import LUTControl from './LUTControl';
import ColorField, { normalizeHexColor, useParsedTextField } from '../ui/ColorField';
import { ColorSwatch } from './Color';
import { AppSettings } from '../../types/settings';
import Text from '../ui/Text';
import AdjustmentSubSection from './AdjustmentSubSection';
import { TextVariants } from '../../types/typography';
import { DepthRangePicker } from './DepthRangePicker';
import DepthScope, { DepthMapKey } from './depthScope/DepthScope';
import { ScenePatch } from './depthScope/scene';
import { selectAiModelDownloadStatus, useProcessStore } from '../../store/useProcessStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { canvasToolState, useEditorStore } from '../../store/useEditorStore';
import { useContextMenu } from '../../context/ContextMenuContext';
import { useSliderKeyframe } from '../../context/SliderKeyframeContext';
import { useEditorActions } from '../../hooks/useEditorActions';
import {
  CLIP_MAPS,
  ClipMaps,
  DEFAULT_SHUTTER,
  MapKind,
  dismissClipMaps,
  prepareClipMaps,
  useClipMaps,
  useShutterScope,
} from '../../store/videoIntegration';

interface EffectsPanelProps {
  adjustments: Adjustments;
  isForMask?: boolean;
  setAdjustments(adjustments: Partial<Adjustments> | ((prev: Adjustments) => Adjustments)): void;
  handleLutSelect(path: string, isSceneReferred: boolean): void;
  appSettings: AppSettings | null;
  onDragStateChange?: (isDragging: boolean) => void;
}

interface BokehShapeSwitchProps {
  selectedShape: string;
  onShapeChange: (shape: string) => void;
}

const BokehShapeSwitch = ({ selectedShape, onShapeChange }: BokehShapeSwitchProps) => {
  const { t } = useTranslation();
  const [isLabelHovered, setIsLabelHovered] = useState(false);

  const shapeOptions = useMemo(
    () => [
      { id: 'circle', icon: Circle, label: t('adjustments.effects.bokehCircular') },
      { id: 'hexagon', icon: Hexagon, label: t('adjustments.effects.bokehHexagonal') },
      { id: 'octagon', icon: Octagon, label: t('adjustments.effects.bokehOctagonal') },
      { id: 'ring', icon: Aperture, label: t('adjustments.effects.bokehRing') },
    ],
    [t],
  );

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

      <SegmentedControl iconOnly options={shapeOptions} value={selectedShape} onChange={onShapeChange} />
    </div>
  );
};

const hasMap = (map: string | null | undefined) => !!map && map !== CLIP_MAPS;

const RING_RADIUS = 6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const STARTING_BLUR_AMOUNT = 25;

const ProgressRing = ({ progress }: { progress: number }) => (
  <svg width={16} height={16} viewBox="0 0 16 16" className="shrink-0 -rotate-90">
    <circle cx={8} cy={8} r={RING_RADIUS} fill="none" strokeWidth={2} className="stroke-card-active" />
    <circle
      cx={8}
      cy={8}
      r={RING_RADIUS}
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      strokeDasharray={RING_LENGTH}
      strokeDashoffset={RING_LENGTH * (1 - progress)}
      className="stroke-accent transition-[stroke-dashoffset] duration-300"
    />
  </svg>
);

const MapGenerationStatus = ({ label, progress }: { label: string; progress?: number }) => {
  const { t } = useTranslation();
  const aiModelDownloadStatus = useProcessStore(selectAiModelDownloadStatus);
  const measured = !aiModelDownloadStatus && !!progress;

  return (
    <div className="flex flex-col items-center justify-center gap-1 p-4 text-text-secondary text-center">
      <div className="flex items-center gap-2">
        {measured ? <ProgressRing progress={progress} /> : <Loader2 size={16} className="animate-spin shrink-0" />}
        <Text variant={TextVariants.label}>
          {aiModelDownloadStatus ? t('editor.masks.settings.aiModelDownloading') : label}
        </Text>
        {measured && (
          <Text variant={TextVariants.label} className="tabular-nums">
            {Math.round(progress * 100)}%
          </Text>
        )}
      </div>
      {aiModelDownloadStatus && (
        <Text variant={TextVariants.small} className="text-accent">
          {aiModelDownloadStatus}
        </Text>
      )}
    </div>
  );
};

interface SpatialEffectProps {
  children: ReactNode;
  enabled: boolean;
  label: string;
  onToggle(enabled: boolean): void;
}

export const SpatialEffect = ({ children, enabled, label, onToggle }: SpatialEffectProps) => {
  return (
    <div>
      <Switch label={label} checked={enabled} onChange={onToggle} />

      <div
        className={`grid transition-all duration-300 ease-in-out ${
          enabled ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <div className="space-y-4 mt-4 mb-1 pl-2 border-l-2 border-card-active transition-opacity duration-300">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
};

function EffectsPanel({
  adjustments,
  setAdjustments,
  isForMask = false,
  handleLutSelect,
  appSettings,
  onDragStateChange,
}: EffectsPanelProps) {
  const { t } = useTranslation();
  const [isGeneratingDepth, setIsGeneratingDepth] = useState(false);
  const [isGeneratingNormals, setIsGeneratingNormals] = useState(false);
  const [isGeneratingFogDepth, setIsGeneratingFogDepth] = useState(false);
  const [isGeneratingMotionDepth, setIsGeneratingMotionDepth] = useState(false);
  const [hoveredLightId, setHoveredLightId] = useState<string | null>(null);
  const motionBlurDepthMap = useEditorStore((state) => state.adjustments.motionBlurDepthMap);
  const { setAdjustments: setImageAdjustments } = useEditorActions();
  const isRelightPickerActive = useEditorStore((state) => state.isRelightPickerActive);
  const activeRelightLightId = useEditorStore((state) => state.activeRelightLightId);
  const setEditor = useEditorStore((state) => state.setEditor);
  const { showContextMenu } = useContextMenu();
  const sliderKeyframes = useSliderKeyframe();
  const depthMaps = useClipMaps(
    'depth',
    !!(adjustments.lensBlurEnabled || adjustments.fogEnabled || adjustments.motionBlurDepthEnabled),
  );
  const normalMaps = useClipMaps('surfaces', !!adjustments.relightEnabled);
  const focusOnReady = useRef(false);

  const handleGenerateLensBlurDepthMap = async () => {
    setIsGeneratingDepth(true);
    try {
      const b64: string = await invoke('generate_full_image_depth_map', { jsAdjustments: adjustments });
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        lensBlurDepthMap: b64,
      }));
    } catch (e) {
      toast.error(`Failed to generate depth map: ${e}`);
      setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, lensBlurEnabled: false }));
    } finally {
      setIsGeneratingDepth(false);
    }
  };

  const handleGenerateRelightNormalMap = async () => {
    setIsGeneratingNormals(true);
    try {
      const b64: string = await invoke('generate_relight_normal_map', { jsAdjustments: adjustments });
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        relightNormalMap: b64,
      }));
      const { relightEnabled, relightLights } = useEditorStore.getState().adjustments;
      if (relightEnabled) {
        focusRelightLight(relightLights);
      }
    } catch (e) {
      toast.error(`Failed to generate normal map: ${e}`);
      setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, relightEnabled: false }));
    } finally {
      setIsGeneratingNormals(false);
    }
  };

  const handleGenerateFogDepthMap = async () => {
    setIsGeneratingFogDepth(true);
    try {
      const b64: string = await invoke('generate_full_image_depth_map', { jsAdjustments: adjustments });
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        fogDepthMap: b64,
      }));
    } catch (e) {
      toast.error(`Failed to generate depth map: ${e}`);
      setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, fogEnabled: false }));
    } finally {
      setIsGeneratingFogDepth(false);
    }
  };

  const handleGenerateMotionBlurDepthMap = async () => {
    setIsGeneratingMotionDepth(true);
    try {
      const b64: string = await invoke('generate_full_image_depth_map', {
        jsAdjustments: useEditorStore.getState().adjustments,
      });
      setImageAdjustments((prev: Adjustments) => ({
        ...prev,
        motionBlurDepthMap: b64,
      }));
    } catch (e) {
      toast.error(`Failed to generate depth map: ${e}`);
      setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, motionBlurDepthEnabled: false }));
    } finally {
      setIsGeneratingMotionDepth(false);
    }
  };

  const handleScenePatch = (patch: ScenePatch) => {
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, ...patch }));
  };

  const handleAdjustmentChange = (key: string, value: boolean | number | string) => {
    const numericValue = typeof value === 'boolean' ? value : parseInt(String(value), 10);
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

  const enableClipMaps = (
    kind: MapKind,
    key: DepthMapKey,
    enabledKey: Effect | null,
    set: (update: (prev: Adjustments) => Adjustments) => void = setAdjustments,
  ) => {
    prepareClipMaps(kind, false);
    set((prev) => ({ ...prev, ...(enabledKey && { [enabledKey]: true }), [key]: prev[key] || CLIP_MAPS }));
  };

  const handleLensBlurToggle = (enabled: boolean) => {
    if (enabled && depthMaps) return enableClipMaps('depth', 'lensBlurDepthMap', Effect.LensBlurEnabled);
    handleAdjustmentChange(Effect.LensBlurEnabled, enabled);
    if (enabled && !hasMap(adjustments.lensBlurDepthMap)) {
      handleGenerateLensBlurDepthMap();
    }
  };

  const handleFogToggle = (enabled: boolean) => {
    if (enabled && depthMaps) return enableClipMaps('depth', 'fogDepthMap', Effect.FogEnabled);
    handleAdjustmentChange(Effect.FogEnabled, enabled);
    if (enabled && !hasMap(adjustments.fogDepthMap)) {
      handleGenerateFogDepthMap();
    }
  };

  const handleMotionBlurDepthToggle = (enabled: boolean) => {
    handleAdjustmentChange(Effect.MotionBlurDepthEnabled, enabled);
    if (enabled && depthMaps) {
      enableClipMaps('depth', 'motionBlurDepthMap', null, setImageAdjustments);
    } else if (enabled && !hasMap(motionBlurDepthMap)) {
      handleGenerateMotionBlurDepthMap();
    }
  };

  const handleRelightToggle = (enabled: boolean) => {
    focusOnReady.current = false;
    if (enabled && normalMaps) {
      enableClipMaps('surfaces', 'relightNormalMap', Effect.RelightEnabled);
      focusOnReady.current = true;
      return;
    }
    handleAdjustmentChange(Effect.RelightEnabled, enabled);
    if (!enabled) {
      setEditor({ isRelightPickerActive: false });
    } else if (!hasMap(adjustments.relightNormalMap)) {
      handleGenerateRelightNormalMap();
    } else {
      focusRelightLight(adjustments.relightLights);
    }
  };

  useEffect(() => {
    if (!normalMaps?.ready || !adjustments.relightEnabled || !focusOnReady.current) return;
    focusOnReady.current = false;
    focusRelightLight(adjustments.relightLights);
  }, [normalMaps?.ready, adjustments.relightEnabled]);

  const failedMaps = (kind: MapKind, maps: ClipMaps | null, effects: Partial<Adjustments>) => {
    if (!maps?.failed) return;
    dismissClipMaps(kind);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, ...effects }));
  };

  useEffect(
    () => failedMaps('depth', depthMaps, { lensBlurEnabled: false, fogEnabled: false, motionBlurDepthEnabled: false }),
    [depthMaps?.failed],
  );

  useEffect(() => failedMaps('surfaces', normalMaps, { relightEnabled: false }), [normalMaps?.failed]);

  const mapStatus = (generating: boolean, maps: ClipMaps | null, label: string) => {
    if (generating) return <MapGenerationStatus label={label} />;
    if (!maps || maps.ready) return null;
    return <MapGenerationStatus label={t('adjustments.effects.analyzingClip')} progress={maps.progress ?? 0} />;
  };

  const relightLights: Array<RelightLight> = adjustments.relightLights || [];
  const activeLight = relightLights.find((light) => light.id === activeRelightLightId);

  const handleSelectLight = (id: string) => {
    if (activeLight?.id === id && isRelightPickerActive) {
      setEditor({ isRelightPickerActive: false });
      return;
    }
    setEditor({
      activeRelightLightId: id,
      ...canvasToolState({ isRelightPickerActive: true }),
    });
  };

  const handleAddLight = () => {
    const light = createRelightLight(0.5, 0.5);
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      relightLights: [...(prev.relightLights || []), light],
    }));
    setEditor({
      activeRelightLightId: light.id,
      ...canvasToolState({ isRelightPickerActive: true }),
    });
  };

  const focusRelightLight = (lights: Array<RelightLight> = []) => {
    if (!lights.length) {
      handleAddLight();
      return;
    }
    setEditor({
      activeRelightLightId: lights[0].id,
      ...canvasToolState({ isRelightPickerActive: true }),
    });
  };

  const handleLightPatch = (patch: Partial<RelightLight>) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      relightLights: (prev.relightLights || []).map((light: RelightLight) =>
        light.id === activeRelightLightId ? { ...light, ...patch } : light,
      ),
    }));
  };

  const handleLightChange = (key: keyof RelightLight, value: number | string) => handleLightPatch({ [key]: value });

  const lightPath = (key: keyof RelightLight) => `relightLights.#${activeRelightLightId}.${key}`;

  const lightSlider = (key: keyof RelightLight) => ({
    resetKey: lightPath(key),
    onChange: (e: SliderChangeEvent) => handleLightChange(key, parseInt(String(e.target.value), 10)),
  });

  const positionKeyframe = activeLight && sliderKeyframes?.render([lightPath('x'), lightPath('y')]);

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

  const handleDuplicateLight = (id: string) => {
    const source = relightLights.find((light) => light.id === id);
    if (!source) return;
    const light = { ...source, id: uuidv4() };
    setAdjustments((prev: Partial<Adjustments>) => {
      const lights = prev.relightLights || [];
      const index = lights.findIndex((l: RelightLight) => l.id === id);
      return { ...prev, relightLights: [...lights.slice(0, index + 1), light, ...lights.slice(index + 1)] };
    });
    setEditor({
      activeRelightLightId: light.id,
      ...canvasToolState({ isRelightPickerActive: true }),
    });
  };

  const handleLightContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      {
        label: t('adjustments.effects.relightDuplicateLight'),
        icon: CopyPlus,
        onClick: () => handleDuplicateLight(id),
      },
      {
        label: t('adjustments.effects.relightRemoveLight'),
        icon: Trash2,
        isDestructive: true,
        onClick: () => handleRemoveLight(id),
      },
    ]);
  };

  const isAiFree = useSettingsStore((s) => s.appSettings?.aiProvider === 'ai-free');
  const shutterScope = useShutterScope();
  const offersShutter = !!shutterScope && !isForMask;
  const blurUntouched =
    offersShutter &&
    (adjustments.motionBlurType ?? 'linear') === 'linear' &&
    !adjustments.motionBlurAmount &&
    !adjustments.motionBlurDepthEnabled;
  const motionBlurType = blurUntouched ? 'shutter' : (adjustments.motionBlurType ?? 'linear');
  const isShutter = motionBlurType === 'shutter';
  const footageSwitch = isShutter && shutterScope === 'both';
  const blursFootage =
    !isShutter || (shutterScope !== 'animation' && (!footageSwitch || adjustments.motionBlurFootage !== false));
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
            resetKey="glowAmount"
            label={t('adjustments.effects.glow')}
            max={100}
            min={0}
            onChange={(e: SliderChangeEvent) => handleAdjustmentChange(CreativeAdjustment.GlowAmount, e.target.value)}
            step={1}
            value={adjustments.glowAmount}
            onDragStateChange={onDragStateChange}
          />

          <Slider
            resetKey="halationAmount"
            label={t('adjustments.effects.halation')}
            max={100}
            min={0}
            onChange={(e: SliderChangeEvent) =>
              handleAdjustmentChange(CreativeAdjustment.HalationAmount, e.target.value)
            }
            step={1}
            value={adjustments.halationAmount}
            onDragStateChange={onDragStateChange}
          />

          {!isForMask && (
            <Slider
              resetKey="flareAmount"
              label={t('adjustments.effects.lightFlares')}
              max={100}
              min={0}
              onChange={(e: SliderChangeEvent) =>
                handleAdjustmentChange(CreativeAdjustment.FlareAmount, e.target.value)
              }
              step={1}
              value={adjustments.flareAmount}
              onDragStateChange={onDragStateChange}
            />
          )}
        </AdjustmentSubSection>
      )}

      {!hiddenTools.includes('motionBlur') && (
        <AdjustmentSubSection
          id="motionBlur"
          order={toolOrder.indexOf('motionBlur')}
          title={t('adjustments.effects.motionBlur')}
        >
          <div className="space-y-4">
            {isShutter ? (
              <Slider
                resetKey="motionBlurShutter"
                label={t('adjustments.effects.motionBlurShutter')}
                max={720}
                min={0}
                defaultValue={DEFAULT_SHUTTER}
                onChange={(e: SliderChangeEvent) => {
                  if (blurUntouched)
                    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [Effect.MotionBlurType]: 'shutter' }));
                  handleAdjustmentChange(Effect.MotionBlurShutter, e.target.value);
                }}
                step={1}
                suffix="°"
                value={blurUntouched ? 0 : (adjustments.motionBlurShutter ?? DEFAULT_SHUTTER)}
                onDragStateChange={onDragStateChange}
                fillOrigin="min"
              />
            ) : (
              <Slider
                resetKey="motionBlurAmount"
                label={t('adjustments.effects.amount')}
                max={100}
                min={0}
                onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.MotionBlurAmount, e.target.value)}
                step={1}
                value={adjustments.motionBlurAmount ?? 0}
                onDragStateChange={onDragStateChange}
              />
            )}

            {motionBlurType === 'linear' && (
              <Slider
                resetKey="motionBlurAngle"
                label={t('adjustments.effects.motionBlurAngle')}
                max={90}
                min={-90}
                onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.MotionBlurAngle, e.target.value)}
                step={1}
                suffix="°"
                value={adjustments.motionBlurAngle ?? 0}
                onDragStateChange={onDragStateChange}
              />
            )}

            {footageSwitch && (
              <Switch
                label={t('adjustments.effects.motionBlurFootage')}
                tooltip={t('adjustments.effects.motionBlurFootageTooltip')}
                checked={adjustments.motionBlurFootage !== false}
                onChange={(footage: boolean) =>
                  setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [Effect.MotionBlurFootage]: footage }))
                }
              />
            )}

            {blursFootage && (
              <Slider
                resetKey="motionBlurHighlights"
                label={t('adjustments.effects.motionBlurHighlights')}
                max={100}
                min={0}
                defaultValue={30}
                onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.MotionBlurHighlights, e.target.value)}
                step={1}
                value={adjustments.motionBlurHighlights ?? 30}
                onDragStateChange={onDragStateChange}
                fillOrigin="min"
              />
            )}

            <div>
              <Text variant={TextVariants.label} className="mb-2 block">
                {t('adjustments.effects.motionBlurType')}
              </Text>
              <Dropdown<MotionBlurType>
                options={[
                  ...(offersShutter || isShutter
                    ? [{ label: t('adjustments.effects.motionBlurTypes.shutter'), value: 'shutter' as const }]
                    : []),
                  { label: t('adjustments.effects.motionBlurTypes.linear'), value: 'linear' },
                  { label: t('adjustments.effects.motionBlurTypes.zoom'), value: 'zoom' },
                  { label: t('adjustments.effects.motionBlurTypes.spin'), value: 'spin' },
                  ...(isForMask
                    ? [{ label: t('adjustments.effects.motionBlurTypes.smooth'), value: 'smooth' as const }]
                    : []),
                ]}
                value={motionBlurType}
                onChange={(value) =>
                  setAdjustments((prev: Partial<Adjustments>) => ({
                    ...prev,
                    [Effect.MotionBlurType]: value,
                    ...(blurUntouched && value !== 'shutter'
                      ? { [Effect.MotionBlurAmount]: STARTING_BLUR_AMOUNT }
                      : {}),
                  }))
                }
              />
            </div>

            {isForMask && motionBlurType !== 'spin' && motionBlurType !== 'smooth' && (
              <div>
                <Text variant={TextVariants.label} className="mb-2 block">
                  {t('adjustments.effects.motionBlurLayer')}
                </Text>
                <Dropdown<MotionBlurLayer>
                  options={[
                    { label: t('adjustments.effects.motionBlurLayers.auto'), value: 'auto' },
                    { label: t('adjustments.effects.motionBlurLayers.subject'), value: 'subject' },
                    { label: t('adjustments.effects.motionBlurLayers.panning'), value: 'panning' },
                    { label: t('adjustments.effects.motionBlurLayers.uniform'), value: 'uniform' },
                  ]}
                  value={adjustments.motionBlurLayer ?? 'auto'}
                  onChange={(value) =>
                    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [Effect.MotionBlurLayer]: value }))
                  }
                />
              </div>
            )}

            {!isAiFree && motionBlurType !== 'spin' && !isShutter && (
              <SpatialEffect
                enabled={!!adjustments.motionBlurDepthEnabled}
                label={t('adjustments.effects.motionBlurDepth')}
                onToggle={handleMotionBlurDepthToggle}
              >
                {mapStatus(isGeneratingMotionDepth, depthMaps, t('editor.ai.generatingDepthMap')) ?? (
                  <>
                    {adjustments.motionBlurDepthEnabled && (
                      <DepthScope
                        mapKey="motionBlurDepthMap"
                        scene={{
                          kind: 'motion',
                          amount: adjustments.motionBlurAmount ?? 0,
                          parallax: adjustments.motionBlurDepth ?? 50,
                          angle: adjustments.motionBlurAngle ?? 0,
                          radial: adjustments.motionBlurType === 'zoom',
                        }}
                      />
                    )}
                    <Slider
                      resetKey="motionBlurDepth"
                      label={t('adjustments.effects.amount')}
                      max={100}
                      min={0}
                      defaultValue={50}
                      onChange={(e: SliderChangeEvent) =>
                        handleAdjustmentChange(Effect.MotionBlurDepth, e.target.value)
                      }
                      step={1}
                      value={adjustments.motionBlurDepth ?? 50}
                      onDragStateChange={onDragStateChange}
                      fillOrigin="min"
                    />
                  </>
                )}
              </SpatialEffect>
            )}
          </div>
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
                <SpatialEffect
                  enabled={!!adjustments.lensBlurEnabled}
                  label={t('adjustments.effects.lensBlur')}
                  onToggle={handleLensBlurToggle}
                >
                  {mapStatus(isGeneratingDepth, depthMaps, t('editor.ai.generatingDepthMap')) ?? (
                    <>
                      <Slider
                        resetKey="lensBlurAmount"
                        label={t('adjustments.effects.amount')}
                        max={100}
                        min={0}
                        defaultValue={40}
                        onChange={(e: SliderChangeEvent) =>
                          handleAdjustmentChange(Effect.LensBlurAmount, e.target.value)
                        }
                        step={1}
                        value={adjustments.lensBlurAmount ?? 50}
                        onDragStateChange={onDragStateChange}
                        fillOrigin="min"
                      />

                      <Slider
                        resetKey="lensBlurDiffusion"
                        label={t('adjustments.effects.lensDiffusion')}
                        max={100}
                        min={0}
                        defaultValue={0}
                        onChange={(e: SliderChangeEvent) =>
                          handleAdjustmentChange(Effect.lensBlurDiffusion, e.target.value)
                        }
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

                      {adjustments.lensBlurEnabled && (
                        <DepthScope
                          mapKey="lensBlurDepthMap"
                          scene={{
                            kind: 'lensBlur',
                            minDepth: adjustments.lensBlurMinDepth ?? 10,
                            maxDepth: adjustments.lensBlurMaxDepth ?? 90,
                            minFade: adjustments.lensBlurMinFade ?? 10,
                            maxFade: adjustments.lensBlurMaxFade ?? 10,
                            amount: adjustments.lensBlurAmount ?? 50,
                          }}
                          onChange={handleScenePatch}
                          onDragStateChange={onDragStateChange}
                        />
                      )}

                      <DepthRangePicker
                        minDepth={100 - (adjustments.lensBlurMaxDepth ?? 90)}
                        maxDepth={100 - (adjustments.lensBlurMinDepth ?? 10)}
                        minFade={adjustments.lensBlurMaxFade ?? 10}
                        maxFade={adjustments.lensBlurMinFade ?? 10}
                        defaultMinDepth={10}
                        defaultMaxDepth={90}
                        defaultMinFade={10}
                        defaultMaxFade={10}
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
                </SpatialEffect>
                <SpatialEffect
                  enabled={!!adjustments.relightEnabled}
                  label={t('adjustments.effects.relight')}
                  onToggle={handleRelightToggle}
                >
                  <div className="space-y-4" data-relight-lights>
                    {mapStatus(isGeneratingNormals, normalMaps, t('editor.ai.generatingNormalMap')) ?? (
                      <>
                        <Slider
                          resetKey="relightAmbient"
                          label={t('adjustments.effects.relightAmbient')}
                          max={100}
                          min={-100}
                          defaultValue={-50}
                          onChange={(e: SliderChangeEvent) =>
                            handleAdjustmentChange(Effect.RelightAmbient, e.target.value)
                          }
                          step={1}
                          value={adjustments.relightAmbient ?? -50}
                          onDragStateChange={onDragStateChange}
                        />

                        <Slider
                          resetKey="relightSoftness"
                          label={t('adjustments.effects.relightSoftness')}
                          max={100}
                          min={0}
                          defaultValue={25}
                          onChange={(e: SliderChangeEvent) =>
                            handleAdjustmentChange(Effect.RelightSoftness, e.target.value)
                          }
                          step={1}
                          value={adjustments.relightSoftness ?? 25}
                          onDragStateChange={onDragStateChange}
                          fillOrigin="min"
                        />

                        <Slider
                          resetKey="relightShine"
                          label={t('adjustments.effects.relightShine')}
                          max={100}
                          min={0}
                          onChange={(e: SliderChangeEvent) =>
                            handleAdjustmentChange(Effect.RelightShine, e.target.value)
                          }
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
                            resetKey="relightShadowSoftness"
                            label={t('adjustments.effects.relightShadowSoftness')}
                            max={100}
                            min={0}
                            defaultValue={15}
                            onChange={(e: SliderChangeEvent) =>
                              handleAdjustmentChange(Effect.RelightShadowSoftness, e.target.value)
                            }
                            step={1}
                            value={adjustments.relightShadowSoftness ?? 15}
                            onDragStateChange={onDragStateChange}
                            fillOrigin="min"
                          />
                        )}

                        <div className="p-3 rounded-md bg-bg-primary space-y-4">
                          <div className="flex flex-wrap items-center gap-3 px-1">
                            {relightLights.map((light, index) => (
                              <div
                                className="relative flex"
                                key={light.id}
                                onMouseEnter={() => setHoveredLightId(light.id)}
                                onMouseLeave={() => setHoveredLightId(null)}
                                onContextMenu={(e) => handleLightContextMenu(e, light.id)}
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

                          {activeLight && (
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

                              {positionKeyframe && (
                                <div className="relative group/keyframe h-5 flex items-center">
                                  <Text variant={TextVariants.label}>{t('adjustments.effects.relightPosition')}</Text>
                                  {positionKeyframe}
                                </div>
                              )}

                              <Slider
                                label={t('adjustments.effects.relightIntensity')}
                                max={100}
                                min={0}
                                defaultValue={40}
                                {...lightSlider('intensity')}
                                step={1}
                                value={activeLight.intensity}
                                onDragStateChange={onDragStateChange}
                                fillOrigin="min"
                              />

                              {activeLight.type !== 'directional' && (
                                <>
                                  <DepthScope
                                    mapKey="relightNormalMap"
                                    scene={{
                                      kind: 'relight',
                                      lights: relightLights,
                                      activeId: activeLight.id,
                                      ambient: adjustments.relightAmbient ?? -50,
                                      softness: adjustments.relightSoftness ?? 25,
                                    }}
                                    onChange={handleLightPatch}
                                    onDragStateChange={onDragStateChange}
                                  />

                                  <Slider
                                    label={t('adjustments.effects.relightDepth')}
                                    max={100}
                                    min={0}
                                    defaultValue={0}
                                    {...lightSlider('depth')}
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
                                    {...lightSlider('radius')}
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
                                    {...lightSlider('angle')}
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
                                    {...lightSlider('elevation')}
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
                                    {...lightSlider('cone')}
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
                                    {...lightSlider('feather')}
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
                                {...lightSlider('temperature')}
                                step={1}
                                value={activeLight.temperature}
                                trackClassName="temperature-gradient-track"
                                onDragStateChange={onDragStateChange}
                              />

                              <Slider
                                label={t('adjustments.color.tint')}
                                max={100}
                                min={-100}
                                {...lightSlider('tint')}
                                step={1}
                                value={activeLight.tint}
                                trackClassName="tint-gradient-track"
                                onDragStateChange={onDragStateChange}
                              />
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </SpatialEffect>
                <SpatialEffect
                  enabled={!!adjustments.fogEnabled}
                  label={t('adjustments.effects.fog')}
                  onToggle={handleFogToggle}
                >
                  {mapStatus(isGeneratingFogDepth, depthMaps, t('editor.ai.generatingDepthMap')) ?? (
                    <>
                      <Slider
                        resetKey="fogAmount"
                        label={t('adjustments.effects.amount')}
                        max={100}
                        min={0}
                        defaultValue={50}
                        onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.FogAmount, e.target.value)}
                        step={1}
                        value={adjustments.fogAmount ?? 50}
                        onDragStateChange={onDragStateChange}
                        fillOrigin="min"
                      />

                      {adjustments.fogEnabled && (
                        <DepthScope
                          mapKey="fogDepthMap"
                          scene={{
                            kind: 'fog',
                            amount: adjustments.fogAmount ?? 50,
                            start: adjustments.fogStart ?? 0,
                            density: adjustments.fogDensity ?? 50,
                            height: adjustments.fogHeight ?? 0,
                            temperature: adjustments.fogTemperature ?? 0,
                            tint: adjustments.fogTint ?? 0,
                          }}
                          onChange={handleScenePatch}
                          onDragStateChange={onDragStateChange}
                        />
                      )}

                      <Slider
                        resetKey="fogStart"
                        label={t('adjustments.effects.fogStart')}
                        max={100}
                        min={0}
                        defaultValue={0}
                        onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.FogStart, e.target.value)}
                        step={1}
                        value={adjustments.fogStart ?? 0}
                        onDragStateChange={onDragStateChange}
                        fillOrigin="min"
                      />

                      <Slider
                        resetKey="fogDensity"
                        label={t('adjustments.effects.fogDensity')}
                        max={100}
                        min={0}
                        defaultValue={50}
                        onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.FogDensity, e.target.value)}
                        step={1}
                        value={adjustments.fogDensity ?? 50}
                        onDragStateChange={onDragStateChange}
                        fillOrigin="min"
                      />

                      <Slider
                        resetKey="fogHeight"
                        label={t('adjustments.effects.fogHeight')}
                        max={100}
                        min={0}
                        defaultValue={0}
                        onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.FogHeight, e.target.value)}
                        step={1}
                        value={adjustments.fogHeight ?? 0}
                        onDragStateChange={onDragStateChange}
                        fillOrigin="min"
                      />

                      <Slider
                        resetKey="fogVariation"
                        label={t('adjustments.effects.fogVariation')}
                        max={100}
                        min={0}
                        defaultValue={25}
                        onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.FogVariation, e.target.value)}
                        step={1}
                        value={adjustments.fogVariation ?? 25}
                        onDragStateChange={onDragStateChange}
                        fillOrigin="min"
                      />

                      <Slider
                        resetKey="fogGlow"
                        label={t('adjustments.effects.glow')}
                        max={100}
                        min={0}
                        defaultValue={25}
                        onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.FogGlow, e.target.value)}
                        step={1}
                        value={adjustments.fogGlow ?? 25}
                        onDragStateChange={onDragStateChange}
                        fillOrigin="min"
                      />

                      <Slider
                        resetKey="fogTemperature"
                        label={t('adjustments.color.temperature')}
                        max={100}
                        min={-100}
                        onChange={(e: SliderChangeEvent) =>
                          handleAdjustmentChange(Effect.FogTemperature, e.target.value)
                        }
                        step={1}
                        value={adjustments.fogTemperature ?? 0}
                        trackClassName="temperature-gradient-track"
                        onDragStateChange={onDragStateChange}
                      />

                      <Slider
                        resetKey="fogTint"
                        label={t('adjustments.color.tint')}
                        max={100}
                        min={-100}
                        onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.FogTint, e.target.value)}
                        step={1}
                        value={adjustments.fogTint ?? 0}
                        trackClassName="tint-gradient-track"
                        onDragStateChange={onDragStateChange}
                      />
                    </>
                  )}
                </SpatialEffect>
              </div>
            </AdjustmentSubSection>
          )}

          {!hiddenTools.includes('lut') && (
            <AdjustmentSubSection id="lut" order={toolOrder.indexOf('lut')} title={t('adjustments.effects.lut')}>
              <LUTControl
                lutPath={adjustments.lutPath || null}
                lutName={adjustments.lutName || null}
                lutIntensity={adjustments.lutIntensity ?? 100}
                onLutSelect={handleLutSelect}
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
              <div
                data-center-marker-controls="vignette"
                onPointerDown={() => setEditor(canvasToolState({ activeCenterMarker: 'vignette' }))}
              >
                <Slider
                  resetKey="vignetteAmount"
                  label={t('adjustments.effects.amount')}
                  max={100}
                  min={-100}
                  onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.VignetteAmount, e.target.value)}
                  speedEditId={Effect.VignetteAmount}
                  step={1}
                  value={adjustments.vignetteAmount}
                  onDragStateChange={onDragStateChange}
                />
                <Slider
                  resetKey="vignetteMidpoint"
                  defaultValue={50}
                  label={t('adjustments.effects.midpoint')}
                  max={100}
                  min={0}
                  onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.VignetteMidpoint, e.target.value)}
                  step={1}
                  value={adjustments.vignetteMidpoint}
                  onDragStateChange={onDragStateChange}
                  fillOrigin="min"
                />
                <Slider
                  resetKey="vignetteRoundness"
                  label={t('adjustments.effects.roundness')}
                  max={100}
                  min={-100}
                  onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.VignetteRoundness, e.target.value)}
                  step={1}
                  value={adjustments.vignetteRoundness}
                  onDragStateChange={onDragStateChange}
                />
                <Slider
                  resetKey="vignetteFeather"
                  defaultValue={50}
                  label={t('adjustments.effects.feather')}
                  max={100}
                  min={0}
                  onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.VignetteFeather, e.target.value)}
                  step={1}
                  value={adjustments.vignetteFeather}
                  onDragStateChange={onDragStateChange}
                  fillOrigin="min"
                />
              </div>
            </AdjustmentSubSection>
          )}

          {!hiddenTools.includes('pixelate') && (
            <AdjustmentSubSection
              id="pixelate"
              order={toolOrder.indexOf('pixelate')}
              title={t('adjustments.effects.pixelate')}
            >
              <Slider
                resetKey="pixelateAmount"
                label={t('adjustments.effects.amount')}
                max={100}
                min={0}
                onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.PixelateAmount, e.target.value)}
                step={1}
                value={adjustments.pixelateAmount}
                onDragStateChange={onDragStateChange}
                fillOrigin="min"
              />
            </AdjustmentSubSection>
          )}

          {!hiddenTools.includes('grain') && (
            <AdjustmentSubSection id="grain" order={toolOrder.indexOf('grain')} title={t('adjustments.effects.grain')}>
              <Slider
                resetKey="grainAmount"
                label={t('adjustments.effects.amount')}
                max={100}
                min={0}
                onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.GrainAmount, e.target.value)}
                step={1}
                value={adjustments.grainAmount}
                onDragStateChange={onDragStateChange}
              />
              <Slider
                resetKey="grainSize"
                defaultValue={25}
                label={t('adjustments.effects.size')}
                max={100}
                min={0}
                onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.GrainSize, e.target.value)}
                step={1}
                value={adjustments.grainSize}
                onDragStateChange={onDragStateChange}
                fillOrigin="min"
              />
              <Slider
                resetKey="grainRoughness"
                defaultValue={50}
                label={t('adjustments.effects.roughness')}
                max={100}
                min={0}
                onChange={(e: SliderChangeEvent) => handleAdjustmentChange(Effect.GrainRoughness, e.target.value)}
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

export default memo(EffectsPanel, areSectionPropsEqual('effects'));
