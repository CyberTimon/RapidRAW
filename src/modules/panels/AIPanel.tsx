import { useState } from 'react';
import { useBloc } from '@blac/react';
import {
  ArrowLeft,
  Circle,
  Eye,
  EyeOff,
  Eraser,
  Loader2,
  RotateCcw,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { AIBloc, type AIPatch } from '../../blocs/editor/AIBloc.js';
import { EditorBloc } from '../../blocs/editor/EditorBloc.js';
import { CollapsibleSection } from '../../primitives/CollapsibleSection.js';
import { Slider } from '../../primitives/Slider.js';
import { Button } from '../../primitives/Button.js';
import type { MaskType, SubMask } from '../../types/editor.js';

interface AIToolConfig {
  type: MaskType;
  name: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  disabled?: boolean;
}

const AI_CREATION_TYPES: AIToolConfig[] = [
  { type: 'brush', name: 'Quick Erase', icon: Eraser },
  { type: 'ai', name: 'AI Select', icon: Sparkles },
  { type: 'radial', name: 'Radial', icon: Circle },
];

function ConnectionStatus({ isConnected }: { isConnected: boolean }) {
  if (isConnected) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-surface rounded-lg mb-4">
        <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
        <span className="text-sm text-text-secondary">ComfyUI Backend:</span>
        <span className="text-sm font-bold text-green-400">Connected</span>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-lg mb-4 p-3">
      <div className="flex items-center gap-2">
        <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
        <span className="text-sm text-text-secondary">ComfyUI Backend:</span>
        <span className="text-sm font-bold text-red-400">Not Detected</span>
      </div>
      <p className="text-xs text-text-tertiary mt-2">
        Only simple inpainting is available. Connect to the backend for generative AI features.
      </p>
    </div>
  );
}

function AIToolGrid() {
  const [state, aiBloc] = useBloc(AIBloc);
  const [editorState] = useBloc(EditorBloc);

  const imageWidth = editorState.selectedImage?.width ?? 1000;
  const imageHeight = editorState.selectedImage?.height ?? 1000;
  const isDisabled = state.isGeneratingMask || state.isGenerating;

  return (
    <div className="grid grid-cols-3 gap-2">
      {AI_CREATION_TYPES.map((tool) => {
        const Icon = tool.icon;
        return (
          <button
            key={tool.type}
            type="button"
            disabled={tool.disabled || isDisabled}
            className={`
              bg-surface text-text-primary rounded-lg p-2 flex flex-col items-center justify-center gap-1.5 aspect-square
              ${tool.disabled || isDisabled
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:bg-surface-hover'
              }
            `}
            onClick={() => aiBloc.addPatch(tool.type, imageWidth, imageHeight)}
            title={
              tool.disabled
                ? `${tool.name} (Coming Soon)`
                : `Add ${tool.name} Edit`
            }
          >
            <Icon size={24} />
            <span className="text-xs">{tool.name}</span>
          </button>
        );
      })}
    </div>
  );
}

interface PatchListItemProps {
  patch: AIPatch;
  isActive: boolean;
}

