import { useState } from 'react';
import { useBloc } from '@blac/react';
import {
  ArrowLeft,
  Brush,
  Circle,
  Eye,
  EyeOff,
  Layers,
  PlusSquare,
  RotateCcw,
  Sparkles,
  Square,
  Sun,
  Trash2,
} from 'lucide-react';
import { MasksBloc } from '../../blocs/editor/MasksBloc.js';
import { EditorBloc } from '../../blocs/editor/EditorBloc.js';
import { CollapsibleSection } from '../../primitives/CollapsibleSection.js';
import { Slider } from '../../primitives/Slider.js';
import type { MaskContainer, MaskType, SubMask } from '../../types/editor.js';

interface MaskTypeConfig {
  type: MaskType;
  name: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  disabled?: boolean;
}

const MASK_CREATION_TYPES: MaskTypeConfig[] = [
  { type: 'brush', name: 'Brush', icon: Brush },
  { type: 'gradient', name: 'Linear', icon: Square },
  { type: 'radial', name: 'Radial', icon: Circle },
  { type: 'luminosity', name: 'Luminosity', icon: Sun },
  { type: 'ai', name: 'AI Select', icon: Sparkles },
];

function MaskCreationGrid() {
  const [, masksBloc] = useBloc(MasksBloc);
  const [editorState] = useBloc(EditorBloc);

  const imageWidth = editorState.selectedImage?.width ?? 1000;
  const imageHeight = editorState.selectedImage?.height ?? 1000;

  return (
    <div className="grid grid-cols-3 gap-2">
      {MASK_CREATION_TYPES.map((maskType) => {
        const Icon = maskType.icon;
        return (
          <button
            key={maskType.type}
            type="button"
            disabled={maskType.disabled}
            className={`
              bg-surface text-text-primary rounded-lg p-2 flex flex-col items-center justify-center gap-1.5 aspect-square
              ${maskType.disabled
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:bg-surface-hover'
              }
            `}
            onClick={() =>
              masksBloc.addMaskContainer(maskType.type, imageWidth, imageHeight)
            }
            title={
              maskType.disabled
                ? `${maskType.name} (Coming Soon)`
                : `Add ${maskType.name} Mask`
            }
          >
            <Icon size={24} />
            <span className="text-xs">{maskType.name}</span>
          </button>
        );
      })}
    </div>
  );
}

interface MaskListItemProps {
  mask: MaskContainer;
  isActive: boolean;
}

