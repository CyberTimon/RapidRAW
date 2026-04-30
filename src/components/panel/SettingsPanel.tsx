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
import { relaunch } from '@tauri-apps/plugin-process';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { useUser } from '@clerk/react';
import Button from '../ui/Button';
import ConfirmModal from '../modals/ConfirmModal';
import Dropdown, { OptionItem } from '../ui/Dropdown';
import Switch from '../ui/Switch';
import Input from '../ui/Input';
import Slider from '../ui/Slider';
import { ThemeProps, THEMES, DEFAULT_THEME_ID } from '../../utils/themes';
import { Invokes } from '../ui/AppProperties';
import {
  arraysEqual,
  codeToDisplayLabel,
  formatKeyCode,
  KeybindDefinition,
  KEYBIND_DEFINITIONS,
  KEYBIND_SECTIONS,
  normalizeCombo,
} from '../../utils/keyboardUtils';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import { useOsPlatform } from '../../hooks/useOsPlatform';

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
  rootPath: string | null;
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

const livePreviewQualityOptions: OptionItem<string>[] = [
  { value: 'full', label: 'Full Resolution' },
  { value: 'high', label: 'High Quality' },
  { value: 'performance', label: 'Performance' },
];

const backendOptions: OptionItem<string>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'vulkan', label: 'Vulkan' },
  { value: 'dx12', label: 'DirectX 12' },
  { value: 'metal', label: 'Metal' },
  { value: 'gl', label: 'OpenGL' },
];

const linearRawOptions: OptionItem<string>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'gamma', label: 'Apply Gamma' },
  { value: 'skip_calib', label: 'Skip Calibrate' },
  { value: 'gamma_skip_calib', label: 'Apply Gamma & Skip Calibrate' },
];

const tonemapperOptions: OptionItem<string>[] = [
  { value: 'agx', label: 'AgX' },
  { value: 'basic', label: 'Basic' },
];

const settingCategories = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'processing', label: 'Processing', icon: Cpu },
  { id: 'shortcuts', label: 'Controls', icon: Keyboard },
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
      <Text variant={TextVariants.label}>{def.description}</Text>
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
              Press a key... (Esc to clear)
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
                <span className="text-text-secondary italic">Not assigned</span>
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
}: DataActionItemProps) => (
  <div className="pb-8 border-b border-border-color last:border-b-0 last:pb-0">
    <Text variant={TextVariants.heading} className="mb-2">
      {title}
    </Text>
    <Text variant={TextVariants.small} className="mb-3">
      {description}
    </Text>
    <Button variant="destructive" onClick={buttonAction} disabled={isProcessing || disabled}>
      {icon}
      {isProcessing ? 'Processing...' : buttonText}
    </Button>
    {message && (
      <Text color={TextColors.accent} className="mt-3">
        {message}
      </Text>
    )}
  </div>
);

const aiProviders = [
  { id: 'cpu', label: 'CPU', icon: Cpu },
  { id: 'ai-connector', label: 'AI Connector', icon: Server },
  { id: 'cloud', label: 'Cloud', icon: Cloud },
];

interface AiProviderSwitchProps {
  selectedProvider: string;
  onProviderChange: (provider: string) => void;
}

