import { useState } from 'react';
import { useBloc } from '@blac/react';
import { Modal } from '../../primitives/Modal';
import { Button } from '../../primitives/Button';
import { Switch } from '../../primitives/Switch';
import { ModalBloc } from '../../blocs/app/ModalBloc';
import { SettingsBloc } from '../../blocs/app/SettingsBloc';

const ADJUSTMENT_GROUPS = [
  {
    label: 'Basic',
    items: [
      { id: 'exposure', label: 'Exposure' },
      { id: 'brightness', label: 'Brightness' },
      { id: 'contrast', label: 'Contrast' },
      { id: 'highlights', label: 'Highlights' },
      { id: 'shadows', label: 'Shadows' },
      { id: 'whites', label: 'Whites' },
      { id: 'blacks', label: 'Blacks' },
    ],
  },
  {
    label: 'Color',
    items: [
      { id: 'temperature', label: 'Temperature' },
      { id: 'tint', label: 'Tint' },
      { id: 'saturation', label: 'Saturation' },
      { id: 'vibrance', label: 'Vibrance' },
    ],
  },
  {
    label: 'Presence',
    items: [
      { id: 'clarity', label: 'Clarity' },
      { id: 'dehaze', label: 'Dehaze' },
      { id: 'texture', label: 'Texture' },
    ],
  },
  {
    label: 'Detail',
    items: [
      { id: 'sharpness', label: 'Sharpness' },
      { id: 'noiseReduction', label: 'Noise Reduction' },
      { id: 'colorNoiseReduction', label: 'Color Noise Reduction' },
    ],
  },
  {
    label: 'Effects',
    items: [
      { id: 'vignette', label: 'Vignette' },
      { id: 'grain', label: 'Grain' },
    ],
  },
  {
    label: 'Advanced',
    items: [
      { id: 'curves', label: 'Tone Curves' },
      { id: 'hsl', label: 'HSL' },
      { id: 'splitToning', label: 'Split Toning' },
      { id: 'lensCorrections', label: 'Lens Corrections' },
    ],
  },
  {
    label: 'Transform',
    items: [
      { id: 'crop', label: 'Crop' },
      { id: 'rotation', label: 'Rotation' },
      { id: 'straighten', label: 'Straighten' },
    ],
  },
];

export function CopyPasteSettingsModal() {
  const [modalState, modalBloc] = useBloc(ModalBloc);
  const [settingsState, settingsBloc] = useBloc(SettingsBloc);
  const isOpen = modalState.openModals.includes('copy-paste-settings');
  
  const currentSettings = settingsState.settings.copyPasteSettings;
  const [selectedItems, setSelectedItems] = useState<string[]>(
    currentSettings?.includedAdjustments || []
  );
  const [mode, setMode] = useState<'merge' | 'replace'>(
    currentSettings?.mode || 'merge'
  );

  if (!isOpen) return null;

  const handleToggleItem = (itemId: string) => {
    setSelectedItems((prev) =>
      prev.includes(itemId)
        ? prev.filter((id) => id !== itemId)
        : [...prev, itemId]
    );
  };

  const handleSelectAll = () => {
    const allIds = ADJUSTMENT_GROUPS.flatMap((group) =>
      group.items.map((item) => item.id)
    );
    setSelectedItems(allIds);
  };

  const handleSelectNone = () => {
    setSelectedItems([]);
  };

  const handleConfirm = () => {
    settingsBloc.updateSettings({
      copyPasteSettings: {
        mode,
        includedAdjustments: selectedItems,
      },
    });
    modalBloc.close('copy-paste-settings');
  };

  const handleClose = () => {
    modalBloc.close('copy-paste-settings');
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Copy/Paste Settings"
      size="lg"
    >
      <div className="space-y-6">
        <div>
          <p className="text-sm text-text-secondary mb-4">
            Select which adjustments to include when copying and pasting between images.
          </p>
          
          <div className="flex items-center justify-between mb-4">
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={handleSelectAll}>
                Select All
              </Button>
              <Button size="sm" variant="ghost" onClick={handleSelectNone}>
                Select None
              </Button>
            </div>
            <div className="text-sm text-text-secondary">
              {selectedItems.length} selected
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-h-[400px] overflow-y-auto pr-2">
          {ADJUSTMENT_GROUPS.map((group) => (
            <div key={group.label} className="space-y-2">
              <h3 className="text-sm font-semibold text-accent">{group.label}</h3>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <Switch
                    key={item.id}
                    label={item.label}
                    checked={selectedItems.includes(item.id)}
                    onChange={() => handleToggleItem(item.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="pt-4 border-t border-border-color">
          <h3 className="text-sm font-semibold text-text-primary mb-3">Paste Mode</h3>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="pasteMode"
                checked={mode === 'merge'}
                onChange={() => setMode('merge')}
                className="accent-accent"
              />
              <span className="text-sm text-text-primary">Merge</span>
              <span className="text-xs text-text-secondary">(keep existing values for unselected)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="pasteMode"
                checked={mode === 'replace'}
                onChange={() => setMode('replace')}
                className="accent-accent"
              />
              <span className="text-sm text-text-primary">Replace</span>
              <span className="text-xs text-text-secondary">(reset unselected to defaults)</span>
            </label>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-3 mt-6">
        <Button variant="ghost" onClick={handleClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleConfirm}>
          Save Settings
        </Button>
      </div>
    </Modal>
  );
}
