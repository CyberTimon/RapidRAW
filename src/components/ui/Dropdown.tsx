import { useState, useEffect, useLayoutEffect, useRef, useMemo, CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown } from 'lucide-react';
import Input from './Input';
import Text from './Text';
import { TEXT_COLOR_KEYS, TextColors, TextVariants, TextWeights } from '../../types/typography';
import clsx from 'clsx';

const MENU_GAP = 8;
const MENU_MAX_HEIGHT = 320;
const VIEWPORT_MARGIN = 8;

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
}: DropdownProps<T>) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusOptionOnOpenRef = useRef(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [listMaxHeight, setListMaxHeight] = useState(MENU_MAX_HEIGHT);
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
      const height = Math.min(listRef.current?.scrollHeight ?? 0, MENU_MAX_HEIGHT);
      const spaceBelow = window.innerHeight - trigger.bottom - MENU_GAP - VIEWPORT_MARGIN;
      const spaceAbove = trigger.top - MENU_GAP - VIEWPORT_MARGIN;
      const up = height > spaceBelow && spaceAbove > spaceBelow;
      setOpensUp(up);
      setListMaxHeight(Math.max(0, Math.min(MENU_MAX_HEIGHT, up ? spaceAbove : spaceBelow)));
      setMenuStyle({
        left: trigger.left,
        width: trigger.width,
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

  useEffect(() => {
    if (!isOpen || !focusOptionOnOpenRef.current) return;
    focusOptionOnOpenRef.current = false;
    const optionButtons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [],
    );
    (optionButtons.find((button) => button.getAttribute('aria-selected') === 'true') ?? optionButtons[0])?.focus();
  }, [isOpen]);

  const moveOptionFocus = (key: string) => {
    const optionButtons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [],
    );
    if (optionButtons.length === 0) return;
    const currentIndex = optionButtons.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number;
    if (key === 'Home') nextIndex = 0;
    else if (key === 'End') nextIndex = optionButtons.length - 1;
    else if (key === 'ArrowDown')
      nextIndex = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, optionButtons.length - 1);
    else nextIndex = currentIndex === -1 ? optionButtons.length - 1 : Math.max(currentIndex - 1, 0);
    optionButtons[nextIndex].focus();
  };

  const isPrintableKey = (e: React.KeyboardEvent<Element>): boolean => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    return e.key.length === 1;
  };

  const handleContainerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (isOpen) triggerRef.current?.focus();
      setIsOpen(false);
      return;
    }

    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      if (!isOpen && (e.key === 'Home' || e.key === 'End')) return;
      e.stopPropagation();
      e.preventDefault();
      if (isOpen) {
        moveOptionFocus(e.key);
      } else if (!disabled) {
        focusOptionOnOpenRef.current = true;
        setIsOpen(true);
      }
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

  return (
    <div className={`relative ${className}`} ref={dropdownRef} onKeyDown={handleContainerKeyDown}>
      <button
        ref={triggerRef}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        disabled={disabled}
        className={clsx(
          'w-full border border-border-color rounded-md px-3 mr-4 py-2 flex justify-between items-center text-left disabled:opacity-50 disabled:cursor-not-allowed',
          'focus:ring-accent focus:border-accent focus:outline-hidden focus:ring-2',
          triggerClassName || 'bg-surface',
        )}
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <Text as="span" variant={TextVariants.label} color={TextColors.primary}>
          {selectedOption ? selectedOption.label : placeholder}
        </Text>
        <ChevronDown
          className={`${TEXT_COLOR_KEYS[TextColors.secondary]} transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          size={20}
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
                className="bg-surface/95 backdrop-blur-md rounded-lg shadow-xl p-2 overflow-y-auto overscroll-contain"
                ref={listRef}
                role="listbox"
                style={{ maxHeight: listMaxHeight }}
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
                        'w-full text-left px-3 py-2 rounded-md flex items-center justify-between',
                        'transition-colors duration-150',
                        {
                          'bg-bg-primary': isSelected,
                          'hover:bg-bg-primary': !option.disabled,
                          'opacity-40 cursor-not-allowed': option.disabled,
                        },
                      )}
                      role="option"
                      aria-selected={isSelected}
                    >
                      <Text color={TextColors.primary} weight={isSelected ? TextWeights.semibold : TextWeights.normal}>
                        {option.label}
                      </Text>
                      {isSelected && <Check size={16} className={TEXT_COLOR_KEYS[TextColors.primary]} />}
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
