import { useId } from 'react';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import Text from './Text';
import { TextVariants } from '../../types/typography';

interface SwitchProps {
  checked: boolean;
  className?: string;
  disabled?: boolean;
  id?: string;
  label: string;
  onChange(val: boolean): void;
  tooltip?: string;
}

/**
 * A beautiful, reusable, and accessible toggle switch component.
 *
 * @param {string} label - The text label for the switch.
 * @param {boolean} checked - The current state of the switch.
 * @param {function(boolean): void} onChange - Callback function that receives the new boolean state.
 * @param {boolean} [disabled=false] - Whether the switch is interactive.
 * @param {string} [className=''] - Additional classes for the container.
 */
const Switch = ({
  checked,
  className = '',
  disabled = false,
  id,
  label,
  onChange,
  tooltip,
}: SwitchProps) => {
  const generatedId = useId();
  const uniqueId = id ?? `switch-${generatedId}`;

  const spring = {
    type: 'spring',
    stiffness: 700,
    damping: 30,
  } as const;

  return (
    <label
      className={clsx(
        'flex items-center justify-between',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
      )}
      htmlFor={uniqueId}
      data-tooltip={tooltip}
    >
      <Text variant={TextVariants.label} className="select-none">
        {label}
      </Text>
      <div className="relative h-6 w-11 shrink-0">
        <input
          checked={checked}
          className="peer sr-only"
          disabled={disabled}
          id={uniqueId}
          onChange={(event) => onChange(event.target.checked)}
          role="switch"
          type="checkbox"
        />
        <div
          className={clsx(
            'h-full w-full rounded-full shadow-inner transition-colors duration-200',
            'peer-focus-visible:ring-2 peer-focus-visible:ring-switch-active peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg-primary',
            checked ? 'bg-switch-active' : 'bg-text-secondary/35',
          )}
        />
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm ring-1 ring-black/5"
          transition={spring}
          initial={false}
          animate={{ x: checked ? 20 : 0 }}
        />
      </div>
    </label>
  );
};

export default Switch;
