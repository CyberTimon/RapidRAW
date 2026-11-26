import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import {
  AlertTriangle,
  AudioLines,
  Ban,
  Box,
  Captions,
  CircleCheck,
  CircleDashed,
  Clapperboard,
  CloudUpload,
  Copy,
  Crosshair,
  Download,
  FileOutput,
  Focus,
  FolderInput,
  FolderSymlink,
  Gauge,
  Inbox,
  ListX,
  Loader2,
  LucideIcon,
  Mountain,
  Music,
  Pause,
  Play,
  Rewind,
  RotateCcw,
  Sparkles,
  Tags,
  Timer,
  Vibrate,
  X,
} from 'lucide-react';
import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { invoke } from '@tauri-apps/api/core';
import Button from '../../ui/Button';
import Text from '../../ui/Text';
import { usePopover } from '../../../hooks/usePopover';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { isJobActive, isTransferJob, Job, JobKind, JobStatus, useProcessStore } from '../../../store/useProcessStore';
import {
  VideoTask,
  clearFinishedVideoJobs,
  isActiveJob,
  libraryName,
  markVideoJobsSeen,
  useUnseenVideoFailures,
  useVideoTasks,
} from '../../../store/videoIntegration';
import { Invokes } from '../../../types/invokes';
import { Progress } from '../../../types/library';
import { TextColor, TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { formatBytes } from '../../../utils/formatBytes';
import { cancelImmichDownload } from '../../../utils/immichApi';

const POPOVER_WIDTH = 320;
const MAX_LISTED_AI_JOBS = 50;
const ICON_BUTTON_CLASS =
  'shrink-0 p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-primary transition-colors';

const COLLAPSE_ANIMATION = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: 'auto' },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.2, ease: 'easeOut' },
} as const;

const ICON_SWAP_ANIMATION = {
  initial: { opacity: 0, scale: 0.5 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.5 },
  transition: { duration: 0.15 },
} as const;

const JOB_KINDS_WITH_FOLDER = [JobKind.Copy, JobKind.Import, JobKind.Move];

const JOB_ICONS: Record<JobKind, LucideIcon> = {
  [JobKind.AiTagging]: Tags,
  [JobKind.Copy]: Copy,
  [JobKind.Export]: FileOutput,
  [JobKind.ImmichDownload]: Download,
  [JobKind.Import]: FolderInput,
  [JobKind.ModelDownload]: Download,
  [JobKind.Move]: FolderSymlink,
};

const VIDEO_TASK_ICONS: Record<string, LucideIcon> = {
  aiMasks: Sparkles,
  beats: Music,
  captions: Captions,
  depth: Mountain,
  export: FileOutput,
  loudness: AudioLines,
  proxy: Gauge,
  reframe: Focus,
  reverse: Rewind,
  stabilize: Vibrate,
  surfaces: Box,
  timelapse: Timer,
  tracking: Crosshair,
  upload: CloudUpload,
};

const progressFraction = ({ current = 0, total }: Progress) => (total > 0 ? Math.min(current / total, 1) : 0);

const hasStepProgress = ({ current, total }: Progress) => current !== undefined && total > 0;

const formatJobAmount = (job: Job, t: TFunction) =>
  isTransferJob(job.kind)
    ? formatBytes(job.progress.total, t, 1)
    : t('library.jobs.images', { count: job.progress.total });

const formatJobProgress = (job: Job, t: TFunction, language: string) =>
  isTransferJob(job.kind)
    ? formatPercent(progressFraction(job.progress), language)
    : t('library.aiJobs.progress', { current: job.progress.current ?? 0, total: job.progress.total });

const formatRemaining = (seconds: number, language: string) => {
  const [value, unit] =
    seconds < 10
      ? [Math.max(1, Math.ceil(seconds)), 'second']
      : seconds < 60
        ? [Math.ceil(seconds / 5) * 5, 'second']
        : seconds < 3600
          ? [Math.ceil(seconds / 60), 'minute']
          : [Math.round(seconds / 360) / 10, 'hour'];
  return new Intl.NumberFormat(language, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value);
};

