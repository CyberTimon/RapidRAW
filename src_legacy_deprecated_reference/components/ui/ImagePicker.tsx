import { open } from '@tauri-apps/plugin-dialog';
import { X } from 'lucide-react';

interface ImagePickerProps {
  imageName: string | null;
  onImageSelect: (path: string) => void;
  onClear: () => void;
  label: string;
}

export default function ImagePicker({
  imageName,
  onImageSelect,
  onClear,
  label,
}: ImagePickerProps) {
  const handleSelectFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: 'Image Files',
            extensions: ['png'],
          },
        ],
      });
      if (typeof selected === 'string') {
        onImageSelect(selected);
      }
    } catch (err) {
      console.error('Failed to open image file dialog:', err);
    }
  };

  return (
    <div className="mb-2">
      <div className="flex justify-between items-center mb-1">
        <span className="text-sm font-medium text-text-secondary select-none">{label}</span>
        <div className="group flex items-center">
          <button
            onClick={handleSelectFile}
            className="text-sm text-text-primary text-right select-none cursor-pointer truncate max-w-[150px] hover:text-accent transition-colors"
            title={imageName || 'Select an image file'}
          >
            {imageName || 'Select'}
          </button>
          
          {imageName && (
            <button
              onClick={onClear}
              className="flex items-center justify-center p-0.5 rounded-full bg-bg-tertiary hover:bg-surface 
                         w-0 ml-0 opacity-0 group-hover:w-6 group-hover:ml-0 group-hover:opacity-100 
                         overflow-hidden pointer-events-none group-hover:pointer-events-auto
                         transition-all duration-200 ease-in-out"
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