import { useCallback, useState, useRef, useEffect } from 'react';
import { COLOR_LABELS, type ColorLabel as ColorLabelType } from '../../types/library';

interface ColorLabelProps {
  value: string | null;
  onChange: (color: string | null) => void;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  showDropdown?: boolean;
}

const sizeConfig = {
  sm: { dotSize: 'w-3 h-3', gap: 'gap-1' },
  md: { dotSize: 'w-4 h-4', gap: 'gap-1.5' },
  lg: { dotSize: 'w-5 h-5', gap: 'gap-2' },
};

export function ColorLabelPicker({
  value,
  onChange,
  size = 'md',
  showLabel = false,
  showDropdown = false,
}: ColorLabelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { dotSize, gap } = sizeConfig[size];

  const selectedLabel = COLOR_LABELS.find((c) => c.name === value);
  const selectableLabels = COLOR_LABELS.filter((c) => c.name !== 'none');

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleClick = useCallback(
    (color: string | null) => {
      onChange(color === value ? null : color);
      setIsOpen(false);
    },
    [onChange, value]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, color: string | null) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick(color);
      }
    },
    [handleClick]
  );

  if (showDropdown) {
    return (
      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={`flex items-center gap-2 px-2 py-1 rounded border border-border-color 
                      hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-accent`}
        >
          {selectedLabel && selectedLabel.name !== 'none' ? (
            <>
              <span
                className={`${dotSize} rounded-full`}
                style={{ backgroundColor: selectedLabel.color }}
              />
              <span className="text-sm text-text-primary capitalize">{selectedLabel.name}</span>
            </>
          ) : (
            <span className="text-sm text-text-secondary">No label</span>
          )}
          <svg
            className="w-4 h-4 text-text-secondary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {isOpen && (
          <div
            className="absolute z-50 mt-1 w-full min-w-[120px] bg-surface border border-border-color 
                       rounded-md shadow-lg overflow-hidden"
          >
            <button
              type="button"
              onClick={() => handleClick(null)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-hover text-left"
            >
              <span className={`${dotSize} rounded-full bg-gray-500`} />
              <span className="text-sm text-text-secondary">No label</span>
            </button>
            {selectableLabels.map((label) => (
              <button
                key={label.name}
                type="button"
                onClick={() => handleClick(label.name)}
                className={`w-full flex items-center gap-2 px-3 py-2 hover:bg-surface-hover text-left
                           ${value === label.name ? 'bg-surface-hover' : ''}`}
              >
                <span className={`${dotSize} rounded-full`} style={{ backgroundColor: label.color }} />
                <span className="text-sm text-text-primary capitalize">{label.name}</span>
                {label.shortcut && (
                  <span className="text-xs text-text-secondary ml-auto">{label.shortcut}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {showLabel && <span className="text-xs text-text-secondary min-w-[40px]">Label</span>}
      <div className={`flex items-center ${gap}`} role="radiogroup" aria-label="Color label">
        {selectableLabels.map((label) => (
          <button
            key={label.name}
            type="button"
            onClick={() => handleClick(label.name)}
            onKeyDown={(e) => handleKeyDown(e, label.name)}
            className={`
              ${dotSize} rounded-full border-2 cursor-pointer
              focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-accent
              ${value === label.name ? 'border-white scale-110' : 'border-transparent hover:scale-110'}
            `}
            style={{ backgroundColor: label.color }}
            role="radio"
            aria-checked={value === label.name}
            aria-label={label.name}
            title={`${label.name}${label.shortcut ? ` (keyboard: ${label.shortcut})` : ''}`}
          />
        ))}
        {value && (
          <button
            type="button"
            onClick={() => handleClick(null)}
            className="ml-1 text-xs text-text-secondary hover:text-text-primary"
            title="Clear label"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

interface CompactColorLabelProps {
  value: string | null;
  size?: 'sm' | 'md';
}

export function CompactColorLabel({ value, size = 'sm' }: CompactColorLabelProps) {
  const label = COLOR_LABELS.find((c) => c.name === value);
  const dotSize = size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3';

  if (!label || label.name === 'none') {
    return null;
  }

  return (
    <span
      className={`${dotSize} rounded-full inline-block`}
      style={{ backgroundColor: label.color }}
      title={`Label: ${label.name}`}
    />
  );
}

interface ColorLabelBadgeProps {
  color: ColorLabelType;
}

export function ColorLabelBadge({ color }: ColorLabelBadgeProps) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
      style={{
        backgroundColor: `${color.color}20`,
        color: color.color,
        borderColor: color.color,
        borderWidth: 1,
      }}
    >
      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color.color }} />
      <span className="capitalize">{color.name}</span>
    </span>
  );
}