const RATE_SETTLE_MS = 1000;

const formatTransfer = ({ progress: { current = 0, total }, transfer }: Job, t: TFunction, language: string) => {
  const rate = transfer && transfer.at - transfer.since >= RATE_SETTLE_MS ? transfer.bytesPerSecond : null;
  const known = total > 0;
  return [
    known
      ? t('library.jobs.transferred', { current: formatBytes(current, t, 1), total: formatBytes(total, t, 1) })
      : formatBytes(current, t, 1),
    rate ? t('library.jobs.rate', { size: formatBytes(rate, t, 1) }) : null,
    rate && known && total > current
      ? t('library.jobs.remaining', { time: formatRemaining((total - current) / rate, language) })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
};

const formatPercent = (fraction: number, language: string) =>
  new Intl.NumberFormat(language, { style: 'percent' }).format(fraction);

const formatRelativeTime = (timestamp: number, language: string) => {
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return format.format(0, 'second');
  if (seconds < 3600) return format.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86400) return format.format(-Math.floor(seconds / 3600), 'hour');
  return format.format(-Math.floor(seconds / 86400), 'day');
};

const copyError = (error: string, t: TFunction) => ({
  tooltip: `${error} · ${t('library.jobs.copyError')}`,
  run: () => navigator.clipboard.writeText(error).then(() => toast.success(t('library.jobs.errorCopied'))),
});

function ProgressBar({ fraction }: { fraction: number }) {
  return (
    <div className="flex-1 h-1 rounded-full bg-bg-primary overflow-hidden">
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
        style={{ width: `${fraction * 100}%` }}
      />
    </div>
  );
}

function ProgressRing({ fraction }: { fraction: number }) {
  const circumference = 2 * Math.PI * 8;
  return (
    <svg className="w-5 h-5 -rotate-90" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="8" fill="none" strokeWidth="2.5" stroke="currentColor" className="opacity-20" />
      <circle
        cx="10"
        cy="10"
        r="8"
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        stroke="currentColor"
        className="text-accent transition-[stroke-dashoffset] duration-300 ease-out"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
      />
    </svg>
  );
}

function SectionTitle({ children, color }: { children: ReactNode; color?: TextColor }) {
  return (
    <Text
      as="div"
      variant={TextVariants.small}
      weight={TextWeights.semibold}
      color={color}
      className="flex-1 truncate uppercase"
    >
      {children}
    </Text>
  );
}

function Count({ children }: { children: ReactNode }) {
  return (
    <Text as="span" variant={TextVariants.small} color={TextColors.secondary} className="tabular-nums">
      {children}
    </Text>
  );
}

function CancelButton({ tooltip, onClick }: { tooltip: string; onClick(): void }) {
  return (
    <button
      className={ICON_BUTTON_CLASS}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      data-tooltip={tooltip}
    >
      <X size={16} />
    </button>
  );
}

const FINISHED_ICONS = {
  success: <CircleCheck size={14} className="text-green-400" />,
  error: <AlertTriangle size={14} className="text-red-400" />,
  cancelled: <Ban size={14} className="text-text-secondary" />,
  busy: <Loader2 size={14} className="animate-spin text-text-secondary" />,
};

interface TaskRowProps {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  isActive: boolean;
  fraction: number | null;
  status?: string;
  trailing: ReactNode;
  action: { tooltip: string; run(): unknown } | null;
  tooltip?: string;
}

