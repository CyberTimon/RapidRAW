import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { Crosshair, Loader2, X } from 'lucide-react';
import Button from '../ui/Button';
import SegmentedControl from '../ui/SegmentedControl';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import { MotionTrack, Ticks } from '../../types/video';
import { cancelJob, setTrackDirection, setTrackKind, useVideoMotion } from '../../store/videoMotion';
import { TrackDirection, TrackKind } from '../../utils/video/tracking';
import { formatDuration } from '../../utils/video/time';
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
      options={TRACK_KINDS.map((id) => ({ id, label: t(`video.tracking.${id}`) }))}
      value={kind}
      disabled={disabled}
      onChange={setTrackKind}
    />
  );
}

export function Tracker({
  jobKey,
  disabled = false,
  onTrack,
}: {
  jobKey: string;
  disabled?: boolean;
  onTrack(): void;
}) {
  const { t } = useTranslation();
  const { direction, progress, busy, error } = useVideoMotion(
    useShallow((state) => ({
      direction: state.trackDirection,
      progress: state.tracking?.key === jobKey ? state.tracking.progress : null,
      busy: state.tracking !== null || Object.keys(state.aiFollow).length > 0,
      error: state.trackError?.key === jobKey ? state.trackError.message : null,
    })),
  );
  return (
    <div className="space-y-2">
      <SegmentedControl
        options={TRACK_DIRECTIONS.map((id) => ({ id, label: t(`video.tracking.${id}`) }))}
        value={direction}
        disabled={progress !== null}
        onChange={setTrackDirection}
      />
      {progress === null ? (
        <Button className="w-full" disabled={disabled || busy} onClick={onTrack}>
          <Crosshair size={16} />
          {t('video.tracking.track')}
        </Button>
      ) : (
        <JobProgress
          label={t('video.tracking.progress', { percent: Math.round(progress * 100) })}
          progress={progress}
          onCancel={cancelJob}
        />
      )}
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
  span,
  label,
  onRemove,
}: {
  track: MotionTrack | null | undefined;
  span: [Ticks, Ticks] | null;
  label?: string;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  const busy = useVideoMotion((state) => state.tracking !== null);
  if (!track?.keys.length) return null;
  return (
    <div className="flex items-center gap-2">
      <Text variant={TextVariants.small} color={TextColors.secondary} className="flex-1 leading-snug">
        {label ?? t('video.tracking.tracked', { duration: formatDuration(span ? span[1] - span[0] : 0) })}
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
