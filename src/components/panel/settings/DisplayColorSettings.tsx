import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { FolderOpen } from 'lucide-react';
import Button from '../../ui/Button';
import Dropdown, { OptionItem } from '../../ui/Dropdown';
import Text from '../../ui/Text';
import { TextColors, TextVariants } from '../../../types/typography';
import { AppSettings, DisplayColorManagementMode, DisplayProfileInfo, Invokes } from '../../ui/AppProperties';
import { useSettingsStore } from '../../../store/useSettingsStore';

interface DisplayColorSettingsProps {
  appSettings: AppSettings | null;
  onSettingsChange(settings: AppSettings): Promise<void>;
}

/** Linux-only: convert the edit view from sRGB to the monitor's ICC profile. */
export default function DisplayColorSettings({ appSettings, onSettingsChange }: DisplayColorSettingsProps) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<DisplayProfileInfo | null>(null);
  const mode: DisplayColorManagementMode = appSettings?.displayColorManagement ?? 'auto';
  const profilePath = appSettings?.displayProfilePath ?? null;

  const applyInfo = useCallback((next: DisplayProfileInfo) => {
    setInfo(next);
    useSettingsStore.getState().setDisplayProfileGeneration(next.generation);
  }, []);

  useEffect(() => {
    invoke<DisplayProfileInfo>(Invokes.GetDisplayProfileInfo).then(setInfo).catch(console.error);
  }, []);

  const saveAndRefresh = async (changes: Partial<AppSettings>) => {
    if (!appSettings) return;
    await onSettingsChange({ ...appSettings, ...changes });
    try {
      applyInfo(await invoke<DisplayProfileInfo>(Invokes.RefreshDisplayProfile));
    } catch (err) {
      console.error('Failed to refresh display profile:', err);
    }
  };

  const chooseFile = async () => {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: t('settings.processing.displayColor.iccFilter'), extensions: ['icc', 'icm', 'ICC', 'ICM'] }],
    });
    if (typeof selected === 'string') {
      await saveAndRefresh({ displayColorManagement: 'custom', displayProfilePath: selected });
    }
  };

  const options = useMemo<OptionItem<DisplayColorManagementMode>[]>(
    () => [
      { value: 'auto', label: t('settings.processing.displayColor.modes.auto') },
      { value: 'custom', label: t('settings.processing.displayColor.modes.custom') },
      { value: 'off', label: t('settings.processing.displayColor.modes.off') },
    ],
    [t],
  );

  const status = (() => {
    if (!info) return null;
    if (info.blockedByWgpu) {
      return { color: TextColors.secondary, text: t('settings.processing.displayColor.status.wgpu') };
    }
    if (info.error) {
      return {
        color: TextColors.error,
        text: t('settings.processing.displayColor.status.error', { error: info.error }),
      };
    }
    if (info.mode === 'off')
      return { color: TextColors.secondary, text: t('settings.processing.displayColor.status.off') };
    if (info.source === 'none') {
      return { color: TextColors.secondary, text: t('settings.processing.displayColor.status.notFound') };
    }
    const name = info.description || t('settings.processing.displayColor.status.unnamed');
    if (!info.active) {
      return { color: TextColors.secondary, text: t('settings.processing.displayColor.status.srgb', { name }) };
    }
    return { color: TextColors.success, text: t('settings.processing.displayColor.status.active', { name }) };
  })();

  return (
    <div className="space-y-2">
      <Dropdown
        onChange={(value: DisplayColorManagementMode) => {
          if (value === 'custom' && !profilePath) {
            chooseFile();
          } else {
            saveAndRefresh({ displayColorManagement: value });
          }
        }}
        options={options}
        value={mode}
        triggerClassName="bg-bg-primary"
      />
      {mode === 'custom' && (
        <div className="flex items-center gap-2">
          <Text variant={TextVariants.small} className="truncate flex-1" title={profilePath ?? undefined}>
            {profilePath ?? t('settings.processing.displayColor.noFile')}
          </Text>
          <Button className="bg-surface shrink-0" onClick={chooseFile}>
            <FolderOpen size={14} />
            {t('settings.processing.displayColor.chooseFile')}
          </Button>
        </div>
      )}
      {status && (
        <Text variant={TextVariants.small} color={status.color}>
          {status.text}
        </Text>
      )}
    </div>
  );
}
