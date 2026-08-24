import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { motion } from 'framer-motion';

interface SegmentedSwitchProps<T extends string | number = string | number> {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  disabled?: boolean;
}

const SegmentedSwitch = <T extends string | number>({
  options,
  value,
  onChange,
  disabled = false,
}: SegmentedSwitchProps<T>) => {
  const [bubbleStyle, setBubbleStyle] = useState<{
    x?: string;
    width?: string;
    opacity: number;
  }>({ opacity: 0 });

  const selectedIndex = options.findIndex((m) => m.id === value);
  const hasSelection = selectedIndex >= 0;

  useEffect(() => {
    const safeIndex = hasSelection ? selectedIndex : 0;
    const widthPercent = 100 / options.length;
    setBubbleStyle({
      x: `${safeIndex * 100}%`,
      width: `${widthPercent}%`,
      opacity: hasSelection ? 1 : 0,
    });
  }, [value, options, hasSelection, selectedIndex]);

  return (
    <div
      className={clsx('w-full bg-bg-primary p-1 rounded-md', {
        'opacity-50 pointer-events-none': disabled,
      })}
    >
      <div className="relative flex w-full">
        <motion.div
          className="absolute top-0 bottom-0 left-0 z-0 bg-card-active shadow-xs"
          style={{ borderRadius: 6 }}
          animate={bubbleStyle}
          initial={false}
          transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
        />
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={disabled}
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
            className={clsx(
              'relative flex-1 flex items-center justify-center px-2 py-1.5 text-xs font-medium rounded-md transition-colors truncate',
              {
                'text-text-secondary hover:text-text-primary': value !== option.id,
                'text-text-primary font-semibold': value === option.id,
              },
            )}
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <span className="relative z-10">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default SegmentedSwitch;
