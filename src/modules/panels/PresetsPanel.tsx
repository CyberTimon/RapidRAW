import { useState } from 'react';
import { useBloc } from '@blac/react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Plus,
  SortAsc,
  Trash2,
  Users,
} from 'lucide-react';
import {
  PresetsBloc,
  type Preset,
  type PresetFolder,
  type PresetItem,
  isPresetFolder,
} from '../../blocs/editor/PresetsBloc.js';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc.js';
import { AppBloc } from '../../blocs/app/AppBloc.js';
import { Button } from '../../primitives/Button.js';
import { Input } from '../../primitives/Input.js';

interface PresetItemProps {
  preset: Preset;
  onApply: (preset: Preset) => void;
}

function PresetItemComponent({ preset, onApply }: PresetItemProps) {
  const [state] = useBloc(PresetsBloc);
  const previewUrl = state.previewUrls[preset.id];
  const isGenerating = state.isGeneratingPreviews;

  return (
    <div
      className="p-2 rounded-lg bg-surface hover:bg-surface-hover cursor-pointer flex items-center gap-2"
      onClick={() => onApply(preset)}
    >
      <div className="w-16 h-12 bg-bg-tertiary rounded-md flex items-center justify-center flex-shrink-0 overflow-hidden">
        {isGenerating && !previewUrl ? (
          <Loader2 size={16} className="animate-spin text-text-secondary" />
        ) : previewUrl ? (
          <img
            src={previewUrl}
            alt={`${preset.name} preview`}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-surface to-bg-tertiary" />
        )}
      </div>
      <div className="flex-grow min-w-0">
        <p className="font-medium text-sm text-text-primary truncate">
          {preset.name}
        </p>
      </div>
    </div>
  );
}

interface FolderItemProps {
  folder: PresetFolder;
  onApply: (preset: Preset) => void;
}

function FolderItemComponent({ folder, onApply }: FolderItemProps) {
  const [state, presetsBloc] = useBloc(PresetsBloc);
  const isExpanded = state.expandedFolders.has(folder.id);
  const hasChildren = folder.children.length > 0;

  return (
    <div className="rounded-lg">
      <div
        className="flex items-center gap-2 p-2 rounded-lg bg-surface hover:bg-surface-hover cursor-pointer"
        onClick={() => presetsBloc.toggleFolderExpanded(folder.id)}
      >
        <div className="p-1">
          {isExpanded ? (
            <FolderOpen size={18} className="text-accent" />
          ) : (
            <Folder size={18} className="text-text-secondary" />
          )}
        </div>
        <p className="font-medium text-sm text-text-primary flex-grow truncate">
          {folder.name}
        </p>
        <span className="text-text-secondary text-xs">
          {folder.children.length}
        </span>
        {hasChildren && (
          <div className="text-text-secondary">
            {isExpanded ? (
              <ChevronDown size={16} />
            ) : (
              <ChevronRight size={16} />
            )}
          </div>
        )}
      </div>
      {isExpanded && hasChildren && (
        <div className="pl-6 space-y-2 mt-2">
          {folder.children.map((item) => (
            <PresetListItem key={item.id} item={item} onApply={onApply} />
          ))}
        </div>
      )}
    </div>
  );
}

interface PresetListItemProps {
  item: PresetItem;
  onApply: (preset: Preset) => void;
}

function PresetListItem({ item, onApply }: PresetListItemProps) {
  if (isPresetFolder(item)) {
    return <FolderItemComponent folder={item} onApply={onApply} />;
  }
  return <PresetItemComponent preset={item} onApply={onApply} />;
}

interface AddPresetModalContentProps {
  onSave: (name: string) => void;
  onCancel: () => void;
}

function AddPresetModalContent({ onSave, onCancel }: AddPresetModalContentProps) {
  const [name, setName] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onSave(name.trim());
    }
  };

  return (
    <div className="p-4 bg-bg-secondary rounded-lg border border-border">
      <h3 className="text-sm font-semibold text-text-primary mb-3">
        Save New Preset
      </h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Preset name"
          autoFocus
        />
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}

