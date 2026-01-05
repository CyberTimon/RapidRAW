import { open } from '@tauri-apps/plugin-dialog';
import { X } from 'lucide-react';

interface ImagePickerProps {
  label: string;
  value: string | null;
  onChange: (path: string | null) => void;
  extensions?: string[];
  className?: string;
}

export function ImagePicker({
  label,
  value,
  onChange,
  extensions = ['png', 'jpg', 'jpeg', 'webp'],
  className = '',
}: ImagePickerProps) {
  const imageName = value ? value.split(/[\\/]/).pop() : null;

  const handleSelectFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: 'Image Files',
            extensions,
          },
        ],
      });
      if (typeof selected === 'string') {
        onChange(selected);
      }
    } catch (err) {
      console.error('Failed to open image file dialog:', err);
    }
  };

  const handleClear = () => {
    onChange(null);
  };

  return (
    <div className={`${className}`}>
      <div className="flex justify-between items-center">
        <span className="text-sm font-medium text-text-secondary select-none">{label}</span>
        <div className="group flex items-center">
          <button
            onClick={handleSelectFile}
            className="text-sm text-text-primary text-right select-none cursor-pointer truncate max-w-[150px] hover:text-accent"
            title={imageName || 'Select an image file'}
          >
            {imageName || 'Select'}
          </button>

          {value && (
            <button
              onClick={handleClear}
              className="flex items-center justify-center p-0.5 rounded-full bg-bg-tertiary hover:bg-surface 
                         w-0 ml-0 opacity-0 group-hover:w-6 group-hover:ml-0 group-hover:opacity-100 
                         overflow-hidden pointer-events-none group-hover:pointer-events-auto"
              title="Clear Image"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
