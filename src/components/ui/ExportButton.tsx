import { AnimatePresence, motion } from 'framer-motion';
import { Ban, CheckCircle, Loader, X, XCircle, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Button from './Button';
import { Status } from '../../types/export';

type ExportButtonStatus = `${Status}`;

const STATUS_CLASSES: Partial<Record<ExportButtonStatus | 'warning', string>> = {
  exporting: 'bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/30 shadow-none',
  cancelling: 'bg-yellow-500/20 text-yellow-400 shadow-none',
  success: 'bg-green-500/70 text-white shadow-none',
  warning: 'bg-amber-500/80 text-white shadow-none',
  error: 'bg-red-500/20 text-red-400 shadow-none',
  cancelled: 'bg-yellow-500/20 text-yellow-400 shadow-none',
};

interface ExportButtonProps {
  status: ExportButtonStatus;
  progress: number | null;
  canExport: boolean;
  icon: LucideIcon;
  label: string;
  progressLabel: string;
  successLabel?: string;
  errorLabel?: string;
  warning?: boolean;
  onExport(): void;
  onCancel(): void;
}

export default function ExportButton({
  status,
  progress,
  canExport,
  icon: Icon,
  label,
  progressLabel,
  successLabel,
  errorLabel,
  warning = false,
  onExport,
  onCancel,
}: ExportButtonProps) {
  const { t } = useTranslation();
  const disabled = status === 'cancelling' || (status !== 'exporting' && !canExport);
  const statusClass = STATUS_CLASSES[status === 'success' && warning ? 'warning' : status] ?? '';

  return (
    <motion.div
      whileTap={disabled ? undefined : { scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 400, damping: 17 }}
      className="w-full"
    >
      <Button
        className={`group relative isolate rounded-md h-11 w-full flex items-center text-md font-bold! justify-center transition-colors ${statusClass}`}
        disabled={disabled}
        onClick={status === 'exporting' ? onCancel : onExport}
        size="lg"
      >
        <AnimatePresence>
          {progress !== null && (
            <motion.span
              className="absolute inset-0 -z-10 overflow-hidden rounded-[inherit]"
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <span
                className="block h-full bg-current opacity-15 transition-[width] duration-150"
                style={{ width: `${progress * 100}%` }}
              />
            </motion.span>
          )}
        </AnimatePresence>
        {status === 'exporting' ? (
          <>
            <span className="flex items-center group-hover:hidden">
              <Loader size={18} className="animate-spin mr-2" />
              {progressLabel}
            </span>
            <span className="hidden items-center group-hover:flex">
              <X size={18} className="mr-2" />
              {t('export.status.cancelExport')}
            </span>
          </>
        ) : status === 'cancelling' ? (
          <>
            <Loader size={18} className="animate-spin mr-2" /> {t('export.status.cancelling')}
          </>
        ) : status === 'success' ? (
          <>
            <CheckCircle size={18} className="mr-2" /> {successLabel ?? t('export.status.success')}
          </>
        ) : status === 'error' ? (
          <>
            <XCircle size={18} className="mr-2" /> {errorLabel ?? t('export.status.failed')}
          </>
        ) : status === 'cancelled' ? (
          <>
            <Ban size={18} className="mr-2" /> {t('export.status.cancelled')}
          </>
        ) : (
          <>
            <Icon size={18} className="mr-2" /> {label}
          </>
        )}
      </Button>
    </motion.div>
  );
}
