import { ReactNode } from 'react';
import clsx from 'clsx';

export type TrackToggleTone = 'off' | 'solo' | 'lock';

const ACTIVE: Record<TrackToggleTone, string> = {
  off: 'bg-red-500/80 text-white',
  solo: 'bg-amber-400 text-black',
  lock: 'bg-accent text-button-text',
};

export default function TrackToggle({
  tone,
  active,
  label,
  onClick,
  className,
  children,
}: {
  tone: TrackToggleTone;
  active: boolean;
  label: string;
  onClick(): void;
  className: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={clsx(
        'shrink-0 flex items-center justify-center rounded transition-colors',
        active ? ACTIVE[tone] : 'text-text-secondary hover:text-text-primary hover:bg-card-active',
        className,
      )}
      onClick={onClick}
      data-tooltip={label}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
