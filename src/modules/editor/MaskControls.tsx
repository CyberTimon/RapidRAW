import { Paintbrush, Eraser, Circle, Square, Wand2 } from 'lucide-react';
import { Slider } from '../../primitives/Slider';
import type { BrushSettings } from '../../types/constants';

type MaskTool = 'brush' | 'eraser' | 'radial' | 'linear' | 'ai';

interface MaskControlsProps {
  activeTool: MaskTool;
  onToolChange: (tool: MaskTool) => void;
  brushSettings: BrushSettings;
  onBrushSettingsChange: (settings: Partial<BrushSettings>) => void;
  onGenerateAIMask: (type: 'subject' | 'sky' | 'foreground') => void;
  isGeneratingMask?: boolean;
}

const TOOLS: { id: MaskTool; icon: typeof Paintbrush; label: string }[] = [
  { id: 'brush', icon: Paintbrush, label: 'Brush' },
  { id: 'eraser', icon: Eraser, label: 'Eraser' },
  { id: 'radial', icon: Circle, label: 'Radial' },
  { id: 'linear', icon: Square, label: 'Linear' },
  { id: 'ai', icon: Wand2, label: 'AI Mask' },
];

export function MaskControls({
  activeTool,
  onToolChange,
  brushSettings,
  onBrushSettingsChange,
  onGenerateAIMask,
  isGeneratingMask = false,
}: MaskControlsProps) {
  return (
    <div className="p-3 space-y-4">
      <div>
        <div className="text-xs text-text-secondary font-medium mb-2 uppercase tracking-wider">
          Tools
        </div>
        <div className="flex gap-1">
          {TOOLS.map((tool) => {
            const Icon = tool.icon;
            return (
              <button
                key={tool.id}
                onClick={() => onToolChange(tool.id)}
                className={`p-2 rounded-md ${
                  activeTool === tool.id
                    ? 'bg-accent text-button-text'
                    : 'bg-surface text-text-primary hover:bg-bg-tertiary'
                }`}
                title={tool.label}
              >
                <Icon size={18} />
              </button>
            );
          })}
        </div>
      </div>

      {(activeTool === 'brush' || activeTool === 'eraser') && (
        <div className="space-y-3">
          <Slider
            label="Size"
            value={brushSettings.size}
            min={1}
            max={500}
            step={1}
            onChange={(v) => onBrushSettingsChange({ size: v })}
          />
          <Slider
            label="Feather"
            value={brushSettings.feather}
            min={0}
            max={100}
            step={1}
            onChange={(v) => onBrushSettingsChange({ feather: v })}
          />
        </div>
      )}

      {activeTool === 'ai' && (
        <div className="space-y-2">
          <div className="text-xs text-text-secondary font-medium mb-2 uppercase tracking-wider">
            AI Mask Type
          </div>
          <button
            onClick={() => onGenerateAIMask('subject')}
            disabled={isGeneratingMask}
            className="w-full px-3 py-2 text-sm bg-surface rounded-md text-text-primary hover:bg-bg-tertiary disabled:opacity-50"
          >
            {isGeneratingMask ? 'Generating...' : 'Detect Subject'}
          </button>
          <button
            onClick={() => onGenerateAIMask('sky')}
            disabled={isGeneratingMask}
            className="w-full px-3 py-2 text-sm bg-surface rounded-md text-text-primary hover:bg-bg-tertiary disabled:opacity-50"
          >
            {isGeneratingMask ? 'Generating...' : 'Detect Sky'}
          </button>
          <button
            onClick={() => onGenerateAIMask('foreground')}
            disabled={isGeneratingMask}
            className="w-full px-3 py-2 text-sm bg-surface rounded-md text-text-primary hover:bg-bg-tertiary disabled:opacity-50"
          >
            {isGeneratingMask ? 'Generating...' : 'Detect Foreground'}
          </button>
        </div>
      )}
    </div>
  );
}
