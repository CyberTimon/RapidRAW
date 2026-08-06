import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Check } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import {
  CaptureDateBatchResult,
  CaptureDateOperation,
  CaptureDateRevertAvailability,
} from '../../hooks/useLibraryActions';

interface CaptureDateModalProps {
  canWriteOriginal: boolean;
  currentDate?: string;
  isOpen: boolean;
  onApply(operation: CaptureDateOperation, writeToOriginal: boolean): Promise<CaptureDateBatchResult>;
  onCheckRevertAvailability(): Promise<CaptureDateRevertAvailability>;
  onClose(): void;
  referencePath: string;
  targetCount: number;
}

type EditMode = 'adjust' | 'shift';

function captureDateParts(value?: string) {
  const match = value?.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return match ? { date: `${match[1]}-${match[2]}-${match[3]}`, time: `${match[4]}:${match[5]}:${match[6]}` } : null;
}

function shiftCaptureDate(value: string | undefined, seconds: number) {
  const parts = captureDateParts(value);
  if (!parts) return null;
  const [year, month, day] = parts.date.split('-').map(Number);
  const [hour, minute, second] = parts.time.split(':').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day, hour, minute, second) + seconds * 1000);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

export default function CaptureDateModal({
  canWriteOriginal,
  currentDate,
  isOpen,
  onApply,
  onCheckRevertAvailability,
  onClose,
  referencePath,
  targetCount,
}: CaptureDateModalProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<EditMode>('adjust');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('00:00:00');
  const [direction, setDirection] = useState<1 | -1>(1);
  const [days, setDays] = useState(0);
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [writeToOriginal, setWriteToOriginal] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [canRevert, setCanRevert] = useState(false);
  const [isCheckingRevert, setIsCheckingRevert] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const parts = captureDateParts(currentDate);
    setMode('adjust');
    setDate(parts?.date || '');
    setTime(parts?.time || '00:00:00');
    setDirection(1);
    setDays(0);
    setHours(0);
    setMinutes(0);
    setSeconds(0);
    setWriteToOriginal(false);
  }, [currentDate, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setCanRevert(false);
    setIsCheckingRevert(true);
    onCheckRevertAvailability()
      .then((availability) => {
        if (!cancelled) setCanRevert(availability.canRevert);
      })
      .catch((error) => {
        if (!cancelled) console.error('Failed to check Capture Date revert availability', error);
      })
      .finally(() => {
        if (!cancelled) setIsCheckingRevert(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, onCheckRevertAvailability]);

  const shiftSeconds = direction * (days * 86400 + hours * 3600 + minutes * 60 + seconds);
  const preview = useMemo(
    () => (mode === 'adjust' ? (date ? `${date} ${time}` : null) : shiftCaptureDate(currentDate, shiftSeconds)),
    [currentDate, date, mode, shiftSeconds, time],
  );
  const normalizedCurrentDate = useMemo(() => {
    const parts = captureDateParts(currentDate);
    return parts ? `${parts.date} ${parts.time}` : null;
  }, [currentDate]);
  const canApply = mode === 'adjust' ? Boolean(date && time && preview !== normalizedCurrentDate) : shiftSeconds !== 0;

  const reportResult = (result: CaptureDateBatchResult) => {
    const sourceFailures = result.updates.filter((update) => update.sourceError);
    if (result.updates.length === 0) {
      result.failures.forEach((failure) =>
        console.error(`Failed to update Capture Date for ${failure.path}: ${failure.error}`),
      );
      toast.error(t('editor.metadata.captureDate.failed'));
      return false;
    }
    if (result.failures.length > 0) {
      toast.warn(
        t('editor.metadata.captureDate.partialSuccess', {
          count: result.updates.length,
          failed: result.failures.length,
        }),
      );
    } else {
      toast.success(t('editor.metadata.captureDate.success', { count: result.updates.length }));
    }
    if (sourceFailures.length > 0) {
      toast.warn(
        t('editor.metadata.captureDate.sourceWriteFailed', {
          count: sourceFailures.length,
        }),
      );
      sourceFailures.forEach((update) =>
        console.error(`Failed to write Capture Date to ${update.path}: ${update.sourceError}`),
      );
    }
    return true;
  };

  const applyOperation = async (operation: CaptureDateOperation, writeOriginal: boolean) => {
    setIsApplying(true);
    try {
      const result = await onApply(operation, writeOriginal);
      if (reportResult(result)) onClose();
    } catch (error) {
      console.error('Failed to update Capture Date', error);
      toast.error(t('editor.metadata.captureDate.failedWithError', { error: String(error) }));
    } finally {
      setIsApplying(false);
    }
  };

  const handleApply = () => {
    if (mode === 'adjust') {
      applyOperation(
        {
          mode: 'adjust',
          referencePath,
          newDate: `${date} ${time}`,
        },
        writeToOriginal,
      );
    } else {
      applyOperation({ mode: 'shift', seconds: shiftSeconds }, writeToOriginal);
    }
  };

  if (!isOpen) return null;

  const numberInput = (label: string, value: number, setValue: (value: number) => void, max: number) => (
    <label className="flex-1 min-w-0">
      <Text as="span" variant={TextVariants.small} color={TextColors.secondary} className="block mb-1">
        {label}
      </Text>
      <input
        className="w-full bg-bg-primary border border-surface rounded-md px-2 py-2 text-sm text-text-primary focus:border-accent outline-hidden"
        max={max}
        min={0}
        onChange={(event) => setValue(Math.max(0, Math.min(max, Number(event.target.value) || 0)))}
        type="number"
        value={value}
      />
    </label>
  );

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs"
      onClick={onClose}
      onKeyDown={(event) => event.key === 'Escape' && onClose()}
      role="dialog"
    >
      <div
        className="bg-surface border border-surface rounded-xl shadow-2xl p-6 w-full max-w-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-1">
          <CalendarClock size={20} className="text-accent" />
          <Text variant={TextVariants.title}>{t('editor.metadata.captureDate.title')}</Text>
        </div>
        <Text variant={TextVariants.small} color={TextColors.secondary} className="mb-5">
          {t('editor.metadata.captureDate.selectionCount', { count: targetCount })}
        </Text>

        <div className="grid grid-cols-2 gap-2 mb-5">
          {(['adjust', 'shift'] as EditMode[]).map((item) => (
            <button
              className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                mode === item ? 'bg-accent text-button-text' : 'bg-bg-primary text-text-secondary hover:bg-card-active'
              }`}
              key={item}
              onClick={() => setMode(item)}
            >
              {t(`editor.metadata.captureDate.${item}`)}
            </button>
          ))}
        </div>

        <Text variant={TextVariants.small} color={TextColors.secondary} className="mb-4">
          {t(
            mode === 'adjust'
              ? targetCount > 1
                ? 'editor.metadata.captureDate.adjustMultipleHint'
                : 'editor.metadata.captureDate.adjustSingleHint'
              : 'editor.metadata.captureDate.shiftHint',
          )}
        </Text>

        {mode === 'adjust' ? (
          <div className="grid grid-cols-2 gap-3 mb-5">
            <label>
              <Text as="span" variant={TextVariants.small} color={TextColors.secondary} className="block mb-1">
                {t('editor.metadata.captureDate.date')}
              </Text>
              <input
                className="w-full bg-bg-primary border border-surface rounded-md px-3 py-2 text-sm text-text-primary focus:border-accent outline-hidden"
                onChange={(event) => setDate(event.target.value)}
                type="date"
                value={date}
              />
            </label>
            <label>
              <Text as="span" variant={TextVariants.small} color={TextColors.secondary} className="block mb-1">
                {t('editor.metadata.captureDate.time')}
              </Text>
              <input
                className="w-full bg-bg-primary border border-surface rounded-md px-3 py-2 text-sm text-text-primary focus:border-accent outline-hidden"
                onChange={(event) => setTime(event.target.value)}
                step={1}
                type="time"
                value={time}
              />
            </label>
          </div>
        ) : (
          <div className="mb-5">
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button
                className={`rounded-md px-3 py-2 text-sm ${direction === 1 ? 'bg-card-active text-text-primary' : 'bg-bg-primary text-text-secondary'}`}
                onClick={() => setDirection(1)}
              >
                {t('editor.metadata.captureDate.forward')}
              </button>
              <button
                className={`rounded-md px-3 py-2 text-sm ${direction === -1 ? 'bg-card-active text-text-primary' : 'bg-bg-primary text-text-secondary'}`}
                onClick={() => setDirection(-1)}
              >
                {t('editor.metadata.captureDate.backward')}
              </button>
            </div>
            <div className="flex gap-2">
              {numberInput(t('editor.metadata.captureDate.days'), days, setDays, 99999)}
              {numberInput(t('editor.metadata.captureDate.hours'), hours, setHours, 23)}
              {numberInput(t('editor.metadata.captureDate.minutes'), minutes, setMinutes, 59)}
              {numberInput(t('editor.metadata.captureDate.seconds'), seconds, setSeconds, 59)}
            </div>
          </div>
        )}

        <div className="rounded-lg bg-bg-primary p-3 mb-5 text-sm">
          <div className="flex justify-between gap-4 mb-1">
            <Text variant={TextVariants.small} color={TextColors.secondary}>
              {t('editor.metadata.captureDate.current')}
            </Text>
            <Text variant={TextVariants.small}>{currentDate || '—'}</Text>
          </div>
          <div className="flex justify-between gap-4">
            <Text variant={TextVariants.small} color={TextColors.secondary}>
              {t('editor.metadata.captureDate.preview')}
            </Text>
            <Text variant={TextVariants.small}>{preview || '—'}</Text>
          </div>
        </div>

        {canWriteOriginal ? (
          <label
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors focus-within:ring-2 focus-within:ring-accent/40 mb-2 ${
              writeToOriginal ? 'border-accent bg-accent/10' : 'border-surface bg-bg-primary hover:bg-card-active'
            }`}
          >
            <input
              checked={writeToOriginal}
              className="sr-only"
              onChange={(event) => setWriteToOriginal(event.target.checked)}
              type="checkbox"
            />
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors ${
                writeToOriginal ? 'border-accent bg-accent text-button-text' : 'border-text-secondary/60 bg-surface'
              }`}
            >
              {writeToOriginal && <Check size={16} strokeWidth={3} />}
            </span>
            <span className="min-w-0">
              <Text as="span" variant={TextVariants.small} className="block font-semibold">
                {t('editor.metadata.captureDate.writeOriginal', { count: targetCount })}
              </Text>
              <Text as="span" variant={TextVariants.small} color={TextColors.secondary} className="block mt-0.5">
                {t('editor.metadata.captureDate.writeOriginalHint', { count: targetCount })}
              </Text>
            </span>
          </label>
        ) : (
          <Text variant={TextVariants.small} color={TextColors.secondary} className="mb-2">
            {t('editor.metadata.captureDate.sidecarOnlyHint')}
          </Text>
        )}

        <div className="flex justify-between gap-3 mt-6">
          <div
            data-tooltip={
              !isCheckingRevert && !canRevert ? t('editor.metadata.captureDate.revertUnavailable') : undefined
            }
          >
            <button
              className="px-3 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isApplying || isCheckingRevert || !canRevert}
              onClick={() => applyOperation({ mode: 'revert' }, false)}
            >
              {t('editor.metadata.captureDate.revert')}
            </button>
          </div>
          <div className="flex gap-2">
            <button
              className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors"
              disabled={isApplying}
              onClick={onClose}
            >
              {t('editor.metadata.captureDate.cancel')}
            </button>
            <button
              className="px-4 py-2 rounded-md bg-accent text-button-text font-semibold hover:bg-accent-hover disabled:opacity-50 transition-colors"
              disabled={!canApply || isApplying}
              onClick={handleApply}
            >
              {isApplying ? t('editor.metadata.captureDate.applying') : t('editor.metadata.captureDate.apply')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
