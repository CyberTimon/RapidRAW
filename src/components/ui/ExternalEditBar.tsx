import { Check, Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import Button from './Button';
import { ExternalEditSession } from '../../store/useProcessStore';

interface ExternalEditBarProps {
  session: ExternalEditSession;
  isFinishing: boolean;
  errorMessage: string;
  onDone: () => void;
}

export default function ExternalEditBar({ session, isFinishing, errorMessage, onDone }: ExternalEditBarProps) {
  const { t } = useTranslation();
  const outputName = session.output.split(/[\\/]/).pop() || session.output;

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-bg-secondary border border-surface rounded-lg shadow-lg px-4 py-2">
      <span className="text-sm text-text-secondary whitespace-nowrap">
        {t('editor.externalEdit.savesTo')} <span className="text-text-primary">{outputName}</span>
      </span>
      {errorMessage && <span className="text-sm text-red-400 max-w-xs truncate">{errorMessage}</span>}
      <Button onClick={onDone} disabled={isFinishing} className="py-1.5">
        {isFinishing ? <Loader size={16} className="animate-spin" /> : <Check size={16} />}
        {isFinishing ? t('editor.externalEdit.exporting') : t('editor.externalEdit.done')}
      </Button>
    </div>
  );
}
