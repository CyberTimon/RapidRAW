import React, { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Plus, Trash2, Save, X, Check } from 'lucide-react';
import { ExportPreset } from './ExportImportProperties';
import { AppSettings } from './AppProperties';
import Dropdown from './Dropdown';

interface ExportPresetsListProps {
  appSettings: AppSettings | null;
  currentSettings: Omit<ExportPreset, 'id' | 'name'>;
  onApplyPreset: (preset: ExportPreset) => void;
  onSettingsChange: (settings: AppSettings) => void;
}

export default function ExportPresetsList({
  appSettings,
  currentSettings,
  onApplyPreset,
  onSettingsChange,
}: ExportPresetsListProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');
  const [isSaved, setIsSaved] = useState(false);
  const presets = appSettings?.exportPresets || [];

  const handleSelect = (id: string) => {
    setSelectedPresetId(id);
    const preset = presets.find((p) => p.id === id);
    if (preset) {
      onApplyPreset(preset);
    }
  };

  const handleSavePreset = () => {
    if (!newPresetName.trim() || !appSettings) return;

    const newPreset: ExportPreset = {
      id: uuidv4(),
      name: newPresetName.trim(),
      ...currentSettings,
    };

    const updatedPresets = [...presets, newPreset];
    const updatedSettings = { ...appSettings, exportPresets: updatedPresets };

    onSettingsChange(updatedSettings);

    setSelectedPresetId(newPreset.id);
    setIsCreating(false);
    setNewPresetName('');
  };

  const isDefault = selectedPresetId.startsWith('default-');

  const handleOverwritePreset = () => {
    if (!selectedPresetId || isDefault || !appSettings) return;

    const updatedPresets = presets.map((p) => {
      if (p.id === selectedPresetId) {
        return {
          ...p,
          ...currentSettings,
        };
      }
      return p;
    });

    const updatedSettings = { ...appSettings, exportPresets: updatedPresets };
    onSettingsChange(updatedSettings);

    setIsSaved(true);
    setTimeout(() => {
      setIsSaved(false);
    }, 1500);
  };

  const handleDeletePreset = () => {
    if (!selectedPresetId || !appSettings) return;

    const updatedPresets = presets.filter((p) => p.id !== selectedPresetId);
    const updatedSettings = { ...appSettings, exportPresets: updatedPresets };

    onSettingsChange(updatedSettings);
    setSelectedPresetId('');
  };

  const dropdownOptions = presets
    .filter((preset) => preset.id !== '__last_used__')
    .map((preset) => ({
      label: preset.name,
      value: preset.id,
    }));

  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-text-primary mb-3 border-surface pb-2">Export Presets</h3>

      {!isCreating ? (
        <div className="flex gap-2">
          <Dropdown
            value={selectedPresetId}
            onChange={handleSelect}
            options={dropdownOptions}
            placeholder="Select a preset..."
            className="w-full"
          />

          <button
            onClick={() => setIsCreating(true)}
            className="p-2 bg-surface hover:bg-card-active rounded-md text-text-primary transition-colors"
            data-tooltip="Save current settings as new preset"
          >
            <Plus size={18} />
          </button>

          {selectedPresetId && !isDefault && (
            <>
              <button
                onClick={handleOverwritePreset}
                disabled={isSaved}
                className={`p-2 bg-surface hover:bg-card-active rounded-md transition-colors ${
                  isSaved ? 'text-green-500' : 'text-text-secondary'
                }`}
                data-tooltip={isSaved ? "Saved!" : "Overwrite selected preset"}
              >
                {isSaved ? <Check size={18} /> : <Save size={18} />}
              </button>
              <button
                onClick={handleDeletePreset}
                className="p-2 bg-surface hover:bg-red-500/20 hover:text-red-500 rounded-md text-text-secondary transition-colors"
                data-tooltip="Delete preset"
              >
                <Trash2 size={18} />
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="flex gap-2 items-center animate-in fade-in slide-in-from-top-1 duration-200">
          <input
            autoFocus
            type="text"
            placeholder="Preset Name"
            value={newPresetName}
            onChange={(e) => setNewPresetName(e.target.value)}
            className="flex-grow bg-bg-primary border border-surface rounded-md p-2 text-sm text-text-primary focus:ring-accent focus:border-accent"
            onKeyDown={(e) => e.key === 'Enter' && handleSavePreset()}
          />
          <button
            onClick={handleSavePreset}
            disabled={!newPresetName.trim()}
            className="p-2 bg-accent text-button-text rounded-md hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save size={18} />
          </button>
          <button onClick={() => setIsCreating(false)} className="p-2 bg-surface text-text-secondary rounded-md hover:bg-card-active">
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  );
}