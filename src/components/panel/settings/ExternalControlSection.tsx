import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';

interface Props {
  appSettings: Record<string, unknown>;
  onSettingsChange: (settings: Record<string, unknown>) => void;
}

type PublicStatus = {
  enabled: boolean;
  listening: boolean;
  port: number;
  tokenRequired: boolean;
  connected: boolean;
  clientCount: number;
  protocolVersion: string;
};

export default function ExternalControlSection({ appSettings, onSettingsChange }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const enabled = Boolean(appSettings?.externalControlEnabled);
  const port = Number(appSettings?.externalControlPort ?? 17355);

  const refreshStatus = useCallback(async () => {
    try {
      const s: PublicStatus = await invoke('external_control_get_public_status');
      setStatus(s);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const id = setInterval(() => void refreshStatus(), 2000);
    return () => clearInterval(id);
  }, [refreshStatus, enabled, port]);

  const toggleEnabled = async (next: boolean) => {
    try {
      if (next && !status?.tokenRequired && !token) {
        const plain: string = await invoke('external_control_generate_token');
        setToken(plain);
        toast.success(
          t(
            'settings.externalControl.tokenGenerated',
            'Token generated. Copy it now — it will not be shown again.',
          ),
        );
      }
      onSettingsChange({ ...appSettings, externalControlEnabled: next });
      await invoke('external_control_update_settings', { enabled: next, port });
      await refreshStatus();
    } catch (e) {
      toast.error(String(e));
      onSettingsChange({ ...appSettings, externalControlEnabled: false });
      await refreshStatus();
    }
  };

  const updatePort = async (nextPort: number) => {
    onSettingsChange({ ...appSettings, externalControlPort: nextPort });
    await invoke('external_control_update_settings', { port: nextPort, enabled });
    await refreshStatus();
  };

  const generateToken = async () => {
    try {
      const plain: string = await invoke('external_control_generate_token');
      setToken(plain);
      toast.success(t('settings.externalControl.tokenGenerated', 'Token generated. Copy it now — it will not be shown again.'));
      await refreshStatus();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const copyToken = async () => {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    toast.success(t('settings.externalControl.tokenCopied', 'Token copied'));
  };

  const stateLabel = !enabled
    ? t('settings.externalControl.stateDisabled', 'Disabled')
    : status?.connected
      ? t('settings.externalControl.stateConnected', 'Connected')
      : status?.listening
        ? t('settings.externalControl.stateEnabled', 'Enabled')
        : t('settings.externalControl.stateStarting', 'Starting…');

  return (
    <div className="flex flex-col gap-3 p-2">
      <p className="text-sm opacity-80">
        {t(
          'settings.externalControl.description',
          'Local MCP / automation API on 127.0.0.1 only. Off by default. Use the rapidraw-mcp server with Cursor, Claude Code, or other MCP clients.',
        )}
      </p>
      <div className="flex items-center justify-between gap-2">
        <span>{t('settings.externalControl.status', 'Status')}</span>
        <span className="font-medium">{stateLabel}</span>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void toggleEnabled(e.target.checked)}
        />
        {t('settings.externalControl.enable', 'Enable external control (localhost)')}
      </label>
      <label className="flex flex-col gap-1">
        <span>{t('settings.externalControl.port', 'Port')}</span>
        <input
          type="number"
          min={1024}
          max={65535}
          value={port}
          onChange={(e) => void updatePort(Number(e.target.value))}
          disabled={!enabled}
          className="rounded border px-2 py-1 bg-transparent"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary px-3 py-1 rounded" onClick={() => void generateToken()}>
          {t('settings.externalControl.generateToken', 'Generate token')}
        </button>
        <button
          type="button"
          className="btn-secondary px-3 py-1 rounded"
          disabled={!token}
          onClick={() => void copyToken()}
        >
          {t('settings.externalControl.copyToken', 'Copy token')}
        </button>
      </div>
      {status?.tokenRequired && !token && (
        <p className="text-xs opacity-70">
          {t('settings.externalControl.tokenHint', 'A bearer token is required for API requests.')}
        </p>
      )}
      {token && (
        <code className="text-xs break-all p-2 rounded bg-black/20">{token}</code>
      )}
      <p className="text-xs opacity-60">
        {t('settings.externalControl.mcpHint', 'Protocol')}: v{status?.protocolVersion ?? '1.0.0'} ·{' '}
        http://127.0.0.1:{port}/v1
      </p>
    </div>
  );
}
