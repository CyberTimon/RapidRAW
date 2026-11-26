import { ReactNode, Ref, TextareaHTMLAttributes, useRef, useState } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Diamond, type LucideIcon } from 'lucide-react';
import CollapsibleSection from '../../ui/CollapsibleSection';
import Slider, { type SliderScale } from '../../ui/Slider';
import Text from '../../ui/Text';
import { normalizeHexColor, useParsedTextField } from '../../ui/ColorField';
import { TextVariants } from '../../../types/typography';
import { Animated, FrameRate, Ticks, TimelineItem } from '../../../types/video';
import { editProject, getVideo, setPlayhead, useVideoStore } from '../../../store/useVideoStore';
import { updateItem } from '../../../utils/video/edit';
import {
  EaseChoice,
  EasePreset,
  easeAt,
  isAnimated,
  keyAt,
  keysWithin,
  setEaseAt,
  setValueAt,
  toggleKeyAt,
  valueAt,
} from '../../../utils/video/animation';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { SliderKeyframeContext, SliderKeyframes } from '../../../context/SliderKeyframeContext';
import { easeOptions, subscribeShownFrame } from './CurveEditor';
import { formatTimecode, frameTicks, parseTimecode } from '../../../utils/video/time';
import { useShortcut } from '../../../hooks/useShortcuts';
import type { ShortcutAction } from '../../../utils/keyboardUtils';

export const LOG_SCALE: SliderScale = {
  fromPosition: (position) => 2 ** position,
  toPosition: (value) => Math.log2(Math.max(value, 1e-6)),
};

export interface SliderUnit {
  toDisplay(value: number): number;
  fromDisplay(value: number): number;
}

const SAME_UNIT: SliderUnit = { toDisplay: (value) => value, fromDisplay: (value) => value };

export const PERCENT: SliderUnit = { toDisplay: (value) => value * 100, fromDisplay: (value) => value / 100 };

export const editItem = <T extends TimelineItem>(
  id: string,
  mergeKey: string | null,
  patch: Partial<T> | ((item: T) => T),
  edit: typeof editProject = editProject,
) => edit((project) => updateItem<T>(project, id, patch), mergeKey ? `${mergeKey}:${id}` : undefined);

export type AnimatedEdit = (update: (value: Animated) => Animated, merge: boolean) => void;

interface SectionState {
  collapsed: Record<string, boolean>;
  toggle(id: string): void;
}

const useSectionState = create<SectionState>((set) => ({
  collapsed: {},
  toggle: (id) => set((state) => ({ collapsed: { ...state.collapsed, [id]: !state.collapsed[id] } })),
}));

export function InspectorSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const isOpen = useSectionState((state) => !state.collapsed[id]);
  const toggle = useSectionState((state) => state.toggle);
  return (
    <div className="shrink-0">
      <CollapsibleSection
        canToggleVisibility={false}
        isContentVisible
        isOpen={isOpen}
        onToggle={() => toggle(id)}
        title={title}
      >
        {children}
      </CollapsibleSection>
    </div>
  );
}

export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 mb-3">
      <Text variant={TextVariants.label} className="truncate select-none">
        {label}
      </Text>
      <div className="grow basis-24 flex justify-end">{children}</div>
    </div>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('flex items-center gap-1 p-1 bg-bg-primary rounded-md', className)}>{children}</div>;
}

export function ToolbarDivider() {
  return <div className="h-5 w-px bg-surface mx-0.5" />;
}

export function IconToggle({
  icon: Icon,
  label,
  isActive,
  onClick,
  activeClassName = 'bg-accent text-button-text',
  shortcut,
}: {
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  onClick(): void;
  activeClassName?: string;
  shortcut?: ShortcutAction;
}) {
  const shortcutProps = useShortcut(shortcut);
  return (
    <button
      type="button"
      className={clsx(
        'w-7 h-7 shrink-0 flex items-center justify-center rounded-md transition-colors',
        isActive ? activeClassName : 'text-text-secondary hover:bg-surface hover:text-text-primary',
      )}
      onClick={onClick}
      data-tooltip={label}
      aria-label={label}
      aria-pressed={isActive}
      {...shortcutProps}
    >
      <Icon size={15} />
    </button>
  );
}

export function ProgressBar({ progress }: { progress: number }) {
  return (
    <div className="h-1 rounded-full bg-bg-primary overflow-hidden">
      <div
        className="h-full bg-accent transition-[width] duration-150"
        style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
      />
    </div>
  );
}

