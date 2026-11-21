import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Redo, Undo } from 'lucide-react';
import clsx from 'clsx';
import { useEditorStore } from '../../../store/useEditorStore';

export default function HistoryPanel() {
  const { t } = useTranslation();
  const history = useEditorStore((s) => s.history);
  const labels = useEditorStore((s) => s.historyLabels);
  const index = useEditorStore((s) => s.historyIndex);
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const goToHistoryIndex = useEditorStore((s) => s.goToHistoryIndex);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector(`[data-history-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!selectedImage) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <span className="text-sm text-text-secondary text-center">{t('ui.history.noImage')}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-3 border-b border-surface shrink-0">
        <span className="text-sm font-medium text-text-secondary select-none">{t('ui.history.title')}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={undo}
            disabled={index <= 0}
            className="p-1.5 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            data-tooltip={t('ui.history.undo')}
          >
            <Undo size={16} />
          </button>
          <button
            onClick={redo}
            disabled={index >= history.length - 1}
            className="p-1.5 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            data-tooltip={t('ui.history.redo')}
          >
            <Redo size={16} />
          </button>
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-0.5">
        {labels.map((label, i) => (
          <button
            key={i}
            data-history-index={i}
            onClick={() => goToHistoryIndex(i)}
            className={clsx(
              'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-xs transition-colors',
              i === index
                ? 'bg-surface text-text-primary'
                : 'text-text-secondary hover:bg-surface/60 hover:text-text-primary',
              i > index && 'opacity-50',
            )}
            data-tooltip={label || t('ui.history.initial')}
          >
            <span className="flex-1 truncate">{label || t('ui.history.initial')}</span>
            <span className="text-[10px] tabular-nums opacity-60">{i}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