function MaskListItem({ mask, isActive }: MaskListItemProps) {
  const [, masksBloc] = useBloc(MasksBloc);
  const [isRenaming, setIsRenaming] = useState(false);
  const [tempName, setTempName] = useState(mask.name);

  const handleRename = () => {
    if (tempName.trim()) {
      masksBloc.renameContainer(mask.id, tempName.trim());
    }
    setIsRenaming(false);
  };

  return (
    <div
      className={`
        group p-2 rounded-lg flex items-center justify-between cursor-pointer
        ${isActive ? 'bg-accent/20' : 'bg-surface hover:bg-surface-hover'}
        ${!mask.visible ? 'opacity-60' : 'opacity-100'}
      `}
      onClick={() => masksBloc.selectContainer(mask.id)}
    >
      <div className="flex items-center gap-3 flex-grow min-w-0">
        <Layers size={16} className="text-text-secondary flex-shrink-0" />
        {isRenaming ? (
          <input
            type="text"
            value={tempName}
            onChange={(e) => setTempName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') {
                setTempName(mask.name);
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
            {mask.name}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          type="button"
          className="p-1.5 rounded-full text-text-secondary hover:bg-bg-primary"
          onClick={(e) => {
            e.stopPropagation();
            masksBloc.toggleContainerVisibility(mask.id);
          }}
          title={mask.visible ? 'Hide Mask' : 'Show Mask'}
        >
          {mask.visible ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
        <button
          type="button"
          className="p-1.5 rounded-full text-text-secondary hover:text-red-500 hover:bg-red-500/10"
          onClick={(e) => {
            e.stopPropagation();
            masksBloc.deleteContainer(mask.id);
          }}
          title="Delete Mask"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function MaskList() {
  const [state] = useBloc(MasksBloc);
  const { masks, activeContainerId } = state;

  if (masks.length === 0) {
    return null;
  }

  return (
    <div>
      <p className="text-sm mb-3 font-semibold text-text-primary">
        Masks ({masks.length})
      </p>
      <div className="flex flex-col gap-2">
        {masks.map((mask) => (
          <MaskListItem
            key={mask.id}
            mask={mask}
            isActive={activeContainerId === mask.id}
          />
        ))}
      </div>
    </div>
  );
}

function SubMaskItem({ subMask }: { subMask: SubMask }) {
  const [state, masksBloc] = useBloc(MasksBloc);

  const isActive = state.activeSubMaskId === subMask.id;

  const getIcon = () => {
    switch (subMask.type) {
      case 'brush':
        return Brush;
      case 'gradient':
        return Square;
      case 'radial':
        return Circle;
      case 'luminosity':
        return Sun;
      case 'ai':
        return Sparkles;
      default:
        return Layers;
    }
  };

  const Icon = getIcon();

  return (
    <div
      className={`
        p-2 rounded-lg flex items-center justify-between cursor-pointer
        ${isActive ? 'bg-accent/20' : 'bg-surface hover:bg-surface-hover'}
      `}
      onClick={() => masksBloc.selectSubMask(subMask.id)}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-text-secondary" />
        <span className="text-sm text-text-primary capitalize">
          {subMask.type}
        </span>
      </div>
      <button
        type="button"
        className="p-1 rounded-full text-text-secondary hover:text-red-500 hover:bg-red-500/10"
        onClick={(e) => {
          e.stopPropagation();
          masksBloc.deleteSubMask(subMask.id);
        }}
        title="Delete"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function MaskAdjustmentsControls({ containerId }: { containerId: string }) {
  const [state, masksBloc] = useBloc(MasksBloc);
  const container = state.masks.find((m) => m.id === containerId);
  if (!container) return null;

  const { adjustments } = container;

  const updateAdjustment = (key: string, value: number) => {
    masksBloc.updateContainerAdjustments(containerId, { [key]: value });
  };

  return (
    <div className="space-y-4">
      <CollapsibleSection title="Exposure" defaultOpen>
        <div className="space-y-3">
          <Slider
            label="Exposure"
            value={adjustments.exposure ?? 0}
            min={-5}
            max={5}
            step={0.01}
            onChange={(v) => updateAdjustment('exposure', v)}
          />
          <Slider
            label="Brightness"
            value={adjustments.brightness ?? 0}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => updateAdjustment('brightness', v)}
          />
          <Slider
            label="Contrast"
            value={adjustments.contrast ?? 0}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => updateAdjustment('contrast', v)}
          />
          <Slider
            label="Highlights"
            value={adjustments.highlights ?? 0}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => updateAdjustment('highlights', v)}
          />
          <Slider
            label="Shadows"
            value={adjustments.shadows ?? 0}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => updateAdjustment('shadows', v)}
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Color" defaultOpen={false}>
        <div className="space-y-3">
          <Slider
            label="Temperature"
            value={adjustments.temperature ?? 0}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => updateAdjustment('temperature', v)}
          />
          <Slider
            label="Tint"
            value={adjustments.tint ?? 0}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => updateAdjustment('tint', v)}
          />
          <Slider
            label="Saturation"
            value={adjustments.saturation ?? 0}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => updateAdjustment('saturation', v)}
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Effects" defaultOpen={false}>
        <div className="space-y-3">
          <Slider
            label="Clarity"
            value={adjustments.clarity ?? 0}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => updateAdjustment('clarity', v)}
          />
          <Slider
            label="Dehaze"
            value={adjustments.dehaze ?? 0}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => updateAdjustment('dehaze', v)}
          />
          <Slider
            label="Sharpness"
            value={adjustments.sharpness ?? 0}
            min={0}
            max={100}
            step={1}
            onChange={(v) => updateAdjustment('sharpness', v)}
          />
        </div>
      </CollapsibleSection>
    </div>
  );
}

function BrushSettingsControls() {
  const [state, masksBloc] = useBloc(MasksBloc);
  const { brushSettings } = state;

  return (
    <div className="space-y-3">
      <Slider
        label="Size"
        value={brushSettings.size}
        min={1}
        max={500}
        step={1}
        onChange={(v) => masksBloc.setBrushSettings({ size: v })}
      />
      <Slider
        label="Hardness"
        value={brushSettings.hardness}
        min={0}
        max={100}
        step={1}
        onChange={(v) => masksBloc.setBrushSettings({ hardness: v })}
      />
      <Slider
        label="Opacity"
        value={brushSettings.opacity}
        min={0}
        max={100}
        step={1}
        onChange={(v) => masksBloc.setBrushSettings({ opacity: v })}
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
          onClick={() => masksBloc.setBrushSettings({ isErase: false })}
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
          onClick={() => masksBloc.setBrushSettings({ isErase: true })}
        >
          Erase
        </button>
      </div>
    </div>
  );
}

