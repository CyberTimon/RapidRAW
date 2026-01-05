interface SwitchProps {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  trackClassName?: string;
  tooltip?: string;
}

export function Switch({
  checked,
  label,
  onChange,
  disabled = false,
  className = '',
  trackClassName,
  tooltip,
}: SwitchProps) {
  const uniqueId = `switch-${label.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <label
      className={`
        flex items-center justify-between
        ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}
        ${className}
      `}
      htmlFor={uniqueId}
      title={tooltip}
    >
      <span className="text-sm text-text-secondary select-none">{label}</span>
      <div className="relative w-10 h-5">
        <input
          checked={checked}
          className="sr-only"
          disabled={disabled}
          id={uniqueId}
          onChange={(e) => !disabled && onChange(e.target.checked)}
          type="checkbox"
        />
        <div
          className={`w-full h-full bg-bg-primary rounded-full shadow-inner ${trackClassName || ''}`}
        />
        <div
          className={`
            absolute top-0.5 w-4 h-4 rounded-full
            ${checked ? 'bg-accent left-[22px]' : 'bg-text-secondary left-0.5'}
          `}
        />
      </div>
    </label>
  );
}

export default Switch;
