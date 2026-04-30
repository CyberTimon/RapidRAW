import { open } from '@tauri-apps/plugin-dialog';
import { X } from 'lucide-react';
import Slider from './Slider';
import { useOsPlatform } from '../../hooks/useOsPlatform';
import { toast } from 'react-toastify';
import { invoke } from '@tauri-apps/api/core';

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
  const osPlatform = useOsPlatform(); 
  const isAndroid = osPlatform === 'android';

  const handleSelectFile = async () => {
    try {
      const LutExtensions = ['cube', '3dl', 'png', 'jpg', 'jpeg', 'tiff'];
      const expandExtensions = (exts: string[]) => {
          return Array.from(new Set(exts.flatMap((ext) => [ext.toLowerCase(), ext.toUpperCase()])));
        };
      const allLutExtensions = expandExtensions(LutExtensions);
      const typeFilters = isAndroid
        ? [ ] 
        : [
            {
              name: 'LUT Files',
              extensions: allLutExtensions,
            },
          ];
      const selected = await open({
        multiple: false,
        filters: typeFilters,
      });
      if (typeof selected === 'string') {
        let fileName = selected;
        if (isAndroid) {
          try {
            fileName = await invoke<string>('resolve_android_content_uri_name', { 
              uriStr: selected 
            });
          } catch (e) {
            console.error('Failed to resolve Android URI:', e);
          }
        }
        const allowedExtensions = new Set(allLutExtensions.map(e => e.toLowerCase()));
        const ext = fileName.split('.').pop()?.toLowerCase() || 'unknown';
        if (!allowedExtensions.has(ext)) {
          toast.error(`Unsupported file format(s) detected: .${ext}`);
          return;
        }
 
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
          onChange={(e) => onIntensityChange(parseInt(e.target.value, 10))}
          onDragStateChange={onDragStateChange}
          fillOrigin="min"
        />
      )}
    </div>
  );
}
