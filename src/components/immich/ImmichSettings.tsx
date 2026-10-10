import { ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, FileLock, Lock, PlugZap, Save, XCircle } from 'lucide-react';
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

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="p-6 bg-surface rounded-xl shadow-md">
      <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
        {title}
      </Text>
      <div className="space-y-8">{children}</div>
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
  const [draft, setDraft] = useState<Partial<ImmichSettingsValues>>({});
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const saved: ImmichSettingsValues = { ...DEFAULT_IMMICH_SETTINGS, ...appSettings?.immich };
  const shown: ImmichSettingsValues = { ...saved, ...draft };

  useEffect(() => {
    getImmichApiKey()
      .then((info) => {
        setKeyInfo(info);
        setApiKey(info.apiKey);
      })
      .catch((err) => setStatus({ kind: 'error', message: String(err) }));
  }, []);

  useEffect(() => {
    setServerUrl(appSettings?.immich?.serverUrl ?? '');
  }, [appSettings?.immich?.serverUrl]);

  if (!appSettings || !keyInfo) return null;

  const saveOption = (changes: Partial<ImmichSettingsValues>) => {
    setDraft({});
    handleSettingsChange({ ...appSettings, immich: { ...saved, ...changes } })
      .then(refreshImmich)
      .catch((err) => setStatus({ kind: 'error', message: String(err) }));
  };

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
    <div className="space-y-10">
      <Card title={t('immich.settings.connectionTitle')}>
        <Text variant={TextVariants.small} className="-mt-4">
          {t('immich.settings.description')}
        </Text>

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

        <div className="flex flex-wrap items-center gap-3">
          <Button className="bg-surface" onClick={testConnection} disabled={isBusy || !hasCredentials}>
            <PlugZap size={16} />
            {t('immich.settings.test')}
          </Button>
          <Button onClick={saveConnection} disabled={isBusy || !connectionChanged}>
            <Save size={16} />
            {t('immich.settings.save')}
          </Button>
          <StatusLine status={status} />
        </div>
      </Card>

      <Card title={t('immich.settings.cacheTitle')}>
        <Item label={t('immich.settings.cacheLimit')} description={t('immich.settings.cacheLimitDesc')}>
          <Input
            type="number"
            value={String(shown.cacheLimitGb)}
            onChange={(e) => setDraft({ ...draft, cacheLimitGb: Number(e.target.value) })}
            onBlur={() => saveOption({ cacheLimitGb: Math.max(1, Math.round(shown.cacheLimitGb || 1)) })}
            className="max-w-32"
            bgClassName="bg-bg-primary"
          />
        </Item>
        <Item label={t('immich.settings.cacheDir')} description={t('immich.settings.cacheDirDesc')}>
          <Input
            value={shown.cacheDir ?? ''}
            placeholder={t('immich.settings.cacheDirDefault')}
            onChange={(e) => setDraft({ ...draft, cacheDir: e.target.value })}
            onBlur={() => saveOption({ cacheDir: shown.cacheDir?.trim() || null })}
            bgClassName="bg-bg-primary"
          />
        </Item>
      </Card>
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  const { t } = useTranslation();

  switch (status.kind) {
    case 'busy':
      return <Text variant={TextVariants.small}>{t('immich.settings.working')}</Text>;
    case 'connected':
      return (
        <Text variant={TextVariants.small} className="flex items-center gap-1.5">
          <CheckCircle2 size={14} className="text-green-500" />
          {t('immich.settings.connected', { user: status.info.userName, version: status.info.version })}
        </Text>
      );
    case 'saved':
      return (
        <Text variant={TextVariants.small} className="flex items-center gap-1.5">
          <CheckCircle2 size={14} className="text-green-500" />
          {t('immich.settings.saved')}
        </Text>
      );
    case 'error':
      return (
        <Text variant={TextVariants.small} className="flex items-center gap-1.5 break-all">
          <XCircle size={14} className="text-red-500 shrink-0" />
          {status.message}
        </Text>
      );
    default:
      return null;
  }
}
