import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Cloud,
  Cpu,
  ExternalLink as ExternalLinkIcon,
  Server,
  Info,
  Trash2,
  Wifi,
  WifiOff,
  Plus,
  X,
  SlidersHorizontal,
  Keyboard,
  Bookmark,
  Scaling,
  Image as ImageIcon,
  Mouse,
  Touchpad,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { relaunch } from '@tauri-apps/plugin-process';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { Show, SignIn, useUser, useAuth, useClerk } from '@clerk/react';
import Button from '../ui/Button';
import ConfirmModal from '../modals/ConfirmModal';
import Dropdown, { OptionItem } from '../ui/Dropdown';
import Switch from '../ui/Switch';
import Input from '../ui/Input';
import Slider from '../ui/Slider';
import { ThemeProps, THEMES, DEFAULT_THEME_ID } from '../../utils/themes';
import { useTranslation } from 'react-i18next';
import { Invokes } from '../ui/AppProperties';
import {
  formatKeyCode,
  KeybindDefinition,
  KEYBIND_DEFINITIONS,
  KEYBIND_SECTIONS,
  normalizeCombo,
} from '../../utils/keyboardUtils';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import { useOsPlatform } from '../../hooks/useOsPlatform';
import { open } from '@tauri-apps/plugin-shell';

interface ConfirmModalState {
  confirmText: string;
  confirmVariant: string;
  isOpen: boolean;
  message: string;
  onConfirm(): void;
  title: string;
}

interface DataActionItemProps {
  buttonAction(): void;
  buttonText: string;
  description: any;
  disabled?: boolean;
  icon: any;
  isProcessing: boolean;
  message: string;
  title: string;
}

interface KeybindRowProps {
  def: KeybindDefinition;
  currentCombo?: string[];
  osPlatform: string;
  onSave: (action: string, combo: string[]) => void;
  recordingAction: string | null;
  onStartRecording: (action: string) => void;
  isConflicting: boolean;
}

interface SettingItemProps {
  children: any;
  description?: string;
  label: string;
}

interface SettingsPanelProps {
  appSettings: any;
  onBack(): void;
  onLibraryRefresh(): void;
  onSettingsChange(settings: any): Promise<void>;
  rootPaths: string[];
}

interface TestStatus {
  message: string;
  success: boolean | null;
  testing: boolean;
}

interface MyLens {
  maker: string;
  model: string;
}

const EXECUTE_TIMEOUT = 3000;

const adjustmentVisibilityDefaults = {
  sharpening: true,
  presence: true,
  noiseReduction: true,
  chromaticAberration: false,
  vignette: true,
  colorCalibration: false,
  grain: true,
};

const resolutions: OptionItem<number>[] = [
  { value: 720, label: '720px' },
  { value: 1280, label: '1280px' },
  { value: 1920, label: '1920px' },
  { value: 2560, label: '2560px' },
  { value: 3840, label: '3840px' },
];

const thumbnailResolutions: OptionItem<number>[] = [
  { value: 640, label: '640px' },
  { value: 720, label: '720px' },
  { value: 960, label: '960px' },
  { value: 1080, label: '1080px' },
];

const zoomMultiplierOptions: OptionItem<number>[] = [
  { value: 1.0, label: '1.0x (Native)' },
  { value: 0.75, label: '0.75x' },
  { value: 0.5, label: '0.50x (Half)' },
  { value: 0.25, label: '0.25x' },
];