function TaskRow({ icon: Icon, title, subtitle, isActive, fraction, status, trailing, action, tooltip }: TaskRowProps) {
  const RowElement = action ? 'button' : 'div';
  return (
    <motion.div className="overflow-hidden shrink-0" {...COLLAPSE_ANIMATION}>
      <div className="px-1 py-0.5">
        <RowElement
          className={clsx(
            'w-full px-3 py-2 rounded-md flex flex-wrap items-center gap-x-3 text-left',
            action && 'cursor-pointer hover:bg-bg-primary transition-colors',
          )}
          onClick={action?.run}
          data-tooltip={action?.tooltip ?? tooltip}
        >
          <Icon size={16} className="shrink-0 text-text-secondary" />
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <Text as="div" color={isActive ? TextColors.primary : TextColors.secondary} className="truncate leading-5">
              {title}
            </Text>
            {subtitle && (
              <Text as="div" variant={TextVariants.small} color={TextColors.secondary} className="truncate leading-4">
                {subtitle}
              </Text>
            )}
            {fraction !== null && (
              <div className="flex items-center h-1 mt-1">
                <ProgressBar fraction={fraction} />
              </div>
            )}
          </div>
          <div className="shrink-0 min-w-7 flex items-center justify-center gap-1">{trailing}</div>
          {status && (
            <Text
              as="div"
              variant={TextVariants.small}
              color={TextColors.secondary}
              className="basis-full pl-7 mt-1.5 truncate leading-4 tabular-nums"
            >
              {status}
            </Text>
          )}
        </RowElement>
      </div>
    </motion.div>
  );
}

const jobCancel = (job: Job, t: TFunction) => {
  if (job.kind === JobKind.Export)
    return { tooltip: t('library.jobs.cancel'), run: () => invoke(Invokes.CancelExport) };
  const { detail } = job;
  if (job.kind === JobKind.ImmichDownload && detail) {
    return {
      tooltip: t('library.jobs.cancelDownload'),
      run: () => {
        useProcessStore.getState().updateJob(job.id, { status: JobStatus.Cancelling });
        return cancelImmichDownload(detail);
      },
    };
  }
  return null;
};

function jobTrailing(job: Job, t: TFunction, language: string) {
  switch (job.status) {
    case JobStatus.Running: {
      const count = hasStepProgress(job.progress) ? <Count>{formatJobProgress(job, t, language)}</Count> : null;
      const cancel = jobCancel(job, t);
      if (cancel) {
        return (
          <>
            <CancelButton tooltip={cancel.tooltip} onClick={cancel.run} />
            {count}
          </>
        );
      }
      return count ?? FINISHED_ICONS.busy;
    }
    case JobStatus.Cancelling:
      return FINISHED_ICONS.busy;
    case JobStatus.Success:
      return FINISHED_ICONS.success;
    case JobStatus.Error:
      return FINISHED_ICONS.error;
    case JobStatus.Cancelled:
      return FINISHED_ICONS.cancelled;
  }
}

