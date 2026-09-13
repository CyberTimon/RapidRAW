import { memo } from 'react';
import { X, Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ExportJob, useExportQueueStore } from '../../store/useExportQueueStore';
import { Status } from './ExportImportProperties';

const filename = (path: string) => path.split(/[\\/]/).pop() || path;

const ExportQueueRow = memo(function ExportQueueRow({ job }: { job: ExportJob }) {
  const { t } = useTranslation();
  const pending = job.status === 'queued';
  const active = job.status === Status.Exporting || job.status === Status.Cancelling;
  const total = job.request.paths.length;
  const percent = job.status === Status.Success ? 100 : Math.min(100, Math.round((job.current / total) * 100));
  const label = t(`export.queue.${job.status}`, {
    defaultValue: {
      queued: 'Queued',
      exporting: 'Exporting',
      cancelling: 'Cancelling',
      cancelled: 'Cancelled',
      success: 'Complete',
      error: 'Failed',
      idle: 'Waiting',
      importing: 'Importing',
    }[job.status],
  });
  const action = active || pending ? t('export.status.cancelExport') : t('export.queue.dismiss', 'Dismiss');
  const destination =
    job.request.exportSettings.destinationType === 'originalFolder'
      ? t('export.queue.originalFolder', 'Original folder')
      : job.request.outputFolderOrFile;
  return (
    <div className="group relative rounded-md bg-bg-secondary text-text-primary px-3 py-2 shadow-md" tabIndex={0}>
      <div className="flex items-center gap-2 text-xs">
        {active && <Loader size={12} className="shrink-0 animate-spin" />}
        <span className="min-w-0 flex-1 truncate">{filename(job.request.paths[0])}</span>
        <span className="shrink-0 text-text-secondary">{label}</span>
        <span className="tabular-nums">
          {job.current}/{total}
        </span>
        <button
          className="rounded p-1 hover:bg-surface focus-visible:outline"
          aria-label={action}
          disabled={job.status === Status.Cancelling}
          onClick={() =>
            active || pending
              ? void useExportQueueStore.getState().cancel(job.id)
              : useExportQueueStore.getState().dismiss(job.id)
          }
        >
          <X size={12} />
        </button>
      </div>
      <div
        role="progressbar"
        aria-label={`${filename(job.request.paths[0])}: ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-1 h-1 overflow-hidden rounded-full bg-surface"
      >
        <div
          className={`h-full transition-[width] ${job.status === Status.Error ? 'bg-red-500' : 'bg-accent'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="hidden group-hover:block group-focus-within:block pt-2 text-xs text-text-secondary break-all space-y-1">
        <p>
          {job.request.outputFormat.toUpperCase()} · {destination}
        </p>
        {job.path && <p>{filename(job.path)}</p>}
        {job.error && <p role="alert">{job.error}</p>}
      </div>
    </div>
  );
});

export default function ExportQueue() {
  const jobs = useExportQueueStore((state) => state.jobs);
  const { t } = useTranslation();
  if (!jobs.length) return null;
  return (
    <section
      aria-label={t('export.queue.title', 'Export queue')}
      className="fixed bottom-4 right-4 z-[100] w-80 max-w-[calc(100vw-2rem)] max-h-[40vh] overflow-y-auto space-y-1 font-sans"
    >
      {jobs.map((job) => (
        <ExportQueueRow key={job.id} job={job} />
      ))}
    </section>
  );
}
