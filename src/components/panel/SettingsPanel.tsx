import { useEffect, useState } from 'react';
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
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { open as openLink } from '@tauri-apps/plugin-shell';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { useUser } from '@clerk/clerk-react';
import Button from '../ui/Button';
import ConfirmModal from '../modals/ConfirmModal';
import Dropdown, { OptionItem } from '../ui/Dropdown';
import Switch from '../ui/Switch';
import Input from '../ui/Input';
import Slider from '../ui/Slider';
import { ThemeProps, THEMES, DEFAULT_THEME_ID } from '../../utils/themes';
import { Invokes } from '../ui/AppProperties';

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

interface KeybindItemProps {
  description: string;
  keys: Array<string>;
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
  onSettingsChange(settings: any): void;
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

const resolutions: Array<OptionItem> = [
  { value: 720, label: '720px' },
  { value: 1280, label: '1280px' },
  { value: 1920, label: '1920px' },
  { value: 2560, label: '2560px' },
  { value: 3840, label: '3840px' },
];

const backendOptions: OptionItem[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'vulkan', label: 'Vulkan' },
  { value: 'dx12', label: 'DirectX 12' },
  { value: 'metal', label: 'Metal' },
  { value: 'gl', label: 'OpenGL' },
];

const linearRawOptions: OptionItem[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'gamma', label: 'Apply Gamma' },
  { value: 'skip_calib', label: 'Skip Calibrate' },
  { value: 'gamma_skip_calib', label: 'Apply Gamma & Skip Calibrate' },
];

const settingCategories = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'processing', label: 'Processing', icon: Cpu },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
];

const KeybindItem = ({ keys, description }: KeybindItemProps) => (
  <div className="flex justify-between items-center py-2">
    <span className="text-text-secondary text-sm">{description}</span>
    <div className="flex items-center gap-1">
      {keys.map((key: string, index: number) => (
        <kbd
          key={index}
          className="px-2 py-1 text-xs font-sans font-semibold text-text-primary bg-bg-primary border border-border-color rounded-md"
        >
          {key}
        </kbd>
      ))}
    </div>
  </div>
);

const SettingItem = ({ children, description, label }: SettingItemProps) => (
  <div>
    <label className="block text-sm font-medium text-text-primary mb-2">{label}</label>
    {children}
    {description && <p className="text-xs text-text-secondary mt-2">{description}</p>}
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
  <div className="pb-6 border-b border-border-color last:border-b-0 last:pb-0">
    <h3 className="text-sm font-medium text-text-primary mb-2">{title}</h3>
    <p className="text-xs text-text-secondary mb-3">{description}</p>
    <Button variant="destructive" onClick={buttonAction} disabled={isProcessing || disabled}>
      {icon}
      {isProcessing ? 'Processing...' : buttonText}
    </Button>
    {message && <p className="text-sm text-accent mt-3">{message}</p>}
  </div>
);

const ExternalLink = ({ href, children, className }: { href: string; children: any; className?: string }) => {
  const handleClick = async (e: any) => {
    e.preventDefault();
    try {
      await openLink(href);
    } catch (err) {
      console.error(`Failed to open link: ${href}`, err);
    }
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      className={clsx('text-accent hover:underline inline-flex items-center gap-1', className)}
    >
      {children}
      <ExternalLinkIcon size={12} />
    </a>
  );
};

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