const KeybindRow = ({
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

const SettingItem = ({ children, description, label }: SettingItemProps) => (
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

const DataActionItem = ({
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

const AiProviderSwitch = ({ selectedProvider, onProviderChange }: AiProviderSwitchProps) => {
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

const CloudDashboard = () => {
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

const CanvasInputModeSwitch = ({ mode, onModeChange }: CanvasInputModeSwitchProps) => {
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

const PreviewModeSwitch = ({ mode, onModeChange }: PreviewModeSwitchProps) => {
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

export default function SettingsPanel({
  appSettings,
  onBack,
  onLibraryRefresh,
  onSettingsChange,
  rootPaths,
}: SettingsPanelProps) {
  const { user: _user } = useUser();
  const { t } = useTranslation();
  const [isClearing, setIsClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState('');
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [cacheClearMessage, setCacheClearMessage] = useState('');
  const [isClearingAiTags, setIsClearingAiTags] = useState(false);
  const [aiTagsClearMessage, setAiTagsClearMessage] = useState('');
  const [isClearingTags, setIsClearingTags] = useState(false);
  const [tagsClearMessage, setTagsClearMessage] = useState('');
  const [confirmModalState, setConfirmModalState] = useState<ConfirmModalState>({
    confirmText: t('settings.data.modals.confirmClear'),
    confirmVariant: 'primary',
    isOpen: false,
    message: '',
    onConfirm: () => {},
    title: '',
  });
  const [testStatus, setTestStatus] = useState<TestStatus>({ message: '', success: null, testing: false });
  const [hasInteractedWithLivePreview, setHasInteractedWithLivePreview] = useState(false);
  const [recordingAction, setRecordingAction] = useState<string | null>(null);

  const [aiProvider, setAiProvider] = useState(appSettings?.aiProvider || 'cpu');
  const [aiConnectorAddress, setAiConnectorAddress] = useState<string>(appSettings?.aiConnectorAddress || '');
  const [newShortcut, setNewShortcut] = useState('');
  const [newAiTag, setNewAiTag] = useState('');

  const [lensMakers, setLensMakers] = useState<string[]>([]);
  const [lensModels, setLensModels] = useState<string[]>([]);
  const [tempLensMaker, setTempLensMaker] = useState<string>('');
  const [tempLensModel, setTempLensModel] = useState<string>('');

  const osPlatform = useOsPlatform();
  const [processingSettings, setProcessingSettings] = useState({
    editorPreviewResolution: appSettings?.editorPreviewResolution || 1920,
    thumbnailResolution: appSettings?.thumbnailResolution || 720,
    rawHighlightCompression: appSettings?.rawHighlightCompression ?? 2.5,
    processingBackend: appSettings?.processingBackend || 'auto',
    linuxGpuOptimization: appSettings?.linuxGpuOptimization ?? false,
    highResZoomMultiplier: appSettings?.highResZoomMultiplier || 1.0,
    useFullDpiRendering: appSettings?.useFullDpiRendering ?? false,
    useWgpuRenderer:
      appSettings?.useWgpuRenderer ?? (osPlatform === 'linux' || osPlatform === 'android' ? false : true),
    thumbnailWorkerThreads: appSettings?.thumbnailWorkerThreads ?? 4,
    imageCacheSize: appSettings?.imageCacheSize ?? 5,
    rawPreprocessingColorNr: appSettings?.rawPreprocessingColorNr ?? 0.5,
    rawPreprocessingSharpening: appSettings?.rawPreprocessingSharpening ?? 0.35,
    applyPreprocessingToNonRaws: appSettings?.applyPreprocessingToNonRaws ?? false,
  });
  const [restartRequired, setRestartRequired] = useState(false);
  const [activeCategory, setActiveCategory] = useState('general');
  const [logPath, setLogPath] = useState<string | null>(null);
  const [logPathLoading, setLogPathLoading] = useState(true);
  const [logPathError, setLogPathError] = useState(false);
  const [dpr, setDpr] = useState(() => (typeof window !== 'undefined' ? window.devicePixelRatio : 1));

  const settingCategories = useMemo(
    () => [
      { id: 'general', label: t('settings.categories.general'), icon: SlidersHorizontal },
      { id: 'processing', label: t('settings.categories.processing'), icon: Cpu },
      { id: 'shortcuts', label: t('settings.categories.shortcuts'), icon: Keyboard },
    ],
    [t],
  );

  const livePreviewQualityOptions = useMemo<OptionItem<string>[]>(
    () => [
      { value: 'full', label: t('settings.processing.qualities.full') },
      { value: 'high', label: t('settings.processing.qualities.high') },
      { value: 'performance', label: t('settings.processing.qualities.performance') },
    ],
    [t],
  );

  const filteredBackendOptions = useMemo<OptionItem<string>[]>(() => {
    const rawOptions = [
      { value: 'auto', label: t('settings.processing.backends.auto') },
      { value: 'vulkan', label: t('settings.processing.backends.vulkan') },
      { value: 'dx12', label: t('settings.processing.backends.dx12') },
      { value: 'metal', label: t('settings.processing.backends.metal') },
      { value: 'gl', label: t('settings.processing.backends.gl') },
    ];
    return rawOptions.filter((opt) => {
      if (opt.value === 'metal' && osPlatform !== 'macos') return false;
      if (opt.value === 'dx12' && osPlatform === 'macos') return false;
      return true;
    });
  }, [t, osPlatform]);

  const linearRawOptions = useMemo<OptionItem<string>[]>(
    () => [
      { value: 'auto', label: t('settings.processing.preprocessing.linearOptions.auto') },
      { value: 'gamma', label: t('settings.processing.preprocessing.linearOptions.gamma') },
      { value: 'skip_calib', label: t('settings.processing.preprocessing.linearOptions.skip_calib') },
      { value: 'gamma_skip_calib', label: t('settings.processing.preprocessing.linearOptions.gamma_skip_calib') },
    ],
    [t],
  );

  const tonemapperOptions = useMemo<OptionItem<string>[]>(
    () => [
      { value: 'agx', label: t('settings.processing.preprocessing.tonemapperOptions.agx') },
      { value: 'basic', label: t('settings.processing.preprocessing.tonemapperOptions.basic') },
    ],
    [t],
  );

  const fontOptions = useMemo<OptionItem<string>[]>(
    () => [
      { value: 'poppins', label: t('settings.general.poppins') },
      { value: 'system', label: t('settings.general.system') },
    ],
    [t],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const updateDpr = () => setDpr(window.devicePixelRatio);

    const mediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mediaQuery.addEventListener('change', updateDpr);

    window.addEventListener('resize', updateDpr);

    return () => {
      mediaQuery.removeEventListener('change', updateDpr);
      window.removeEventListener('resize', updateDpr);
    };
  }, []);

  const customAiTags = Array.from(new Set<string>(appSettings?.customAiTags || []));
  const taggingShortcuts = Array.from(new Set<string>(appSettings?.taggingShortcuts || []));

  useEffect(() => {
    if (appSettings?.aiConnectorAddress !== aiConnectorAddress) {
      setAiConnectorAddress(appSettings?.aiConnectorAddress || '');
    }
    if (appSettings?.aiProvider !== aiProvider) {
      setAiProvider(appSettings?.aiProvider || 'cpu');
    }
    setProcessingSettings({
      editorPreviewResolution: appSettings?.editorPreviewResolution || 1920,
      thumbnailResolution: appSettings?.thumbnailResolution || 720,
      rawHighlightCompression: appSettings?.rawHighlightCompression ?? 2.5,
      processingBackend: appSettings?.processingBackend || 'auto',
      linuxGpuOptimization: appSettings?.linuxGpuOptimization ?? false,
      highResZoomMultiplier: appSettings?.highResZoomMultiplier || 1.0,
      useFullDpiRendering: appSettings?.useFullDpiRendering ?? false,
      useWgpuRenderer: appSettings?.useWgpuRenderer ?? true,
      thumbnailWorkerThreads: appSettings?.thumbnailWorkerThreads ?? 4,
      imageCacheSize: appSettings?.imageCacheSize ?? 5,
      rawPreprocessingColorNr: appSettings?.rawPreprocessingColorNr ?? 0.5,
      rawPreprocessingSharpening: appSettings?.rawPreprocessingSharpening ?? 0.35,
      applyPreprocessingToNonRaws: appSettings?.applyPreprocessingToNonRaws ?? false,
    });
    setRestartRequired(false);
  }, [appSettings]);

  useEffect(() => {
    const fetchLogPath = async () => {
      try {
        const path: string = await invoke(Invokes.GetLogFilePath);
        setLogPath(path);
      } catch (error) {
        console.error('Failed to get log file path:', error);
        setLogPathError(true);
      } finally {
        setLogPathLoading(false);
      }
    };
    fetchLogPath();
  }, []);

  useEffect(() => {
    invoke<string[]>('get_lensfun_makers').then(setLensMakers).catch(console.error);
  }, []);

  const handleProcessingSettingChange = async (key: string, value: any) => {
    setProcessingSettings((prev) => ({ ...prev, [key]: value }));

    if (
      key === 'processingBackend' ||
      key === 'linuxGpuOptimization' ||
      key === 'useWgpuRenderer' ||
      key === 'thumbnailWorkerThreads'
    ) {
      setRestartRequired(true);
    } else {
      await onSettingsChange({ ...appSettings, [key]: value });
      if (
        key === 'rawHighlightCompression' ||
        key === 'rawPreprocessingColorNr' ||
        key === 'rawPreprocessingSharpening' ||
        key === 'applyPreprocessingToNonRaws'
      ) {
        await invoke('clear_image_caches');
      }
    }
  };

  const handleSaveAndRelaunch = async () => {
    await onSettingsChange({
      ...appSettings,
      ...processingSettings,
    });
    await relaunch();
  };

  const handleProviderChange = (provider: string) => {
    setAiProvider(provider);
    onSettingsChange({ ...appSettings, aiProvider: provider });
  };

  const handlePreviewModeChange = (mode: 'static' | 'dynamic') => {
    const enableZoomHifi = mode === 'dynamic';
    onSettingsChange({ ...appSettings, enableZoomHifi });
  };

  const handleTempMakerChange = (maker: string) => {
    setTempLensMaker(maker);
    setTempLensModel('');
    setLensModels([]);
    if (maker) {
      invoke('get_lensfun_lenses_for_maker', { maker })
        .then((l: any) => setLensModels(l))
        .catch(console.error);
    }
  };

  const handleAddLens = () => {
    if (tempLensMaker && tempLensModel) {
      const currentLenses: MyLens[] = appSettings?.myLenses || [];
      if (!currentLenses.some((l) => l.maker === tempLensMaker && l.model === tempLensModel)) {
        const newLenses = [...currentLenses, { maker: tempLensMaker, model: tempLensModel }];

        newLenses.sort((a, b) => {
          const makerComp = a.maker.localeCompare(b.maker);
          if (makerComp !== 0) return makerComp;
          return a.model.localeCompare(b.model);
        });

        onSettingsChange({
          ...appSettings,
          myLenses: newLenses,
        });
        setTempLensMaker('');
        setTempLensModel('');
        setLensModels([]);
      }
    }
  };

  const handleRemoveLens = (index: number) => {
    const currentLenses: MyLens[] = appSettings?.myLenses || [];
    const newLenses = [...currentLenses];
    newLenses.splice(index, 1);
    onSettingsChange({ ...appSettings, myLenses: newLenses });
  };

  const effectiveRootPaths = rootPaths?.length > 0 ? rootPaths : appSettings?.rootFolders || [];

  const executeClearSidecars = async () => {
    setIsClearing(true);
    setClearMessage(t('settings.data.statuses.deleting'));
    try {
      let totalCount = 0;
      for (const root of effectiveRootPaths) {
        const count: number = await invoke(Invokes.ClearAllSidecars, { rootPath: root });
        totalCount += count;
      }
      setClearMessage(t('settings.data.statuses.sidecarSuccess', { count: totalCount }));
      onLibraryRefresh();
    } catch (err: any) {
      console.error('Failed to clear sidecars:', err);
      setClearMessage(`Error: ${err}`);
    } finally {
      setTimeout(() => {
        setIsClearing(false);
        setClearMessage('');
      }, EXECUTE_TIMEOUT);
    }
  };

  const handleClearSidecars = () => {
    setConfirmModalState({
      confirmText: t('settings.data.modals.confirmDeleteAllEdits'),
      confirmVariant: 'destructive',
      isOpen: true,
      message: t('settings.data.modals.sidecarMessage'),
      onConfirm: executeClearSidecars,
      title: t('settings.data.modals.confirmTitle'),
    });
  };

  const executeClearAiTags = async () => {
    setIsClearingAiTags(true);
    setAiTagsClearMessage(t('settings.data.statuses.clearingAi'));
    try {
      let totalCount = 0;
      for (const root of effectiveRootPaths) {
        const count: number = await invoke(Invokes.ClearAiTags, { rootPath: root });
        totalCount += count;
      }
      setAiTagsClearMessage(t('settings.data.statuses.aiSuccess', { count: totalCount }));
      onLibraryRefresh();
    } catch (err: any) {
      console.error('Failed to clear AI tags:', err);
      setAiTagsClearMessage(`Error: ${err}`);
    } finally {
      setTimeout(() => {
        setIsClearingAiTags(false);
        setAiTagsClearMessage('');
      }, EXECUTE_TIMEOUT);
    }
  };

  const handleClearAiTags = () => {
    setConfirmModalState({
      confirmText: t('settings.data.modals.confirmClearAi'),
      confirmVariant: 'destructive',
      isOpen: true,
      message: t('settings.data.modals.aiMessage'),
      onConfirm: executeClearAiTags,
      title: t('settings.data.modals.confirmAiTitle'),
    });
  };

  const executeClearTags = async () => {
    setIsClearingTags(true);
    setTagsClearMessage(t('settings.data.statuses.clearingAll'));
    try {
      let totalCount = 0;
      for (const root of effectiveRootPaths) {
        const count: number = await invoke(Invokes.ClearAllTags, { rootPath: root });
        totalCount += count;
      }
      setTagsClearMessage(t('settings.data.statuses.allSuccess', { count: totalCount }));
      onLibraryRefresh();
    } catch (err: any) {
      console.error('Failed to clear tags:', err);
      setTagsClearMessage(`Error: ${err}`);
    } finally {
      setTimeout(() => {
        setIsClearingTags(false);
        setTagsClearMessage('');
      }, EXECUTE_TIMEOUT);
    }
  };

  const handleClearTags = () => {
    setConfirmModalState({
      confirmText: t('settings.data.modals.confirmClearAll'),
      confirmVariant: 'destructive',
      isOpen: true,
      message: t('settings.data.modals.allMessage'),
      onConfirm: executeClearTags,
      title: t('settings.data.modals.confirmAllTitle'),
    });
  };

  const shortcutTagVariants = {
    visible: { opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 500, damping: 30 } },
    exit: { opacity: 0, scale: 0.8, transition: { duration: 0.15 } },
  };

  const executeClearCache = async () => {
    setIsClearingCache(true);
    setCacheClearMessage(t('settings.data.statuses.clearingCache'));
    try {
      await invoke(Invokes.ClearThumbnailCache);
      setCacheClearMessage(t('settings.data.statuses.cacheSuccess'));
      onLibraryRefresh();
    } catch (err: any) {
      console.error('Failed to clear thumbnail cache:', err);
      setCacheClearMessage(`Error: ${err}`);
    } finally {
      setTimeout(() => {
        setIsClearingCache(false);
        setCacheClearMessage('');
      }, EXECUTE_TIMEOUT);
    }
  };

  const handleClearCache = () => {
    setConfirmModalState({
      confirmText: t('settings.data.modals.confirmClearCache'),
      confirmVariant: 'destructive',
      isOpen: true,
      message: t('settings.data.modals.cacheMessage'),
      onConfirm: executeClearCache,
      title: t('settings.data.modals.confirmCacheTitle'),
    });
  };

  const handleTestConnection = async () => {
    if (!aiConnectorAddress) {
      return;
    }
    setTestStatus({ testing: true, message: t('settings.processing.ai.connector.testing'), success: null });
    try {
      await invoke(Invokes.TestAIConnectorConnection, { address: aiConnectorAddress });
      setTestStatus({ testing: false, message: t('settings.processing.ai.connector.success'), success: true });
    } catch (err) {
      setTestStatus({ testing: false, message: t('settings.processing.ai.connector.failed'), success: false });
      console.error('AI Connector connection test failed:', err);
    } finally {
      setTimeout(() => setTestStatus({ testing: false, message: '', success: null }), EXECUTE_TIMEOUT);
    }
  };

  const closeConfirmModal = () => {
    setConfirmModalState({ ...confirmModalState, isOpen: false });
  };

  const handleAddShortcut = () => {
    const parsedTags = newShortcut
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);

    if (parsedTags.length > 0) {
      const uniqueShortcuts = Array.from(new Set([...taggingShortcuts, ...parsedTags])).sort();
      onSettingsChange({ ...appSettings, taggingShortcuts: uniqueShortcuts });
    }
    setNewShortcut('');
  };

  const handleRemoveShortcut = (shortcutToRemove: string) => {
    const uniqueShortcuts = taggingShortcuts.filter((s) => s !== shortcutToRemove);
    onSettingsChange({ ...appSettings, taggingShortcuts: uniqueShortcuts });
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddShortcut();
    }
  };

  const handleAddAiTag = () => {
    const parsedTags = newAiTag
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);

    if (parsedTags.length > 0) {
      const uniqueTags = Array.from(new Set([...customAiTags, ...parsedTags])).sort();
      onSettingsChange({ ...appSettings, customAiTags: uniqueTags });
    }
    setNewAiTag('');
  };

  const handleRemoveAiTag = (tagToRemove: string) => {
    const uniqueTags = customAiTags.filter((t) => t !== tagToRemove);
    onSettingsChange({ ...appSettings, customAiTags: uniqueTags });
  };

  const handleAiTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddAiTag();
    }
  };

  const handleKeybindSave = (action: string, combo: string[]) => {
    const newKeybinds = { ...(appSettings?.keybinds || {}), [action]: combo };
    onSettingsChange({ ...appSettings, keybinds: newKeybinds });
  };

  const conflictingKeys = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const userKb = appSettings?.keybinds || {};
    for (const def of KEYBIND_DEFINITIONS) {
      const userCombo = userKb[def.action];
      const effective = userCombo?.length ? userCombo : userCombo === undefined ? def.defaultCombo : null;
      if (!effective) continue;
      const key = effective.join('+');
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(def.action);
    }
    const keys = new Set<string>();
    for (const [, actions] of map) {
      if (actions.size > 1) actions.forEach((k) => keys.add(k));
    }
    return keys;
  }, [appSettings?.keybinds]);

  return (
    <>
      <ConfirmModal {...confirmModalState} onClose={closeConfirmModal} />
      <div className="flex flex-col h-full w-full text-text-primary">
        <header className="shrink-0 flex flex-wrap items-center justify-between gap-y-4 mb-8 pt-4">
          <div className="flex items-center shrink-0">
            <Button
              className="mr-4 hover:bg-surface text-text-primary rounded-full"
              onClick={onBack}
              size="icon"
              variant="ghost"
              data-tooltip={t('settings.tooltips.goHome')}
            >
              <ArrowLeft />
            </Button>
            <Text variant={TextVariants.display} color={TextColors.accent} className="whitespace-nowrap">
              {t('settings.title')}
            </Text>
          </div>

          <div className="relative flex w-full min-[1200px]:w-112.5 p-2 bg-surface rounded-md">
            {settingCategories.map((category) => (
              <button
                key={category.id}
                onClick={() => setActiveCategory(category.id)}
                className={clsx(
                  'relative flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                  {
                    'text-text-primary hover:bg-surface': activeCategory !== category.id,
                    'text-button-text': activeCategory === category.id,
                  },
                )}
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                {activeCategory === category.id && (
                  <motion.span
                    layoutId="settings-category-switch-bubble"
                    className="absolute inset-0 z-0 bg-accent"
                    style={{ borderRadius: 6 }}
                    transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
                  />
                )}
                <span className="relative z-10 flex items-center">
                  <category.icon size={16} className="mr-2 shrink-0" />
                  <span className="truncate">{category.label}</span>
                </span>
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto overflow-x-hidden pr-2 -mr-2 custom-scrollbar">
          <AnimatePresence mode="wait">
            {activeCategory === 'general' && (
              <motion.div
                key="general"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
                className="space-y-10"
              >
                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    {t('settings.general.title')}
                  </Text>
                  <div className="space-y-8">
                    <SettingItem label={t('settings.general.theme')} description={t('settings.general.themeDesc')}>
                      <Dropdown
                        onChange={(value: any) => onSettingsChange({ ...appSettings, theme: value })}
                        options={THEMES.map((theme: ThemeProps) => ({ value: theme.id, label: t(theme.name as any) }))}
                        value={appSettings?.theme || DEFAULT_THEME_ID}
                        triggerClassName="bg-bg-primary"
                      />
                    </SettingItem>

                    <SettingItem label={t('settings.language')} description={t('settings.languageDesc')}>
                      <Dropdown
                        onChange={(value: any) => onSettingsChange({ ...appSettings, language: value })}
                        options={[
                          { value: 'en', label: 'English' },
                          { value: 'de', label: 'Deutsch' },
                          { value: 'es', label: 'Español' },
                          { value: 'fr', label: 'Français' },
                          { value: 'it', label: 'Italiano' },
                          { value: 'ja', label: '日本語' },
                          { value: 'ko', label: '한국어' },
                          { value: 'pl', label: 'Polski' },
                          { value: 'pt', label: 'Português' },
                          { value: 'ru', label: 'Русский' },
                          { value: 'zh-CN', label: '简体中文' },
                          { value: 'zh-TW', label: '繁體中文' },
                        ]}
                        value={appSettings?.language || 'en'}
                        triggerClassName="bg-bg-primary"
                      />
                    </SettingItem>

                    <div className="space-y-4">
                      <SettingItem
                        label={t('settings.general.xmpSync')}
                        description={t('settings.general.xmpSyncDesc')}
                      >
                        <Switch
                          checked={appSettings?.enableXmpSync ?? true}
                          id="enable-xmp-sync-toggle"
                          label={t('settings.general.enableXmpSync')}
                          onChange={(checked) => {
                            const newSettings = { ...appSettings, enableXmpSync: checked };
                            if (!checked) {
                              newSettings.createXmpIfMissing = false;
                            }
                            onSettingsChange(newSettings);
                          }}
                        />
                      </SettingItem>

                      <AnimatePresence initial={false}>
                        {(appSettings?.enableXmpSync ?? true) && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.3, ease: 'easeInOut' }}
                            className="overflow-hidden"
                          >
                            <div className="pl-4 border-l-2 border-border-color ml-1">
                              <SettingItem
                                label={t('settings.general.createXmp')}
                                description={t('settings.general.createXmpDesc')}
                              >
                                <Switch
                                  checked={appSettings?.createXmpIfMissing ?? false}
                                  id="create-xmp-missing-toggle"
                                  label={t('settings.general.createXmpMissing')}
                                  onChange={(checked) =>
                                    onSettingsChange({ ...appSettings, createXmpIfMissing: checked })
                                  }
                                />
                              </SettingItem>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    <SettingItem
                      label={t('settings.general.folderImageCounts')}
                      description={t('settings.general.folderImageCountsDesc')}
                    >
                      <Switch
                        checked={appSettings?.enableFolderImageCounts ?? false}
                        id="folder-image-counts-toggle"
                        label={t('settings.general.showImageCounts')}
                        onChange={(checked) => onSettingsChange({ ...appSettings, enableFolderImageCounts: checked })}
                      />
                    </SettingItem>

                    <SettingItem
                      label={t('settings.general.displayEditIcon')}
                      description={t('settings.general.displayEditIconDesc')}
                    >
                      <Switch
                        checked={appSettings?.displayEditIcon ?? true}
                        id="display-edit-icon-toggle"
                        label={t('settings.general.displayEditIcon')}
                        onChange={(checked) => onSettingsChange({ ...appSettings, displayEditIcon: checked })}
                      />
                    </SettingItem>

                    <SettingItem
                      label={t('settings.general.focusMode')}
                      description={t('settings.general.focusModeDesc')}
                    >
                      <Switch
                        checked={appSettings?.enableFocusMode ?? false}
                        id="focus-mode-toggle"
                        label={t('settings.general.enableFocusMode')}
                        onChange={(checked) => onSettingsChange({ ...appSettings, enableFocusMode: checked })}
                      />
                    </SettingItem>

                    <SettingItem label={t('settings.general.font')} description={t('settings.general.fontDesc')}>
                      <Dropdown
                        onChange={(value: any) => onSettingsChange({ ...appSettings, fontFamily: value })}
                        options={fontOptions}
                        value={appSettings?.fontFamily || 'poppins'}
                        triggerClassName="bg-bg-primary"
                      />
                    </SettingItem>

                    {osPlatform === 'linux' && (
                      <SettingItem
                        label={t('settings.general.nativeTitlebar')}
                        description={t('settings.general.nativeTitlebarDesc')}
                      >
                        <Switch
                          checked={appSettings?.decorations ?? false}
                          id="native-titlebar-toggle"
                          label={t('settings.general.enableOsTitlebar')}
                          onChange={(checked) => {
                            onSettingsChange({ ...appSettings, decorations: checked });
                            getCurrentWindow().setDecorations(checked).catch(console.error);
                          }}
                        />
                      </SettingItem>
                    )}
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    {t('settings.adjustments.title')}
                  </Text>
                  <Text className="mb-4">{t('settings.adjustments.description')}</Text>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                    <Switch
                      label={t('settings.adjustments.chromaticAberration')}
                      checked={appSettings?.adjustmentVisibility?.chromaticAberration ?? false}
                      onChange={(checked) =>
                        onSettingsChange({
                          ...appSettings,
                          adjustmentVisibility: {
                            ...(appSettings?.adjustmentVisibility || adjustmentVisibilityDefaults),
                            chromaticAberration: checked,
                          },
                        })
                      }
                    />
                    <Switch
                      label={t('settings.adjustments.grain')}
                      checked={appSettings?.adjustmentVisibility?.grain ?? true}
                      onChange={(checked) =>
                        onSettingsChange({
                          ...appSettings,
                          adjustmentVisibility: {
                            ...(appSettings?.adjustmentVisibility || adjustmentVisibilityDefaults),
                            grain: checked,
                          },
                        })
                      }
                    />
                    <Switch
                      label={t('settings.adjustments.colorCalibration')}
                      checked={appSettings?.adjustmentVisibility?.colorCalibration ?? true}
                      onChange={(checked) =>
                        onSettingsChange({
                          ...appSettings,
                          adjustmentVisibility: {
                            ...(appSettings?.adjustmentVisibility || adjustmentVisibilityDefaults),
                            colorCalibration: checked,
                          },
                        })
                      }
                    />
                    <Switch
                      label={t('settings.adjustments.noiseReduction')}
                      checked={appSettings?.adjustmentVisibility?.noiseReduction ?? true}
                      onChange={(checked) =>
                        onSettingsChange({
                          ...appSettings,
                          adjustmentVisibility: {
                            ...(appSettings?.adjustmentVisibility || adjustmentVisibilityDefaults),
                            noiseReduction: checked,
                          },
                        })
                      }
                    />
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    {t('settings.lenses.title')}
                  </Text>
                  <Text className="mb-6">{t('settings.lenses.description')}</Text>

                  <div className="space-y-8">
                    <div className="bg-bg-primary rounded-lg p-4 border border-border-color">
                      <Text variant={TextVariants.heading} className="mb-3">
                        {t('settings.lenses.addNew')}
                      </Text>
                      <div className="space-y-4">
                        <Dropdown
                          options={lensMakers.map((m) => ({ label: m, value: m }))}
                          value={tempLensMaker}
                          onChange={handleTempMakerChange}
                          placeholder={t('settings.lenses.manufacturerPlaceholder')}
                        />
                        <Dropdown
                          options={lensModels.map((m) => ({ label: m, value: m }))}
                          value={tempLensModel}
                          onChange={setTempLensModel}
                          placeholder={t('settings.lenses.modelPlaceholder')}
                          disabled={!tempLensMaker}
                        />
                        <Button onClick={handleAddLens} disabled={!tempLensMaker || !tempLensModel} className="w-full">
                          <Plus size={16} className="mr-1" />
                          {t('settings.lenses.addButton')}
                        </Button>
                      </div>
                    </div>

                    <div>
                      <Text variant={TextVariants.heading} className="mb-2">
                        {t('settings.lenses.saved')}
                      </Text>
                      {(!appSettings?.myLenses || appSettings.myLenses.length === 0) && (
                        <Text className="italic">{t('settings.lenses.noLenses')}</Text>
                      )}
                      <div className="divide-y divide-border-color">
                        {(appSettings?.myLenses || []).map((lens: MyLens, index: number) => (
                          <div
                            key={`${lens.maker}-${lens.model}-${index}`}
                            className="flex justify-between items-center py-3 first:pt-0 last:pb-0"
                          >
                            <div className="flex items-center gap-3">
                              <div className="p-2 bg-surface rounded-md text-accent">
                                <Bookmark size={16} />
                              </div>
                              <div>
                                <Text color={TextColors.primary} weight={TextWeights.medium}>
                                  {lens.model}
                                </Text>
                                <Text variant={TextVariants.small}>{lens.maker}</Text>
                              </div>
                            </div>
                            <button
                              onClick={() => handleRemoveLens(index)}
                              className="p-2 text-text-secondary hover:text-red-400 hover:bg-bg-primary rounded-md transition-colors"
                              data-tooltip={t('settings.lenses.removeTooltip')}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    {t('settings.tagging.title')}
                  </Text>
                  <div className="space-y-8">
                    <div className="space-y-4">
                      <SettingItem
                        description={t('settings.tagging.aiTaggingDesc')}
                        label={t('settings.tagging.aiTagging')}
                      >
                        <Switch
                          checked={appSettings?.enableAiTagging ?? false}
                          id="ai-tagging-toggle"
                          label={t('settings.tagging.automaticAiTagging')}
                          onChange={(checked) => onSettingsChange({ ...appSettings, enableAiTagging: checked })}
                        />
                      </SettingItem>

                      <AnimatePresence>
                        {(appSettings?.enableAiTagging ?? false) && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.3, ease: 'easeInOut' }}
                            className="overflow-hidden"
                          >
                            <div className="pl-4 border-l-2 border-border-color ml-1 space-y-8">
                              <SettingItem
                                label={t('settings.tagging.maxAiTags')}
                                description={t('settings.tagging.maxAiTagsDesc')}
                              >
                                <Slider
                                  label={t('settings.tagging.amount')}
                                  min={1}
                                  max={20}
                                  step={1}
                                  value={appSettings?.aiTagCount ?? 10}
                                  defaultValue={10}
                                  onChange={(e: any) =>
                                    onSettingsChange({ ...appSettings, aiTagCount: parseInt(e.target.value) })
                                  }
                                />
                              </SettingItem>

                              <SettingItem
                                label={t('settings.tagging.customList')}
                                description={t('settings.tagging.customListDesc')}
                              >
                                <div>
                                  <div className="flex flex-wrap gap-2 p-2 bg-bg-primary rounded-md min-h-10 border border-border-color mb-2 items-center">
                                    <AnimatePresence>
                                      {customAiTags.length > 0 ? (
                                        customAiTags.map((tag: string) => (
                                          <motion.div
                                            key={tag}
                                            layout
                                            variants={shortcutTagVariants}
                                            initial={false}
                                            animate="visible"
                                            exit="exit"
                                            onClick={() => handleRemoveAiTag(tag)}
                                            data-tooltip={t('settings.tagging.removeCustomTooltip', { tag })}
                                            className="flex items-center gap-1 bg-surface px-2 py-1 rounded-sm group cursor-pointer"
                                          >
                                            <Text variant={TextVariants.label} color={TextColors.primary}>
                                              {tag}
                                            </Text>
                                            <span className="rounded-full group-hover:bg-black/20 p-0.5 transition-colors">
                                              <X size={14} />
                                            </span>
                                          </motion.div>
                                        ))
                                      ) : (
                                        <motion.span
                                          key="no-ai-tags-placeholder"
                                          initial={{ opacity: 0 }}
                                          animate={{ opacity: 1 }}
                                          exit={{ opacity: 0 }}
                                          transition={{ duration: 0.2 }}
                                        >
                                          <Text className="px-1 select-none italic">
                                            {t('settings.tagging.noCustomTags')}
                                          </Text>
                                        </motion.span>
                                      )}
                                    </AnimatePresence>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <div className="relative flex-1">
                                      <Input
                                        type="text"
                                        value={newAiTag}
                                        onChange={(e) => setNewAiTag(e.target.value)}
                                        onKeyDown={handleAiTagInputKeyDown}
                                        placeholder={t('settings.tagging.addCustomPlaceholder')}
                                        className="pr-10"
                                        bgClassName="bg-bg-primary"
                                      />
                                      <button
                                        onClick={handleAddAiTag}
                                        className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded-full text-text-secondary hover:text-text-primary hover:bg-surface"
                                        data-tooltip={t('settings.tagging.addCustomTooltip')}
                                      >
                                        <Plus size={18} />
                                      </button>
                                    </div>
                                    <button
                                      onClick={() => onSettingsChange({ ...appSettings, customAiTags: [] })}
                                      disabled={customAiTags.length === 0}
                                      className="p-2 text-text-secondary hover:text-red-400 hover:bg-surface rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-text-secondary disabled:hover:bg-transparent"
                                      data-tooltip={t('settings.tagging.clearCustomTooltip')}
                                    >
                                      <Trash2 size={18} />
                                    </button>
                                  </div>
                                </div>
                              </SettingItem>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    <SettingItem
                      label={t('settings.tagging.shortcuts')}
                      description={t('settings.tagging.shortcutsDesc')}
                    >
                      <div>
                        <div className="flex flex-wrap gap-2 p-2 bg-bg-primary rounded-md min-h-10 border border-border-color mb-2 items-center">
                          <AnimatePresence>
                            {taggingShortcuts.length > 0 ? (
                              taggingShortcuts.map((shortcut: string) => (
                                <motion.div
                                  key={shortcut}
                                  layout
                                  variants={shortcutTagVariants}
                                  initial={false}
                                  animate="visible"
                                  exit="exit"
                                  onClick={() => handleRemoveShortcut(shortcut)}
                                  data-tooltip={t('settings.tagging.removeShortcutTooltip', { shortcut })}
                                  className="flex items-center gap-1 bg-surface px-2 py-1 rounded-sm group cursor-pointer"
                                >
                                  <Text variant={TextVariants.label} color={TextColors.primary}>
                                    {shortcut}
                                  </Text>
                                  <span className="rounded-full group-hover:bg-black/20 p-0.5 transition-colors">
                                    <X size={14} />
                                  </span>
                                </motion.div>
                              ))
                            ) : (
                              <motion.span
                                key="no-shortcuts-placeholder"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.2 }}
                                className="text-sm text-text-secondary italic px-1 select-none"
                              >
                                {t('settings.tagging.noShortcuts')}
                              </motion.span>
                            )}
                          </AnimatePresence>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="relative flex-1">
                            <Input
                              type="text"
                              value={newShortcut}
                              onChange={(e) => setNewShortcut(e.target.value)}
                              onKeyDown={handleInputKeyDown}
                              placeholder={t('settings.tagging.addShortcutsPlaceholder')}
                              className="pr-10"
                              bgClassName="bg-bg-primary"
                            />
                            <button
                              onClick={handleAddShortcut}
                              className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded-full text-text-secondary hover:text-text-primary hover:bg-surface"
                              data-tooltip={t('settings.tagging.addShortcutTooltip')}
                            >
                              <Plus size={18} />
                            </button>
                          </div>
                          <button
                            onClick={() => onSettingsChange({ ...appSettings, taggingShortcuts: [] })}
                            disabled={taggingShortcuts.length === 0}
                            className="p-2 text-text-secondary hover:text-red-400 hover:bg-surface rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-text-secondary disabled:hover:bg-transparent"
                            data-tooltip={t('settings.tagging.clearShortcutsTooltip')}
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </div>
                    </SettingItem>

                    <div className="pt-8 border-t border-border-color">
                      <div className="space-y-8">
                        <DataActionItem
                          buttonAction={handleClearAiTags}
                          buttonText={t('settings.tagging.clearAiTagsButton')}
                          description={t('settings.tagging.clearAiTagsDesc')}
                          disabled={effectiveRootPaths.length === 0}
                          icon={<Trash2 size={16} className="mr-2" />}
                          isProcessing={isClearingAiTags}
                          message={aiTagsClearMessage}
                          title={t('settings.tagging.clearAiTagsTitle')}
                        />
                        <DataActionItem
                          buttonAction={handleClearTags}
                          buttonText={t('settings.tagging.clearAiTagsButton')}
                          description={t('settings.tagging.clearAllTagsDesc')}
                          disabled={effectiveRootPaths.length === 0}
                          icon={<Trash2 size={16} className="mr-2" />}
                          isProcessing={isClearingTags}
                          message={tagsClearMessage}
                          title={t('settings.tagging.clearAllTagsTitle')}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-6">
                    {t('settings.thanks.title')}
                  </Text>
                  <Text className="mb-4">{t('settings.thanks.description')}</Text>
                  <Text as="ul" className="space-y-3 list-disc ml-5 pl-1">
                    <li>
                      <a
                        href="https://github.com/dnglab/dnglab/tree/main/rawler"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-accent hover:underline"
                      >
                        rawler
                      </a>
                      : {t('settings.thanks.list.rawler')}
                    </li>
                    <li>
                      <a
                        href="https://lensfun.github.io/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-accent hover:underline"
                      >
                        lensfun
                      </a>
                      : {t('settings.thanks.list.lensfun')}
                    </li>
                    <li>
                      <a
                        href="https://github.com/marcinz606/NegPy"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-accent hover:underline"
                      >
                        NegPy
                      </a>
                      : {t('settings.thanks.list.negpy')}
                    </li>
                    <li>
                      <a
                        href="https://github.com/advimman/lama"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-accent hover:underline"
                      >
                        LaMa
                      </a>
                      : {t('settings.thanks.list.lama')}
                    </li>
                    <li>
                      <a
                        href="https://github.com/facebookresearch/sam2"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-accent hover:underline"
                      >
                        SAM 2
                      </a>
                      : {t('settings.thanks.list.sam2')}
                    </li>
                    <li>
                      <a
                        href="https://github.com/xuebinqin/U-2-Net"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-accent hover:underline"
                      >
                        U-2-Net
                      </a>
                      : {t('settings.thanks.list.u2net')}
                    </li>
                    <li>
                      <a
                        href="https://github.com/DepthAnything/Depth-Anything-V2"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-accent hover:underline"
                      >
                        Depth Anything V2
                      </a>
                      : {t('settings.thanks.list.depth')}
                    </li>
                    <li>
                      <a
                        href="https://github.com/trougnouf/nind-denoise"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-accent hover:underline"
                      >
                        nind-denoise
                      </a>
                      : {t('settings.thanks.list.nind')}
                    </li>
                    <li>
                      <a
                        href="https://github.com/darktable-org/darktable"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-accent hover:underline"
                      >
                        darktable & co.
                      </a>
                      : {t('settings.thanks.list.darktable')}
                    </li>
                    <li>
                      <span className="font-semibold text-accent">{t('settings.thanks.list.youLabel')}</span>:{' '}
                      {t('settings.thanks.list.you')}
                    </li>
                  </Text>
                </div>
              </motion.div>
            )}
            {activeCategory === 'processing' && (
              <motion.div
                key="processing"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
                className="space-y-10"
              >
                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    {t('settings.processing.title')}
                  </Text>
                  <div className="space-y-8">
                    <div>
                      <Text variant={TextVariants.heading} className="mb-2">
                        {t('settings.processing.previewStrategy')}
                      </Text>
                      <PreviewModeSwitch
                        mode={appSettings?.enableZoomHifi ? 'dynamic' : 'static'}
                        onModeChange={handlePreviewModeChange}
                      />

                      <div className="mt-3">
                        <AnimatePresence mode="wait">
                          {!(appSettings?.enableZoomHifi ?? true) ? (
                            <motion.div
                              key="static-preview"
                              initial={{ opacity: 0, x: 10 }}
                              animate={{ opacity: 1, x: 0 }}
                              exit={{ opacity: 0, x: -10 }}
                              transition={{ duration: 0.2 }}
                            >
                              <Text variant={TextVariants.small} className="mb-4">
                                {t('settings.processing.staticDesc')}
                              </Text>
                              <div className="pl-4 border-l-2 border-border-color ml-1">
                                <SettingItem
                                  description={t('settings.processing.previewResDesc')}
                                  label={t('settings.processing.previewRes')}
                                >
                                  <Dropdown
                                    onChange={(value: any) =>
                                      handleProcessingSettingChange('editorPreviewResolution', value)
                                    }
                                    options={resolutions}
                                    value={processingSettings.editorPreviewResolution}
                                    triggerClassName="bg-bg-primary"
                                  />
                                </SettingItem>
                              </div>
                            </motion.div>
                          ) : (
                            <motion.div
                              key="dynamic-preview"
                              initial={{ opacity: 0, x: 10 }}
                              animate={{ opacity: 1, x: 0 }}
                              exit={{ opacity: 0, x: -10 }}
                              transition={{ duration: 0.2 }}
                            >
                              <Text variant={TextVariants.small} className="mb-4">
                                {t('settings.processing.dynamicDesc')}
                              </Text>
                              <div className="pl-4 border-l-2 border-border-color ml-1 space-y-3">
                                <SettingItem
                                  description={t('settings.processing.staticPreviewResDesc')}
                                  label={t('settings.processing.staticPreviewRes')}
                                >
                                  <Dropdown
                                    onChange={(value: any) =>
                                      handleProcessingSettingChange('editorPreviewResolution', value)
                                    }
                                    options={resolutions}
                                    value={processingSettings.editorPreviewResolution}
                                    triggerClassName="bg-bg-primary"
                                  />
                                </SettingItem>

                                <SettingItem
                                  label={t('settings.processing.renderScale')}
                                  description={t('settings.processing.renderScaleDesc')}
                                >
                                  <Dropdown
                                    onChange={(value: any) =>
                                      handleProcessingSettingChange('highResZoomMultiplier', value)
                                    }
                                    options={zoomMultiplierOptions}
                                    value={processingSettings.highResZoomMultiplier}
                                    triggerClassName="bg-bg-primary"
                                  />
                                </SettingItem>

                                <SettingItem
                                  label={t('settings.processing.highDpi')}
                                  description={
                                    dpr > 1
                                      ? t('settings.processing.highDpiDesc', { dpr })
                                      : t('settings.processing.highDpiDescStandard')
                                  }
                                >
                                  <Switch
                                    checked={processingSettings.useFullDpiRendering}
                                    disabled={dpr <= 1}
                                    id="full-dpi-rendering-toggle"
                                    label={t('settings.processing.nativeDpi')}
                                    onChange={(checked) =>
                                      handleProcessingSettingChange('useFullDpiRendering', checked)
                                    }
                                  />
                                </SettingItem>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>

                    <div className="space-y-4">
                      <SettingItem
                        label={t('settings.processing.livePreviews')}
                        description={t('settings.processing.livePreviewsDesc')}
                      >
                        <Switch
                          checked={appSettings?.enableLivePreviews ?? true}
                          id="live-previews-toggle"
                          label={t('settings.processing.enableLivePreviews')}
                          onChange={(checked) => {
                            setHasInteractedWithLivePreview(true);
                            onSettingsChange({ ...appSettings, enableLivePreviews: checked });
                          }}
                        />
                      </SettingItem>

                      <AnimatePresence>
                        {(appSettings?.enableLivePreviews ?? true) && (
                          <motion.div
                            initial={hasInteractedWithLivePreview ? { height: 0, opacity: 0 } : false}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.3, ease: 'easeInOut' }}
                          >
                            <div className="pl-4 border-l-2 border-border-color ml-1">
                              <SettingItem
                                label={t('settings.processing.livePreviewQuality')}
                                description={t('settings.processing.livePreviewQualityDesc')}
                              >
                                <Dropdown
                                  onChange={(value: any) =>
                                    onSettingsChange({ ...appSettings, livePreviewQuality: value })
                                  }
                                  options={livePreviewQualityOptions}
                                  value={appSettings?.livePreviewQuality || 'high'}
                                  triggerClassName="bg-bg-primary"
                                />
                              </SettingItem>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    <SettingItem
                      description={t('settings.processing.thumbnailResDesc')}
                      label={t('settings.processing.thumbnailRes')}
                    >
                      <Dropdown
                        onChange={(value: any) => handleProcessingSettingChange('thumbnailResolution', value)}
                        options={thumbnailResolutions}
                        value={processingSettings.thumbnailResolution}
                        triggerClassName="bg-bg-primary"
                      />
                    </SettingItem>

                    <SettingItem
                      label={t('settings.processing.workerThreads')}
                      description={t('settings.processing.workerThreadsDesc')}
                    >
                      <Slider
                        label={t('settings.processing.threads')}
                        min={2}
                        max={10}
                        step={1}
                        value={processingSettings.thumbnailWorkerThreads}
                        defaultValue={4}
                        onChange={(e: any) =>
                          handleProcessingSettingChange('thumbnailWorkerThreads', parseInt(e.target.value))
                        }
                        fillOrigin="min"
                      />
                    </SettingItem>

                    <SettingItem
                      label={t('settings.processing.imageCache')}
                      description={t('settings.processing.imageCacheDesc')}
                    >
                      <Slider
                        label={t('settings.processing.images')}
                        min={2}
                        max={10}
                        step={1}
                        value={processingSettings.imageCacheSize}
                        defaultValue={5}
                        onChange={(e: any) => handleProcessingSettingChange('imageCacheSize', parseInt(e.target.value))}
                        fillOrigin="min"
                      />
                    </SettingItem>

                    <SettingItem
                      label={t('settings.processing.wgpu')}
                      description={
                        osPlatform === 'linux'
                          ? t('settings.processing.wgpuDescLinux')
                          : osPlatform === 'android'
                            ? t('settings.processing.wgpuDescAndroid')
                            : t('settings.processing.wgpuDescRecommended')
                      }
                    >
                      <Switch
                        checked={processingSettings.useWgpuRenderer}
                        disabled={osPlatform === 'linux' || osPlatform === 'android'}
                        id="wgpu-renderer-toggle"
                        label={t('settings.processing.wgpuLabel')}
                        onChange={(checked) => handleProcessingSettingChange('useWgpuRenderer', checked)}
                      />
                    </SettingItem>

                    <SettingItem
                      label={t('settings.processing.backend')}
                      description={t('settings.processing.backendDesc')}
                    >
                      <Dropdown
                        onChange={(value: any) => handleProcessingSettingChange('processingBackend', value)}
                        options={filteredBackendOptions}
                        value={
                          filteredBackendOptions.some((option) => option.value === processingSettings.processingBackend)
                            ? processingSettings.processingBackend
                            : 'auto'
                        }
                        triggerClassName="bg-bg-primary"
                      />
                    </SettingItem>

                    {osPlatform !== 'macos' && osPlatform !== 'windows' && (
                      <SettingItem
                        label={t('settings.processing.linuxCompat')}
                        description={t('settings.processing.linuxCompatDesc')}
                      >
                        <Switch
                          checked={processingSettings.linuxGpuOptimization}
                          id="gpu-compat-toggle"
                          label={t('settings.processing.linuxCompatLabel')}
                          onChange={(checked) => handleProcessingSettingChange('linuxGpuOptimization', checked)}
                        />
                      </SettingItem>
                    )}

                    {restartRequired && (
                      <>
                        <Text
                          as="div"
                          color={TextColors.info}
                          className="p-3 bg-blue-900/10 border border-blue-500/50 rounded-lg flex items-center gap-3"
                        >
                          <Info size={18} />
                          <p>{t('settings.processing.restartRequired')}</p>
                        </Text>
                        <div className="flex justify-end">
                          <Button onClick={handleSaveAndRelaunch}>{t('settings.processing.saveRelaunch')}</Button>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    {t('settings.processing.preprocessing.title')}
                  </Text>
                  <div className="space-y-8">
                    <SettingItem
                      label={t('settings.processing.preprocessing.highlightRecovery')}
                      description={t('settings.processing.preprocessing.highlightRecoveryDesc')}
                    >
                      <Slider
                        label={t('settings.tagging.amount')}
                        min={1}
                        max={10}
                        step={0.1}
                        value={processingSettings.rawHighlightCompression}
                        defaultValue={2.5}
                        onChange={(e: any) =>
                          handleProcessingSettingChange('rawHighlightCompression', parseFloat(e.target.value))
                        }
                        fillOrigin="min"
                      />
                    </SettingItem>

                    <SettingItem
                      label={t('settings.processing.preprocessing.colorNr')}
                      description={t('settings.processing.preprocessing.colorNrDesc')}
                    >
                      <Slider
                        label={t('settings.tagging.amount')}
                        min={0}
                        max={1.0}
                        step={0.05}
                        value={processingSettings.rawPreprocessingColorNr}
                        defaultValue={0.5}
                        onChange={(e: any) =>
                          handleProcessingSettingChange('rawPreprocessingColorNr', parseFloat(e.target.value))
                        }
                        fillOrigin="min"
                      />
                    </SettingItem>

                    <SettingItem
                      label={t('settings.processing.preprocessing.sharpening')}
                      description={t('settings.processing.preprocessing.sharpeningDesc')}
                    >
                      <Slider
                        label={t('settings.tagging.amount')}
                        min={0}
                        max={1.0}
                        step={0.05}
                        value={processingSettings.rawPreprocessingSharpening}
                        defaultValue={0.35}
                        onChange={(e: any) =>
                          handleProcessingSettingChange('rawPreprocessingSharpening', parseFloat(e.target.value))
                        }
                        fillOrigin="min"
                      />
                    </SettingItem>

                    <SettingItem
                      label={t('settings.processing.preprocessing.applyPreprocessing')}
                      description={t('settings.processing.preprocessing.applyPreprocessingDesc')}
                    >
                      <Switch
                        checked={processingSettings.applyPreprocessingToNonRaws}
                        id="preprocessing-non-raws-toggle"
                        label={t('settings.processing.preprocessing.enablePreprocessingNonRaws')}
                        onChange={(checked) => handleProcessingSettingChange('applyPreprocessingToNonRaws', checked)}
                      />
                    </SettingItem>

                    <SettingItem
                      label={t('settings.processing.preprocessing.linearRaw')}
                      description={t('settings.processing.preprocessing.linearRawDesc')}
                    >
                      <Dropdown
                        onChange={(value: any) => onSettingsChange({ ...appSettings, linearRawMode: value })}
                        options={linearRawOptions}
                        value={appSettings?.linearRawMode || 'auto'}
                        triggerClassName="bg-bg-primary"
                      />
                    </SettingItem>

                    <div className="space-y-4">
                      <SettingItem
                        label={t('settings.processing.preprocessing.tonemapperOverride')}
                        description={t('settings.processing.preprocessing.tonemapperOverrideDesc')}
                      >
                        <Switch
                          checked={appSettings?.tonemapperOverrideEnabled ?? false}
                          id="tonemapper-override-toggle"
                          label={t('settings.processing.preprocessing.enableTonemapperOverride')}
                          onChange={(checked) =>
                            onSettingsChange({ ...appSettings, tonemapperOverrideEnabled: checked })
                          }
                        />
                      </SettingItem>

                      <AnimatePresence>
                        {(appSettings?.tonemapperOverrideEnabled ?? false) && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.3, ease: 'easeInOut' }}
                          >
                            <div className="pl-4 border-l-2 border-border-color ml-1 space-y-3">
                              <SettingItem
                                label={t('settings.processing.preprocessing.defaultRawTonemapper')}
                                description={t('settings.processing.preprocessing.defaultRawTonemapperDesc')}
                              >
                                <Dropdown
                                  onChange={(value: any) =>
                                    onSettingsChange({ ...appSettings, defaultRawTonemapper: value })
                                  }
                                  options={tonemapperOptions}
                                  value={appSettings?.defaultRawTonemapper || 'agx'}
                                  triggerClassName="bg-bg-primary"
                                />
                              </SettingItem>

                              <SettingItem
                                label={t('settings.processing.preprocessing.defaultNonRawTonemapper')}
                                description={t('settings.processing.preprocessing.defaultNonRawTonemapperDesc')}
                              >
                                <Dropdown
                                  onChange={(value: any) =>
                                    onSettingsChange({ ...appSettings, defaultNonRawTonemapper: value })
                                  }
                                  options={tonemapperOptions}
                                  value={appSettings?.defaultNonRawTonemapper || 'basic'}
                                  triggerClassName="bg-bg-primary"
                                />
                              </SettingItem>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    {t('settings.processing.ai.title')}
                  </Text>
                  <Text className="mb-4">{t('settings.processing.ai.description')}</Text>

                  <AiProviderSwitch selectedProvider={aiProvider} onProviderChange={handleProviderChange} />

                  <div className="mt-8">
                    <AnimatePresence mode="wait">
                      {aiProvider === 'cpu' && (
                        <motion.div
                          key="cpu"
                          initial={{ opacity: 0, x: 10 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -10 }}
                          transition={{ duration: 0.2 }}
                        >
                          <Text variant={TextVariants.heading}>{t('settings.processing.ai.cpu.title')}</Text>
                          <Text className="mt-1">{t('settings.processing.ai.cpu.description')}</Text>
                          <Text as="ul" className="mt-3 space-y-1 list-disc list-inside">
                            <li>{t('settings.processing.ai.cpu.feature1')}</li>
                            <li>{t('settings.processing.ai.cpu.feature2')}</li>
                            <li>{t('settings.processing.ai.cpu.feature3')}</li>
                          </Text>
                        </motion.div>
                      )}

                      {aiProvider === 'ai-connector' && (
                        <motion.div
                          key="ai-connector"
                          initial={{ opacity: 0, x: 10 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -10 }}
                          transition={{ duration: 0.2 }}
                        >
                          <div className="space-y-8">
                            <div>
                              <Text variant={TextVariants.heading}>{t('settings.processing.ai.connector.title')}</Text>
                              <Text className="mt-1">{t('settings.processing.ai.connector.description')}</Text>
                              <Text as="ul" className="mt-3 space-y-1 list-disc list-inside">
                                <li>{t('settings.processing.ai.connector.feature1')}</li>
                                <li>{t('settings.processing.ai.connector.feature2')}</li>
                                <li>{t('settings.processing.ai.connector.feature3')}</li>
                              </Text>
                            </div>
                            <SettingItem
                              label={t('settings.processing.ai.connector.address')}
                              description={t('settings.processing.ai.connector.addressDesc')}
                            >
                              <div className="flex items-center gap-2">
                                <Input
                                  className="grow"
                                  id="ai-connector-address"
                                  onBlur={() =>
                                    onSettingsChange({ ...appSettings, aiConnectorAddress: aiConnectorAddress })
                                  }
                                  onChange={(e: any) => setAiConnectorAddress(e.target.value)}
                                  onKeyDown={(e: any) => e.stopPropagation()}
                                  placeholder="127.0.0.1:8188"
                                  type="text"
                                  value={aiConnectorAddress}
                                  bgClassName="bg-bg-primary"
                                />
                                <Button
                                  className="w-32"
                                  disabled={testStatus.testing || !aiConnectorAddress}
                                  onClick={handleTestConnection}
                                >
                                  {testStatus.testing
                                    ? t('settings.processing.ai.connector.testing')
                                    : t('settings.processing.ai.connector.test')}
                                </Button>
                              </div>
                              {testStatus.message && (
                                <Text
                                  color={testStatus.success ? TextColors.success : TextColors.error}
                                  className="mt-2 flex items-center gap-2"
                                >
                                  {testStatus.success === true && <Wifi size={16} />}
                                  {testStatus.success === false && <WifiOff size={16} />}
                                  {testStatus.message}
                                </Text>
                              )}
                            </SettingItem>
                          </div>
                        </motion.div>
                      )}

                      {aiProvider === 'cloud' && (
                        <motion.div
                          key="cloud"
                          initial={{ opacity: 0, x: 10 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -10 }}
                          transition={{ duration: 0.2 }}
                        >
                          <Text variant={TextVariants.heading}>{t('settings.processing.ai.cloud.title')}</Text>
                          <Text className="mt-1">{t('settings.processing.ai.cloud.description')}</Text>
                          <Text as="ul" className="mt-3 space-y-1 list-disc list-inside">
                            <li>{t('settings.processing.ai.cloud.feature1')}</li>
                            <li>{t('settings.processing.ai.cloud.feature2')}</li>
                            <li>{t('settings.processing.ai.cloud.feature3')}</li>
                          </Text>

                          <div className="mt-8">
                            <Show when="signed-in">
                              <div className="p-6 bg-bg-primary rounded-xl border border-border-color shadow-inner">
                                <CloudDashboard />
                              </div>
                            </Show>
                            <Show when="signed-out">
                              <div className="w-full max-w-md">
                                <SignIn
                                  routing="hash"
                                  fallbackRedirectUrl="/"
                                  forceRedirectUrl="/"
                                  appearance={{
                                    variables: {
                                      colorBackground: 'transparent',
                                      colorInput: 'transparent',
                                      colorForeground: 'inherit',
                                      colorInputForeground: 'inherit',
                                      colorPrimaryForeground: 'inherit',
                                      colorBorder: 'transparent',
                                      colorShadow: 'none',
                                      colorNeutral: 'inherit',
                                    },
                                    elements: {
                                      rootBox: '',

                                      cardBox: '!shadow-none !m-0 !p-0 !rounded-none',

                                      card: '!bg-transparent !border-none !shadow-none !py-0 !px-1 !rounded-none',

                                      header: '!hidden',

                                      formFieldLabel: '!text-base !font-semibold !text-text-primary !block !mb-2',

                                      formFieldAction:
                                        '!text-text-secondary hover:!text-text-primary !transition-colors !no-underline hover:!underline',

                                      formFieldInput:
                                        '!bg-bg-primary !border !border-border-color !text-text-primary focus:!border-accent focus:!ring-1 focus:!ring-accent !rounded-md !px-3 !py-2',

                                      formButtonPrimary:
                                        '!bg-accent !text-button-text hover:!bg-accent/90 !shadow-none !transition-colors !rounded-md !mt-4 !py-2',

                                      footer:
                                        '!bg-transparent !p-0 !mt-4 opacity-50 hover:opacity-100 transition-opacity',
                                      footerAction: '!hidden',

                                      identityPreview: '!bg-bg-primary !border !border-border-color !rounded-md !mb-4',
                                      identityPreviewText: '!text-text-primary !font-medium',
                                      identityPreviewEditButtonIcon:
                                        '!text-text-secondary hover:!text-text-primary !transition-colors',
                                    },
                                  }}
                                />
                                <div className="mt-6">
                                  <Text variant={TextVariants.small}>
                                    {t('settings.processing.ai.cloud.signedOut.noAccount')}{' '}
                                    <button
                                      onClick={() => open('https://www.getrapidraw.com/dashboard')}
                                      className="text-accent hover:underline focus:outline-none"
                                    >
                                      {t('settings.processing.ai.cloud.signedOut.signup')}
                                    </button>
                                  </Text>
                                </div>
                              </div>
                            </Show>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    {t('settings.data.title')}
                  </Text>
                  <div className="space-y-8">
                    <DataActionItem
                      buttonAction={handleClearSidecars}
                      buttonText={t('settings.data.clearSidecarsButton')}
                      description={
                        <Text as="span" variant={TextVariants.small}>
                          {t('settings.data.clearSidecarsDesc')}{' '}
                          <code className="bg-bg-primary px-1 rounded-sm text-text-primary">.rrdata</code> files
                          (containing your edits) within your root folders:
                          <span className="block font-mono bg-bg-primary p-2 rounded-sm mt-2 break-all border border-border-color whitespace-pre-wrap">
                            {effectiveRootPaths.length > 0
                              ? effectiveRootPaths.join('\n')
                              : t('settings.data.noFolders')}
                          </span>
                        </Text>
                      }
                      disabled={effectiveRootPaths.length === 0}
                      icon={<Trash2 size={16} className="mr-2" />}
                      isProcessing={isClearing}
                      message={clearMessage}
                      title={t('settings.data.clearSidecars')}
                    />

                    <DataActionItem
                      buttonAction={handleClearCache}
                      buttonText={t('settings.data.clearThumbnailButton')}
                      description={t('settings.data.clearThumbnailDesc')}
                      icon={<Trash2 size={16} className="mr-2" />}
                      isProcessing={isClearingCache}
                      message={cacheClearMessage}
                      title={t('settings.data.clearThumbnail')}
                    />

                    <DataActionItem
                      buttonAction={async () => {
                        if (logPath && !logPathLoading && !logPathError) {
                          await invoke(Invokes.ShowInFinder, { path: logPath });
                        }
                      }}
                      buttonText={t('settings.data.logsButton')}
                      description={
                        <Text as="span" variant={TextVariants.small}>
                          {t('settings.data.logsDesc')}
                          <span className="block font-mono bg-bg-primary p-2 rounded-sm mt-2 break-all border border-border-color">
                            {logPathLoading
                              ? t('settings.data.loading')
                              : logPathError
                                ? t('settings.data.statuses.failedToGetPath')
                                : logPath}
                          </span>
                        </Text>
                      }
                      disabled={logPathLoading || logPathError || !logPath}
                      icon={<ExternalLinkIcon size={16} className="mr-2" />}
                      isProcessing={false}
                      message=""
                      title={t('settings.data.logs')}
                    />
                  </div>
                </div>
              </motion.div>
            )}

            {activeCategory === 'shortcuts' && (
              <motion.div
                key="shortcuts"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
                className="space-y-10"
              >
                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    {t('settings.controls.title')}
                  </Text>
                  <div className="space-y-8">
                    <div>
                      <Text variant={TextVariants.heading} className="mb-2">
                        {t('settings.controls.optimization')}
                      </Text>
                      <Text variant={TextVariants.small} className="mb-4">
                        {t('settings.controls.optimizationDesc')}
                      </Text>
                      <CanvasInputModeSwitch
                        mode={(appSettings?.canvasInputMode as 'mouse' | 'trackpad') || 'mouse'}
                        onModeChange={(value) => onSettingsChange({ ...appSettings, canvasInputMode: value })}
                      />
                    </div>

                    <SettingItem label={t('settings.controls.zoom')} description={t('settings.controls.zoomDesc')}>
                      <Slider
                        label={t('settings.controls.speed')}
                        min={0.1}
                        max={3.0}
                        step={0.1}
                        value={appSettings?.zoomSpeedMultiplier ?? 1.0}
                        defaultValue={1.0}
                        onChange={(e: any) =>
                          onSettingsChange({ ...appSettings, zoomSpeedMultiplier: parseFloat(e.target.value) })
                        }
                        fillOrigin="min"
                      />
                    </SettingItem>
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    {t('settings.controls.keyboardTitle')}
                  </Text>
                  <div className="space-y-8">
                    {' '}
                    {KEYBIND_SECTIONS.map((section) => {
                      const sectionDefs = KEYBIND_DEFINITIONS.filter((d) => d.section === section.id);
                      const userKb = appSettings?.keybinds || {};
                      return (
                        <div key={section.id}>
                          <Text variant={TextVariants.heading}>{t(section.label as any)}</Text>
                          <div className="divide-y divide-border-color">
                            {sectionDefs.map((def) => (
                              <KeybindRow
                                key={def.action}
                                def={def}
                                currentCombo={userKb[def.action]}
                                osPlatform={osPlatform}
                                onSave={handleKeybindSave}
                                recordingAction={recordingAction}
                                onStartRecording={setRecordingAction}
                                isConflicting={conflictingKeys.has(def.action)}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    <div className="flex justify-end mt-6">
                      <Button variant="ghost" onClick={() => onSettingsChange({ ...appSettings, keybinds: {} })}>
                        {t('settings.controls.resetDefaults')}
                      </Button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </>
  );
}