const AiProviderSwitch = ({ selectedProvider, onProviderChange }: AiProviderSwitchProps) => {
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

const canvasInputModes = [
  { id: 'mouse', label: 'Mouse', icon: Mouse },
  { id: 'trackpad', label: 'Touchpad', icon: Touchpad },
];

interface CanvasInputModeSwitchProps {
  mode: 'mouse' | 'trackpad';
  onModeChange: (mode: 'mouse' | 'trackpad') => void;
}

const CanvasInputModeSwitch = ({ mode, onModeChange }: CanvasInputModeSwitchProps) => {
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

const previewModes = [
  { id: 'static', label: 'Fixed Resolution', icon: ImageIcon },
  { id: 'dynamic', label: 'Dynamic', icon: Scaling },
];

interface PreviewModeSwitchProps {
  mode: 'static' | 'dynamic';
  onModeChange: (mode: 'static' | 'dynamic') => void;
}

const PreviewModeSwitch = ({ mode, onModeChange }: PreviewModeSwitchProps) => {
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
  rootPath,
}: SettingsPanelProps) {
  const { user: _user } = useUser();
  const [isClearing, setIsClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState('');
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [cacheClearMessage, setCacheClearMessage] = useState('');
  const [isClearingAiTags, setIsClearingAiTags] = useState(false);
  const [aiTagsClearMessage, setAiTagsClearMessage] = useState('');
  const [isClearingTags, setIsClearingTags] = useState(false);
  const [tagsClearMessage, setTagsClearMessage] = useState('');
  const [confirmModalState, setConfirmModalState] = useState<ConfirmModalState>({
    confirmText: 'Confirm',
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
  });
  const [restartRequired, setRestartRequired] = useState(false);
  const [activeCategory, setActiveCategory] = useState('general');
  const [logPath, setLogPath] = useState('');
  const [dpr, setDpr] = useState(() => (typeof window !== 'undefined' ? window.devicePixelRatio : 1));

  const filteredBackendOptions = backendOptions.filter((opt) => {
    if (opt.value === 'metal' && osPlatform !== 'macos') return false;
    if (opt.value === 'dx12' && osPlatform === 'macos') return false;
    return true;
  });

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
        setLogPath('Could not retrieve log file path.');
      }
    };
    fetchLogPath();

    invoke('get_lensfun_makers')
      .then((m: any) => setLensMakers(m))
      .catch(console.error);
  }, []);

  const handleProcessingSettingChange = (key: string, value: any) => {
    setProcessingSettings((prev) => ({ ...prev, [key]: value }));
    if (
      key === 'processingBackend' ||
      key === 'linuxGpuOptimization' ||
      key === 'useWgpuRenderer' ||
      key === 'thumbnailWorkerThreads'
    ) {
      setRestartRequired(true);
    } else {
      onSettingsChange({ ...appSettings, [key]: value });
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

  const effectiveRootPath = rootPath || appSettings?.lastRootPath;

  const executeClearSidecars = async () => {
    setIsClearing(true);
    setClearMessage('Deleting sidecar files, please wait...');
    try {
      const count: number = await invoke(Invokes.ClearAllSidecars, { rootPath: effectiveRootPath });
      setClearMessage(`${count} sidecar files deleted successfully.`);
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
      confirmText: 'Delete All Edits',
      confirmVariant: 'destructive',
      isOpen: true,
      message:
        'Are you sure you want to delete all sidecar files?\n\nThis will permanently remove all your edits for all images inside the current base folder and its subfolders.',
      onConfirm: executeClearSidecars,
      title: 'Confirm Deletion',
    });
  };

  const executeClearAiTags = async () => {
    setIsClearingAiTags(true);
    setAiTagsClearMessage('Clearing AI tags from all sidecar files...');
    try {
      const count: number = await invoke(Invokes.ClearAiTags, { rootPath: effectiveRootPath });
      setAiTagsClearMessage(`${count} files updated. AI tags removed.`);
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
      confirmText: 'Clear AI Tags',
      confirmVariant: 'destructive',
      isOpen: true,
      message:
        'Are you sure you want to remove all AI-generated tags from all images in the current base folder?\n\nThis will not affect user-added tags. This action cannot be undone.',
      onConfirm: executeClearAiTags,
      title: 'Confirm AI Tag Deletion',
    });
  };

  const executeClearTags = async () => {
    setIsClearingTags(true);
    setTagsClearMessage('Clearing all tags from sidecar files...');
    try {
      const count: number = await invoke(Invokes.ClearAllTags, { rootPath: effectiveRootPath });
      setTagsClearMessage(`${count} files updated. All non-color tags removed.`);
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
      confirmText: 'Clear All Tags',
      confirmVariant: 'destructive',
      isOpen: true,
      message:
        'Are you sure you want to remove all AI-generated and user-added tags from all images in the current base folder?\n\nThis action cannot be undone.',
      onConfirm: executeClearTags,
      title: 'Confirm All Tag Deletion',
    });
  };

  const shortcutTagVariants = {
    visible: { opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 500, damping: 30 } },
    exit: { opacity: 0, scale: 0.8, transition: { duration: 0.15 } },
  };

  const executeClearCache = async () => {
    setIsClearingCache(true);
    setCacheClearMessage('Clearing thumbnail cache...');
    try {
      await invoke(Invokes.ClearThumbnailCache);
      setCacheClearMessage('Thumbnail cache cleared successfully.');
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
      confirmText: 'Clear Cache',
      confirmVariant: 'destructive',
      isOpen: true,
      message:
        'Are you sure you want to clear the thumbnail cache?\n\nAll thumbnails will need to be regenerated, which may be slow for large folders.',
      onConfirm: executeClearCache,
      title: 'Confirm Cache Deletion',
    });
  };

  const handleTestConnection = async () => {
    if (!aiConnectorAddress) {
      return;
    }
    setTestStatus({ testing: true, message: 'Testing...', success: null });
    try {
      await invoke(Invokes.TestAIConnectorConnection, { address: aiConnectorAddress });
      setTestStatus({ testing: false, message: 'Connection successful!', success: true });
    } catch (err) {
      setTestStatus({ testing: false, message: `Connection failed.`, success: false });
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
              data-tooltip="Go to Home"
            >
              <ArrowLeft />
            </Button>
            <Text variant={TextVariants.display} color={TextColors.accent} className="whitespace-nowrap">
              Settings
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
                    General Settings
                  </Text>
                  <div className="space-y-8">
                    <SettingItem label="Theme" description="Change the look and feel of the application.">
                      <Dropdown
                        onChange={(value: any) => onSettingsChange({ ...appSettings, theme: value })}
                        options={THEMES.map((theme: ThemeProps) => ({ value: theme.id, label: theme.name }))}
                        value={appSettings?.theme || DEFAULT_THEME_ID}
                        triggerClassName="bg-bg-primary"
                      />
                    </SettingItem>

                    <SettingItem
                      label="EXIF Library Sorting"
                      description="Read EXIF data (ISO, aperture, etc.) on folder load at the cost of slower folder loading when using EXIF sorting."
                    >
                      <Switch
                        checked={appSettings?.enableExifReading ?? false}
                        id="exif-reading-toggle"
                        label="EXIF Reading"
                        onChange={(checked) => onSettingsChange({ ...appSettings, enableExifReading: checked })}
                      />
                    </SettingItem>

                    <SettingItem
                      label="XMP Metadata Sync"
                      description="Sync ratings, color labels and tags to standard XMP sidecar files for compatibility with other photo editors."
                    >
                      <Switch
                        checked={appSettings?.enableXmpSync ?? true}
                        id="enable-xmp-sync-toggle"
                        label="Enable XMP Sync"
                        onChange={(checked) => {
                          const newSettings = { ...appSettings, enableXmpSync: checked };
                          if (!checked) {
                            newSettings.createXmpIfMissing = false;
                          }
                          onSettingsChange(newSettings);
                        }}
                      />
                    </SettingItem>

                    <SettingItem
                      label="Create Missing XMP Files"
                      description="Automatically create a new XMP sidecar file if one does not exist for an image. (Requires XMP Sync)"
                    >
                      <Switch
                        disabled={!appSettings?.enableXmpSync}
                        checked={appSettings?.createXmpIfMissing ?? false}
                        id="create-xmp-missing-toggle"
                        label="Create XMP if missing"
                        onChange={(checked) => onSettingsChange({ ...appSettings, createXmpIfMissing: checked })}
                      />
                    </SettingItem>

                    <SettingItem
                      label="Folder Image Counts"
                      description="Show the number of images inside folders when hovering over the folder tree."
                    >
                      <Switch
                        checked={appSettings?.enableFolderImageCounts ?? false}
                        id="folder-image-counts-toggle"
                        label="Show Image Counts"
                        onChange={(checked) => onSettingsChange({ ...appSettings, enableFolderImageCounts: checked })}
                      />
                    </SettingItem>

                    <SettingItem label="Font" description="Change the application font.">
                      <Dropdown
                        onChange={(value: any) => onSettingsChange({ ...appSettings, fontFamily: value })}
                        options={[
                          { value: 'poppins', label: 'Poppins' },
                          { value: 'system', label: 'System Default' },
                        ]}
                        value={appSettings?.fontFamily || 'poppins'}
                        triggerClassName="bg-bg-primary"
                      />
                    </SettingItem>
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    Adjustments Visibility
                  </Text>
                  <Text className="mb-4">
                    Hide adjustment sections you don't use often to simplify the editing panel. Your settings will be
                    preserved and applied even when hidden.
                  </Text>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                    <Switch
                      label="Chromatic Aberration"
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
                      label="Grain"
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
                      label="Color Calibration"
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
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    My Lenses
                  </Text>
                  <Text className="mb-6">
                    Create a list of your frequently used lenses to quickly access them in the Lens Correction panel.
                  </Text>

                  <div className="space-y-8">
                    <div className="bg-bg-primary rounded-lg p-4 border border-border-color">
                      <Text variant={TextVariants.heading} className="mb-3">
                        Add New Lens
                      </Text>
                      <div className="space-y-4">
                        <Dropdown
                          options={lensMakers.map((m) => ({ label: m, value: m }))}
                          value={tempLensMaker}
                          onChange={handleTempMakerChange}
                          placeholder="Select Manufacturer"
                        />
                        <Dropdown
                          options={lensModels.map((m) => ({ label: m, value: m }))}
                          value={tempLensModel}
                          onChange={setTempLensModel}
                          placeholder="Select Lens Model"
                          disabled={!tempLensMaker}
                        />
                        <Button onClick={handleAddLens} disabled={!tempLensMaker || !tempLensModel} className="w-full">
                          <Plus size={16} className="mr-1" />
                          Add to My Lenses
                        </Button>
                      </div>
                    </div>

                    <div>
                      <Text variant={TextVariants.heading} className="mb-2">
                        Saved Lenses
                      </Text>
                      {(!appSettings?.myLenses || appSettings.myLenses.length === 0) && (
                        <Text className="italic">No lenses added yet.</Text>
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
                              data-tooltip="Remove lens"
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
                    Tagging
                  </Text>
                  <div className="space-y-8">
                    <div className="space-y-4">
                      <SettingItem
                        description="Enables automatic image tagging using an AI (CLIP) model. This will download an additional model and impact performance while browsing folders. Tags are used for searching a folder."
                        label="AI Tagging"
                      >
                        <Switch
                          checked={appSettings?.enableAiTagging ?? false}
                          id="ai-tagging-toggle"
                          label="Automatic AI Tagging"
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
                                label="Maximum AI Tags"
                                description="The maximum number of tags to generate per image."
                              >
                                <Slider
                                  label="Amount"
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
                                label="Custom AI Tag List"
                                description="If provided, the AI will ONLY use tags from this list, overriding RapidRAW’s built-in list. Tagging works only in English."
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
                                            data-tooltip={`Remove tag "${tag}"`}
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
                                            No custom AI tags (Using built-in list)
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
                                        placeholder="Add custom AI tags (comma separated)..."
                                        className="pr-10"
                                        bgClassName="bg-bg-primary"
                                      />
                                      <button
                                        onClick={handleAddAiTag}
                                        className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded-full text-text-secondary hover:text-text-primary hover:bg-surface"
                                        data-tooltip="Add AI tag"
                                      >
                                        <Plus size={18} />
                                      </button>
                                    </div>
                                    <button
                                      onClick={() => onSettingsChange({ ...appSettings, customAiTags: [] })}
                                      disabled={customAiTags.length === 0}
                                      className="p-2 text-text-secondary hover:text-red-400 hover:bg-surface rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-text-secondary disabled:hover:bg-transparent"
                                      data-tooltip="Clear AI Tag List"
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
                      label="Tagging Shortcuts"
                      description="A list of tags that will appear as shortcuts in the tagging context menu."
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
                                  data-tooltip={`Remove shortcut "${shortcut}"`}
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
                                No shortcuts added
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
                              placeholder="Add shortcuts (comma separated)..."
                              className="pr-10"
                              bgClassName="bg-bg-primary"
                            />
                            <button
                              onClick={handleAddShortcut}
                              className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded-full text-text-secondary hover:text-text-primary hover:bg-surface"
                              data-tooltip="Add Shortcut"
                            >
                              <Plus size={18} />
                            </button>
                          </div>
                          <button
                            onClick={() => onSettingsChange({ ...appSettings, taggingShortcuts: [] })}
                            disabled={taggingShortcuts.length === 0}
                            className="p-2 text-text-secondary hover:text-red-400 hover:bg-surface rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-text-secondary disabled:hover:bg-transparent"
                            data-tooltip="Clear Shortcuts Tag List"
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
                          buttonText="Clear"
                          description="This will remove all AI-generated tags from your .rrdata files in the current base folder. User-added tags will be kept."
                          disabled={!effectiveRootPath}
                          icon={<Trash2 size={16} className="mr-2" />}
                          isProcessing={isClearingAiTags}
                          message={aiTagsClearMessage}
                          title="Clear AI Tags"
                        />
                        <DataActionItem
                          buttonAction={handleClearTags}
                          buttonText="Clear"
                          description="This will remove all AI-generated and user-added tags from your .rrdata files in the current base folder. Color labels will be kept."
                          disabled={!effectiveRootPath}
                          icon={<Trash2 size={16} className="mr-2" />}
                          isProcessing={isClearingTags}
                          message={tagsClearMessage}
                          title="Clear All Tags"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-6">
                    Special Thanks
                  </Text>
                  <Text className="mb-4">
                    A huge thank you to the following projects that were very important in the development of RapidRAW:
                  </Text>
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
                      : For the excellent Rust crate that provides the foundation for RAW file processing in this
                      project.
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
                      : For its invaluable open-source library and comprehensive database for automatic lens correction.
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
                      : For the inspiration behind the negative conversion logic.
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
                      : For the powerful & simple image inpainting model, which enables content-aware fill and object
                      removal.
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
                      : For providing the foundation model used for the AI subject detection capabilities.
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
                      : For providing the robust architecture used for the AI sky and foreground detection capabilities.
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
                      : For the powerful monocular depth estimation model that enables the AI depth masking
                      capabilities.
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
                      : For providing AI models that power the AI noise reduction capabilities in RapidRAW.
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
                      : For some reference implementations that guided parts of this work.
                    </li>
                    <li>
                      <span className="font-semibold text-accent">You</span>: For using and supporting RapidRAW. Your
                      interest keeps this project alive and evolving.
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
                    Processing Engine
                  </Text>
                  <div className="space-y-8">
                    <div>
                      <Text variant={TextVariants.heading} className="mb-2">
                        Preview Rendering Strategy
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
                                The editor renders the image at a fixed resolution. This mode is the fastest and most
                                consistent, making it ideal for lower-end hardware where smooth performance is
                                prioritized over pixel-perfect zoom.
                              </Text>
                              <div className="pl-4 border-l-2 border-border-color ml-1">
                                <SettingItem
                                  description="Determines the maximum resolution of the preview. Lower values significantly improve performance."
                                  label="Preview Resolution"
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
                                The editor renders the preview to match your display's actual pixel density. This
                                ensures that every detail is represented with 1:1 pixel accuracy, providing maximum
                                clarity when zooming and checking focus.
                              </Text>
                              <div className="pl-4 border-l-2 border-border-color ml-1 space-y-3">
                                <SettingItem
                                  description="Sets the resolution for static previews like crop mode, lens correction, and perspective tools. Does not affect the main editor preview."
                                  label="Static Preview Resolution"
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
                                  label="Render Resolution Scale"
                                  description="Scales the render resolution relative to your display. Lower values improve performance on high-resolution screens at the cost of some sharpness."
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
                                  label="High-DPI Rendering"
                                  description={
                                    dpr > 1
                                      ? `Render previews at your screen's native ${dpr}x physical pixel resolution. Produces the sharpest possible preview but uses significantly more memory.`
                                      : 'This setting only affects high-DPI displays. Your current display is standard resolution.'
                                  }
                                >
                                  <Switch
                                    checked={processingSettings.useFullDpiRendering}
                                    disabled={dpr <= 1}
                                    id="full-dpi-rendering-toggle"
                                    label="Render at native DPI"
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
                        label="Live Interactive Previews"
                        description="Update the preview immediately while dragging sliders. Disable this if the interface feels laggy during adjustments."
                      >
                        <Switch
                          checked={appSettings?.enableLivePreviews ?? true}
                          id="live-previews-toggle"
                          label="Enable Live Previews"
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
                                label="Live Preview Quality"
                                description="Controls the resolution and compression of the image while dragging sliders. Lower quality significantly improves responsiveness."
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
                      description="Determines the resolution of generated library thumbnails. Higher values produce sharper images during loading."
                      label="Thumbnail Resolution"
                    >
                      <Dropdown
                        onChange={(value: any) => handleProcessingSettingChange('thumbnailResolution', value)}
                        options={thumbnailResolutions}
                        value={processingSettings.thumbnailResolution}
                        triggerClassName="bg-bg-primary"
                      />
                    </SettingItem>

                    <SettingItem
                      label="RAW Highlight Recovery"
                      description="Controls how much detail is recovered from clipped highlights in RAW files. Higher values recover more detail but can introduce purple artefacts."
                    >
                      <Slider
                        label="Amount"
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
                      label="Thumbnail Worker Threads"
                      description="Number of parallel threads used to generate thumbnails. Higher values speed up library loading but use more CPU & RAM."
                    >
                      <Slider
                        label="Threads"
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
                      label="Decoded Image Cache"
                      description="Maximum number of full-resolution images kept in RAM. Higher values make switching between recently edited images instant, but use significantly more memory."
                    >
                      <Slider
                        label="Images"
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
                      label="Linear RAW Processing"
                      description="Fixes color casts or pink tint in some DNG files. Controls how already processed LinearRAW data is interpreted."
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
                        label="Global Tonemapper Override"
                        description="Force a specific tonemapper globally for all images, hiding the tonemapper switch from the adjustments panel."
                      >
                        <Switch
                          checked={appSettings?.tonemapperOverrideEnabled ?? false}
                          id="tonemapper-override-toggle"
                          label="Enable Tonemapper Override"
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
                                label="Default RAW Tonemapper"
                                description="The tonemapper to apply to RAW images."
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
                                label="Default Non-RAW Tonemapper"
                                description="The tonemapper to apply to non-RAW images (e.g., JPEG, PNG)."
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

                    <SettingItem
                      label="WGPU Direct Rendering"
                      description={
                        osPlatform === 'linux'
                          ? 'Bypasses browser encoding for instantly responsive live previews. (Disabled on Linux: Tauri uses GTK for webviews, which conflicts with WGPU on the same X11 surface and causes flickering.)'
                          : osPlatform === 'android'
                            ? 'Bypasses browser encoding for instantly responsive live previews. (Disabled on Android: Native WGPU surface creation is currently not supported alongside the mobile webview.)'
                            : 'Bypasses browser encoding for instantly responsive live previews. Highly recommended for performance.'
                      }
                    >
                      <Switch
                        checked={processingSettings.useWgpuRenderer}
                        disabled={osPlatform === 'linux' || osPlatform === 'android'}
                        id="wgpu-renderer-toggle"
                        label="Enable Direct WGPU Render"
                        onChange={(checked) => handleProcessingSettingChange('useWgpuRenderer', checked)}
                      />
                    </SettingItem>

                    <SettingItem
                      label="Processing Backend"
                      description="Select the graphics API. 'Auto' is recommended. May fix crashes on some systems."
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
                        label="Linux Compatibility Mode"
                        description="Enable workarounds for common GPU driver and display server issues. Disable this to enable full GPU acceleration."
                      >
                        <Switch
                          checked={processingSettings.linuxGpuOptimization}
                          id="gpu-compat-toggle"
                          label="Enable Compatibility Mode"
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
                          <p>Changes to the processing engine require an application restart to take effect.</p>
                        </Text>
                        <div className="flex justify-end">
                          <Button onClick={handleSaveAndRelaunch}>Save & Relaunch</Button>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    Generative AI
                  </Text>
                  <Text className="mb-4">
                    RapidRAW's AI is built for flexibility. Choose your ideal workflow, from fast local tools to
                    powerful self-hosting.
                  </Text>

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
                          <Text variant={TextVariants.heading}>Built-in AI (CPU)</Text>
                          <Text className="mt-1">
                            Integrated directly into RapidRAW, these features run entirely on your computer. They are
                            fast, free, and require no setup, making them ideal for everyday workflow acceleration.
                          </Text>
                          <Text as="ul" className="mt-3 space-y-1 list-disc list-inside">
                            <li>AI Masking (Subject, Sky, Foreground)</li>
                            <li>Automatic Image Tagging</li>
                            <li>Simple CPU-based Generative Replace</li>
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
                              <Text variant={TextVariants.heading}>Self-Hosted (RapidRAW AI Connector)</Text>
                              <Text className="mt-1">
                                For users with a capable GPU who want maximum control, connect RapidRAW to your own
                                Connector server. This gives you full control for technical workflows.
                              </Text>
                              <Text as="ul" className="mt-3 space-y-1 list-disc list-inside">
                                <li>Use your own ComfyUI instance</li>
                                <li>Cost-free advanced generative edits</li>
                                <li>Custom workflow selection</li>
                              </Text>
                            </div>
                            <SettingItem
                              label="AI Connector Address"
                              description="Enter the address and port of your running AI Connector instance. Required for generative AI features."
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
                                  {testStatus.testing ? 'Testing...' : 'Test'}
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
                          <Text variant={TextVariants.heading}>Cloud Service</Text>
                          <Text className="mt-1">
                            For those who want a simpler solution, an optional subscription provides the same
                            high-quality results as self-hosting without any hassle. This is the most convenient option
                            and the best way to support the project.
                          </Text>
                          <Text as="ul" className="mt-3 space-y-1 list-disc list-inside">
                            <li>Maximum convenience, no setup</li>
                            <li>Same results as self-hosting</li>
                            <li>No powerful hardware required</li>
                          </Text>

                          <div className="mt-8 p-4 bg-bg-primary rounded-lg border border-border-color text-center space-y-3">
                            <Text
                              variant={TextVariants.small}
                              color={TextColors.button}
                              weight={TextWeights.semibold}
                              className="inline-block bg-accent px-2 py-1 rounded-full"
                            >
                              Coming Soon
                            </Text>
                            <Text>
                              Keep an eye on the GitHub page to be notified when the cloud service is available.
                            </Text>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <Text variant={TextVariants.title} color={TextColors.accent} className="mb-8">
                    Data Management
                  </Text>
                  <div className="space-y-8">
                    <DataActionItem
                      buttonAction={handleClearSidecars}
                      buttonText="Clear"
                      description={
                        <Text as="span" variant={TextVariants.small}>
                          This will delete all{' '}
                          <code className="bg-bg-primary px-1 rounded-sm text-text-primary">.rrdata</code> files
                          (containing your edits) within the current base folder:
                          <span className="block font-mono bg-bg-primary p-2 rounded-sm mt-2 break-all border border-border-color">
                            {effectiveRootPath || 'No folder selected'}
                          </span>
                        </Text>
                      }
                      disabled={!effectiveRootPath}
                      icon={<Trash2 size={16} className="mr-2" />}
                      isProcessing={isClearing}
                      message={clearMessage}
                      title="Clear All Sidecar Files"
                    />

                    <DataActionItem
                      buttonAction={handleClearCache}
                      buttonText="Clear"
                      description="This will delete all cached thumbnail images. They will be regenerated automatically as you browse your library."
                      icon={<Trash2 size={16} className="mr-2" />}
                      isProcessing={isClearingCache}
                      message={cacheClearMessage}
                      title="Clear Thumbnail Cache"
                    />

                    <DataActionItem
                      buttonAction={async () => {
                        if (logPath && !logPath.startsWith('Could not')) {
                          await invoke(Invokes.ShowInFinder, { path: logPath });
                        }
                      }}
                      buttonText="Open"
                      description={
                        <Text as="span" variant={TextVariants.small}>
                          View the application's log file for troubleshooting. The log is located at:
                          <span className="block font-mono bg-bg-primary p-2 rounded-sm mt-2 break-all border border-border-color">
                            {logPath || 'Loading...'}
                          </span>
                        </Text>
                      }
                      disabled={!logPath || logPath.startsWith('Could not')}
                      icon={<ExternalLinkIcon size={16} className="mr-2" />}
                      isProcessing={false}
                      message=""
                      title="View Application Logs"
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
                    Mouse Controls
                  </Text>
                  <div className="space-y-8">
                    <div>
                      <Text variant={TextVariants.heading} className="mb-2">
                        Input Device Optimization
                      </Text>
                      <Text variant={TextVariants.small} className="mb-4">
                        Choose the primary input device you use to pan and zoom the canvas.
                      </Text>
                      <CanvasInputModeSwitch
                        mode={(appSettings?.canvasInputMode as 'mouse' | 'trackpad') || 'mouse'}
                        onModeChange={(value) => onSettingsChange({ ...appSettings, canvasInputMode: value })}
                      />
                    </div>

                    <SettingItem
                      label="Zoom Speed Multiplier"
                      description="Adjust how fast the canvas zooms in and out when using the scroll wheel or pinch gesture."
                    >
                      <Slider
                        label="Speed"
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
                    Keyboard Controls
                  </Text>
                  <div className="space-y-8">
                    {' '}
                    {KEYBIND_SECTIONS.map((section) => {
                      const sectionDefs = KEYBIND_DEFINITIONS.filter((d) => d.section === section.id);
                      const userKb = appSettings?.keybinds || {};
                      return (
                        <div key={section.id}>
                          <Text variant={TextVariants.heading}>{section.label}</Text>
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
                        Reset All to Defaults
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