function JobRow({ job, onNavigateToFolder }: { job: Job; onNavigateToFolder?(path: string): void }) {
  const { t, i18n } = useTranslation();
  const isActive = isJobActive(job.status);
  const showProgress = isActive && hasStepProgress(job.progress);
  const { detail, error } = job;
  const subtitle = [
    job.status === JobStatus.Cancelling ? t('library.jobs.cancelling') : null,
    !showProgress && job.progress.total > 0 ? formatJobAmount(job, t) : null,
    job.skipped ? t('library.jobs.skipped', { count: job.skipped }) : null,
    detail ? libraryName(detail) : null,
    job.finishedAt !== null ? formatRelativeTime(job.finishedAt, i18n.language) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const action =
    job.status === JobStatus.Error && error
      ? copyError(error, t)
      : isActive || !detail
        ? null
        : job.kind === JobKind.Export
          ? {
              tooltip: t('contextMenus.thumbnail.showExplorer'),
              run: () =>
                invoke(Invokes.ShowInFinder, { path: detail }).catch((err) =>
                  toast.error(t('contextMenus.toasts.couldNotShowExplorer', { err })),
                ),
            }
          : job.status === JobStatus.Success && onNavigateToFolder && JOB_KINDS_WITH_FOLDER.includes(job.kind)
            ? { tooltip: t('library.jobs.openInLibrary'), run: () => onNavigateToFolder(detail) }
            : null;

  return (
    <TaskRow
      icon={JOB_ICONS[job.kind]}
      title={t(`library.jobs.kinds.${job.kind}`)}
      subtitle={subtitle}
      isActive={isActive}
      fraction={showProgress ? progressFraction(job.progress) : null}
      status={
        isActive && isTransferJob(job.kind) && job.progress.current ? formatTransfer(job, t, i18n.language) : undefined
      }
      trailing={jobTrailing(job, t, i18n.language)}
      action={action}
      tooltip={detail ?? undefined}
    />
  );
}

function VideoTaskRow({ task }: { task: VideoTask }) {
  const { t, i18n } = useTranslation();
  const isActive = isActiveJob(task);
  const isQueued = task.state === 'queued';
  const trailing = isActive ? (
    <>
      {task.cancel && <CancelButton tooltip={t('video.jobs.cancel')} onClick={task.cancel} />}
      {!isQueued &&
        (task.progress === null ? FINISHED_ICONS.busy : <Count>{formatPercent(task.progress, i18n.language)}</Count>)}
    </>
  ) : task.state === 'done' ? (
    FINISHED_ICONS.success
  ) : task.state === 'failed' ? (
    FINISHED_ICONS.error
  ) : (
    FINISHED_ICONS.cancelled
  );

  return (
    <TaskRow
      icon={VIDEO_TASK_ICONS[task.kind] ?? Clapperboard}
      title={t(`video.jobs.kinds.${task.kind}`, { defaultValue: task.kind })}
      subtitle={[task.label, isQueued ? t('library.aiJobs.queuedItem') : null].filter(Boolean).join(' · ')}
      isActive={isActive}
      fraction={isActive && !isQueued ? task.progress : null}
      trailing={trailing}
      action={task.state === 'failed' && task.error ? copyError(task.error, t) : null}
    />
  );
}

function AiJobRow({ path, active, children }: { path: string; active?: boolean; children?: ReactNode }) {
  return (
    <motion.div className="overflow-hidden shrink-0" {...COLLAPSE_ANIMATION}>
      <div className="px-1 py-0.5">
        <div
          className={clsx('px-3 py-2 rounded-md flex items-center gap-3 transition-colors', active && 'bg-bg-primary')}
          data-tooltip={path}
        >
          <Text
            as="span"
            color={active ? TextColors.primary : TextColors.secondary}
            className="flex-1 min-w-0 truncate"
          >
            {libraryName(path)}
          </Text>
          <div className="shrink-0 w-20 flex justify-end">{children}</div>
        </div>
      </div>
    </motion.div>
  );
}

function AiJobsSection({ unprocessedPaths }: { unprocessedPaths: string[] }) {
  const { t } = useTranslation();
  const { current, queued, completed, paused, failed } = useProcessStore((state) => state.aiJobs);
  const aiPendingPaths = useProcessStore((state) => state.aiPendingPaths);

  const queuedPaths = useMemo(() => {
    const paths = Object.keys(aiPendingPaths);
    return current ? [current.path, ...paths.filter((path) => path !== current.path)] : paths;
  }, [aiPendingPaths, current]);

  const task = current ? t(`library.aiJobs.kinds.${current.kind}`) : null;
  const statusLabel = paused
    ? current
      ? t('library.aiJobs.pausing')
      : t('library.aiJobs.paused', { remaining: queued })
    : task && current?.maskName
      ? t('library.aiJobs.taskWithMask', { task, mask: current.maskName })
      : (task ?? t('library.aiJobs.waiting'));
  const total = completed + queued;
  const hiddenJobs = Math.max(0, queuedPaths.length - MAX_LISTED_AI_JOBS);

  return (
    <div className="flex flex-col gap-3">
      <div className="px-4 flex items-center gap-1 h-8">
        <SectionTitle>{t('library.aiJobs.title')}</SectionTitle>
        {queued > 0 && (
          <>
            <button
              className={ICON_BUTTON_CLASS}
              onClick={() => invoke(paused ? Invokes.ResumeAiJobs : Invokes.PauseAiJobs)}
              data-tooltip={paused ? t('library.aiJobs.resume') : t('library.aiJobs.pause')}
            >
              {paused ? <Play size={16} /> : <Pause size={16} />}
            </button>
            <button
              className={ICON_BUTTON_CLASS}
              onClick={() => invoke(Invokes.DiscardAiJobs)}
              data-tooltip={t('library.aiJobs.discard')}
            >
              <X size={16} />
            </button>
          </>
        )}
      </div>

      <AnimatePresence initial={false}>
        {queued > 0 && (
          <motion.div key="queue" className="overflow-hidden flex flex-col gap-3" {...COLLAPSE_ANIMATION}>
            <div className="px-4 space-y-2">
              <Text as="div" color={TextColors.primary} className="truncate">
                {statusLabel}
              </Text>
              <div className="flex items-center gap-3">
                <ProgressBar fraction={progressFraction({ current: completed, total })} />
                <Text
                  as="span"
                  variant={TextVariants.small}
                  color={TextColors.secondary}
                  className="shrink-0 w-16 text-right tabular-nums"
                >
                  {t('library.aiJobs.progress', { current: completed, total })}
                </Text>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-4 py-1 uppercase">
                {t('library.aiJobs.queue')}
              </Text>
              <div className="max-h-64 overflow-y-auto custom-scrollbar flex flex-col px-1">
                <AnimatePresence initial={false}>
                  {queuedPaths.slice(0, MAX_LISTED_AI_JOBS).map((path) => {
                    const isCurrent = current?.path === path;
                    return (
                      <AiJobRow key={path} path={path} active={isCurrent}>
                        {isCurrent && !paused ? (
                          FINISHED_ICONS.busy
                        ) : (
                          <Text
                            as="span"
                            variant={TextVariants.small}
                            color={TextColors.secondary}
                            className="truncate"
                          >
                            {paused ? t('library.aiJobs.pausedItem') : t('library.aiJobs.queuedItem')}
                          </Text>
                        )}
                      </AiJobRow>
                    );
                  })}
                </AnimatePresence>
                {hiddenJobs > 0 && (
                  <Text as="div" variant={TextVariants.small} color={TextColors.secondary} className="px-4 py-1">
                    {t('library.aiJobs.more', { moreCount: hiddenJobs })}
                  </Text>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {failed.length > 0 && (
        <div className="flex flex-col gap-1 pt-3 border-t border-border-color/40">
          <div className="px-4 flex items-center gap-3 h-8">
            <SectionTitle color={TextColors.error}>
              {t('library.aiJobs.failed', { failedCount: failed.length })}
            </SectionTitle>
            <button
              className={ICON_BUTTON_CLASS}
              onClick={() => invoke(Invokes.RetryFailedAiJobs)}
              data-tooltip={t('library.aiJobs.retry')}
            >
              <RotateCcw size={16} />
            </button>
          </div>
          <div className="max-h-40 overflow-y-auto custom-scrollbar flex flex-col px-1">
            <AnimatePresence initial={false}>
              {failed.slice(0, MAX_LISTED_AI_JOBS).map((job) => (
                <AiJobRow key={job.path} path={job.path}>
                  <span data-tooltip={job.error} className="text-red-400">
                    <AlertTriangle size={14} />
                  </span>
                </AiJobRow>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      {unprocessedPaths.length > 0 && (
        <div className="px-4 pt-3 flex items-center gap-3 border-t border-border-color/40">
          <CircleDashed size={16} className="shrink-0 text-text-secondary" />
          <Text as="div" color={TextColors.secondary} className="flex-1 min-w-0">
            {t('library.aiJobs.unprocessed', { count: unprocessedPaths.length })}
          </Text>
          <button
            className={ICON_BUTTON_CLASS}
            onClick={() => invoke(Invokes.QueueAiJobs, { paths: unprocessedPaths })}
            data-tooltip={t('library.aiJobs.process')}
          >
            <Play size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

interface JobsMenuProps {
  compact?: boolean;
  onNavigateToFolder?(path: string): void;
}

export const JobsMenu = memo(function JobsMenu({ compact = false, onNavigateToFolder }: JobsMenuProps) {
  const { t, i18n } = useTranslation();
  const jobs = useProcessStore((state) => state.jobs);
  const jobsSeenAt = useProcessStore((state) => state.jobsSeenAt);
  const markJobsSeen = useProcessStore((state) => state.markJobsSeen);
  const clearFinishedJobs = useProcessStore((state) => state.clearFinishedJobs);
  const { queued, completed, paused, failed } = useProcessStore((state) => state.aiJobs);
  const aiPendingPaths = useProcessStore((state) => state.aiPendingPaths);
  const imageList = useLibraryStore((state) => state.imageList);
  const videoTasks = useVideoTasks();
  const unseenVideoFailures = useUnseenVideoFailures();
  const [isOpen, setIsOpen] = useState(false);

  const setOpen = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      markJobsSeen();
      markVideoJobsSeen();
    },
    [markJobsSeen],
  );
  const close = useCallback(() => setOpen(false), [setOpen]);
  const { anchorRef, popoverRef, placement } = usePopover(isOpen, close, POPOVER_WIDTH);

  const unprocessedPaths = useMemo(
    () => imageList.filter((image) => image.needs_ai && !aiPendingPaths[image.path]).map((image) => image.path),
    [imageList, aiPendingPaths],
  );
  const { activeJobs, finishedJobs } = useMemo(() => {
    const sorted = Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt);
    return {
      activeJobs: sorted.filter((job) => isJobActive(job.status)),
      finishedJobs: sorted
        .filter((job) => !isJobActive(job.status))
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)),
    };
  }, [jobs]);
  const activeVideo = useMemo(() => videoTasks.filter(isActiveJob), [videoTasks]);
  const finishedVideo = useMemo(() => videoTasks.filter((task) => !isActiveJob(task)), [videoTasks]);

  const hasAiSection = queued > 0 || failed.length > 0 || unprocessedPaths.length > 0;
  const isAiRunning = queued > 0 && !paused;
  const hasRunning = activeJobs.length > 0 || activeVideo.length > 0;
  const hasFinished = finishedJobs.length > 0 || finishedVideo.length > 0;
  const hasFailures =
    failed.length > 0 ||
    unseenVideoFailures ||
    finishedJobs.some((job) => job.status === JobStatus.Error && (job.finishedAt ?? 0) > jobsSeenAt);

  const progressFractions = [
    ...activeJobs.filter((job) => hasStepProgress(job.progress)).map((job) => progressFraction(job.progress)),
    ...activeVideo.flatMap((task) => (task.progress === null ? [] : [task.progress])),
    ...(isAiRunning ? [progressFraction({ current: completed, total: completed + queued })] : []),
  ];
  const overallProgress =
    progressFractions.length > 0
      ? progressFractions.reduce((sum, fraction) => sum + fraction, 0) / progressFractions.length
      : null;
  const isBusy = hasRunning || isAiRunning;
  const buttonIcon = isBusy
    ? overallProgress !== null
      ? 'progress'
      : 'busy'
    : paused && queued > 0
      ? 'paused'
      : 'idle';

  const buttonTooltip = isBusy
    ? [
        ...activeJobs.map((job) =>
          hasStepProgress(job.progress)
            ? `${t(`library.jobs.kinds.${job.kind}`)} ${formatJobProgress(job, t, i18n.language)}`
            : t(`library.jobs.kinds.${job.kind}`),
        ),
        ...activeVideo.map((task) =>
          [
            t(`video.jobs.kinds.${task.kind}`, { defaultValue: task.kind }),
            task.progress === null ? null : formatPercent(task.progress, i18n.language),
          ]
            .filter(Boolean)
            .join(' '),
        ),
        isAiRunning
          ? `${t('library.aiJobs.title')} ${t('library.aiJobs.progress', { current: completed, total: completed + queued })}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : t('library.jobs.title');

  const idle = compact && !isBusy && !hasFailures && !isOpen;
  const tooltip = isOpen || idle ? undefined : buttonTooltip;

  const icon = (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={buttonIcon} className="absolute flex items-center justify-center" {...ICON_SWAP_ANIMATION}>
        {buttonIcon === 'progress' ? (
          <ProgressRing fraction={overallProgress ?? 0} />
        ) : buttonIcon === 'busy' ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : buttonIcon === 'paused' ? (
          <Pause className="w-5 h-5" />
        ) : (
          <Inbox className="w-4.5 h-4.5" />
        )}
      </motion.div>
    </AnimatePresence>
  );

  const notice = (hasFailures || (!isBusy && unprocessedPaths.length > 0)) && (
    <motion.div
      key="notice"
      className={clsx(
        'absolute rounded-full transition-colors',
        compact ? 'top-1 right-1 w-2 h-2' : 'top-1 right-1 w-2.5 h-2.5',
        hasFailures ? 'bg-red-500' : 'bg-accent',
      )}
      {...ICON_SWAP_ANIMATION}
    />
  );

  return (
    <div ref={anchorRef} className="relative shrink-0">
      {compact ? (
        <button
          className={clsx(
            'relative h-9 w-9 flex items-center justify-center rounded-full bg-surface text-text-primary hover:bg-card-active transition-[background-color,opacity] duration-200',
            isOpen && 'bg-card-active',
            idle && 'opacity-0 pointer-events-none',
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen(!isOpen)}
          data-tooltip={tooltip}
          aria-expanded={isOpen}
          aria-hidden={idle || undefined}
          tabIndex={idle ? -1 : undefined}
        >
          {icon}
          <AnimatePresence initial={false}>{notice}</AnimatePresence>
        </button>
      ) : (
        <Button
          aria-expanded={isOpen}
          aria-haspopup="true"
          className="relative h-12 w-12 bg-surface text-text-primary shadow-none p-0 flex items-center justify-center"
          onClick={() => setOpen(!isOpen)}
          data-tooltip={tooltip}
        >
          {icon}
          <AnimatePresence initial={false}>{notice}</AnimatePresence>
        </Button>
      )}
      {createPortal(
        <AnimatePresence>
          {isOpen && (
            <motion.div
              ref={popoverRef}
              className="fixed z-60 bg-surface/90 backdrop-blur-md rounded-lg shadow-xl"
              style={{ ...placement, width: POPOVER_WIDTH }}
              role="menu"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.1, ease: 'easeOut' }}
            >
              <div className="py-3 flex flex-col gap-3 max-h-[70vh] overflow-y-auto custom-scrollbar">
                {hasRunning && (
                  <div className="flex flex-col gap-1">
                    <div className="px-4 flex items-center h-8">
                      <SectionTitle>{t('library.jobs.active')}</SectionTitle>
                    </div>
                    <div className="flex flex-col px-1">
                      <AnimatePresence initial={false}>
                        {activeJobs.map((job) => (
                          <JobRow key={job.id} job={job} onNavigateToFolder={onNavigateToFolder} />
                        ))}
                        {activeVideo.map((task) => (
                          <VideoTaskRow key={task.id} task={task} />
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                )}

                {hasAiSection && (
                  <div className={clsx(hasRunning && 'pt-3 border-t border-border-color/40')}>
                    <AiJobsSection unprocessedPaths={unprocessedPaths} />
                  </div>
                )}

                {hasFinished && (
                  <div
                    className={clsx(
                      'flex flex-col gap-1',
                      (hasRunning || hasAiSection) && 'pt-3 border-t border-border-color/40',
                    )}
                  >
                    <div className="px-4 flex items-center gap-1 h-8">
                      <SectionTitle>{t('library.jobs.recent')}</SectionTitle>
                      <button
                        className={ICON_BUTTON_CLASS}
                        onClick={() => {
                          clearFinishedJobs();
                          clearFinishedVideoJobs();
                        }}
                        data-tooltip={t('library.jobs.clear')}
                      >
                        <ListX size={16} />
                      </button>
                    </div>
                    <div className="flex flex-col px-1">
                      <AnimatePresence initial={false}>
                        {finishedVideo.map((task) => (
                          <VideoTaskRow key={task.id} task={task} />
                        ))}
                        {finishedJobs.map((job) => (
                          <JobRow key={job.id} job={job} onNavigateToFolder={onNavigateToFolder} />
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                )}

                {!hasAiSection && !hasRunning && !hasFinished && (
                  <div className="px-4 py-4 flex flex-col items-center gap-2 text-center">
                    <Inbox size={24} className="text-text-secondary" />
                    <Text as="div" color={TextColors.primary}>
                      {t('library.jobs.empty')}
                    </Text>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
});
