import { ParsedTextField } from './ColorField';

interface ValidatedNumberInputProps {
  ariaLabel: string;
  disabled: boolean;
  field: ParsedTextField<number>;
  max?: number;
  background?: string;
}

export default function ValidatedNumberInput({
  ariaLabel,
  disabled,
  field,
  max,
  background = 'bg-surface',
}: ValidatedNumberInputProps) {
  return (
    <input
      aria-label={ariaLabel}
      className={`w-20 ${background} text-center rounded-md p-2 border focus:ring-accent text-text-secondary focus:text-text-primary ${
        field.parsed === null ? 'border-red-500' : 'border-surface focus:border-accent'
      }`}
      disabled={disabled}
      max={max}
      min="0"
      onChange={(e) => field.handleChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      step="any"
      type="number"
      value={field.text}
    />
  );
}
