import { useEffect, useState, useRef } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Cloud,
  Cpu,
  ExternalLink as ExternalLinkIcon,
  Save,
  Server,
  Info,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { open } from '@tauri-apps/plugin-dialog';
import { open as openLink } from '@tauri-apps/plugin-shell';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { SignedIn, SignedOut, SignInButton, UserButton, useUser } from '@clerk/clerk-react';
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

const EXECUTE_TIMEOUT = 3000;

const adjustmentVisibilityDefaults = {
  sharpening: true,
  presence: true,
  noiseReduction: true,
  chromaticAberration: false,
  negativeConversion: false,
  vignette: true,
  colorCalibration: false,
  grain: true,
};

const DEFAULT_WORKFLOW_CONFIG = {
  workflowPath: null,
  modelCheckpoints: { '1': 'XL_RealVisXL_V5.0_Lightning.safetensors' },
  vaeLoaders: { '49': 'sdxl_vae.safetensors' },
  controlnetLoaders: { '12': 'diffusion_pytorch_model_promax.safetensors' },
  sourceImageNodeId: '30',
  maskImageNodeId: '47',
  textPromptNodeId: '7',
  finalOutputNodeId: '41',
  samplerNodeId: '28',
  samplerSteps: 10,
  transferResolution: 3072,
  inpaintResolutionNodeId: '37',
  inpaintResolution: 1280,
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

const CacheStats = () => {
  const [stats, setStats] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = async () => {
    try {
      const cacheStats = await invoke('get_cache_stats');
      setStats(cacheStats);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch cache stats:', err);
      setError(String(err));
    }
  };

  const handleClearCache = async () => {
    try {
      await invoke('clear_processing_cache');
      await fetchStats();
    } catch (err) {
      console.error('Failed to clear cache:', err);
      setError(String(err));
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 2000); // Update every 2 seconds
    return () => clearInterval(interval);
  }, []);

  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-3 text-xs text-red-300">
        Failed to load cache stats: {error}
      </div>
    );
  }

  if (!stats) {
    return <div className="text-xs text-text-secondary">Loading cache statistics...</div>;
  }

  const hitRate = stats.hits + stats.misses > 0
    ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1)
    : '0.0';
  const utilizationPercent = ((stats.currentSizeBytes / stats.maxSizeBytes) * 100).toFixed(1);
  const currentSizeMB = (stats.currentSizeBytes / (1024 * 1024)).toFixed(1);
  const maxSizeMB = (stats.maxSizeBytes / (1024 * 1024)).toFixed(0);

  return (
    <div className="bg-bg-primary border border-border-color rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-secondary">Cache Efficiency:</span>
        <span className="text-text-primary font-medium">{hitRate}% hit rate</span>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-secondary">Memory Usage:</span>
        <span className="text-text-primary font-medium">{currentSizeMB} / {maxSizeMB} MB ({utilizationPercent}%)</span>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-secondary">Cached Items:</span>
        <span className="text-text-primary font-medium">{stats.entryCount}</span>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-secondary">Stats:</span>
        <span className="text-text-primary font-mono">{stats.hits} hits / {stats.misses} misses / {stats.evictions} evictions</span>
      </div>
      <button
        onClick={handleClearCache}
        className="w-full mt-2 px-3 py-1.5 bg-red-900/20 hover:bg-red-900/30 text-red-300 border border-red-500/50 rounded text-xs transition-colors"
      >
        Clear Cache
      </button>
    </div>
  );
};

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
    <h3 className="font-medium text-text-primary mb-1">{title}</h3>
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

const ModelConfigItem = ({ label, data, onChange, description }: any) => {
  const [[key, value] = ['', '']] = Object.entries(data || {});

  const handleKeyChange = (newKey: any) => {
    onChange({ [newKey]: value });
  };

  const handleValueChange = (newValue: any) => {
    onChange({ [key]: newValue });
  };

  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-2">{label}</label>
      <div className="flex items-center gap-4 bg-bg-primary p-3 rounded-lg border border-border-color">
        <div className="flex-1">
          <label className="block text-xs text-text-secondary mb-1">Node ID</label>
          <Input type="number" value={key} onChange={(e) => handleKeyChange(e.target.value)} />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-text-secondary mb-1">Model Name</label>
          <Input value={value as string} onChange={(e) => handleValueChange(e.target.value)} />
        </div>
      </div>
      {description && <div className="text-xs text-text-secondary mt-2">{description}</div>}
    </div>
  );
};

