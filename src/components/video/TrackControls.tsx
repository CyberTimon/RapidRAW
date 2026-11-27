import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { Check, Crosshair, Loader2, X } from 'lucide-react';
import Button from '../ui/Button';
import SegmentedControl from '../ui/SegmentedControl';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import { MotionTrack, PinFit, TrackAttach } from '../../types/video';
import { cancelJob, setPendingAttach, setTrackDirection, setTrackKind, useVideoMotion } from '../../store/videoMotion';
import { AttachChoices, SURFACE_ATTACH, attachOf, chosenAttach, isPlanar } from '../../utils/video/maskTracking';
import { TrackDirection, TrackKind } from '../../utils/video/tracking';
import { IconToggle, KeyframeControls, ProgressBar } from './inspector/InspectorControls';
import { RecordToggle } from './RecordingBadge';

const TRACK_DIRECTIONS: Array<TrackDirection> = ['backward', 'both', 'forward'];
const TRACK_KINDS: Array<TrackKind> = ['position', 'planar'];

export function JobProgress({ label, progress, onCancel }: { label: string; progress: number; onCancel?(): void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <Loader2 size={12} className="animate-spin text-text-secondary" />
          <Text variant={TextVariants.small}>{label}</Text>
        </div>
        <ProgressBar progress={progress} />
      </div>
      {onCancel && <IconToggle icon={X} label={t('video.tracking.cancel')} isActive={false} onClick={onCancel} />}
    </div>
  );
}

