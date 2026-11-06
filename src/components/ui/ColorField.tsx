import { useState, useEffect } from 'react';
import Text from './Text';
import { TextVariants } from '../../types/typography';

export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : null;
}

export interface ParsedTextField<T> {
  text: string;
  parsed: T | null;
  handleChange: (text: string) => void;
  resetText: () => void;
}

export function useParsedTextField<T>(
  value: T,
  onValidChange: (value: T) => void,
  parse: (text: string) => T | null,
): ParsedTextField<T> {
  const [text, setText] = useState<string>(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const handleChange = (next: string) => {
    setText(next);
    const parsed = parse(next);
    if (parsed !== null) onValidChange(parsed);
  };

  return { text, parsed: parse(text), handleChange, resetText: () => setText(String(value)) };
}

interface ColorFieldProps {
  color: string;
  disabled: boolean;
  field: ParsedTextField<string>;
  label: string;
  onColorChange: (color: string) => void;
}

export default function ColorField({ color, disabled, field, label, onColorChange }: ColorFieldProps) {
  return (
    <div>
      <Text variant={TextVariants.label} className="mb-2 block">
        {label}
      </Text>
      <div className="flex items-center gap-2 bg-surface p-2 rounded-md">
        <input
          aria-label={label}
          className="w-8 h-8 p-0 border-none rounded-sm cursor-pointer bg-transparent"
          disabled={disabled}
          onChange={(e) => onColorChange(e.target.value)}
          type="color"
          value={color}
        />
        <input
          className="w-full bg-bg-primary text-center rounded-md p-1 border border-surface focus:border-accent focus:ring-accent"
          disabled={disabled}
          onBlur={field.resetText}
          onChange={(e) => field.handleChange(e.target.value)}
          type="text"
          value={field.text}
        />
      </div>
    </div>
  );
}
