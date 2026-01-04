import { useBloc } from '@blac/react';
import { Modal } from '../../primitives/Modal';
import { ModalBloc } from '../../blocs/app/ModalBloc';
import { Button } from '../../primitives/Button';

export function ExportProgressModal() {
  const [state, modalBloc] = useBloc(ModalBloc);
  const isOpen = state.openModals.includes('export-progress');
  const data = state.modalData['export-progress'];

  if (!isOpen || !data) return null;

  const { current, total, currentFile } = data;
  const progress = total > 0 ? (current / total) * 100 : 0;
  const isComplete = current >= total;

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {}}
      title={isComplete ? 'Export Complete' : 'Exporting Images'}
      size="sm"
      showCloseButton={isComplete}
      closeOnBackdropClick={false}
      closeOnEscape={isComplete}
    >
      <div className="space-y-4">
        <div className="text-center">
          {isComplete ? (
            <div className="text-green-500 mb-4">
              <svg
                width={48}
                height={48}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="mx-auto"
              >
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>
          ) : (
            <div className="text-accent mb-4">
              <svg
                className="animate-spin mx-auto"
                width={48}
                height={48}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            </div>
          )}
          <p className="text-lg font-medium text-text-primary">
            {isComplete
              ? `Successfully exported ${total} image${total !== 1 ? 's' : ''}`
              : `Exporting ${current} of ${total}`}
          </p>
        </div>

        <div className="space-y-2">
          <div className="h-2 bg-surface-hover rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full"
              style={{ width: `${progress}%` }}
            />
          </div>
          {currentFile && !isComplete && (
            <p className="text-xs text-text-secondary truncate text-center">
              {currentFile.split('/').pop()}
            </p>
          )}
        </div>

        {isComplete && (
          <div className="flex justify-center pt-2">
            <Button variant="primary" onClick={() => modalBloc.close('export-progress')}>
              Done
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