export function TrackKindControl({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const kind = useVideoMotion((state) => state.trackKind);
  return (
    <SegmentedControl
      options={TRACK_KINDS.map((id) => ({
        id,
        label: t(`video.tracking.${id}`),
        tooltip: t(`video.tracking.${id}Tip`),
      }))}
      value={kind}
      disabled={disabled}
      onChange={setTrackKind}
    />
  );
}

export function ChoiceRow<T extends string>({
  label,
  options,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  options: Array<{ id: T; label: string; tooltip?: string }>;
  value: T;
  disabled?: boolean;
  onChange(value: T): void;
}) {
  return (
    <div className="space-y-1.5">
      <Text variant={TextVariants.small} color={TextColors.secondary} className="block">
        {label}
      </Text>
      <SegmentedControl options={options} value={value} disabled={disabled} onChange={onChange} />
    </div>
  );
}

export const useAttachChoice = (
  key: string,
  track: MotionTrack | null | undefined,
  choices: AttachChoices,
  apply: (attach: TrackAttach) => void,
) => {
  const surface = useVideoMotion((state) => state.trackKind === 'planar');
  const pending = useVideoMotion((state) => state.pendingAttach[key]);
  return {
    options: surface ? choices.surface : choices.object,
    value: chosenAttach(choices, surface, pending, track?.keys.length ? attachOf(track) : null),
    choose: (attach: TrackAttach) => {
      if (track?.keys.length && (isPlanar(track) || !SURFACE_ATTACH.includes(attach))) {
        apply(attach);
        setPendingAttach(key, null);
      } else setPendingAttach(key, attach);
    },
  };
};

export function AttachControl({
  options,
  value,
  disabled,
  onChange,
}: {
  options: Array<TrackAttach>;
  value: TrackAttach;
  disabled?: boolean;
  onChange(attach: TrackAttach): void;
}) {
  const { t } = useTranslation();
  return (
    <ChoiceRow
      label={t('video.tracking.attach.title')}
      options={options.map((id) => ({
        id,
        label: t(`video.tracking.attach.${id}`),
        tooltip: t(`video.tracking.attach.${id}Tip`),
      }))}
      value={value}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

const PIN_FITS: Array<PinFit> = ['fill', 'fit', 'stretch'];

export function PinFitControl({ value, onChange }: { value: PinFit; onChange(fit: PinFit): void }) {
  const { t } = useTranslation();
  return (
    <ChoiceRow
      label={t('video.tracking.fit.title')}
      options={PIN_FITS.map((id) => ({
        id,
        label: t(`video.tracking.fit.${id}`),
        tooltip: t(`video.tracking.fit.${id}Tip`),
      }))}
      value={value}
      onChange={onChange}
    />
  );
}

export interface TrackJob {
  key: string;
  label?: string;
  done?: string | null;
  disabled?: boolean;
  onTrack(): void;
  onRemove?(): void;
}

export function Tracker({ jobs }: { jobs: Array<TrackJob> }) {
  const { t } = useTranslation();
  const keys = jobs.map((job) => job.key);
  const { direction, running, progress, busy, error } = useVideoMotion(
    useShallow((state) => {
      const own = state.tracking && keys.includes(state.tracking.key) ? state.tracking : null;
      return {
        direction: state.trackDirection,
        running: own?.key ?? null,
        progress: own?.progress ?? null,
        busy: state.tracking !== null || Object.keys(state.aiFollow).length > 0,
        error: state.trackError && keys.includes(state.trackError.key) ? state.trackError.message : null,
      };
    }),
  );
  return (
    <div className="space-y-2">
      <SegmentedControl
        options={TRACK_DIRECTIONS.map((id) => ({ id, label: t(`video.tracking.${id}`) }))}
        value={direction}
        disabled={running !== null}
        onChange={setTrackDirection}
      />
      <div className="flex gap-2">
        {jobs.map((job) => (
          <div key={job.key} className="flex-1 min-w-0 flex items-center gap-1">
            {running === job.key ? (
              <Button
                className="group flex-1 min-w-0 bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/30 transition-colors"
                onClick={() => void cancelJob()}
              >
                <span className="flex items-center justify-center min-w-0 group-hover:hidden">
                  <Loader2 size={16} className="animate-spin mr-2 shrink-0" />
                  <span className="truncate">
                    {t('video.tracking.progress', { percent: Math.round((progress ?? 0) * 100) })}
                  </span>
                </span>
                <span className="hidden items-center justify-center min-w-0 group-hover:flex">
                  <X size={16} className="mr-2 shrink-0" />
                  <span className="truncate">{t('video.tracking.cancel')}</span>
                </span>
              </Button>
            ) : job.done ? (
              <div className="flex-1 min-w-0 flex items-center justify-center gap-2 py-2 px-3 rounded-md bg-card-active text-text-secondary text-md font-semibold select-none">
                <Check size={16} className="shrink-0" />
                <span className="truncate">{job.done}</span>
              </div>
            ) : (
              <Button className="flex-1 min-w-0" disabled={job.disabled || busy} onClick={job.onTrack}>
                <Crosshair size={16} className="shrink-0" />
                <span className="truncate">{job.label ?? t('video.tracking.track')}</span>
              </Button>
            )}
            {job.onRemove && !busy && (
              <IconToggle icon={X} label={t('video.tracking.remove')} isActive={false} onClick={job.onRemove} />
            )}
          </div>
        ))}
      </div>
      {error && (
        <Text variant={TextVariants.small} className="block text-red-400 leading-snug">
          {error}
        </Text>
      )}
    </div>
  );
}

export function TrackedRow({
  track,
  label,
  onRemove,
}: {
  track: MotionTrack | null | undefined;
  label: string;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  const busy = useVideoMotion((state) => state.tracking !== null);
  if (!track?.keys.length) return null;
  return (
    <div className="flex items-center gap-2">
      <Text variant={TextVariants.small} color={TextColors.secondary} className="flex-1 leading-snug">
        {label}
      </Text>
      {!busy && (
        <button type="button" className="shrink-0 text-sm text-accent hover:underline" onClick={onRemove}>
          {t('video.tracking.remove')}
        </button>
      )}
    </div>
  );
}

export function KeyframesRow({
  label,
  animated,
  onKey,
  onPrevious,
  onNext,
  onToggle,
}: {
  label: string;
  animated: boolean;
  onKey: boolean;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onToggle(): void;
}) {
  return (
    <div className="flex items-center gap-1 pt-1">
      <Text variant={TextVariants.small} color={TextColors.secondary} className="flex-1">
        {label}
      </Text>
      <RecordToggle />
      <KeyframeControls
        animated={animated}
        onKey={onKey}
        onPrevious={onPrevious}
        onNext={onNext}
        onToggle={onToggle}
        revealOnHover={false}
      />
    </div>
  );
}
