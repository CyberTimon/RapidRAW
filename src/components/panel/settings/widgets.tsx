import { useEffect, useMemo, useState } from 'react';
import {
  Cpu,
  ExternalLink as ExternalLinkIcon,
  Server,
  Image as ImageIcon,
  Scaling,
  Mouse,
  Touchpad,
} from 'lucide-react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { useUser, useAuth, useClerk } from '@clerk/react';
import { open } from '@tauri-apps/plugin-shell';
import { useTranslation } from 'react-i18next';
import Button from '../../ui/Button';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { formatKeyCode, KeybindDefinition, normalizeCombo } from '../../../utils/keyboardUtils';

export interface DataActionItemProps {
  buttonAction(): void;
  buttonText: string;
  description: any;
  disabled?: boolean;
  icon: any;
  isProcessing: boolean;
  message: string;
  title: string;
}

export interface KeybindRowProps {
  def: KeybindDefinition;
  currentCombo?: string[];
  osPlatform: string;
  onSave: (action: string, combo: string[]) => void;
  recordingAction: string | null;
  onStartRecording: (action: string) => void;
  isConflicting: boolean;
}

export interface SettingItemProps {
  children: any;
  description?: string;
  label: string;
}

export const KeybindRow = ({
  def,
  currentCombo,
  osPlatform,
  onSave,
  recordingAction,
  onStartRecording,
  isConflicting,
}: KeybindRowProps) => {
  const { t } = useTranslation();
  const recording = recordingAction === def.action;

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onSave(def.action, []);
        onStartRecording('');
        return;
      }
      e.preventDefault();
      const parts = normalizeCombo(e, osPlatform);
      if (parts.length > 0 && !['ctrl', 'shift', 'alt'].includes(parts[parts.length - 1])) {
        onSave(def.action, parts);
        onStartRecording('');
      }
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [recording, def.action, onSave, onStartRecording]);

  const displayCombo = currentCombo !== undefined ? (currentCombo.length ? currentCombo : null) : def.defaultCombo;

  return (
    <div className="flex justify-between items-center py-2">
      <Text variant={TextVariants.label}>{t(def.description as any)}</Text>
      <div className="flex items-center gap-1">
        {isConflicting && <span className="text-yellow-400 text-xs">⚠</span>}
        <button onClick={() => onStartRecording(def.action)} className="flex items-center gap-1 flex-wrap shrink-0">
          {recording ? (
            <Text
              as="kbd"
              variant={TextVariants.small}
              color={TextColors.accent}
              weight={TextWeights.semibold}
              className="px-2 py-1 font-sans bg-bg-primary border border-accent rounded-md animate-pulse"
            >
              {t('settings.controls.pressKey')}
            </Text>
          ) : (
            <Text
              as="kbd"
              variant={TextVariants.small}
              color={TextColors.primary}
              weight={TextWeights.semibold}
              className={`px-2 py-1 font-sans bg-bg-primary border rounded-md cursor-pointer hover:border-accent transition-colors ${isConflicting ? 'border-yellow-400' : 'border-border-color'}`}
            >
              {displayCombo ? (
                displayCombo.map((k) => formatKeyCode(k, osPlatform)).join(' + ')
              ) : (
                <span className="text-text-secondary italic">{t('settings.controls.notAssigned')}</span>
              )}
            </Text>
          )}
        </button>
      </div>
    </div>
  );
};

