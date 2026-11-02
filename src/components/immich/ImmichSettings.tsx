import { ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, FileLock, Lock, Wifi, WifiOff } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import {
  DEFAULT_IMMICH_SETTINGS,
  getImmichApiKey,
  ImmichApiKeyInfo,
  ImmichConnectionInfo,
  ImmichSettings as ImmichSettingsValues,
  setImmichApiKey,
  testImmichConnection,
} from './immichApi';
import { useImmichStore } from './useImmichStore';
import { useSettingsStore } from '../../store/useSettingsStore';

type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'connected'; info: ImmichConnectionInfo }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

function Item({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div>
      <Text variant={TextVariants.heading} className="block mb-2">
        {label}
      </Text>
      {children}
      {description && (
        <Text variant={TextVariants.small} className="mt-2">
          {description}
        </Text>
      )}
    </div>
  );
}

export default function ImmichSettings() {
  const { t } = useTranslation();
  const refreshImmich = useImmichStore((state) => state.refresh);
  const appSettings = useSettingsStore((state) => state.appSettings);
  const handleSettingsChange = useSettingsStore((state) => state.handleSettingsChange);
  const [keyInfo, setKeyInfo] = useState<ImmichApiKeyInfo | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const saved: ImmichSettingsValues = { ...DEFAULT_IMMICH_SETTINGS, ...appSettings?.immich };

  const savedServerUrl = appSettings?.immich?.serverUrl?.trim() ?? '';

  useEffect(() => {
    if (!savedServerUrl) {
      setKeyInfo({ apiKey: '', inCredentialStore: false });
      return;
    }
    getImmichApiKey()
      .then((info) => {
        setKeyInfo(info);
        setApiKey(info.apiKey);
      })
      .catch((err) => {
        setKeyInfo({ apiKey: '', inCredentialStore: false });
        setStatus({ kind: 'error', message: String(err) });
      });
  }, [savedServerUrl]);

  useEffect(() => {
    setServerUrl(appSettings?.immich?.serverUrl ?? '');
  }, [appSettings?.immich?.serverUrl]);

  if (!appSettings || !keyInfo) return null;

  const saveConnection = async () => {
    setStatus({ kind: 'busy' });
    try {
      setKeyInfo(await setImmichApiKey(apiKey.trim()));
      await handleSettingsChange({ ...appSettings, immich: { ...saved, serverUrl: serverUrl.trim() } });
      await refreshImmich();
      setStatus({ kind: 'saved' });
    } catch (err) {
      setStatus({ kind: 'error', message: String(err) });
    }
  };

  const testConnection = async () => {
    setStatus({ kind: 'busy' });
    try {
      setStatus({ kind: 'connected', info: await testImmichConnection(serverUrl, apiKey) });
    } catch (err) {
      setStatus({ kind: 'error', message: String(err) });
    }
  };

  const isBusy = status.kind === 'busy';
  const hasCredentials = !!serverUrl.trim() && !!apiKey.trim();
  const connectionChanged = serverUrl.trim() !== saved.serverUrl || apiKey.trim() !== keyInfo.apiKey;

  return (
    <div className="p-6 bg-surface rounded-xl shadow-md">
      <Text variant={TextVariants.title} color={TextColors.accent} className="mb-5">
        {t('immich.settings.title')}
      </Text>
      <Text className="mb-6">{t('immich.settings.description')}</Text>

      <div className="space-y-8">
        <Item label={t('immich.settings.serverUrl')} description={t('immich.settings.serverUrlDesc')}>
          <Input
            value={serverUrl}
            placeholder="https://photos.example.com"
            onChange={(e) => {
              setServerUrl(e.target.value);
              setStatus({ kind: 'idle' });
            }}
            bgClassName="bg-bg-primary"
          />
        </Item>

        <Item label={t('immich.settings.apiKey')} description={t('immich.settings.apiKeyDesc')}>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setStatus({ kind: 'idle' });
            }}
            bgClassName="bg-bg-primary"
          />
          {keyInfo.apiKey && !connectionChanged && (
            <Text variant={TextVariants.small} className="mt-2 flex items-center gap-1.5">
              {keyInfo.inCredentialStore ? <Lock size={12} /> : <FileLock size={12} />}
              {keyInfo.inCredentialStore ? t('immich.settings.keyInStore') : t('immich.settings.keyInFile')}
            </Text>
          )}
        </Item>

        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Button className="min-w-32" onClick={testConnection} disabled={isBusy || !hasCredentials}>
              {isBusy ? t('immich.settings.working') : t('immich.settings.test')}
            </Button>
            <Button className="min-w-32" onClick={saveConnection} disabled={isBusy || !connectionChanged}>
              {t('immich.settings.save')}
            </Button>
          </div>
          <StatusLine status={status} />
        </div>
      </div>
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  const { t } = useTranslation();

  if (status.kind === 'idle' || status.kind === 'busy') return null;
  const success = status.kind !== 'error';
  const message =
    status.kind === 'connected'
      ? t('immich.settings.connected', { user: status.info.userName, version: status.info.version })
      : status.kind === 'saved'
        ? t('immich.settings.saved')
        : status.message;

  return (
    <Text color={success ? TextColors.success : TextColors.error} className="mt-2 flex items-center gap-2 break-all">
      {status.kind === 'connected' && <Wifi size={16} className="shrink-0" />}
      {status.kind === 'saved' && <Check size={16} className="shrink-0" />}
      {status.kind === 'error' && <WifiOff size={16} className="shrink-0" />}
      {message}
    </Text>
  );
}
