import { Switch as AriaSwitch } from 'react-aria-components';
import { tv } from 'tailwind-variants';
import { focusRing } from './aria-utils';
import { Tooltip, TooltipTrigger } from './Tooltip';

interface SwitchProps {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  trackClassName?: string;
  tooltip?: string;
}

const switchStyles = tv({
  base: [
    'group flex items-center justify-between',
    'cursor-pointer',
  ],
  variants: {
    isDisabled: {
      true: 'cursor-not-allowed opacity-50',
    },
  },
});

const trackStyles = tv({
  base: [
    'w-10 h-5 bg-bg-primary rounded-full shadow-inner',
    'transition-colors duration-200',
    focusRing,
  ],
});

const thumbStyles = tv({
  base: [
    'absolute top-0.5 w-4 h-4 rounded-full',
    'transition-all duration-200',
  ],
  variants: {
    isSelected: {
      true: 'bg-accent left-[22px]',
      false: 'bg-text-secondary left-0.5',
    },
  },
});

function SwitchInner({
  checked,
  label,
  onChange,
  disabled = false,
  className = '',
  trackClassName,
}: Omit<SwitchProps, 'tooltip'>) {
  return (
    <AriaSwitch
      isSelected={checked}
      onChange={onChange}
      isDisabled={disabled}
      className={({ isDisabled }) => switchStyles({ isDisabled, className })}
    >
      {({ isSelected }) => (
        <>
          <span className="text-sm text-text-secondary select-none">{label}</span>
          <div className={`relative ${trackStyles()} ${trackClassName || ''}`}>
            <div className={thumbStyles({ isSelected })} />
          </div>
        </>
      )}
    </AriaSwitch>
  );
}

export function Switch({ tooltip, ...props }: SwitchProps) {
  if (tooltip) {
    return (
      <TooltipTrigger>
        <SwitchInner {...props} />
        <Tooltip>{tooltip}</Tooltip>
      </TooltipTrigger>
    );
  }
  return <SwitchInner {...props} />;
}

export default Switch;