export const SettingItem = ({ children, description, label }: SettingItemProps) => (
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

export const DataActionItem = ({
  buttonAction,
  buttonText,
  description,
  disabled = false,
  icon,
  isProcessing,
  message,
  title,
}: DataActionItemProps) => {
  const { t } = useTranslation();

  return (
    <div className="pb-8 border-b border-border-color last:border-b-0 last:pb-0">
      <Text variant={TextVariants.heading} className="mb-2">
        {title}
      </Text>
      <Text variant={TextVariants.small} className="mb-3">
        {description}
      </Text>
      <Button variant="destructive" onClick={buttonAction} disabled={isProcessing || disabled}>
        {icon}
        {isProcessing ? t('settings.data.statuses.processing') : buttonText}
      </Button>
      {message && (
        <Text color={TextColors.accent} className="mt-3">
          {message}
        </Text>
      )}
    </div>
  );
};

interface AiProviderSwitchProps {
  selectedProvider: string;
  onProviderChange: (provider: string) => void;
}

export const AiProviderSwitch = ({ selectedProvider, onProviderChange }: AiProviderSwitchProps) => {
  const { t } = useTranslation();

  const aiProviders = useMemo(
    () => [
      { id: 'cpu', label: t('settings.processing.ai.providers.cpu'), icon: Cpu },
      { id: 'ai-connector', label: t('settings.processing.ai.providers.aiConnector'), icon: Server },
      //{ id: 'cloud', label: t('settings.processing.ai.providers.cloud'), icon: Cloud },
    ],
    [t],
  );

  return (
    <div className="relative flex w-full p-1 bg-bg-primary rounded-md border border-border-color">
      {aiProviders.map((provider) => (
        <button
          key={provider.id}
          onClick={() => onProviderChange(provider.id)}
          className={clsx(
            'relative flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
            {
              'text-text-primary hover:bg-surface': selectedProvider !== provider.id,
              'text-button-text': selectedProvider === provider.id,
            },
          )}
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          {selectedProvider === provider.id && (
            <motion.span
              layoutId="ai-provider-switch-bubble"
              className="absolute inset-0 z-0 bg-accent"
              style={{ borderRadius: 6 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
            />
          )}
          <span className="relative z-10 flex items-center">
            <provider.icon size={16} className="mr-2" />
            {provider.label}
          </span>
        </button>
      ))}
    </div>
  );
};

export const CloudDashboard = () => {
  const { user } = useUser();
  const { getToken } = useAuth();
  const { signOut } = useClerk();
  const [usage, setUsage] = useState<{ requests: number; limit: number; month: string } | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    const fetchUsage = async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const res = await fetch('https://getrapidraw.com/api/usage', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          setUsage(await res.json());
        }
      } catch (e) {
        console.error('Failed to fetch cloud usage', e);
      }
    };
    fetchUsage();
  }, [getToken]);

  const isPro = user?.publicMetadata?.plan === 'pro';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-border-color pb-4">
        <div className="flex items-center gap-3">
          <div>
            <Text variant={TextVariants.heading}>{user?.fullName || user?.primaryEmailAddress?.emailAddress}</Text>
            <Text variant={TextVariants.small} color={isPro ? TextColors.success : TextColors.error}>
              {isPro
                ? t('settings.processing.ai.cloud.signedIn.active')
                : t('settings.processing.ai.cloud.signedIn.inactive')}
            </Text>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            className="bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface border-none shadow-none"
            onClick={() => open('https://www.getrapidraw.com/dashboard')}
          >
            {t('settings.processing.ai.cloud.signedIn.manage')} <ExternalLinkIcon size={14} className="ml-1" />
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              await signOut();
            }}
          >
            {t('settings.processing.ai.cloud.signedIn.logout')}
          </Button>
        </div>
      </div>

      {isPro ? (
        <div className="bg-surface p-4 rounded-md">
          <div className="flex justify-between items-center mb-2">
            <Text variant={TextVariants.label}>{t('settings.processing.ai.cloud.signedIn.usage')}</Text>
            <Text variant={TextVariants.small}>
              {t('settings.processing.ai.cloud.signedIn.usageStats', {
                requests: usage?.requests ?? 0,
                limit: usage?.limit ?? 500,
              })}
            </Text>
          </div>
          <div className="w-full bg-bg-primary rounded-full h-2">
            <div
              className="bg-accent h-2 rounded-full transition-all duration-500"
              style={{ width: `${Math.min(100, ((usage?.requests ?? 0) / (usage?.limit ?? 500)) * 100)}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="bg-red-900/10 border border-red-500/50 p-4 rounded-md text-center">
          <Text className="mb-3">{t('settings.processing.ai.cloud.signedOut.upgradeDesc')}</Text>
          <Button onClick={() => open('https://www.getrapidraw.com/cloud')}>
            {t('settings.processing.ai.cloud.signedOut.upgradeBtn')}
          </Button>
        </div>
      )}
    </div>
  );
};

interface CanvasInputModeSwitchProps {
  mode: 'mouse' | 'trackpad';
  onModeChange: (mode: 'mouse' | 'trackpad') => void;
}

export const CanvasInputModeSwitch = ({ mode, onModeChange }: CanvasInputModeSwitchProps) => {
  const { t } = useTranslation();

  const canvasInputModes = useMemo(
    () => [
      { id: 'mouse', label: t('settings.controls.modes.mouse'), icon: Mouse },
      { id: 'trackpad', label: t('settings.controls.modes.trackpad'), icon: Touchpad },
    ],
    [t],
  );

  return (
    <div className="relative flex w-full p-1 bg-bg-primary rounded-md border border-border-color">
      {canvasInputModes.map((item) => (
        <button
          key={item.id}
          onClick={() => onModeChange(item.id as 'mouse' | 'trackpad')}
          className={clsx(
            'relative flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
            {
              'text-text-primary hover:bg-surface': mode !== item.id,
              'text-button-text': mode === item.id,
            },
          )}
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          {mode === item.id && (
            <motion.span
              layoutId="canvas-input-mode-switch-bubble"
              className="absolute inset-0 z-0 bg-accent"
              style={{ borderRadius: 6 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
            />
          )}
          <span className="relative z-10 flex items-center">
            <item.icon size={16} className="mr-2" />
            {item.label}
          </span>
        </button>
      ))}
    </div>
  );
};

interface PreviewModeSwitchProps {
  mode: 'static' | 'dynamic';
  onModeChange: (mode: 'static' | 'dynamic') => void;
}

export const PreviewModeSwitch = ({ mode, onModeChange }: PreviewModeSwitchProps) => {
  const { t } = useTranslation();

  const previewModes = useMemo(
    () => [
      { id: 'static', label: t('settings.processing.modes.static'), icon: ImageIcon },
      { id: 'dynamic', label: t('settings.processing.modes.dynamic'), icon: Scaling },
    ],
    [t],
  );

  return (
    <div className="relative flex w-full p-1 bg-bg-primary rounded-md border border-border-color">
      {previewModes.map((item) => (
        <button
          key={item.id}
          onClick={() => onModeChange(item.id as 'static' | 'dynamic')}
          className={clsx(
            'relative flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
            {
              'text-text-primary hover:bg-surface': mode !== item.id,
              'text-button-text': mode === item.id,
            },
          )}
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          {mode === item.id && (
            <motion.span
              layoutId="preview-mode-switch-bubble"
              className="absolute inset-0 z-0 bg-accent"
              style={{ borderRadius: 6 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
            />
          )}
          <span className="relative z-10 flex items-center">
            <item.icon size={16} className="mr-2" />
            {item.label}
          </span>
        </button>
      ))}
    </div>
  );
};