export default function SettingsPanel({
  appSettings,
  onBack,
  onLibraryRefresh,
  onSettingsChange,
  rootPath,
}: SettingsPanelProps) {
  const { user } = useUser();
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

  const [aiProvider, setAiProvider] = useState(appSettings?.aiProvider || 'cpu');
  const [aiConnectorAddress, setAiConnectorAddress] = useState<string>(appSettings?.aiConnectorAddress || '');
  const [newShortcut, setNewShortcut] = useState('');
  const [newAiTag, setNewAiTag] = useState('');

  const [lensMakers, setLensMakers] = useState<string[]>([]);
  const [lensModels, setLensModels] = useState<string[]>([]);
  const [tempLensMaker, setTempLensMaker] = useState<string>('');
  const [tempLensModel, setTempLensModel] = useState<string>('');

  const [processingSettings, setProcessingSettings] = useState({
    editorPreviewResolution: appSettings?.editorPreviewResolution || 1920,
    rawHighlightCompression: appSettings?.rawHighlightCompression ?? 2.5,
    processingBackend: appSettings?.processingBackend || 'auto',
    linuxGpuOptimization: appSettings?.linuxGpuOptimization ?? false,
  });
  const [restartRequired, setRestartRequired] = useState(false);
  const [activeCategory, setActiveCategory] = useState('general');
  const [logPath, setLogPath] = useState('');

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
      rawHighlightCompression: appSettings?.rawHighlightCompression ?? 2.5,
      processingBackend: appSettings?.processingBackend || 'auto',
      linuxGpuOptimization: appSettings?.linuxGpuOptimization ?? false,
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
    if (key === 'processingBackend' || key === 'linuxGpuOptimization') {
      setRestartRequired(true);
    } else {
      onSettingsChange({ ...appSettings, [key]: value });
    }
  };

  const handleSaveAndRelaunch = async () => {
    onSettingsChange({
      ...appSettings,
      ...processingSettings,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await relaunch();
  };

  const handleProviderChange = (provider: string) => {
    setAiProvider(provider);
    onSettingsChange({ ...appSettings, aiProvider: provider });
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

  const executeSetTransparent = async (transparent: boolean) => {
    onSettingsChange({ ...appSettings, transparent });
    await relaunch();
  };

  const handleSetTransparent = (transparent: boolean) => {
    setConfirmModalState({
      confirmText: 'Toggle Transparency',
      confirmVariant: 'primary',
      isOpen: true,
      message: `Are you sure you want to ${transparent ? 'enable' : 'disable'} window transparency effects?\n${
        transparent ? 'These effects may reduce application performance.' : ''
      }\nThe application will relaunch to make this change.`,
      onConfirm: () => executeSetTransparent(transparent),
      title: 'Confirm Window Transparency',
    });
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

  return (
    <>
      <ConfirmModal {...confirmModalState} onClose={closeConfirmModal} />
      <div className="flex flex-col h-full w-full text-text-primary">
        <header className="flex-shrink-0 flex flex-wrap items-center justify-between gap-y-4 mb-8 pt-4">
          <div className="flex items-center flex-shrink-0">
            <Button
              className="mr-4 hover:bg-surface text-text-primary rounded-full"
              onClick={onBack}
              size="icon"
              variant="ghost"
              data-tooltip="Go to Home"
            >
              <ArrowLeft />
            </Button>
            <h1 className="text-3xl font-bold text-accent text-shadow-shiny whitespace-nowrap">Settings</h1>
          </div>

          <div className="relative flex w-full min-[1200px]:w-[450px] p-2 bg-surface rounded-md">
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
                  <category.icon size={16} className="mr-2 flex-shrink-0" />
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
                className="space-y-8"
              >
                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <h2 className="text-xl font-semibold mb-6 text-accent">General Settings</h2>
                  <div className="space-y-6">
                    <SettingItem label="Theme" description="Change the look and feel of the application.">
                      <Dropdown
                        onChange={(value: any) => onSettingsChange({ ...appSettings, theme: value })}
                        options={THEMES.map((theme: ThemeProps) => ({ value: theme.id, label: theme.name }))}
                        value={appSettings?.theme || DEFAULT_THEME_ID}
                      />
                    </SettingItem>

                    <SettingItem
                      description="Dynamically changes editor colors based on the current image."
                      label="Editor Theme"
                    >
                      <Switch
                        checked={appSettings?.adaptiveEditorTheme ?? false}
                        id="adaptive-theme-toggle"
                        label="Adaptive Editor Theme"
                        onChange={(checked) => onSettingsChange({ ...appSettings, adaptiveEditorTheme: checked })}
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

                    <SettingItem
                      description="Enables or disables transparency effects for the application window. Relaunch required."
                      label="Window Effects"
                    >
                      <Switch
                        checked={appSettings?.transparent ?? true}
                        id="window-effects-toggle"
                        label="Transparency"
                        onChange={handleSetTransparent}
                      />
                    </SettingItem>
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <h2 className="text-xl font-semibold mb-6 text-accent">Adjustments Visibility</h2>
                  <p className="text-sm text-text-secondary mb-4">
                    Hide adjustment sections you don't use often to simplify the editing panel. Your settings will be
                    preserved and applied even when hidden.
                  </p>
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
                  <h2 className="text-xl font-semibold mb-6 text-accent">My Lenses</h2>
                  <p className="text-sm text-text-secondary mb-6">
                    Create a list of your frequently used lenses to quickly access them in the Lens Correction panel.
                  </p>

                  <div className="bg-bg-primary rounded-lg p-4 border border-border-color mb-6">
                    <h3 className="text-sm font-medium text-text-primary mb-3">Add New Lens</h3>
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
                        <Plus size={16} className="mr-2" />
                        Add to My Lenses
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-text-primary mb-3">Saved Lenses</h3>
                    {(!appSettings?.myLenses || appSettings.myLenses.length === 0) && (
                      <p className="text-sm text-text-secondary italic">No lenses added yet.</p>
                    )}
                    <div className="divide-y divide-border-color">
                      {(appSettings?.myLenses || []).map((lens: MyLens, index: number) => (
                        <div key={`${lens.maker}-${lens.model}-${index}`} className="flex justify-between items-center py-3">
                          <div className="flex items-center gap-3">
                            <div className="p-2 bg-surface rounded-md text-accent">
                              <Bookmark size={16} />
                            </div>
                            <div>
                              <p className="text-sm font-medium text-text-primary">{lens.model}</p>
                              <p className="text-xs text-text-secondary">{lens.maker}</p>
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

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <h2 className="text-xl font-semibold mb-6 text-accent">Tagging</h2>
                  <div className="space-y-6">
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
                          <div className="pl-4 border-l-2 border-border-color ml-1 mt-4 space-y-6">
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
                                <div className="flex flex-wrap gap-2 p-2 bg-bg-primary rounded-md min-h-[40px] border border-border-color mb-2 items-center">
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
                                          className="flex items-center gap-1 bg-surface text-text-primary text-sm font-medium px-2 py-1 rounded group cursor-pointer"
                                        >
                                          <span>{tag}</span>
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
                                        className="text-sm text-text-secondary italic px-1 select-none"
                                      >
                                        No custom AI tags (Using built-in list)
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

                    <SettingItem
                      label="Tagging Shortcuts"
                      description="A list of tags that will appear as shortcuts in the tagging context menu."
                    >
                      <div>
                        <div className="flex flex-wrap gap-2 p-2 bg-bg-primary rounded-md min-h-[40px] border border-border-color mb-2 items-center">
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
                                  className="flex items-center gap-1 bg-surface text-text-primary text-sm font-medium px-2 py-1 rounded group cursor-pointer"
                                >
                                  <span>{shortcut}</span>
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

                    <div className="pt-6 border-t border-border-color">
                      <div className="space-y-6">
                        <DataActionItem
                          buttonAction={handleClearAiTags}
                          buttonText="Clear AI Tags"
                          description="This will remove all AI-generated tags from your .rrdata files in the current base folder. User-added tags will be kept."
                          disabled={!effectiveRootPath}
                          icon={<Trash2 size={16} className="mr-2" />}
                          isProcessing={isClearingAiTags}
                          message={aiTagsClearMessage}
                          title="Clear AI Tags"
                        />
                        <DataActionItem
                          buttonAction={handleClearTags}
                          buttonText="Clear All Tags"
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
              </motion.div>
            )}

            {activeCategory === 'processing' && (
              <motion.div
                key="processing"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
                className="space-y-8"
              >
                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <h2 className="text-xl font-semibold mb-6 text-accent">Processing Engine</h2>
                  <div className="space-y-6">
                    <SettingItem
                      description="Higher resolutions provide a sharper preview but may impact performance on less powerful systems."
                      label="Preview Resolution"
                    >
                      <Dropdown
                        onChange={(value: any) => handleProcessingSettingChange('editorPreviewResolution', value)}
                        options={resolutions}
                        value={processingSettings.editorPreviewResolution}
                      />
                    </SettingItem>

                    <SettingItem
                      label="High Quality Zoom"
                      description="Load a higher quality version of the image when zooming in for more detail. Disabling this can improve performance."
                    >
                      <Switch
                        checked={appSettings?.enableZoomHifi ?? true}
                        id="zoom-hifi-toggle"
                        label="Enable High Quality Zoom"
                        onChange={(checked) => onSettingsChange({ ...appSettings, enableZoomHifi: checked })}
                      />
                    </SettingItem>

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
                            className="overflow-hidden"
                          >
                            <div className="pl-4 border-l-2 border-border-color ml-1">
                              <SettingItem
                                label="High Quality Live Preview"
                                description="Uses higher resolution and less compression during interaction. Significantly increases GPU load."
                              >
                                <Switch
                                  checked={appSettings?.enableHighQualityLivePreviews ?? false}
                                  id="hq-live-previews-toggle"
                                  label="Enable High Quality"
                                  onChange={(checked) =>
                                    onSettingsChange({ ...appSettings, enableHighQualityLivePreviews: checked })
                                  }
                                />
                              </SettingItem>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

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
                      />
                    </SettingItem>

                    <SettingItem
                      label="Processing Backend"
                      description="Select the graphics API. 'Auto' is recommended. May fix crashes on some systems."
                    >
                      <Dropdown
                        onChange={(value: any) => handleProcessingSettingChange('processingBackend', value)}
                        options={backendOptions}
                        value={processingSettings.processingBackend}
                      />
                    </SettingItem>

                    <SettingItem
                      label="Linux Compatibility Mode"
                      description="Enable workarounds for common GPU driver and display server (e.g., Wayland) issues. May improve stability or performance on some systems."
                    >
                      <Switch
                        checked={processingSettings.linuxGpuOptimization}
                        id="gpu-compat-toggle"
                        label="Enable Compatibility Mode"
                        onChange={(checked) => handleProcessingSettingChange('linuxGpuOptimization', checked)}
                      />
                    </SettingItem>

                    {restartRequired && (
                      <>
                        <div className="p-3 bg-blue-900/20 text-blue-300 border border-blue-500/50 rounded-lg text-sm flex items-center gap-3">
                          <Info size={18} />
                          <p>Changes to the processing engine require an application restart to take effect.</p>
                        </div>
                        <div className="flex justify-end">
                          <Button onClick={handleSaveAndRelaunch}>Save & Relaunch</Button>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <h2 className="text-xl font-semibold mb-6 text-accent">Generative AI</h2>
                  <p className="text-sm text-text-secondary mb-4">
                    RapidRAW's AI is built for flexibility. Choose your ideal workflow, from fast local tools to
                    powerful self-hosting.
                  </p>

                  <AiProviderSwitch selectedProvider={aiProvider} onProviderChange={handleProviderChange} />

                  <div className="mt-6">
                    <AnimatePresence mode="wait">
                      {aiProvider === 'cpu' && (
                        <motion.div
                          key="cpu"
                          initial={{ opacity: 0, x: 10 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -10 }}
                          transition={{ duration: 0.2 }}
                        >
                          <h3 className="text-lg font-semibold text-text-primary">Built-in AI (CPU)</h3>
                          <p className="text-sm text-text-secondary mt-1">
                            Integrated directly into RapidRAW, these features run entirely on your computer. They are
                            fast, free, and require no setup, making them ideal for everyday workflow acceleration.
                          </p>
                          <ul className="mt-3 space-y-1 list-disc list-inside text-sm text-text-secondary">
                            <li>AI Masking (Subject, Sky, Foreground)</li>
                            <li>Automatic Image Tagging</li>
                            <li>Simple CPU-based Generative Replace</li>
                          </ul>
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
                          <h3 className="text-lg font-semibold text-text-primary">Self-Hosted (RapidRAW AI Connector)</h3>
                          <p className="text-sm text-text-secondary mt-1">
                            For users with a capable GPU who want maximum control, connect RapidRAW to your own local
                            AI Connector server. This gives you full control for technical workflows.
                          </p>
                          <ul className="mt-3 mb-6 space-y-1 list-disc list-inside text-sm text-text-secondary">
                            <li>Use your own ComfyUI instance</li>
                            <li>Cost-free advanced generative edits</li>
                            <li>Custom workflow selection</li>
                          </ul>
                          <div className="space-y-6">
                            <SettingItem
                              label="AI Connector Address"
                              description="Enter the address and port of your running AI Connector instance. Required for generative AI features."
                            >
                              <div className="flex items-center gap-2">
                                <Input
                                  className="flex-grow"
                                  id="ai-connector-address"
                                  onBlur={() => onSettingsChange({ ...appSettings, aiConnectorAddress: aiConnectorAddress })}
                                  onChange={(e: any) => setAiConnectorAddress(e.target.value)}
                                  onKeyDown={(e: any) => e.stopPropagation()}
                                  placeholder="127.0.0.1:8188"
                                  type="text"
                                  value={aiConnectorAddress}
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
                                <p
                                  className={`text-sm mt-2 flex items-center gap-2 ${
                                    testStatus.success ? 'text-green-400' : 'text-red-400'
                                  }`}
                                >
                                  {testStatus.success === true && <Wifi size={16} />}
                                  {testStatus.success === false && <WifiOff size={16} />}
                                  {testStatus.message}
                                </p>
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
                          <h3 className="text-lg font-semibold text-text-primary">Cloud Service</h3>
                          <p className="text-sm text-text-secondary mt-1">
                            For those who want a simpler solution, an optional subscription provides the same
                            high-quality results as self-hosting without any hassle. This is the most convenient option
                            and the best way to support the project.
                          </p>
                          <ul className="mt-3 space-y-1 list-disc list-inside text-sm text-text-secondary">
                            <li>Maximum convenience, no setup</li>
                            <li>Same results as self-hosting</li>
                            <li>No powerful hardware required</li>
                          </ul>

                          <div className="mt-6 p-4 bg-bg-primary rounded-lg border border-border-color text-center space-y-3">
                            <span className="inline-block bg-accent text-button-text text-xs font-semibold px-2 py-1 rounded-full">
                              Coming Soon
                            </span>
                            <p className="text-sm text-text-secondary">
                              Keep an eye on the GitHub page to be notified when the cloud service is available.
                            </p>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <h2 className="text-xl font-semibold mb-6 text-accent">Data Management</h2>
                  <div className="space-y-6">
                    <DataActionItem
                      buttonAction={handleClearSidecars}
                      buttonText="Delete All Edits in Folder"
                      description={
                        <>
                          This will delete all{' '}
                          <code className="bg-bg-primary px-1 rounded text-text-primary">.rrdata</code> files
                          (containing your edits) within the current base folder:
                          <span className="block font-mono text-xs bg-bg-primary p-2 rounded mt-2 break-all border border-border-color">
                            {effectiveRootPath || 'No folder selected'}
                          </span>
                        </>
                      }
                      disabled={!effectiveRootPath}
                      icon={<Trash2 size={16} className="mr-2" />}
                      isProcessing={isClearing}
                      message={clearMessage}
                      title="Clear All Sidecar Files"
                    />

                    <DataActionItem
                      buttonAction={handleClearCache}
                      buttonText="Clear Thumbnail Cache"
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
                      buttonText="Open Log File"
                      description={
                        <>
                          View the application's log file for troubleshooting. The log is located at:
                          <span className="block font-mono text-xs bg-bg-primary p-2 rounded mt-2 break-all border border-border-color">
                            {logPath || 'Loading...'}
                          </span>
                        </>
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
                className="space-y-8"
              >
                <div className="p-6 bg-surface rounded-xl shadow-md">
                  <h2 className="text-xl font-semibold mb-6 text-accent">Keyboard Shortcuts</h2>
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-lg font-semibold pt-3 pb-2 text-accent">General</h3>
                      <div className="divide-y divide-border-color">
                        <KeybindItem keys={['Space', 'Enter']} description="Open selected image" />
                        <KeybindItem keys={['Ctrl/Cmd', '+', 'C']} description="Copy selected adjustments" />
                        <KeybindItem keys={['Ctrl/Cmd', '+', 'V']} description="Paste copied adjustments" />
                        <KeybindItem keys={['Ctrl/Cmd', '+', 'Shift', '+', 'C']} description="Copy selected file(s)" />
                        <KeybindItem
                          description="Paste file(s) to current folder"
                          keys={['Ctrl/Cmd', '+', 'Shift', '+', 'V']}
                        />
                        <KeybindItem keys={['Ctrl/Cmd', '+', 'A']} description="Select all images" />
                        <KeybindItem keys={['Delete']} description="Delete selected file(s)" />
                        <KeybindItem keys={['0-5']} description="Set star rating for selected image(s)" />
                        <KeybindItem keys={['Shift', '+', '0-5']} description="Set color label for selected image(s)" />
                        <KeybindItem keys={['↑', '↓', '←', '→']} description="Navigate images in library" />
                      </div>
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold pt-3 pb-2 text-accent">Editor</h3>
                      <div className="divide-y divide-border-color">
                        <KeybindItem keys={['Esc']} description="Deselect mask, exit crop/fullscreen/editor" />
                        <KeybindItem keys={['Ctrl/Cmd', '+', 'Z']} description="Undo adjustment" />
                        <KeybindItem keys={['Ctrl/Cmd', '+', 'Y']} description="Redo adjustment" />
                        <KeybindItem keys={['Delete']} description="Delete selected mask/patch or image" />
                        <KeybindItem keys={['Space']} description="Cycle zoom (Fit, 2x Fit, 100%)" />
                        <KeybindItem keys={['←', '→']} description="Previous / Next image" />
                        <KeybindItem keys={['↑', '↓']} description="Zoom in / Zoom out (by step)" />
                        <KeybindItem keys={['Shift', '+', 'Mouse Wheel']} description="Adjust slider value by 2 steps" />
                        <KeybindItem keys={['Ctrl/Cmd', '+', '+']} description="Zoom in" />
                        <KeybindItem keys={['Ctrl/Cmd', '+', '-']} description="Zoom out" />
                        <KeybindItem keys={['Ctrl/Cmd', '+', '0']} description="Zoom to fit" />
                        <KeybindItem keys={['Ctrl/Cmd', '+', '1']} description="Zoom to 100%" />
                        <KeybindItem keys={['F']} description="Toggle fullscreen" />
                        <KeybindItem keys={['B']} description="Show original (before/after)" />
                        <KeybindItem keys={['D']} description="Toggle Adjustments panel" />
                        <KeybindItem keys={['R']} description="Toggle Crop panel" />
                        <KeybindItem keys={['M']} description="Toggle Masks panel" />
                        <KeybindItem keys={['K']} description="Toggle AI panel" />
                        <KeybindItem keys={['P']} description="Toggle Presets panel" />
                        <KeybindItem keys={['I']} description="Toggle Metadata panel" />
                        <KeybindItem keys={['W']} description="Toggle Waveform display" />
                        <KeybindItem keys={['E']} description="Toggle Export panel" />
                      </div>
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