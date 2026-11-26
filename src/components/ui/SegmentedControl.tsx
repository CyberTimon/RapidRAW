import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import { motion, type TargetAndTransition } from 'framer-motion';
import clsx from 'clsx';

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
  tooltip?: string;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  options: Array<SegmentedOption<T>>;
  value: T | null;
  onChange(value: T): void;
  iconOnly?: boolean;
  disabled?: boolean;
  variant?: 'inset' | 'outlined' | 'embedded';
  tone?: 'accent' | 'subtle';
  className?: string;
}

interface Fit {
  columns: number;
  tight: boolean;
}

export const SegmentedIntro = createContext({ current: true });

const PADDING = 24;
const TIGHT_PADDING = 16;

const measures = new WeakMap<Element, () => void>();
const observer = new ResizeObserver((entries) => entries.forEach((entry) => measures.get(entry.target)?.()));

const measureFit = (track: HTMLElement): Fit | null => {
  const buttons = Array.from(track.querySelectorAll<HTMLElement>(':scope > button'));
  const width = track.clientWidth;
  if (!width || buttons.length === 0) return null;
  const widest = Math.max(
    ...buttons.map((button) => {
      const content = button.firstElementChild as HTMLElement;
      const text = content.querySelector('span');
      return content.clientWidth + (text ? text.scrollWidth - text.clientWidth : 0) + 1;
    }),
  );
  const fit = Math.min(buttons.length, Math.max(1, Math.floor(width / (widest + TIGHT_PADDING))));
  const columns = Math.ceil(buttons.length / Math.ceil(buttons.length / fit));
  return { columns, tight: width / columns < widest + PADDING };
};

export default function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  iconOnly = false,
  disabled = false,
  variant = 'inset',
  tone = 'accent',
  className,
}: SegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const intro = useRef(useContext(SegmentedIntro).current);
  const [fit, setFit] = useState<Fit | null>(null);
  const [bubble, setBubble] = useState<TargetAndTransition>({});
  const layoutKey = `${iconOnly}:${options.map((option) => option.label).join('\n')}`;

  const count = options.length;
  const cols = fit?.columns ?? count;
  const rows = Math.ceil(count / cols);
  const index = options.findIndex((option) => option.id === value);
  const column = Math.max(index, 0) % cols;
  const row = Math.floor(Math.max(index, 0) / cols);
  const target = useMemo(
    () => ({
      x: `${column * 100}%`,
      y: `${row * 100}%`,
      width: `${100 / cols}%`,
      height: `${100 / rows}%`,
      opacity: index < 0 ? 0 : 1,
    }),
    [column, row, cols, rows, index],
  );

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const next = measureFit(track);
      if (next) {
        setFit((current) => (current?.columns === next.columns && current.tight === next.tight ? current : next));
      }
    };
    measure();
    measures.set(track, measure);
    observer.observe(track);
    return () => {
      observer.unobserve(track);
      measures.delete(track);
    };
  }, [layoutKey]);

  useEffect(() => {
    if (!fit) return;
    if (intro.current && index >= 0) {
      intro.current = false;
      const from = column === cols - 1 && cols > 1 ? `${cols * 100}%` : '-25%';
      setBubble({ ...target, x: [from, target.x] });
    } else {
      setBubble(target);
    }
  }, [fit, target, cols, column, index]);

  return (
    <div
      className={clsx(
        'w-full',
        variant !== 'embedded' && 'p-1 bg-bg-primary rounded-md',
        variant === 'outlined' && 'border border-border-color',
        disabled && 'opacity-50 pointer-events-none',
        className,
      )}
    >
      <div
        ref={trackRef}
        className="relative grid w-full auto-rows-fr"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {fit && (
          <motion.div
            className={clsx('absolute top-0 left-0 z-0', tone === 'accent' ? 'bg-accent' : 'bg-card-active shadow-sm')}
            style={{ borderRadius: 6 }}
            initial={intro.current ? { y: target.y, height: target.height } : target}
            animate={bubble}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
          />
        )}
        {options.map((option) => {
          const selected = option.id === value;
          const Icon = option.icon;
          return (
            <button
              key={option.id}
              type="button"
              className={clsx(
                'relative min-w-0 flex items-center justify-center py-1.5 text-sm font-medium rounded-md transition-colors',
                fit?.tight ? 'px-2' : 'px-3',
                selected
                  ? tone === 'accent'
                    ? 'text-button-text'
                    : 'text-text-primary'
                  : option.disabled
                    ? 'opacity-50 cursor-not-allowed text-text-secondary'
                    : variant === 'inset'
                      ? 'text-text-secondary hover:text-text-primary hover:bg-surface'
                      : 'text-text-primary hover:bg-surface',
              )}
              style={{ WebkitTapHighlightColor: 'transparent' }}
              disabled={disabled}
              aria-disabled={option.disabled || undefined}
              aria-pressed={selected}
              aria-label={iconOnly ? option.label : undefined}
              data-tooltip={option.tooltip ?? (iconOnly ? option.label : undefined)}
              onClick={() => {
                if (!option.disabled) onChange(option.id);
              }}
            >
              <span className="relative z-10 flex items-center min-w-0">
                {Icon && <Icon size={16} className={clsx('shrink-0', !iconOnly && 'mr-2')} />}
                {!iconOnly && <span className="truncate">{option.label}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