function PatchListItem({ patch, isActive }: PatchListItemProps) {
  const [, aiBloc] = useBloc(AIBloc);
  const [isRenaming, setIsRenaming] = useState(false);
  const [tempName, setTempName] = useState(patch.name);

  const handleRename = () => {
    if (tempName.trim()) {
      aiBloc.renamePatch(patch.id, tempName.trim());
    }
    setIsRenaming(false);
  };

  return (
    <div
      className={`
        group p-2 rounded-lg flex items-center justify-between cursor-pointer
        ${isActive ? 'bg-accent/20' : 'bg-surface hover:bg-surface-hover'}
        ${!patch.visible ? 'opacity-60' : 'opacity-100'}
      `}
      onClick={() => aiBloc.selectPatch(patch.id)}
    >
      <div className="flex items-center gap-3 flex-grow min-w-0">
        {patch.isLoading ? (
          <Loader2 size={16} className="text-accent animate-spin flex-shrink-0" />
        ) : (
          <Wand2 size={16} className="text-text-secondary flex-shrink-0" />
        )}
        {isRenaming ? (
          <input
            type="text"
            value={tempName}
            onChange={(e) => setTempName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') {
                setTempName(patch.name);
                setIsRenaming(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            className="bg-transparent w-full text-sm font-medium text-text-primary focus:outline-none focus:ring-1 focus:ring-accent rounded px-1 -mx-1"
          />
        ) : (
          <span
            className="font-medium text-sm text-text-primary truncate"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setIsRenaming(true);
            }}
          >
            {patch.name}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          type="button"
          className="p-1.5 rounded-full text-text-secondary hover:bg-bg-primary"
          onClick={(e) => {
            e.stopPropagation();
            aiBloc.togglePatchVisibility(patch.id);
          }}
          title={patch.visible ? 'Hide Edit' : 'Show Edit'}
        >
          {patch.visible ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
        <button
          type="button"
          className="p-1.5 rounded-full text-text-secondary hover:text-red-500 hover:bg-red-500/10"
          onClick={(e) => {
            e.stopPropagation();
            aiBloc.deletePatch(patch.id);
          }}
          title="Delete Edit"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function PatchList() {
  const [state] = useBloc(AIBloc);
  const { patches, activePatchId } = state;

  if (patches.length === 0) {
    return null;
  }

  return (
    <div className="pt-4">
      <p className="text-sm mb-3 font-semibold text-text-primary">
        Edits ({patches.length})
      </p>
      <div className="flex flex-col gap-2">
        {patches.map((patch) => (
          <PatchListItem
            key={patch.id}
            patch={patch}
            isActive={activePatchId === patch.id}
          />
        ))}
      </div>
    </div>
  );
}

function BrushSettingsControls() {
  const [state, aiBloc] = useBloc(AIBloc);
  const { brushSettings } = state;

  return (
    <div className="space-y-3">
      <Slider
        label="Size"
        value={brushSettings.size}
        min={1}
        max={500}
        step={1}
        onChange={(v) => aiBloc.setBrushSettings({ size: v })}
      />
      <Slider
        label="Hardness"
        value={brushSettings.hardness}
        min={0}
        max={100}
        step={1}
        onChange={(v) => aiBloc.setBrushSettings({ hardness: v })}
      />
      <Slider
        label="Opacity"
        value={brushSettings.opacity}
        min={0}
        max={100}
        step={1}
        onChange={(v) => aiBloc.setBrushSettings({ opacity: v })}
      />
      <div className="flex gap-2 pt-2">
        <button
          type="button"
          className={`
            flex-1 py-2 px-3 rounded-lg text-sm font-medium
            ${!brushSettings.isErase
              ? 'bg-accent text-white'
              : 'bg-surface text-text-primary hover:bg-surface-hover'
            }
          `}
          onClick={() => aiBloc.setBrushSettings({ isErase: false })}
        >
          Paint
        </button>
        <button
          type="button"
          className={`
            flex-1 py-2 px-3 rounded-lg text-sm font-medium
            ${brushSettings.isErase
              ? 'bg-accent text-white'
              : 'bg-surface text-text-primary hover:bg-surface-hover'
            }
          `}
          onClick={() => aiBloc.setBrushSettings({ isErase: true })}
        >
          Erase
        </button>
      </div>
    </div>
  );
}

function SubMaskSettings({ subMask }: { subMask: SubMask }) {
  const [, aiBloc] = useBloc(AIBloc);

  return (
    <div className="space-y-3">
      <Slider
        label="Feather"
        value={subMask.feather}
        min={0}
        max={100}
        step={1}
        onChange={(v) => aiBloc.updateSubMask(subMask.id, { feather: v })}
      />
      <Slider
        label="Opacity"
        value={subMask.opacity}
        min={0}
        max={100}
        step={1}
        onChange={(v) => aiBloc.updateSubMask(subMask.id, { opacity: v })}
      />
      <div className="pt-2">
        <button
          type="button"
          className={`
            w-full py-2 px-3 rounded-lg text-sm font-medium
            ${subMask.inverted
              ? 'bg-accent text-white'
              : 'bg-surface text-text-primary hover:bg-surface-hover'
            }
          `}
          onClick={() =>
            aiBloc.updateSubMask(subMask.id, { inverted: !subMask.inverted })
          }
        >
          {subMask.inverted ? 'Inverted' : 'Invert Selection'}
        </button>
      </div>
    </div>
  );
}

function PromptSection({ patchId, prompt }: { patchId: string; prompt: string }) {
  const [state, aiBloc] = useBloc(AIBloc);
  const [localPrompt, setLocalPrompt] = useState(prompt);

  const handleGenerate = () => {
    aiBloc.setPrompt(patchId, localPrompt);
    aiBloc.setIsGenerating(true);
  };

  return (
    <div className="space-y-3">
      <textarea
        value={localPrompt}
        onChange={(e) => setLocalPrompt(e.target.value)}
        placeholder="Describe what to generate..."
        className="w-full bg-surface rounded-lg p-3 text-sm text-text-primary placeholder-text-tertiary resize-none focus:outline-none focus:ring-1 focus:ring-accent"
        rows={3}
      />
      <Button
        onClick={handleGenerate}
        disabled={state.isGenerating || !state.isComfyUiConnected}
        className="w-full"
      >
        {state.isGenerating ? (
          <>
            <Loader2 size={16} className="animate-spin mr-2" />
            Generating...
          </>
        ) : (
          <>
            <Wand2 size={16} className="mr-2" />
            Generate
          </>
        )}
      </Button>
      {!state.isComfyUiConnected && (
        <p className="text-xs text-text-tertiary text-center">
          Connect to ComfyUI backend to use generative features
        </p>
      )}
    </div>
  );
}

function PatchEditingView() {
  const [, aiBloc] = useBloc(AIBloc);
  const patch = aiBloc.getActivePatch();
  const activeSubMask = aiBloc.getActiveSubMask();

  if (!patch) return null;

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-border">
        <button
          type="button"
          className="p-2 rounded-full hover:bg-surface flex-shrink-0"
          onClick={() => aiBloc.selectPatch(null)}
          title="Back to AI Edit List"
        >
          <ArrowLeft size={18} />
        </button>
        <h2 className="text-lg font-bold text-text-primary truncate px-2">
          {patch.name}
        </h2>
        <button
          type="button"
          className="p-2 rounded-full hover:bg-surface flex-shrink-0"
          onClick={() => aiBloc.clearSubMasks(patch.id)}
          title="Reset Selection"
        >
          <RotateCcw size={18} />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto p-4 space-y-4">
        {activeSubMask && (
          <>
            <CollapsibleSection title="Selection Settings" defaultOpen>
              <SubMaskSettings subMask={activeSubMask} />
            </CollapsibleSection>

            {activeSubMask.type === 'brush' && (
              <CollapsibleSection title="Brush Settings" defaultOpen>
                <BrushSettingsControls />
              </CollapsibleSection>
            )}
          </>
        )}

        <CollapsibleSection title="Generative Fill" defaultOpen>
          <PromptSection patchId={patch.id} prompt={patch.prompt} />
        </CollapsibleSection>
      </div>
    </div>
  );
}

function AIListView() {
  const [state, aiBloc] = useBloc(AIBloc);

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-border">
        <h2 className="text-lg font-bold text-text-primary">AI Tools</h2>
        <button
          type="button"
          className="p-2 rounded-full hover:bg-surface transition-colors"
          disabled={state.patches.length === 0 || state.isGenerating}
          onClick={() => aiBloc.resetAll()}
          title="Reset All AI Edits"
        >
          <RotateCcw size={18} />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto p-4 space-y-6">
        <ConnectionStatus isConnected={state.isComfyUiConnected} />

        {state.aiModelDownloadStatus && (
          <div className="p-2 text-center text-xs text-text-secondary bg-surface rounded-md">
            Downloading AI Model: {state.aiModelDownloadStatus}
          </div>
        )}

        <div>
          <p className="text-sm mb-3 font-semibold text-text-primary">
            Create New Generative Edit
          </p>
          <AIToolGrid />
        </div>

        <PatchList />
      </div>
    </div>
  );
}

export function AIPanel() {
  const [editorState] = useBloc(EditorBloc);
  const [state] = useBloc(AIBloc);

  const hasImage = !!editorState.selectedImage;

  if (!hasImage) {
    return (
      <div className="h-full flex flex-col">
        <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-border">
          <h2 className="text-lg font-bold text-text-primary">AI Tools</h2>
        </div>
        <div className="flex-grow flex items-center justify-center">
          <p className="text-text-tertiary text-center">No image selected.</p>
        </div>
      </div>
    );
  }

  if (state.activePatchId) {
    return <PatchEditingView />;
  }

  return <AIListView />;
}
