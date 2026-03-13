import { open } from '@tauri-apps/plugin-dialog';
import { X } from 'lucide-react';
import Slider from './Slider';

interface LUTControlProps {
  lutName: string | null;
  lutIntensity: number;
  onLutSelect: (path: string) => void;
  onIntensityChange: (intensity: number) => void;
  onClear: () => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

export default function LUTControl({
  lutName,
  lutIntensity,
  onLutSelect,
  onIntensityChange,
  onClear,
  onDragStateChange,
}: LUTControlProps) {
  const handleSelectFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: 'LUT Files',
            extensions: ['cube', '3dl', 'png', 'jpg', 'jpeg', 'tiff'],
          },
        ],
      });
      if (typeof selected === 'string') {
        onLutSelect(selected);
      }
    } catch (err) {
      console.error('Failed to open LUT file dialog:', err);
    }
  };

  return (
    <div className="mb-2">
      <div className="flex justify-between items-center mb-1">
        <span className="text-sm font-medium text-text-secondary select-none">LUT</span>
        <div className="group flex items-center">
          <button
            onClick={handleSelectFile}
            className="text-sm text-text-primary text-right select-none cursor-pointer truncate max-w-[150px] hover:text-accent transition-colors"
            data-tooltip={lutName || 'Select a LUT file'}
          >
            {lutName || 'Select'}
          </button>
          
          {lutName && (
            <button
              onClick={onClear}
              className="flex items-center justify-center p-0.5 rounded-full bg-bg-tertiary hover:bg-surface 
                         w-0 ml-0 opacity-0 group-hover:w-6 group-hover:ml-0 group-hover:opacity-100 
                         overflow-hidden pointer-events-none group-hover:pointer-events-auto
                         transition-all duration-200 ease-in-out"
              data-tooltip="Clear LUT"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {lutName && (
        <Slider
          label="Intensity"
          min={0}
          max={100}
          step={1}
          value={lutIntensity}
          defaultValue={100}
          onChange={(value) => onIntensityChange(Math.trunc(value))}
          onDragStateChange={onDragStateChange}
        />
      )}
    </div>
  );
}