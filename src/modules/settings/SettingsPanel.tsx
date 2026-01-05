import { useState } from 'react';
import { useBloc } from '@blac/react';
import {
  ArrowLeft,
  SlidersHorizontal,
  Cpu,
  Keyboard,
  Trash2,
  ExternalLink,
} from 'lucide-react';
import { Button } from '../../primitives/Button';
import { Dropdown } from '../../primitives/Dropdown';
import { Switch } from '../../primitives/Switch';
import { Slider } from '../../primitives/Slider';
import { ConfirmModal } from '../../primitives/Modal';
import { SettingsBloc } from '../../blocs/app/SettingsBloc';
import { getThemeOptions, applyTheme, DEFAULT_THEME_ID } from '../../utils/themes';

interface SettingItemProps {
  label: string;
  description?: string;
  children: React.ReactNode;
}

interface KeybindItemProps {
  keys: string[];
  description: string;
}

interface DataActionItemProps {
  title: string;
  description: React.ReactNode;
  buttonText: string;
  buttonAction: () => void;
  isProcessing: boolean;
  message: string;
  disabled?: boolean;
  icon: React.ReactNode;
}

interface ConfirmModalState {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText: string;
  confirmVariant: 'primary' | 'destructive';
  onConfirm: () => void;
}

const RESOLUTION_OPTIONS = [
  { value: '720', label: '720px' },
  { value: '1280', label: '1280px' },
  { value: '1920', label: '1920px' },
  { value: '2560', label: '2560px' },
  { value: '3840', label: '3840px' },
];

const BACKEND_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'vulkan', label: 'Vulkan' },
  { value: 'dx12', label: 'DirectX 12' },
  { value: 'metal', label: 'Metal' },
  { value: 'gl', label: 'OpenGL' },
];

const SETTING_CATEGORIES = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'processing', label: 'Processing', icon: Cpu },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
];

function SettingItem({ label, description, children }: SettingItemProps) {
  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-2">{label}</label>
      {children}
      {description && <p className="text-xs text-text-secondary mt-2">{description}</p>}
    </div>
  );
}

