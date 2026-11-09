import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { Invokes } from '../../ui/AppProperties';

export default function CacheLocationSettings({
  cachePath,
  restartRequired,
  directoryError,
  onSaved,
}: {
  cachePath?: string;
  restartRequired?: boolean;
  directoryError?: string | null;
  onSaved(): Promise<void>;
}) {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.appSettings);
  const osPlatform = useSettingsStore((state) => state.osPlatform);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (osPlatform === 'android') return null;

  const changeLocation = async (reset: boolean) => {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      const selected = reset
        ? undefined
        : await open({ directory: true, multiple: false, defaultPath: settings.cacheDirectory });
      if (!reset && typeof selected !== 'string') return;
      const next = { ...settings, cacheDirectory: selected || undefined };
      await invoke(Invokes.SaveSettings, { settings: next });
      useSettingsStore.getState().setAppSettings(next);
      await onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-4 space-y-2 rounded-md border border-border-color p-3 text-sm">
      <p className="font-medium text-text-primary">{t('settings.data.cacheLocation')}</p>
      <p className="text-text-secondary">{t('settings.data.cacheLocationDescription')}</p>
      <p className="break-all text-text-secondary">{cachePath}</p>
      <div className="flex gap-2">
        <button
          disabled={busy}
          onClick={() => changeLocation(false)}
          className="rounded bg-bg-primary px-3 py-1 disabled:opacity-40"
        >
          {t('settings.data.chooseCacheFolder')}
        </button>
        <button
          disabled={busy || !settings?.cacheDirectory}
          onClick={() => changeLocation(true)}
          className="rounded bg-bg-primary px-3 py-1 disabled:opacity-40"
        >
          {t('settings.data.defaultCacheFolder')}
        </button>
      </div>
      {restartRequired && (
        <p role="status" className="text-text-secondary">
          {t('settings.data.cacheRestartRequired')}
        </p>
      )}
      {(error || directoryError) && (
        <p role="alert" className="text-red-400">
          {error || directoryError}
        </p>
      )}
    </div>
  );
}
