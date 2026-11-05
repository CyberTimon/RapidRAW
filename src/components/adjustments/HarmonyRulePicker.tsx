import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import type { HarmonyRule } from '../../utils/adjustments';

type RuleOption = { value: HarmonyRule; label: string };

interface Props {
  ariaLabel: string;
  value: HarmonyRule;
  options: RuleOption[];
  onChange: (rule: HarmonyRule) => void;
}

/** Render the accessible rule picker in a portal to avoid clipping by collapsing panels. */
export default function HarmonyRulePicker({ ariaLabel, value, options, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [bounds, setBounds] = useState({ top: 0, left: 0, width: 180, maxHeight: 320 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((item) => item.value === value),
  );

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const availableBelow = window.innerHeight - rect.bottom - 12;
      const desiredHeight = Math.min(340, options.length * 37 + 16);
      const placeAbove = availableBelow < Math.min(220, desiredHeight) && rect.top > availableBelow;
      const height = Math.min(desiredHeight, Math.max(110, placeAbove ? rect.top - 12 : availableBelow));
      setBounds({
        top: placeAbove ? Math.max(6, rect.top - height - 6) : rect.bottom + 6,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
        width: Math.min(rect.width, window.innerWidth - 16),
        maxHeight: height,
      });
    };
    reposition();
    window.addEventListener('resize', reposition);
    const onScroll = (event: Event) => {
      if (popupRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const timer = requestAnimationFrame(() => optionRefs.current[focusedIndex]?.focus());
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      cancelAnimationFrame(timer);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open, focusedIndex]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const show = (index = selectedIndex) => {
    setFocusedIndex(index);
    setOpen(true);
  };

  const handleKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show(event.key === 'ArrowDown' ? selectedIndex : Math.max(0, selectedIndex - 1));
      else setFocusedIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Home' || event.key === 'End') {
      if (open) {
        event.preventDefault();
        setFocusedIndex(event.key === 'Home' ? 0 : options.length - 1);
      }
    } else if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault();
      choose(focusedIndex);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onKeyDown={handleKey}
        onClick={() => (open ? setOpen(false) : show())}
        className="min-w-0 w-full rounded-md border border-border-color bg-bg-secondary px-3 py-2 text-text-primary shadow-sm transition-colors hover:bg-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-left text-sm font-medium text-text-primary">
            {options[selectedIndex]?.label}
          </span>
          <ChevronDown
            size={15}
            className={`shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popupRef}
            id={id}
            role="listbox"
            aria-label={ariaLabel}
            className="fixed z-[9999] overflow-y-auto rounded-lg border border-border-color bg-bg-secondary p-1.5 shadow-2xl"
            style={{ top: bounds.top, left: bounds.left, width: bounds.width, maxHeight: bounds.maxHeight }}
            onKeyDown={handleKey}
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onMouseEnter={() => setFocusedIndex(index)}
                onClick={() => choose(index)}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                  option.value === value
                    ? 'bg-accent/15 font-semibold text-text-primary'
                    : 'text-text-primary hover:bg-bg-tertiary focus:bg-bg-tertiary'
                }`}
              >
                <span className="min-w-0 truncate">{option.label}</span>
                {option.value === value && <Check size={15} className="shrink-0 text-accent" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
