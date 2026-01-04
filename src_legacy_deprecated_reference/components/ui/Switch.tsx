import React from 'react';
import clsx from 'clsx';
import { motion } from 'framer-motion';

interface SwitchProps {
  checked: boolean;
  className?: string;
  disabled?: boolean;
  id?: string;
  label: string;
  onChange(val: boolean): any;
  tooltip?: string;
  trackClassName?: string;
}

/**
 * A beautiful, reusable, and accessible toggle switch component.
 *
 * @param {string} label - The text label for the switch.
 * @param {boolean} checked - The current state of the switch.
 * @param {function(boolean): void} onChange - Callback function that receives the new boolean state.
 * @param {boolean} [disabled=false] - Whether the switch is interactive.
 * @param {string} [className=''] - Additional classes for the container.
 * @param {string} [trackClassName] - Custom classes for the switch's background track.
 */
const Switch = ({
  checked,
  className = '',
  disabled = false,
  label,
  onChange,
  tooltip,
  trackClassName,
}: SwitchProps) => {
  const uniqueId = `switch-${label.replace(/\s+/g, '-').toLowerCase()}`;

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
      title={tooltip}
    >
      <span className="text-sm text-text-secondary select-none">{label}</span>
      <div className="relative w-10 h-5">
        <input
          checked={checked}
          className="sr-only"
          disabled={disabled}
          id={uniqueId}
          onChange={(e: any) => !disabled && onChange(e.target.checked)}
          type="checkbox"
        />
        <div
          className={clsx(
            'w-full h-full bg-bg-primary rounded-full shadow-inner',
            trackClassName,
          )}
        ></div>
        <motion.div
          className={clsx(
            'absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-colors',
            {
              'bg-accent': checked,
              'bg-text-secondary': !checked,
            },
          )}
          layout
          transition={spring}
          initial={false}
          animate={{ x: checked ? 20 : 0 }}
        />
      </div>
    </label>
  );
};

export default Switch;