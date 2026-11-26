import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';

interface SearchFieldProps {
  value: string;
  onChange(value: string): void;
  placeholder: string;
}

export default function SearchField({ value, onChange, placeholder }: SearchFieldProps) {
  const { t } = useTranslation();
  const clear = t('library.folders.tooltips.clearSearch');
  return (
    <div className="relative">
      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none" />
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.stopPropagation();
            onChange('');
          }
        }}
        className="w-full h-9 bg-surface border border-transparent rounded-md pl-9 pr-8 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-hidden truncate"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-card-active"
          data-tooltip={clear}
          aria-label={clear}
        >
          <X size={16} className="text-text-secondary" />
        </button>
      )}
    </div>
  );
}