interface AddFolderModalContentProps {
  onSave: (name: string) => void;
  onCancel: () => void;
}

function AddFolderModalContent({ onSave, onCancel }: AddFolderModalContentProps) {
  const [name, setName] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onSave(name.trim());
    }
  };

  return (
    <div className="p-4 bg-bg-secondary rounded-lg border border-border">
      <h3 className="text-sm font-semibold text-text-primary mb-3">
        Create New Folder
      </h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Folder name"
          autoFocus
        />
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim()}>
            Create
          </Button>
        </div>
      </form>
    </div>
  );
}

export function PresetsPanel() {
  const [state, presetsBloc] = useBloc(PresetsBloc);
  const [, adjustmentsBloc] = useBloc(AdjustmentsBloc);
  const [, appBloc] = useBloc(AppBloc);
  const [showAddPreset, setShowAddPreset] = useState(false);
  const [showAddFolder, setShowAddFolder] = useState(false);

  const { presets, isLoading } = state;
  const folders = presetsBloc.getFolders();
  const rootPresets = presetsBloc.getRootPresets();

  const handleApplyPreset = (preset: Preset) => {
    adjustmentsBloc.setAdjustments(preset.adjustments);
  };

  const handleSavePreset = (name: string) => {
    const currentAdjustments = adjustmentsBloc.current;
    presetsBloc.addPreset(name, currentAdjustments);
    setShowAddPreset(false);
  };

  const handleAddFolder = (name: string) => {
    presetsBloc.addFolder(name);
    setShowAddFolder(false);
  };

  const handleNavigateToCommunity = () => {
    appBloc.navigateToCommunity();
  };

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-border">
        <h2 className="text-lg font-bold text-text-primary">Presets</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="p-2 rounded-full hover:bg-surface transition-colors"
            onClick={handleNavigateToCommunity}
            title="Explore Community Presets"
          >
            <Users size={18} />
          </button>
          <button
            type="button"
            className="p-2 rounded-full hover:bg-surface transition-colors"
            onClick={() => presetsBloc.sortAlphabetically()}
            title="Sort Alphabetically"
            disabled={presets.length === 0}
          >
            <SortAsc size={18} />
          </button>
          <button
            type="button"
            className="p-2 rounded-full hover:bg-surface transition-colors"
            onClick={() => setShowAddFolder(true)}
            title="Create Folder"
          >
            <FolderPlus size={18} />
          </button>
          <button
            type="button"
            className="p-2 rounded-full hover:bg-surface transition-colors"
            onClick={() => setShowAddPreset(true)}
            title="Save Current Settings as Preset"
          >
            <Plus size={18} />
          </button>
        </div>
      </div>

      <div className="flex-grow overflow-y-auto p-4 space-y-2">
        {showAddPreset && (
          <AddPresetModalContent
            onSave={handleSavePreset}
            onCancel={() => setShowAddPreset(false)}
          />
        )}

        {showAddFolder && (
          <AddFolderModalContent
            onSave={handleAddFolder}
            onCancel={() => setShowAddFolder(false)}
          />
        )}

        {isLoading && presets.length === 0 && (
          <div className="text-center text-text-secondary py-2">
            <Loader2 size={16} className="animate-spin inline-block mr-2" />
            Loading Presets...
          </div>
        )}

        {!isLoading && presets.length === 0 && !showAddPreset && !showAddFolder && (
          <div className="text-center text-text-secondary py-8 flex flex-col items-center gap-4">
            <p className="max-w-xs text-sm">
              No presets saved yet. Create your own or explore community
              presets.
            </p>
            <Button variant="secondary" onClick={handleNavigateToCommunity}>
              <Users size={16} className="mr-2" />
              Get Community Presets
            </Button>
          </div>
        )}

        {folders.map((folder) => (
          <FolderItemComponent
            key={folder.id}
            folder={folder}
            onApply={handleApplyPreset}
          />
        ))}

        {rootPresets.map((preset) => (
          <PresetItemComponent
            key={preset.id}
            preset={preset}
            onApply={handleApplyPreset}
          />
        ))}
      </div>
    </div>
  );
}