export function ActionButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  className,
  tooltip,
}: {
  icon: LucideIcon;
  label: string;
  onClick(): void;
  disabled?: boolean;
  className?: string;
  tooltip?: string;
}) {
  return (
    <button
      type="button"
      data-tooltip={tooltip}
      className={clsx(
        'w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-bg-primary text-sm text-text-primary',
        'hover:bg-card-active transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        className,
      )}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={15} />
      <span className="truncate">{label}</span>
    </button>
  );
}

const FIELD_INPUT_CLASS =
  'bg-bg-primary text-center text-sm text-text-primary rounded-md px-1 py-1 border border-surface focus:border-accent focus:outline-hidden';

export function ColorRow({
  label,
  value,
  onChange,
  action,
}: {
  label: string;
  value: string;
  onChange(color: string): void;
  action?: ReactNode;
}) {
  const field = useParsedTextField(value, onChange, normalizeHexColor);
  return (
    <FieldRow label={label}>
      <div className="flex items-center gap-2">
        <input
          className={clsx('w-20', FIELD_INPUT_CLASS)}
          aria-label={label}
          onBlur={field.resetText}
          onChange={(e) => field.handleChange(e.target.value)}
          spellCheck={false}
          type="text"
          value={field.text}
        />
        <input
          className="w-7 h-7 p-0 border-none rounded-sm cursor-pointer bg-transparent"
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
          type="color"
          value={value}
        />
        {action}
      </div>
    </FieldRow>
  );
}

export function TimecodeRow({
  label,
  value,
  fps,
  onChange,
}: {
  label: string;
  value: Ticks;
  fps: FrameRate;
  onChange(value: Ticks): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = () => {
    const parsed = draft === null || cancelled.current ? null : parseTimecode(draft, fps);
    cancelled.current = false;
    setDraft(null);
    if (parsed !== null && parsed !== value) onChange(parsed);
  };
  return (
    <FieldRow label={label}>
      <input
        className={clsx('w-28 tabular-nums', FIELD_INPUT_CLASS)}
        aria-label={label}
        spellCheck={false}
        type="text"
        value={draft ?? formatTimecode(value, fps)}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            event.stopPropagation();
            cancelled.current = true;
            event.currentTarget.blur();
          }
        }}
      />
    </FieldRow>
  );
}

export function AutoTextArea({
  value,
  className,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'className'> & {
  value: string;
  className: string;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  return (
    <div className="grid grid-cols-1">
      <div aria-hidden className={clsx(className, 'invisible whitespace-pre-wrap wrap-break-word [grid-area:1/1]')}>
        {`${value} `}
      </div>
      <textarea
        {...props}
        value={value}
        spellCheck={false}
        className={clsx(className, 'resize-none overflow-hidden [grid-area:1/1]')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur();
        }}
      />
    </div>
  );
}

export function TextBox({
  value,
  placeholder,
  onChange,
  onBlur,
}: {
  value: string;
  placeholder?: string;
  onChange(value: string): void;
  onBlur?(): void;
}) {
  return (
    <div className="mb-3">
      <AutoTextArea
        className={clsx(
          'w-full rounded-md border px-3 py-2 text-sm',
          'bg-bg-primary border-surface text-text-primary placeholder:text-text-secondary',
          'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent',
        )}
        rows={2}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
    </div>
  );
}

const ANIMATED_VALUE = 'value';

const localTime = (playhead: Ticks, start: Ticks, duration: Ticks, frame: Ticks) =>
  Math.min(Math.max(playhead - start, 0), Math.max(0, duration - frame));

export const useAnimatedKeys = (values: Array<Animated>, start: Ticks, duration: Ticks) => {
  const animated = values.some(isAnimated);
  const frame = useVideoStore((state) => (state.project ? frameTicks(state.project.settings.fps) : 1));
  const tolerance = frame / 2;
  const times = [...new Set(values.flatMap((value) => keysWithin(value, duration).map((key) => key.time)))].sort(
    (a, b) => a - b,
  );
  const localAt = (playhead: Ticks) => localTime(playhead, start, duration, frame);
  const { onKey, previous, next } = useVideoStore(
    useShallow((state) => {
      if (!animated) return { onKey: false, previous: undefined, next: undefined };
      const local = localAt(state.playhead);
      return {
        onKey: values.some((value) => keyAt(value, local, tolerance) !== null),
        previous: times.filter((time) => time < local - tolerance).at(-1),
        next: times.find((time) => time > local + tolerance),
      };
    }),
  );
  return {
    animated,
    tolerance,
    onKey,
    now: () => localAt(getVideo().playhead),
    onPrevious: previous === undefined ? null : () => setPlayhead(start + previous),
    onNext: next === undefined ? null : () => setPlayhead(start + next),
  };
};

function KeyframeButton({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="w-4 h-5 flex items-center justify-center text-text-secondary hover:text-text-primary disabled:opacity-30 disabled:pointer-events-none"
      disabled={disabled}
      onClick={onClick}
      data-tooltip={label}
      aria-label={label}
    >
      <Icon size={12} />
    </button>
  );
}

export interface KeyEase {
  current(): EaseChoice | null;
  apply(preset: EasePreset): void;
}

export function KeyframeControls({
  animated,
  onKey,
  onPrevious,
  onNext,
  onToggle,
  ease,
  disabled = false,
  revealOnHover = true,
}: {
  animated: boolean;
  onKey: boolean;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onToggle(): void;
  ease?: KeyEase;
  disabled?: boolean;
  revealOnHover?: boolean;
}) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const toggleLabel = onKey ? t('video.inspector.removeKeyframe') : t('video.inspector.addKeyframe');
  return (
    <>
      {animated && (
        <KeyframeButton
          icon={ChevronLeft}
          label={t('video.inspector.previousKeyframe')}
          disabled={!onPrevious}
          onClick={() => onPrevious?.()}
        />
      )}
      <button
        type="button"
        className={clsx(
          'w-5 h-5 flex items-center justify-center transition-opacity disabled:pointer-events-none',
          animated
            ? 'text-accent'
            : revealOnHover
              ? 'text-text-secondary opacity-0 group-hover/keyframe:opacity-100 focus-visible:opacity-100 hover:text-text-primary'
              : 'text-text-secondary hover:text-text-primary',
        )}
        disabled={disabled}
        onClick={onToggle}
        onContextMenu={(event) => {
          if (!ease || !onKey) return;
          event.preventDefault();
          event.stopPropagation();
          showContextMenu(event.clientX, event.clientY, easeOptions(t, ease.current(), ease.apply));
        }}
        data-tooltip={toggleLabel}
        aria-label={toggleLabel}
        aria-pressed={onKey}
      >
        <Diamond size={11} strokeWidth={2.25} fill={onKey ? 'currentColor' : 'none'} />
      </button>
      {animated && (
        <KeyframeButton
          icon={ChevronRight}
          label={t('video.inspector.nextKeyframe')}
          disabled={!onNext}
          onClick={() => onNext?.()}
        />
      )}
    </>
  );
}

