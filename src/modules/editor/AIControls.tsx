import { useState } from 'react';
import { Wand2, Loader2, Sparkles, Image, Eraser } from 'lucide-react';
import { Button } from '../../primitives/Button';

interface AIControlsProps {
  onGenerativeReplace: (prompt: string) => void;
  onRemoveObject: () => void;
  isProcessing?: boolean;
  hasMask?: boolean;
}

export function AIControls({
  onGenerativeReplace,
  onRemoveObject,
  isProcessing = false,
  hasMask = false,
}: AIControlsProps) {
  const [prompt, setPrompt] = useState('');
  const [activeMode, setActiveMode] = useState<'replace' | 'remove'>('replace');

  const handleGenerate = () => {
    if (activeMode === 'replace' && prompt.trim()) {
      onGenerativeReplace(prompt.trim());
    } else if (activeMode === 'remove') {
      onRemoveObject();
    }
  };

  return (
    <div className="p-3 space-y-4">
      <div className="text-xs text-text-secondary font-medium uppercase tracking-wider">
        AI Tools
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => setActiveMode('replace')}
          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm ${
            activeMode === 'replace'
              ? 'bg-accent text-button-text'
              : 'bg-surface text-text-primary hover:bg-bg-tertiary'
          }`}
        >
          <Sparkles size={16} />
          Replace
        </button>
        <button
          onClick={() => setActiveMode('remove')}
          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm ${
            activeMode === 'remove'
              ? 'bg-accent text-button-text'
              : 'bg-surface text-text-primary hover:bg-bg-tertiary'
          }`}
        >
          <Eraser size={16} />
          Remove
        </button>
      </div>

      {activeMode === 'replace' && (
        <div className="space-y-2">
          <label className="text-xs text-text-secondary">Describe what to generate:</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g., a beautiful sunset sky, a green meadow..."
            className="w-full h-20 px-3 py-2 text-sm bg-bg-primary border border-surface rounded-md text-text-primary placeholder-text-tertiary resize-none focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      )}

      {activeMode === 'remove' && (
        <p className="text-xs text-text-secondary">
          Select an area with a mask, then click Generate to remove the object and fill with surrounding content.
        </p>
      )}

      {!hasMask && (
        <div className="flex items-center gap-2 p-2 bg-yellow-500/10 rounded-md">
          <Image size={16} className="text-yellow-500" />
          <p className="text-xs text-yellow-500">Create a mask to define the area to modify.</p>
        </div>
      )}

      <Button
        onClick={handleGenerate}
        disabled={isProcessing || !hasMask || (activeMode === 'replace' && !prompt.trim())}
        className="w-full"
      >
        {isProcessing ? (
          <>
            <Loader2 size={16} className="animate-spin mr-2" />
            Processing...
          </>
        ) : (
          <>
            <Wand2 size={16} className="mr-2" />
            Generate
          </>
        )}
      </Button>
    </div>
  );
}
