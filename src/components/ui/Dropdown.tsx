import { useState, useEffect, useLayoutEffect, useRef, useMemo, CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown } from 'lucide-react';
import Input from './Input';
import Text from './Text';
import { TEXT_COLOR_KEYS, TextColors, TextVariants, TextWeights, VariantConfig } from '../../types/typography';
import clsx from 'clsx';

const MENU_GAP = 8;

export interface OptionItem<T extends React.Key> {
  label: string;
  value: T;
  disabled?: boolean;
}

interface DropdownProps<T extends React.Key> {
  className?: string;
  onChange: (value: T) => void;
  options: Array<OptionItem<T>>;
  placeholder?: string;
  searchPlaceholder?: string;
  value: T | null;
  disabled?: boolean;
  triggerClassName?: string;
  textVariant?: VariantConfig;
  chevronSize?: number;
}

const Dropdown = <T extends React.Key>({
  className = '',
  onChange,
  options,
  placeholder = 'Select an option',
  searchPlaceholder = 'Filter options...',
  value,
  disabled = false,
  triggerClassName = '',
  textVariant,
  chevronSize,
}: DropdownProps<T>) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [opensUp, setOpensUp] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const selectedOption = options.find((opt) => opt.value === value) || null;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!dropdownRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setSearchTerm('');
      setShowSearch(false);
    }
  }, [isOpen]);

  const handleSelect = (option: OptionItem<T>) => {
    onChange(option.value);
    setIsOpen(false);
  };

  const filteredOptions = useMemo(() => {
    if (!searchTerm) return options;
    return options.filter((opt) => opt.label.toLowerCase().includes(searchTerm.toLowerCase()));
  }, [options, searchTerm]);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    const place = () => {
      const trigger = dropdownRef.current?.getBoundingClientRect();
      if (!trigger) {
        return;
      }
      const height = menuRef.current?.offsetHeight ?? 0;
      const up = trigger.bottom + MENU_GAP + height > window.innerHeight && trigger.top - MENU_GAP - height >= 0;
      setOpensUp(up);
      const menuWidth = Math.max(trigger.width, 160);
      const maxLeft = window.innerWidth - menuWidth - 8;
      const left = Math.max(8, Math.min(trigger.left, maxLeft));
      setMenuStyle({
        left,
        minWidth: menuWidth,
        width: trigger.width > 160 ? trigger.width : undefined,
        ...(up ? { bottom: window.innerHeight - trigger.top + MENU_GAP } : { top: trigger.bottom + MENU_GAP }),
      });
    };

    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [isOpen, filteredOptions.length, showSearch]);

  const isPrintableKey = (e: React.KeyboardEvent<Element>): boolean => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    return e.key.length === 1;
  };

  const handleContainerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setIsOpen(false);
      return;
    }

    if (e.key === 'Enter') {
      if (isOpen && filteredOptions.length === 1) {
        e.stopPropagation();
        e.preventDefault();
        handleSelect(filteredOptions[0]);
      }
      return;
    }

    if (e.target === searchInputRef.current) return;

    if (isPrintableKey(e)) {
      e.stopPropagation();
      e.preventDefault();

      setIsOpen(true);
      setShowSearch(true);
      setSearchTerm((prev) => prev + e.key);
    }
  };

  const hasCustomPadding = triggerClassName && /(?:^|\s)p[xytb]?-[\d.]+/.test(triggerClassName);
  const hasCustomMargin = triggerClassName && /(?:^|\s)m[xytbrl]?-[\d.]+/.test(triggerClassName);

  return (
    <div className={`relative ${className}`} ref={dropdownRef} onKeyDown={handleContainerKeyDown}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        disabled={disabled}
        className={clsx(
          'w-full border border-border-color rounded-md flex justify-between items-center text-left disabled:opacity-50 disabled:cursor-not-allowed',
          'focus:ring-accent focus:border-accent focus:outline-hidden focus:ring-2',
          !hasCustomPadding && 'px-3 py-2',
          !hasCustomMargin && (triggerClassName ? '' : 'mr-4'),
          triggerClassName || 'bg-surface',
        )}
        onClick={() => setIsOpen(!isOpen)}
        type="button"
        data-tooltip={selectedOption ? selectedOption.label : undefined}
      >
        <Text
          as="span"
          variant={textVariant ?? TextVariants.label}
          color={TextColors.primary}
          className="min-w-0 truncate"
        >
          {selectedOption ? selectedOption.label : placeholder}
        </Text>
        <ChevronDown
          className={`shrink-0 ml-1.5 ${TEXT_COLOR_KEYS[TextColors.secondary]} transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          size={chevronSize ?? 20}
        />
      </button>

      {createPortal(
        <AnimatePresence>
          {isOpen && (
            <motion.div
              ref={menuRef}
              animate={{ opacity: 1, scale: 1 }}
              className={clsx('fixed z-60', opensUp ? 'origin-bottom-right' : 'origin-top-right')}
              data-dropdown-menu
              exit={{ opacity: 0, scale: 0.95 }}
              initial={{ opacity: 0, scale: 0.95 }}
              onMouseDown={(e) => e.stopPropagation()}
              style={menuStyle}
              transition={{ duration: 0.1, ease: 'easeOut' }}
            >
              <div
                aria-orientation="vertical"
                className="bg-surface/95 backdrop-blur-md rounded-lg shadow-xl p-2 max-h-80 overflow-y-auto"
                role="listbox"
              >
                {showSearch && (
                  <Input
                    ref={searchInputRef}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder={searchPlaceholder}
                    autoFocus={true}
                    className="mb-2"
                  />
                )}

                {filteredOptions.map((option: OptionItem<T>) => {
                  const isSelected = value === option.value;
                  return (
                    <button
                      key={option.value}
                      onClick={() => handleSelect(option)}
                      disabled={option.disabled}
                      className={clsx(
                        'w-full text-left px-3 py-2 rounded-md flex items-center justify-between gap-2',
                        'transition-colors duration-150',
                        {
                          'bg-bg-primary': isSelected,
                          'hover:bg-bg-primary': !option.disabled,
                          'opacity-40 cursor-not-allowed': option.disabled,
                        },
                      )}
                      role="option"
                      aria-selected={isSelected}
                      data-tooltip={option.label}
                    >
                      <Text
                        variant={textVariant ?? TextVariants.body}
                        color={TextColors.primary}
                        weight={isSelected ? TextWeights.semibold : TextWeights.normal}
                        className="min-w-0 truncate"
                      >
                        {option.label}
                      </Text>
                      {isSelected && <Check size={16} className={`shrink-0 ${TEXT_COLOR_KEYS[TextColors.primary]}`} />}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
};

export default Dropdown;