interface AnimatedSliderProps {
  label: string;
  value: Animated;
  start: Ticks;
  duration: Ticks;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit?: SliderUnit;
  suffix?: string;
  minLabel?: string;
  disabled?: boolean;
  fillOrigin?: 'min' | 'default';
  scale?: SliderScale;
  onEdit: AnimatedEdit;
}

export function AnimatedSlider({
  label,
  value,
  start,
  duration,
  min,
  max,
  step,
  defaultValue,
  unit = SAME_UNIT,
  suffix,
  minLabel,
  disabled = false,
  fillOrigin,
  scale,
  onEdit,
}: AnimatedSliderProps) {
  const keys = useAnimatedKeys([value], start, duration);
  const shown = () => (keys.animated ? valueAt(value, keys.now()) : value.value);
  const live: SliderKeyframes = {
    render: () => (
      <div className="absolute top-0 right-14 h-5 pr-1 flex items-center">
        <KeyframeControls
          animated={keys.animated}
          onKey={keys.onKey}
          disabled={disabled}
          onPrevious={keys.onPrevious}
          onNext={keys.onNext}
          onToggle={() => {
            const time = keys.now();
            onEdit((currentValue) => toggleKeyAt(currentValue, time, keys.tolerance), false);
          }}
          ease={{
            current: () => easeAt(value, keys.now(), keys.tolerance),
            apply: (preset) => {
              const time = keys.now();
              onEdit((currentValue) => setEaseAt(currentValue, time, keys.tolerance, preset), false);
            },
          }}
        />
      </div>
    ),
    subscribe: subscribeShownFrame,
    valueOf: () => (keys.animated ? unit.toDisplay(shown()) : undefined),
  };

  return (
    <SliderKeyframeContext.Provider value={live}>
      <Slider
        label={label}
        min={min}
        max={max}
        step={step}
        value={unit.toDisplay(shown())}
        resetKey={ANIMATED_VALUE}
        defaultValue={defaultValue}
        suffix={suffix}
        minLabel={minLabel}
        disabled={disabled}
        fillOrigin={fillOrigin}
        scale={scale}
        onChange={(event) => {
          const target = unit.fromDisplay(Number(event.target.value));
          if (!Number.isFinite(target)) return;
          const time = keys.now();
          const record = getVideo().recordKeyframes;
          onEdit((currentValue) => setValueAt(currentValue, time, target, keys.tolerance, record), true);
        }}
      />
    </SliderKeyframeContext.Provider>
  );
}