const aiProviders = [
  { id: 'cpu', label: 'CPU', icon: Cpu },
  { id: 'comfyui', label: 'ComfyUI', icon: Server },
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
  const [saveStatus, setSaveStatus] = useState({ saving: false, message: '' });
  const [isConfigExpanded, setIsConfigExpanded] = useState(false);

  const [aiProvider, setAiProvider] = useState(appSettings?.aiProvider || 'cpu');
  const [comfyUiAddress, setComfyUiAddress] = useState<string>(appSettings?.comfyuiAddress || '');
  const [comfyConfig, setComfyConfig] = useState(appSettings?.comfyuiWorkflowConfig || DEFAULT_WORKFLOW_CONFIG);

  const [processingSettings, setProcessingSettings] = useState({
    editorPreviewResolution: appSettings?.editorPreviewResolution || 1920,
    rawHighlightCompression: appSettings?.rawHighlightCompression ?? 2.5,
    processingBackend: appSettings?.processingBackend || 'auto',
    linuxGpuOptimization: appSettings?.linuxGpuOptimization ?? false,
    cacheMaxSizeMb: appSettings?.cacheMaxSizeMb || 2048,
  });
  const [restartRequired, setRestartRequired] = useState(false);
  const cacheUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (appSettings?.comfyuiAddress !== comfyUiAddress) {
      setComfyUiAddress(appSettings?.comfyuiAddress || '');
    }
    if (appSettings?.aiProvider !== aiProvider) {
      setAiProvider(appSettings?.aiProvider || 'cpu');
    }
    setComfyConfig(appSettings?.comfyuiWorkflowConfig || DEFAULT_WORKFLOW_CONFIG);
    setProcessingSettings({
      editorPreviewResolution: appSettings?.editorPreviewResolution || 1920,
      rawHighlightCompression: appSettings?.rawHighlightCompression ?? 2.5,
      processingBackend: appSettings?.processingBackend || 'auto',
      linuxGpuOptimization: appSettings?.linuxGpuOptimization ?? false,
      cacheMaxSizeMb: appSettings?.cacheMaxSizeMb || 2048,
    });
    setRestartRequired(false);
  }, [appSettings]);

  useEffect(() => {
    return () => {
      if (cacheUpdateTimeoutRef.current) {
        clearTimeout(cacheUpdateTimeoutRef.current);
      }
    };
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

  const resetToDefaults = () => {
    setComfyConfig(DEFAULT_WORKFLOW_CONFIG);
  };

  const handleProviderChange = (provider: string) => {
    setAiProvider(provider);
    onSettingsChange({ ...appSettings, aiProvider: provider });
  };

  const handleConfigChange = (field: any, value: any) => {
    setComfyConfig((prev: any) => ({ ...prev, [field]: value }));
  };

  const handleSaveComfyConfig = () => {
    setSaveStatus({ saving: true, message: 'Saving...' });
    const newConfig = { ...comfyConfig };
    onSettingsChange({ ...appSettings, comfyuiWorkflowConfig: newConfig });
    setTimeout(() => {
      setSaveStatus({ saving: false, message: 'Saved!' });
      setTimeout(() => setSaveStatus({ saving: false, message: '' }), EXECUTE_TIMEOUT - 500);
    }, 500);
  };

  const handleSelectWorkflowFile = async () => {
    try {
      const selected = await open({
        filters: [{ name: 'ComfyUI Workflow', extensions: ['json'] }],
        multiple: false,
      });
      if (typeof selected === 'string') {
        handleConfigChange('workflowPath', selected);
      }
    } catch (err) {
      console.error('Failed to open workflow file dialog:', err);
    }
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
        'Are you sure you want to delete all sidecar files?\n\nThis will permanently remove all your edits for all images inside the current root folder and its subfolders.',
      onConfirm: executeClearSidecars,
      title: 'Confirm Deletion',
    });
  };

  const executeClearTags = async () => {
    setIsClearingTags(true);
    setTagsClearMessage('Clearing AI tags from all sidecar files...');
    try {
      const count: number = await invoke(Invokes.ClearAllTags, { rootPath: effectiveRootPath });
      setTagsClearMessage(`${count} files updated. Tags removed.`);
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
        'Are you sure you want to remove all AI-generated tags from all images in the current root folder?\n\nThis action cannot be undone.',
      onConfirm: executeClearTags,
      title: 'Confirm AI Tag Deletion',
    });
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
      message: `Are you sure you want to ${transparent ? 'enable' : 'disable'} window transparency effects?\n\n${
        transparent ? 'These effects may reduce application performance.' : ''
      }\n\nThe application will relaunch to make this change.`,
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
    if (!comfyUiAddress) {
      return;
    }
    setTestStatus({ testing: true, message: 'Testing...', success: null });
    try {
      await invoke(Invokes.TestComfyuiConnection, { address: comfyUiAddress });
      setTestStatus({ testing: false, message: 'Connection successful!', success: true });
    } catch (err) {
      setTestStatus({ testing: false, message: `Connection failed.`, success: false });
      console.error('ComfyUI connection test failed:', err);
    } finally {
      setTimeout(() => setTestStatus({ testing: false, message: '', success: null }), EXECUTE_TIMEOUT);
    }
  };

  const closeConfirmModal = () => {
    setConfirmModalState({ ...confirmModalState, isOpen: false });
  };

  return (
    <>
      <ConfirmModal {...confirmModalState} onClose={closeConfirmModal} />
      <div className="flex flex-col h-full w-full text-text-primary">
        <header className="flex-shrink-0 flex items-center mb-6">
          <Button
            className="mr-4 hover:bg-surface text-text-primary rounded-full"
            onClick={onBack}
            size="icon"
            variant="ghost"
          >
            <ArrowLeft />
          </Button>
          <h1 className="text-3xl font-bold text-accent">Settings</h1>
        </header>
        <div className="flex-1 overflow-y-auto pr-2 -mr-2 space-y-8 custom-scrollbar">
          {/* commented out until the endpoint is available and production ready
          <div className="p-6 bg-surface rounded-xl shadow-md">
            <h2 className="text-xl font-semibold mb-6 text-accent">Account</h2>
            <div className="flex items-center justify-between">
              <div>
                <SignedIn>
                  <p className="text-sm text-text-primary">
                    Signed in as <span className="font-semibold">{user?.primaryEmailAddress?.emailAddress}</span>
                  </p>
                  {user?.publicMetadata?.plan === 'pro' && (
                    <p className="text-xs text-accent flex items-center gap-1.5 mt-1">
                      <Sparkles size={14} /> Pro Member
                    </p>
                  )}
                </SignedIn>
                <SignedOut>
                  <p className="text-sm text-text-secondary">Sign in to access generative cloud features.</p>
                </SignedOut>
              </div>
              <div className="flex items-center gap-4">
                <SignedOut>
                  <SignInButton mode="modal">
                    <Button>Sign In</Button>
                  </SignInButton>
                </SignedOut>
                <SignedIn>
                  <UserButton afterSignOutUrl="/" />
                </SignedIn>
              </div>
            </div>
          </div> 
          */}

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
                description="Enables automatic image tagging using an AI (CLIP) model. This will download an additional model file (~600MB). Tags are used for searching a folder."
                label="AI Tagging"
              >
                <Switch
                  checked={appSettings?.enableAiTagging ?? false}
                  id="ai-tagging-toggle"
                  label="Automatic AI Tagging"
                  onChange={(checked) => onSettingsChange({ ...appSettings, enableAiTagging: checked })}
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

              <SettingItem
                label="Image Processing Cache Size"
                description="Maximum memory allocated for caching decoded masks, AI patches, and transformed images. Higher values improve performance but use more RAM. Changes apply immediately."
              >
                <div className="space-y-3">
                  <Slider
                    label={`${processingSettings.cacheMaxSizeMb} MB`}
                    min={512}
                    max={8192}
                    step={256}
                    value={processingSettings.cacheMaxSizeMb}
                    defaultValue={2048}
                    onChange={(e: any) => {
                      const newValue = parseInt(e.target.value);
                      handleProcessingSettingChange('cacheMaxSizeMb', newValue);

                      // Clear existing timeout
                      if (cacheUpdateTimeoutRef.current) {
                        clearTimeout(cacheUpdateTimeoutRef.current);
                      }

                      // Set new timeout to update backend after user stops adjusting
                      cacheUpdateTimeoutRef.current = setTimeout(() => {
                        invoke('set_cache_max_size', { sizeMb: newValue });
                      }, 500);
                    }}
                  />
                  <CacheStats />
                </div>
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
            <h2 className="text-xl font-semibold mb-6 text-accent">Adjustments Visibility</h2>
            <p className="text-sm text-text-secondary mb-4">
              Hide adjustment sections you don't use often to simplify the editing panel. Your settings will be
              preserved and applied even when hidden.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
              <Switch
                label="Noise Reduction"
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
              <Switch
                label="Negative Conversion"
                checked={appSettings?.adjustmentVisibility?.negativeConversion ?? false}
                onChange={(checked) =>
                  onSettingsChange({
                    ...appSettings,
                    adjustmentVisibility: {
                      ...(appSettings?.adjustmentVisibility || adjustmentVisibilityDefaults),
                      negativeConversion: checked,
                    },
                  })
                }
              />
            </div>
          </div>

          <div className="p-6 bg-surface rounded-xl shadow-md">
            <h2 className="text-xl font-semibold mb-6 text-accent">Generative AI</h2>
            <p className="text-sm text-text-secondary mb-4">
              RapidRAW's AI is built for flexibility. Choose your ideal workflow, from fast local tools to powerful
              self-hosting.
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
                      Integrated directly into RapidRAW, these features run entirely on your computer. They are fast,
                      free, and require no setup, making them ideal for everyday workflow acceleration.
                    </p>
                    <ul className="mt-3 space-y-1 list-disc list-inside text-sm text-text-secondary">
                      <li>AI Masking (Subject, Sky, Foreground)</li>
                      <li>Automatic Image Tagging</li>
                      <li>Simple Generative Replace</li>
                    </ul>
                  </motion.div>
                )}

                {aiProvider === 'comfyui' && (
                  <motion.div
                    key="comfyui"
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={{ duration: 0.2 }}
                  >
                    <h3 className="text-lg font-semibold text-text-primary">Self-Hosted (ComfyUI)</h3>
                    <p className="text-sm text-text-secondary mt-1">
                      For users with a capable GPU who want maximum control, connect RapidRAW to your own local ComfyUI
                      server. This gives you full control for technical workflows.
                    </p>
                    <ul className="mt-3 mb-6 space-y-1 list-disc list-inside text-sm text-text-secondary">
                      <li>Use your own hardware & models</li>
                      <li>Cost-free advanced generative edits</li>
                      <li>Custom workflow selection</li>
                    </ul>
                    <div className="space-y-6">
                      <SettingItem
                        label="ComfyUI Address"
                        description="Enter the address and port of your running ComfyUI instance. Required for generative AI features."
                      >
                        <div className="flex items-center gap-2">
                          <Input
                            className="flex-grow"
                            id="comfyui-address"
                            onBlur={() => onSettingsChange({ ...appSettings, comfyuiAddress: comfyUiAddress })}
                            onChange={(e: any) => setComfyUiAddress(e.target.value)}
                            onKeyDown={(e: any) => e.stopPropagation()}
                            placeholder="127.0.0.1:8188"
                            type="text"
                            value={comfyUiAddress}
                          />
                          <Button
                            className="w-32"
                            disabled={testStatus.testing || !comfyUiAddress}
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

                      <SettingItem
                        label="Custom Workflow File"
                        description="Select a custom ComfyUI API format JSON file. If not set, the built-in workflow will be used."
                      >
                        <div className="flex items-center gap-2">
                          <Input
                            readOnly
                            value={comfyConfig.workflowPath || 'Using built-in workflow'}
                            className="flex-grow"
                          />
                          <Button onClick={handleSelectWorkflowFile}>Select</Button>
                          <Button variant="secondary" onClick={resetToDefaults}>
                            Reset
                          </Button>
                        </div>
                      </SettingItem>

                      <div
                        className="flex items-center justify-between cursor-pointer"
                        onClick={() => setIsConfigExpanded(!isConfigExpanded)}
                      >
                        <h3 className="font-medium text-text-primary">Advanced Configuration</h3>
                        <ChevronDown
                          className={clsx('transition-transform', isConfigExpanded && 'rotate-180')}
                          size={20}
                        />
                      </div>

                      <AnimatePresence>
                        {isConfigExpanded && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.3, ease: 'easeInOut' }}
                            className="overflow-hidden"
                          >
                            <div className="pt-4 border-t border-border-color space-y-8">
                              <div className="text-xs text-text-secondary space-y-2">
                                <p className="font-semibold">How to find Node IDs:</p>
                                <ol className="list-decimal list-inside space-y-1 pl-2">
                                  <li>
                                    In ComfyUI, build your workflow, then click{' '}
                                    <code className="bg-bg-primary px-1 rounded text-text-primary">
                                      Save (API Format)
                                    </code>
                                    .
                                  </li>
                                  <li>Open the saved JSON file in a text editor. Each node has a number ID.</li>
                                  <li>Find the IDs for the required nodes and enter them below.</li>
                                </ol>
                              </div>

                              {!comfyConfig.workflowPath && (
                                <div className="p-3 bg-bg-primary rounded-lg border border-border-color text-xs text-text-secondary space-y-2">
                                  <p className="font-semibold text-text-primary">Default Workflow Requirements:</p>
                                  <p>
                                    The built-in workflow handles resolution scaling automatically and requires the
                                    following custom nodes. Please install them using the ComfyUI Manager.
                                  </p>
                                  <ul className="list-disc list-inside space-y-1 pl-2">
                                    <li>
                                      <ExternalLink href="https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch">
                                        ComfyUI Inpaint CropAndStitch
                                      </ExternalLink>
                                    </li>
                                  </ul>
                                </div>
                              )}

                              <div>
                                <h4 className="text-base font-semibold text-accent-secondary mb-4">
                                  Node Configuration
                                </h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-6">
                                  <SettingItem label="Source Image Node ID">
                                    <Input
                                      type="number"
                                      value={comfyConfig.sourceImageNodeId || ''}
                                      onChange={(e) => handleConfigChange('sourceImageNodeId', e.target.value)}
                                    />
                                  </SettingItem>
                                  <SettingItem label="Mask Image Node ID">
                                    <Input
                                      type="number"
                                      value={comfyConfig.maskImageNodeId || ''}
                                      onChange={(e) => handleConfigChange('maskImageNodeId', e.target.value)}
                                    />
                                  </SettingItem>
                                  <SettingItem label="Text Prompt Node ID">
                                    <Input
                                      type="number"
                                      value={comfyConfig.textPromptNodeId || ''}
                                      onChange={(e) => handleConfigChange('textPromptNodeId', e.target.value)}
                                    />
                                  </SettingItem>
                                  <SettingItem label="Final Output Node ID">
                                    <Input
                                      type="number"
                                      value={comfyConfig.finalOutputNodeId || ''}
                                      onChange={(e) => handleConfigChange('finalOutputNodeId', e.target.value)}
                                    />
                                  </SettingItem>
                                  <SettingItem label="Sampler Node ID">
                                    <Input
                                      type="number"
                                      value={comfyConfig.samplerNodeId || ''}
                                      onChange={(e) => handleConfigChange('samplerNodeId', e.target.value)}
                                    />
                                  </SettingItem>
                                  <SettingItem label="Inpaint Resolution Node ID">
                                    <Input
                                      type="number"
                                      value={comfyConfig.inpaintResolutionNodeId || ''}
                                      onChange={(e) => handleConfigChange('inpaintResolutionNodeId', e.target.value)}
                                    />
                                  </SettingItem>
                                  <SettingItem label="Sampler Steps">
                                    <Input
                                      type="number"
                                      value={comfyConfig.samplerSteps || 10}
                                      onChange={(e) =>
                                        handleConfigChange('samplerSteps', parseInt(e.target.value, 10) || 0)
                                      }
                                    />
                                  </SettingItem>
                                  <SettingItem label="Transfer Resolution">
                                    <Input
                                      type="number"
                                      value={comfyConfig.transferResolution || 3072}
                                      onChange={(e) =>
                                        handleConfigChange('transferResolution', parseInt(e.target.value, 10) || 0)
                                      }
                                    />
                                  </SettingItem>
                                  <SettingItem label="Inpaint Resolution">
                                    <Input
                                      type="number"
                                      value={comfyConfig.inpaintResolution || 1280}
                                      onChange={(e) =>
                                        handleConfigChange('inpaintResolution', parseInt(e.target.value, 10) || 0)
                                      }
                                    />
                                  </SettingItem>
                                </div>
                              </div>

                              <div>
                                <h4 className="text-base font-semibold text-accent-secondary mb-4">
                                  Model Configuration
                                </h4>
                                <div className="space-y-6">
                                  <ModelConfigItem
                                    label="Checkpoint"
                                    data={comfyConfig.modelCheckpoints}
                                    onChange={(newData: any) => handleConfigChange('modelCheckpoints', newData)}
                                    description={
                                      !comfyConfig.workflowPath && (
                                        <>
                                          Recommended:{' '}
                                          <ExternalLink href="https://civitai.com/models/139562/realvisxl-v50">
                                            RealVisXL V5.0
                                          </ExternalLink>
                                        </>
                                      )
                                    }
                                  />
                                  <ModelConfigItem
                                    label="VAE"
                                    data={comfyConfig.vaeLoaders}
                                    onChange={(newData: any) => handleConfigChange('vaeLoaders', newData)}
                                    description={
                                      !comfyConfig.workflowPath && (
                                        <>
                                          Recommended:{' '}
                                          <ExternalLink href="https://huggingface.co/stabilityai/sdxl-vae/blob/main/sdxl_vae.safetensors">
                                            SDXL VAE
                                          </ExternalLink>
                                        </>
                                      )
                                    }
                                  />
                                  <ModelConfigItem
                                    label="ControlNet"
                                    data={comfyConfig.controlnetLoaders}
                                    onChange={(newData: any) => handleConfigChange('controlnetLoaders', newData)}
                                    description={
                                      !comfyConfig.workflowPath && (
                                        <>
                                          Recommended:{' '}
                                          <ExternalLink href="https://huggingface.co/xinsir/controlnet-union-sdxl-1.0/blob/main/diffusion_pytorch_model_promax.safetensors">
                                            Promax ControlNet
                                          </ExternalLink>
                                        </>
                                      )
                                    }
                                  />
                                </div>
                              </div>

                              <div className="flex justify-end items-center gap-4 pt-4">
                                {saveStatus.message && (
                                  <p className="text-sm text-green-400 flex items-center gap-2">
                                    <Check size={16} />
                                    {saveStatus.message}
                                  </p>
                                )}
                                <Button onClick={handleSaveComfyConfig} disabled={saveStatus.saving} className="w-48">
                                  {saveStatus.saving ? (
                                    'Saving...'
                                  ) : (
                                    <>
                                      <Save size={16} className="mr-2" />
                                      Save Config
                                    </>
                                  )}
                                </Button>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
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
                      For those who want a simpler solution, an optional subscription provides the same high-quality
                      results as self-hosting without any hassle. This is the most convenient option and the best way to support the
                      project.
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
                    This will delete all <code className="bg-bg-primary px-1 rounded text-text-primary">.rrdata</code>{' '}
                    files (containing your edits) within the current root folder:
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
                buttonAction={handleClearTags}
                buttonText="Clear All Tags"
                description="This will remove all AI-generated tags from your .rrdata files in the current root folder."
                disabled={!effectiveRootPath}
                icon={<Trash2 size={16} className="mr-2" />}
                isProcessing={isClearingTags}
                message={tagsClearMessage}
                title="Clear All Tags"
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
            </div>
          </div>

          <div className="p-6 bg-surface rounded-xl shadow-md">
            <h2 className="text-xl font-semibold mb-6 text-accent">Keyboard Shortcuts</h2>
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold pt-3 pb-2 text-accent">General</h3>
                <div className="divide-y divide-border-color">
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

          <div className="p-6 bg-surface rounded-xl shadow-md">
            <h2 className="text-xl font-semibold mb-4 text-accent">Information</h2>
            {appSettings?.lastRootPath ? (
              <div className="mt-4">
                <h3 className="font-medium text-text-primary mb-2">Last Used Folder</h3>
                <p className="text-sm text-text-secondary bg-bg-primary p-3 rounded-md font-mono break-all border border-border-color">
                  {appSettings.lastRootPath}
                </p>
              </div>
            ) : (
              <p className="text-sm text-text-secondary">No folder has been opened yet.</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}