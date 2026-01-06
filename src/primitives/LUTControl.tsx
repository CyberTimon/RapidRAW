import { useBloc } from '@blac/react';
import { X, FileImage } from 'lucide-react';
import { TauriService } from '../blocs/services/TauriService';

interface LUTControlProps {
  label: string;
  value: string | null;
  onChange: (path: string | null) => void;
  className?: string;
}

export function LUTControl({ label, value, onChange, className = '' }: LUTControlProps) {
  const [, tauriService] = useBloc(TauriService);
  const lutName = value ? value.split(/[\\/]/).pop() : null;

  const handleSelectFile = async () => {
    try {
      const selected = await tauriService.openFileDialog({
        filters: [
          {
            name: 'LUT Files',
            extensions: ['cube', '3dl', 'look', 'csp'],
          },
        ],
      });
      if (selected) {
        onChange(selected);
      }
    } catch (err) {
      console.error('Failed to open LUT file dialog:', err);
    }
  };

  const handleClear = () => {
    onChange(null);
  };

  return (
    <div className={className}>
      <div className="flex justify-between items-center mb-2">
        <span className="text-sm font-medium text-text-secondary select-none">{label}</span>
      </div>

      {value ? (
        <div className="flex items-center gap-2 bg-surface rounded-md p-2">
          <FileImage size={16} className="text-text-secondary flex-shrink-0" />
          <span className="text-sm text-text-primary truncate flex-1" title={lutName || undefined}>
            {lutName}
          </span>
          <button
            onClick={handleClear}
            className="p-1 rounded hover:bg-bg-tertiary text-text-secondary hover:text-text-primary"
            title="Remove LUT"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <button
          onClick={handleSelectFile}
          className="w-full px-3 py-2 text-sm bg-surface rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-tertiary text-left"
        >
          Select LUT file...
        </button>
      )}
    </div>
  );
}
