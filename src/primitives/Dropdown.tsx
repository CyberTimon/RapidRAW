import { useState, useRef, useEffect } from 'react';

interface DropdownOption<T = string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

interface DropdownProps<T = string> {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function Dropdown<T = string>({
  value,
  options,
  onChange,
  placeholder = 'Select...',
  disabled = false,
  className = '',
}: DropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (option: DropdownOption<T>) => {
    if (option.disabled) return;
    onChange(option.value);
    setIsOpen(false);
  };

  return (
    <div ref={dropdownRef} className={`relative ${className}`}>
      <button
        type="button"
        className={`
          w-full px-3 py-2 rounded-md
          bg-surface border border-border-color
          text-left text-sm
          flex items-center justify-between gap-2
          focus:outline-none focus:ring-2 focus:ring-accent
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-surface/80 cursor-pointer'}
        `}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
      >
        <span className={selectedOption ? 'text-text-primary' : 'text-text-secondary'}>
          {selectedOption?.icon && <span className="mr-2">{selectedOption.icon}</span>}
          {selectedOption?.label || placeholder}
        </span>
        <svg
          className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-bg-primary border border-border-color rounded-md shadow-lg overflow-hidden">
          {options.map((option, index) => (
            <button
              key={index}
              type="button"
              className={`
                w-full px-3 py-2 text-left text-sm
                flex items-center gap-2
                ${option.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-surface cursor-pointer'}
                ${option.value === value ? 'bg-accent/10 text-accent' : 'text-text-primary'}
              `}
              onClick={() => handleSelect(option)}
              disabled={option.disabled}
            >
              {option.icon && <span>{option.icon}</span>}
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
