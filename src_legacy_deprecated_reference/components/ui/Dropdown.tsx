import { useState, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown } from 'lucide-react';

interface DropdownProps {
  className?: string;
  onChange: any;
  options: Array<any>;
  placeholder?: string;
  value: string;
}

export interface OptionItem {
  label: string;
  value: any;
}

export default function Dropdown({
  className = '',
  onChange,
  options,
  placeholder = 'Select an option',
  value,
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<any>(null);
  const selectedOption = options.find((opt: OptionItem) => opt.value === value) || null;

  useEffect(() => {
    const handleClickOutside = (event: any) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleSelect = (option: OptionItem) => {
    onChange(option.value);
    setIsOpen(false);
  };

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className="w-full bg-bg-primary border border-border-color rounded-md px-3 py-2 focus:ring-accent focus:border-accent focus:outline-none focus:ring-2 flex justify-between items-center text-left"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <span className="text-text-primary">{selectedOption ? selectedOption.label : placeholder}</span>
        <ChevronDown
          className={`text-text-secondary transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          size={20}
        />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            animate={{ opacity: 1, scale: 1 }}
            className="absolute right-0 mt-2 w-full origin-top-right z-20"
            exit={{ opacity: 0, scale: 0.95 }}
            initial={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1, ease: 'easeOut' }}
          >
            <div
              aria-orientation="vertical"
              className="bg-surface/95 backdrop-blur-md rounded-lg shadow-xl p-2 max-h-80 overflow-y-auto"
              role="listbox"
            >
              {options.map((option: OptionItem) => {
                const isSelected = value === option.value;
                return (
                  <button
                    key={option.value}
                    onClick={() => handleSelect(option)}
                    className={`
                      w-full text-left px-3 py-2 text-sm rounded-md flex items-center justify-between
                      transition-colors duration-150
                      ${
                        isSelected
                          ? 'bg-bg-primary text-text-primary font-semibold'
                          : 'text-text-primary hover:bg-bg-primary'
                      }
                    `}
                    role="option"
                    aria-selected={isSelected}
                  >
                    <span>{option.label}</span>
                    {isSelected && <Check size={16} />}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