function SubMaskSettings({ subMask }: { subMask: SubMask }) {
  const [, masksBloc] = useBloc(MasksBloc);

  return (
    <div className="space-y-3">
      <Slider
        label="Feather"
        value={subMask.feather}
        min={0}
        max={100}
        step={1}
        onChange={(v) => masksBloc.updateSubMask(subMask.id, { feather: v })}
      />
      <Slider
        label="Opacity"
        value={subMask.opacity}
        min={0}
        max={100}
        step={1}
        onChange={(v) => masksBloc.updateSubMask(subMask.id, { opacity: v })}
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
            masksBloc.updateSubMask(subMask.id, { inverted: !subMask.inverted })
          }
        >
          {subMask.inverted ? 'Inverted' : 'Invert Mask'}
        </button>
      </div>
    </div>
  );
}

function MaskEditingView() {
  const [, masksBloc] = useBloc(MasksBloc);
  const [editorState] = useBloc(EditorBloc);

  const container = masksBloc.getActiveContainer();
  const activeSubMask = masksBloc.getActiveSubMask();

  if (!container) return null;

  const imageWidth = editorState.selectedImage?.width ?? 1000;
  const imageHeight = editorState.selectedImage?.height ?? 1000;

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-border">
        <button
          type="button"
          className="p-2 rounded-full hover:bg-surface flex-shrink-0"
          onClick={() => masksBloc.selectContainer(null)}
          title="Back to Mask List"
        >
          <ArrowLeft size={18} />
        </button>
        <h2 className="text-lg font-bold text-text-primary truncate px-2">
          {container.name}
        </h2>
        <button
          type="button"
          className="p-2 rounded-full hover:bg-surface flex-shrink-0"
          onClick={() => masksBloc.resetContainerAdjustments(container.id)}
          title="Reset Adjustments"
        >
          <RotateCcw size={18} />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto p-4 space-y-4">
        <CollapsibleSection title="Sub-Masks" defaultOpen>
          <div className="space-y-2">
            {container.subMasks.map((sm) => (
              <SubMaskItem key={sm.id} subMask={sm} />
            ))}
            <button
              type="button"
              className="w-full p-2 rounded-lg border border-dashed border-border text-text-secondary hover:text-text-primary hover:border-accent flex items-center justify-center gap-2"
              onClick={() =>
                masksBloc.addSubMaskToContainer(
                  container.id,
                  'brush',
                  imageWidth,
                  imageHeight
                )
              }
            >
              <PlusSquare size={16} />
              <span className="text-sm">Add Sub-Mask</span>
            </button>
          </div>
        </CollapsibleSection>

        {activeSubMask && (
          <>
            <CollapsibleSection title="Mask Settings" defaultOpen>
              <SubMaskSettings subMask={activeSubMask} />
            </CollapsibleSection>

            {activeSubMask.type === 'brush' && (
              <CollapsibleSection title="Brush Settings" defaultOpen>
                <BrushSettingsControls />
              </CollapsibleSection>
            )}
          </>
        )}

        <MaskAdjustmentsControls containerId={container.id} />
      </div>
    </div>
  );
}

function MaskListView() {
  const [state, masksBloc] = useBloc(MasksBloc);

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-border">
        <h2 className="text-lg font-bold text-text-primary">Masking</h2>
        <button
          type="button"
          className="p-2 rounded-full hover:bg-surface transition-colors"
          disabled={state.masks.length === 0}
          onClick={() => masksBloc.resetAll()}
          title="Reset All Masks"
        >
          <RotateCcw size={18} />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto p-4 space-y-6">
        {state.aiModelDownloadStatus && (
          <div className="p-2 text-center text-xs text-text-secondary bg-surface rounded-md">
            Downloading AI Model: {state.aiModelDownloadStatus}
          </div>
        )}

        <div>
          <p className="text-sm mb-3 font-semibold text-text-primary">
            Create New Mask
          </p>
          <MaskCreationGrid />
        </div>

        <MaskList />
      </div>
    </div>
  );
}

export function MasksPanel() {
  const [editorState] = useBloc(EditorBloc);
  const [state] = useBloc(MasksBloc);

  const hasImage = !!editorState.selectedImage;

  if (!hasImage) {
    return (
      <div className="h-full flex flex-col">
        <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-border">
          <h2 className="text-lg font-bold text-text-primary">Masking</h2>
        </div>
        <div className="flex-grow flex items-center justify-center">
          <p className="text-text-tertiary text-center">No image selected.</p>
        </div>
      </div>
    );
  }

  if (state.activeContainerId) {
    return <MaskEditingView />;
  }

  return <MaskListView />;
}
