import clsx from 'clsx';
import { Ban, Flag, Minus, Star } from 'lucide-react';

export type CullingPillMode = 'rate' | 'flag';

interface CullingPillProps {
  mode: CullingPillMode;
  value: number;
  visible: boolean;
}

const FLAG_SLOTS = [
  { value: 1, Icon: Flag, activeClass: 'bg-accent text-button-text', iconClass: 'fill-current' },
  { value: 0, Icon: Minus, activeClass: 'bg-white/25 text-white', iconClass: '' },
  { value: -1, Icon: Ban, activeClass: 'bg-accent text-button-text', iconClass: '' },
];

export default function CullingPill({ mode, value, visible }: CullingPillProps) {
  return (
    <div
      className={clsx(
        'absolute top-1/2 -translate-y-1/2 z-20 pointer-events-none select-none',
        'flex flex-col items-center gap-1 rounded-full bg-black/60 backdrop-blur-md p-1.5 shadow-lg',
        'transition-opacity duration-150 ease-out',
        mode === 'rate' ? 'left-20' : 'right-20',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      {mode === 'rate' ? (
        <>
          {[5, 4, 3, 2, 1].map((star) => (
            <div key={star} className="w-11 h-11 flex items-center justify-center">
              <Star
                size={28}
                className={clsx(
                  'transition-colors duration-100',
                  star <= value ? 'text-accent fill-accent' : 'text-white/40',
                )}
              />
            </div>
          ))}
          <div className="w-11 h-7 flex items-center justify-center text-base font-semibold text-white tabular-nums">
            {value}
          </div>
        </>
      ) : (
        FLAG_SLOTS.map(({ value: slotValue, Icon, activeClass, iconClass }) => (
          <div
            key={slotValue}
            className={clsx(
              'w-11 h-11 rounded-full flex items-center justify-center transition-colors duration-100',
              slotValue === value ? activeClass : 'text-white/40',
            )}
          >
            <Icon size={22} className={slotValue === value ? iconClass : ''} />
          </div>
        ))
      )}
    </div>
  );
}