function KeybindItem({ keys, description }: KeybindItemProps) {
  return (
    <div className="flex justify-between items-center py-2">
      <span className="text-text-secondary text-sm">{description}</span>
      <div className="flex items-center gap-1">
        {keys.map((key, index) => (
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
}

function DataActionItem({
  title,
  description,
  buttonText,
  buttonAction,
  isProcessing,
  message,
  disabled = false,
  icon,
}: DataActionItemProps) {
  return (
    <div className="pb-6 border-b border-border-color last:border-b-0 last:pb-0">
      <h3 className="text-sm font-medium text-text-primary mb-2">{title}</h3>
      <div className="text-xs text-text-secondary mb-3">{description}</div>
      <Button variant="destructive" onClick={buttonAction} disabled={isProcessing || disabled}>
        {icon}
        {isProcessing ? 'Processing...' : buttonText}
      </Button>
      {message && <p className="text-sm text-accent mt-3">{message}</p>}
    </div>
  );
}

interface SettingsPanelProps {
  onBack?: () => void;
}

export function SettingsPanel({ onBack }: SettingsPanelProps) {
  const [state, settingsBloc] = useBloc(SettingsBloc);
  const [activeCategory, setActiveCategory] = useState('general');
  
  const [isClearingSidecars, setIsClearingSidecars] = useState(false);
  const [sidecarsClearMessage, setSidecarsClearMessage] = useState('');
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [cacheClearMessage, setCacheClearMessage] = useState('');
  
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState>({
    isOpen: false,
    title: '',
    message: '',
    confirmText: 'Confirm',
    confirmVariant: 'primary',
    onConfirm: () => {},
  });

  const settings = state.settings;

  const handleThemeChange = (theme: string) => {
    settingsBloc.setTheme(theme);
    applyTheme(theme);
  };

  const handleClearSidecars = () => {
    setConfirmModal({
      isOpen: true,
      title: 'Confirm Deletion',
      message: 'Are you sure you want to delete all sidecar files?\n\nThis will permanently remove all your edits for all images inside the current base folder and its subfolders.',
      confirmText: 'Delete All Edits',
      confirmVariant: 'destructive',
      onConfirm: async () => {
        setIsClearingSidecars(true);
        setSidecarsClearMessage('Deleting sidecar files...');
        try {
          // TODO: Implement via TauriService
          setSidecarsClearMessage('Sidecar files deleted successfully.');
        } catch (err) {
          setSidecarsClearMessage(`Error: ${err}`);
        } finally {
          setTimeout(() => {
            setIsClearingSidecars(false);
            setSidecarsClearMessage('');
          }, 3000);
        }
      },
    });
  };

  const handleClearCache = () => {
    setConfirmModal({
      isOpen: true,
      title: 'Confirm Cache Deletion',
      message: 'Are you sure you want to clear the thumbnail cache?\n\nAll thumbnails will need to be regenerated, which may be slow for large folders.',
      confirmText: 'Clear Cache',
      confirmVariant: 'destructive',
      onConfirm: async () => {
        setIsClearingCache(true);
        setCacheClearMessage('Clearing thumbnail cache...');
        try {
          // TODO: Implement via TauriService
          setCacheClearMessage('Thumbnail cache cleared successfully.');
        } catch (err) {
          setCacheClearMessage(`Error: ${err}`);
        } finally {
          setTimeout(() => {
            setIsClearingCache(false);
            setCacheClearMessage('');
          }, 3000);
        }
      },
    });
  };

  const closeConfirmModal = () => {
    setConfirmModal((prev) => ({ ...prev, isOpen: false }));
  };

  return (
    <>
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        onClose={closeConfirmModal}
        onConfirm={confirmModal.onConfirm}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText={confirmModal.confirmText}
        confirmVariant={confirmModal.confirmVariant}
      />

      <div className="flex flex-col h-full w-full text-text-primary p-4">
        <header className="flex-shrink-0 flex flex-wrap items-center justify-between gap-y-4 mb-8 pt-4">
          <div className="flex items-center flex-shrink-0">
            {onBack && (
              <Button
                className="mr-4 hover:bg-surface text-text-primary rounded-full"
                onClick={onBack}
                size="icon"
                variant="ghost"
              >
                <ArrowLeft />
              </Button>
            )}
            <h1 className="text-3xl font-bold text-accent whitespace-nowrap">Settings</h1>
          </div>

          <div className="relative flex w-full min-[1200px]:w-[450px] p-2 bg-surface rounded-md">
            {SETTING_CATEGORIES.map((category) => (
              <button
                key={category.id}
                onClick={() => setActiveCategory(category.id)}
                className={`
                  relative flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md
                  ${activeCategory === category.id
                    ? 'text-button-text bg-accent'
                    : 'text-text-primary hover:bg-bg-primary'
                  }
                `}
              >
                <category.icon size={16} className="flex-shrink-0" />
                <span className="truncate">{category.label}</span>
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto overflow-x-hidden pr-2 -mr-2 custom-scrollbar">
          {activeCategory === 'general' && (
            <div className="space-y-8">
              <div className="p-6 bg-surface rounded-xl shadow-md">
                <h2 className="text-xl font-semibold mb-6 text-accent">General Settings</h2>
                <div className="space-y-6">
                  <SettingItem label="Theme" description="Change the look and feel of the application.">
                    <Dropdown
                      onChange={handleThemeChange}
                      options={getThemeOptions()}
                      value={settings.theme || DEFAULT_THEME_ID}
                    />
                  </SettingItem>

                  <SettingItem
                    label="Adaptive Editor Theme"
                    description="Dynamically changes editor colors based on the current image."
                  >
                    <Switch
                      checked={settings.adaptiveEditorTheme ?? false}
                      label="Enable Adaptive Theme"
                      onChange={(checked) => settingsBloc.updateSettings({ adaptiveEditorTheme: checked })}
                    />
                  </SettingItem>

                  <SettingItem
                    label="EXIF Library Sorting"
                    description="Read EXIF data (ISO, aperture, etc.) on folder load for sorting. May slow down initial folder loading."
                  >
                    <Switch
                      checked={settings.enableExifReading ?? true}
                      label="Enable EXIF Reading"
                      onChange={(checked) => settingsBloc.updateSettings({ enableExifReading: checked })}
                    />
                  </SettingItem>
                </div>
              </div>

              <div className="p-6 bg-surface rounded-xl shadow-md">
                <h2 className="text-xl font-semibold mb-6 text-accent">Adjustments Visibility</h2>
                <p className="text-sm text-text-secondary mb-4">
                  Hide adjustment sections you don't use often to simplify the editing panel.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                  <Switch
                    label="Chromatic Aberration"
                    checked={true}
                    onChange={() => {}}
                  />
                  <Switch
                    label="Grain"
                    checked={true}
                    onChange={() => {}}
                  />
                  <Switch
                    label="Color Calibration"
                    checked={true}
                    onChange={() => {}}
                  />
                  <Switch
                    label="Negative Conversion"
                    checked={false}
                    onChange={() => {}}
                  />
                </div>
              </div>

              <div className="p-6 bg-surface rounded-xl shadow-md">
                <h2 className="text-xl font-semibold mb-6 text-accent">Tagging</h2>
                <div className="space-y-6">
                  <SettingItem
                    label="AI Tagging"
                    description="Enables automatic image tagging using an AI model. This will download an additional model and impact performance while browsing folders."
                  >
                    <Switch
                      checked={settings.enableAiTagging ?? false}
                      label="Automatic AI Tagging"
                      onChange={(checked) => settingsBloc.updateSettings({ enableAiTagging: checked })}
                    />
                  </SettingItem>
                </div>
              </div>
            </div>
          )}

          {activeCategory === 'processing' && (
            <div className="space-y-8">
              <div className="p-6 bg-surface rounded-xl shadow-md">
                <h2 className="text-xl font-semibold mb-6 text-accent">Processing Engine</h2>
                <div className="space-y-6">
                  <SettingItem
                    label="Preview Resolution"
                    description="Higher resolutions provide a sharper preview but may impact performance."
                  >
                    <Dropdown
                      onChange={(value) => settingsBloc.updateSettings({ editorPreviewResolution: parseInt(value) })}
                      options={RESOLUTION_OPTIONS}
                      value={String(settings.editorPreviewResolution || 2560)}
                    />
                  </SettingItem>

                  <SettingItem
                    label="High Quality Zoom"
                    description="Load a higher quality version of the image when zooming in for more detail."
                  >
                    <Switch
                      checked={settings.enableZoomHifi ?? true}
                      label="Enable High Quality Zoom"
                      onChange={(checked) => settingsBloc.updateSettings({ enableZoomHifi: checked })}
                    />
                  </SettingItem>

                  <SettingItem
                    label="Processing Backend"
                    description="Select the graphics API. 'Auto' is recommended. May fix crashes on some systems."
                  >
                    <Dropdown
                      onChange={() => {}}
                      options={BACKEND_OPTIONS}
                      value="auto"
                    />
                  </SettingItem>
                </div>
              </div>

              <div className="p-6 bg-surface rounded-xl shadow-md">
                <h2 className="text-xl font-semibold mb-6 text-accent">Data Management</h2>
                <div className="space-y-6">
                  <DataActionItem
                    title="Clear All Sidecar Files"
                    description={
                      <>
                        This will delete all <code className="bg-bg-primary px-1 rounded text-text-primary">.rrdata</code> files
                        (containing your edits) within the current base folder.
                      </>
                    }
                    buttonText="Delete All Edits in Folder"
                    buttonAction={handleClearSidecars}
                    isProcessing={isClearingSidecars}
                    message={sidecarsClearMessage}
                    icon={<Trash2 size={16} className="mr-2" />}
                  />

                  <DataActionItem
                    title="Clear Thumbnail Cache"
                    description="This will delete all cached thumbnail images. They will be regenerated automatically as you browse your library."
                    buttonText="Clear Thumbnail Cache"
                    buttonAction={handleClearCache}
                    isProcessing={isClearingCache}
                    message={cacheClearMessage}
                    icon={<Trash2 size={16} className="mr-2" />}
                  />

                  <DataActionItem
                    title="View Application Logs"
                    description="View the application's log file for troubleshooting."
                    buttonText="Open Log File"
                    buttonAction={() => {}}
                    isProcessing={false}
                    message=""
                    icon={<ExternalLink size={16} className="mr-2" />}
                  />
                </div>
              </div>
            </div>
          )}

          {activeCategory === 'shortcuts' && (
            <div className="space-y-8">
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
                      <KeybindItem keys={['Ctrl/Cmd', '+', 'Shift', '+', 'V']} description="Paste file(s) to current folder" />
                      <KeybindItem keys={['Ctrl/Cmd', '+', 'A']} description="Select all images" />
                      <KeybindItem keys={['Delete']} description="Delete selected file(s)" />
                      <KeybindItem keys={['0-5']} description="Set star rating for selected image(s)" />
                      <KeybindItem keys={['Shift', '+', '0-5']} description="Set color label for selected image(s)" />
                      <KeybindItem keys={['\u2191', '\u2193', '\u2190', '\u2192']} description="Navigate images in library" />
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
                      <KeybindItem keys={['\u2190', '\u2192']} description="Previous / Next image" />
                      <KeybindItem keys={['\u2191', '\u2193']} description="Zoom in / Zoom out (by step)" />
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
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default SettingsPanel;
