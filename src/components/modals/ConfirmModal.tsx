import { useEffect, useState, useCallback } from 'react';
import { useBloc } from '@blac/react';
import Button from '../ui/Button';
import { ModalsCubit } from '../../cubits';

export default function ConfirmModal() {
  const [modals, modalsCubit] = useBloc(ModalsCubit);
  const { isOpen, title, message, confirmText = 'Confirm', confirmVariant = 'default', onConfirm } = modals.confirm;
  const cancelText = 'Cancel';

  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => {
        setShow(true);
      }, 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    modalsCubit.closeConfirm();
  }, [modalsCubit]);

  const handleConfirm = useCallback(() => {
    if (onConfirm) {
      onConfirm();
    }
    handleClose();
  }, [onConfirm, handleClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        handleConfirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        handleClose();
      }
    },
    [handleConfirm, handleClose],
  );

  if (!isMounted) {
    return null;
  }

  return (
    <div
      aria-labelledby="confirm-modal-title"
      aria-modal="true"
      className={`
        fixed inset-0 flex items-center justify-center z-50 
        bg-black/30 backdrop-blur-sm 
        transition-opacity duration-300 ease-in-out
        ${show ? 'opacity-100' : 'opacity-0'}
      `}
      onClick={handleClose}
      role="dialog"
    >
      <div
        className={`
          bg-surface rounded-lg shadow-xl p-6 w-full max-w-md 
          transform transition-all duration-300 ease-out
          ${show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'}
        `}
        onClick={(e: any) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <h3 id="confirm-modal-title" className="text-lg font-semibold text-text-primary mb-4">
          {title}
        </h3>
        <p className="text-sm text-text-secondary mb-6 whitespace-pre-wrap">{message}</p>
        <div className="flex justify-end gap-3 mt-5">
          <Button
            className="bg-bg-primary shadow-transparent hover:bg-bg-primary text-white shadow-none focus:outline-none focus:ring-0"
      onClick={handleClose}
      variant="ghost"
          >
            {cancelText}
          </Button>
          <Button 
            onClick={handleConfirm} 
            variant={confirmVariant} 
            autoFocus={true}
            className="focus:outline-none focus:ring-0 focus:ring-offset-0"
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}