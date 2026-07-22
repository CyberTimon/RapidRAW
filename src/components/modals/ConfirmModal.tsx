import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../ui/Button';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';

interface ConfirmModalProps {
  cancelText?: string;
  confirmText?: string;
  confirmVariant?: string;
  initialFocus?: 'cancel' | 'confirm';
  isOpen: boolean;
  message?: string;
  onClose(): void;
  onConfirm?(): void;
  title?: string;
}

export default function ConfirmModal({
  cancelText,
  confirmText,
  confirmVariant = 'primary',
  initialFocus = 'confirm',
  isOpen,
  message,
  onClose,
  onConfirm,
  title,
}: ConfirmModalProps) {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  const resolvedCancelText = cancelText || t('modals.confirm.cancel');
  const resolvedConfirmText = confirmText || t('modals.confirm.confirm');

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
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleConfirm = useCallback(() => {
    if (onConfirm) {
      onConfirm();
    }
    onClose();
  }, [onConfirm, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter') {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        handleConfirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        onClose();
      }
    },
    [handleConfirm, onClose],
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
        bg-black/30 backdrop-blur-xs
        transition-opacity duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none
        ${show ? 'opacity-100' : 'opacity-0'}
      `}
      onClick={onClose}
      role="dialog"
    >
      <div
        className={`
          bg-surface rounded-lg shadow-xl p-6 w-full max-w-md
          transform transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transform-none motion-reduce:transition-none
          ${show ? 'scale-100 opacity-100 translate-y-0' : 'scale-[0.97] opacity-0 -translate-y-2'}
        `}
        onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <Text variant={TextVariants.title} id="confirm-modal-title" className="mb-4">
          {title}
        </Text>
        <Text className="mb-6 whitespace-pre-wrap">{message}</Text>
        <div className="flex justify-end gap-3 mt-5">
          <Button
            className="bg-bg-primary shadow-transparent hover:bg-bg-primary text-white shadow-none focus:outline-hidden focus:ring-0"
            autoFocus={initialFocus === 'cancel'}
            onClick={onClose}
            variant="ghost"
            tabIndex={0}
          >
            {resolvedCancelText}
          </Button>
          <Button
            onClick={handleConfirm}
            variant={confirmVariant}
            autoFocus={initialFocus === 'confirm'}
            className="focus:outline-hidden focus:ring-0 focus:ring-offset-0"
          >
            {resolvedConfirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}
