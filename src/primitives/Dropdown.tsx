import {
  Select,
  SelectValue,
  Button,
  Popover,
  ListBox,
  ListBoxItem,
  type Key,
} from 'react-aria-components';
import { Check, ChevronDown } from 'lucide-react';
import { tv } from 'tailwind-variants';
import { focusRing } from './aria-utils';

export interface DropdownOption<T extends string = string> {
  value: T;
  label: string;
}

interface DropdownProps<T extends string = string> {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

const triggerStyles = tv({
  base: [
    'w-full bg-bg-primary border border-border-color rounded-md px-3 py-2',
    'flex justify-between items-center text-left',
    'transition-colors',
    focusRing,
  ],
  variants: {
    isDisabled: {
      true: 'opacity-50 cursor-not-allowed',
    },
  },
});

const listBoxItemStyles = tv({
  base: [
    'w-full text-left px-3 py-2 text-sm rounded-md flex items-center justify-between cursor-default',
    'text-text-primary outline-none',
  ],
  variants: {
    isFocused: {
      true: 'bg-bg-primary',
    },
    isSelected: {
      true: 'bg-bg-primary font-semibold',
    },
  },
});

export function Dropdown<T extends string = string>({
  value,
  options,
  onChange,
  placeholder = 'Select an option',
  disabled = false,
  className = '',
}: DropdownProps<T>) {
  const handleSelectionChange = (key: Key | null) => {
    if (key !== null) {
      onChange(key as T);
    }
  };

  return (
    <Select
      selectedKey={value}
      onSelectionChange={handleSelectionChange}
      isDisabled={disabled}
      className={`relative ${className}`}
    >
      <Button className={({ isDisabled }) => triggerStyles({ isDisabled })}>
        <SelectValue className="text-text-primary">
          {({ selectedText }) => selectedText || placeholder}
        </SelectValue>
        <ChevronDown
          className="text-text-secondary transition-transform [[data-open]_&]:rotate-180"
          size={20}
        />
      </Button>
      <Popover
        className="w-[--trigger-width] bg-surface/95 backdrop-blur-md rounded-lg shadow-xl p-2 max-h-80 overflow-y-auto"
        offset={8}
      >
        <ListBox items={options.map((opt) => ({ id: opt.value, ...opt }))}>
          {(item) => (
            <ListBoxItem
              id={item.value}
              textValue={item.label}
              className={({ isFocused, isSelected }) =>
                listBoxItemStyles({ isFocused, isSelected })
              }
            >
              {({ isSelected }) => (
                <>
                  <span>{item.label}</span>
                  {isSelected && <Check size={16} />}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}

export default Dropdown;
