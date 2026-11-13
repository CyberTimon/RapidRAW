import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import Dropdown, { OptionItem } from '../../ui/Dropdown';
import Switch from '../../ui/Switch';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import {
  AppSettings,
  Camera,
  CameraDefaults,
  DevelopDefaultsSettings,
  SliderResetTarget,
} from '../../../types/settings';
import { Invokes } from '../../../types/invokes';
import type { Preset } from '../../../types/editor';
import type { UserPreset } from '../../../hooks/usePresets';
import { useEditorStore } from '../../../store/useEditorStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { cameraDisplayName, isSameCamera } from '../../../utils/developDefaults';

const NO_PRESET = '';
const SAME_AS_ALL_CAMERAS = '\u0000all';

const cameraOptionKey = ({ make, model }: Camera) => `${make}\u0000${model}`;

interface DefaultAdjustmentsSettingsProps {
  appSettings: AppSettings | null;
  onSettingsChange(settings: AppSettings): void | Promise<void>;
}

export default function DefaultAdjustmentsSettings({ appSettings, onSettingsChange }: DefaultAdjustmentsSettingsProps) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<UserPreset[] | null>(null);
  const developDefaults: DevelopDefaultsSettings = appSettings?.developDefaults ?? {};
  const selectedPresetId = developDefaults.presetId ?? NO_PRESET;

  useEffect(() => {
    invoke<UserPreset[]>(Invokes.LoadPresets)
      .then(setPresets)
      .catch((err) => {
        console.error('Failed to load presets:', err);
        setPresets([]);
      });
  }, []);

  const presetOptions = useMemo<OptionItem<string>[]>(() => {
    const options: OptionItem<string>[] = [
      { value: NO_PRESET, label: t('settings.processing.defaultAdjustments.noPreset') },
    ];
    for (const item of presets ?? []) {
      if (item.preset) {
        options.push({ value: item.preset.id, label: item.preset.name });
      }
      if (item.folder) {
        for (const child of item.folder.children as Preset[]) {
          options.push({ value: child.id, label: `${item.folder.name} / ${child.name}` });
        }
      }
    }
    return options;
  }, [presets, t]);

  const sliderResetOptions = useMemo<OptionItem<SliderResetTarget>[]>(
    () => [
      { value: 'neutral', label: t('settings.processing.defaultAdjustments.sliderResetNeutral') },
      { value: 'defaults', label: t('settings.processing.defaultAdjustments.sliderResetDefaults') },
    ],
    [t],
  );

  const isPresetMissing = (presetId: string | null | undefined) =>
    presets !== null && !!presetId && !presetOptions.some((option) => option.value === presetId);
  const presetMissing = isPresetMissing(selectedPresetId);

  const update = (patch: Partial<DevelopDefaultsSettings>) => {
    if (appSettings) onSettingsChange({ ...appSettings, developDefaults: { ...developDefaults, ...patch } });
  };

  const cameraRules = developDefaults.cameras ?? [];
  const updateCamera = (index: number, patch: Partial<CameraDefaults>) =>
    update({ cameras: cameraRules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)) });
  const removeCamera = (index: number) => update({ cameras: cameraRules.filter((_, i) => i !== index) });
  const cameraPresetOptions = useMemo<OptionItem<string>[]>(
    () => [
      { value: SAME_AS_ALL_CAMERAS, label: t('settings.processing.defaultAdjustments.sameAsAllCameras') },
      ...presetOptions,
    ],
    [presetOptions, t],
  );
  const cameraPresetValue = (presetId: string | null | undefined) => {
    if (presetId === null || presetId === undefined || isPresetMissing(presetId)) return SAME_AS_ALL_CAMERAS;
    return presetId;
  };

  const openImageCamera = useEditorStore((state) => state.imageDefaults?.camera ?? null);
  const exifByPath = useLibraryStore((state) => state.exifByPath);
  const availableCameras = useMemo(() => {
    const cameras: Camera[] = openImageCamera ? [openImageCamera] : [];
    for (const exif of Object.values(exifByPath)) {
      const make = exif?.Make?.trim();
      const model = exif?.Model?.trim();
      if (make && model && !cameras.some((camera) => isSameCamera(camera, { make, model }))) {
        cameras.push({ make, model });
      }
    }
    return cameras
      .filter((camera) => !cameraRules.some((rule) => isSameCamera(rule, camera)))
      .sort((a, b) => cameraDisplayName(a).localeCompare(cameraDisplayName(b)));
  }, [openImageCamera, exifByPath, cameraRules]);
  const cameraOptions = useMemo<OptionItem<string>[]>(
    () => availableCameras.map((camera) => ({ value: cameraOptionKey(camera), label: cameraDisplayName(camera) })),
    [availableCameras],
  );
  const addCamera = (key: string) => {
    const camera = availableCameras.find((candidate) => cameraOptionKey(candidate) === key);
    if (camera) update({ cameras: [...cameraRules, { ...camera, presetId: null }] });
  };

  return (
    <div className="space-y-6">
      <Text variant={TextVariants.small}>{t('settings.processing.defaultAdjustments.description')}</Text>

      <div>
        <Text variant={TextVariants.heading} className="block mb-2">
          {t('settings.processing.defaultAdjustments.preset')}
        </Text>
        <Dropdown
          onChange={(value: string) => update({ presetId: value === NO_PRESET ? null : value })}
          options={presetOptions}
          value={presetMissing ? NO_PRESET : selectedPresetId}
          triggerClassName="bg-bg-primary"
        />
        <Text variant={TextVariants.small} className="mt-2">
          {presetMissing
            ? t('settings.processing.defaultAdjustments.presetMissing')
            : t('settings.processing.defaultAdjustments.presetDesc')}
        </Text>
      </div>

      <div>
        <Text variant={TextVariants.heading} className="block mb-2">
          {t('settings.processing.defaultAdjustments.lensCorrection')}
        </Text>
        <Switch
          checked={developDefaults.autoLensCorrection ?? false}
          id="default-auto-lens-correction-toggle"
          label={t('settings.processing.defaultAdjustments.autoLensCorrection')}
          onChange={(checked) => update({ autoLensCorrection: checked })}
        />
        <Text variant={TextVariants.small} className="mt-2">
          {t('settings.processing.defaultAdjustments.autoLensCorrectionDesc')}
        </Text>
      </div>

      <div>
        <Text variant={TextVariants.heading} className="block mb-2">
          {t('settings.processing.defaultAdjustments.scope')}
        </Text>
        <Switch
          checked={developDefaults.applyToNonRaw ?? false}
          id="default-adjustments-non-raw-toggle"
          label={t('settings.processing.defaultAdjustments.applyToNonRaw')}
          onChange={(checked) => update({ applyToNonRaw: checked })}
        />
        <Text variant={TextVariants.small} className="mt-2">
          {t('settings.processing.defaultAdjustments.applyToNonRawDesc')}
        </Text>
      </div>

      <div>
        <Text variant={TextVariants.heading} className="block mb-2">
          {t('settings.processing.defaultAdjustments.sliderReset')}
        </Text>
        <Dropdown
          onChange={(value: SliderResetTarget) =>
            appSettings && onSettingsChange({ ...appSettings, sliderResetTarget: value })
          }
          options={sliderResetOptions}
          value={appSettings?.sliderResetTarget ?? 'neutral'}
          triggerClassName="bg-bg-primary"
        />
        <Text variant={TextVariants.small} className="mt-2">
          {t('settings.processing.defaultAdjustments.sliderResetDesc')}
        </Text>
      </div>

      <div>
        <Text variant={TextVariants.heading} className="block mb-2">
          {t('settings.processing.defaultAdjustments.cameraDefaults')}
        </Text>
        <Text variant={TextVariants.small} className="mb-3">
          {t('settings.processing.defaultAdjustments.cameraDefaultsDesc')}
        </Text>
        <div className="space-y-3">
          {cameraRules.map((rule, index) => (
            <div
              key={cameraOptionKey(rule)}
              className="p-4 bg-bg-primary rounded-lg border border-border-color space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <Text variant={TextVariants.heading}>{cameraDisplayName(rule)}</Text>
                <button
                  className="p-2 text-text-secondary hover:text-red-400 hover:bg-surface rounded-md transition-colors"
                  data-tooltip={t('settings.processing.defaultAdjustments.removeCamera')}
                  onClick={() => removeCamera(index)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <Dropdown
                onChange={(value: string) =>
                  updateCamera(index, { presetId: value === SAME_AS_ALL_CAMERAS ? null : value })
                }
                options={cameraPresetOptions}
                value={cameraPresetValue(rule.presetId)}
                triggerClassName="bg-surface"
              />
              {isPresetMissing(rule.presetId) && (
                <Text variant={TextVariants.small}>
                  {t('settings.processing.defaultAdjustments.cameraPresetMissing')}
                </Text>
              )}
            </div>
          ))}
          {cameraOptions.length > 0 ? (
            <Dropdown
              onChange={addCamera}
              options={cameraOptions}
              placeholder={t('settings.processing.defaultAdjustments.addCamera')}
              value={null}
              triggerClassName="bg-bg-primary"
            />
          ) : (
            <Text variant={TextVariants.small}>{t('settings.processing.defaultAdjustments.noCamerasFound')}</Text>
          )}
        </div>
      </div>
    </div>
  );
}
