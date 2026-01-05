import { useCallback, useEffect, useRef, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';

type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: ModalSize;
  showCloseButton?: boolean;
  closeOnBackdropClick?: boolean;
  closeOnEscape?: boolean;
  footer?: ReactNode;
}

const sizeClasses: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  full: 'max-w-4xl',
};

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
  showCloseButton = true,
  closeOnBackdropClick = true,
  closeOnEscape = true,
  footer,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (closeOnEscape && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    },
    [closeOnEscape, onClose]
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (closeOnBackdropClick && e.target === e.currentTarget) {
        onClose();
      }
    },
    [closeOnBackdropClick, onClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
      modalRef.current?.focus();
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-sm"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'modal-title' : undefined}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className={`bg-surface rounded-lg shadow-xl p-6 w-full ${sizeClasses[size]} max-h-[90vh] flex flex-col outline-none`}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || showCloseButton) && (
          <div className="flex items-center justify-between mb-4">
            {title && (
              <h3 id="modal-title" className="text-lg font-semibold text-text-primary">
                {title}
              </h3>
            )}
            {showCloseButton && (
              <button
                onClick={onClose}
                className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-bg-primary"
                aria-label="Close modal"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex justify-end gap-3 mt-5">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: 'primary' | 'destructive';
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  confirmVariant = 'primary',
}: ConfirmModalProps) {
  const handleConfirm = useCallback(() => {
    onConfirm();
    onClose();
  }, [onConfirm, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
      }
    },
    [handleConfirm]
  );

  if (!isOpen) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      <div
        className="bg-surface rounded-lg shadow-xl p-6 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <h3 id="confirm-modal-title" className="text-lg font-semibold text-text-primary mb-4">
          {title}
        </h3>
        <p className="text-sm text-text-secondary mb-6 whitespace-pre-wrap">{message}</p>
        <div className="flex justify-end gap-3 mt-5">
          <Button
            className="bg-bg-primary shadow-transparent hover:bg-bg-primary text-white shadow-none"
            onClick={onClose}
            variant="ghost"
          >
            {cancelText}
          </Button>
          <Button onClick={handleConfirm} variant={confirmVariant} autoFocus>
            {confirmText}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

interface InputModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (value: string) => void;
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmText?: string;
  cancelText?: string;
}

export function InputModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  label,
  placeholder,
  initialValue = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
}: InputModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.value = initialValue;
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isOpen, initialValue]);

  const handleConfirm = useCallback(() => {
    const value = inputRef.current?.value.trim();
    if (value) {
      onConfirm(value);
      onClose();
    }
  }, [onConfirm, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
      }
    },
    [handleConfirm]
  );

  if (!isOpen) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-surface rounded-lg shadow-xl p-6 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-text-primary mb-4">{title}</h3>
        <div>
          {label && (
            <label className="block text-sm font-medium text-text-secondary mb-2">{label}</label>
          )}
          <input
            ref={inputRef}
            type="text"
            className="w-full px-3 py-2 bg-bg-primary border border-border-color rounded-md text-text-primary placeholder-text-secondary focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
            placeholder={placeholder}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="flex justify-end gap-3 mt-5">
          <Button
            className="bg-bg-primary shadow-transparent hover:bg-bg-primary text-white shadow-none"
            onClick={onClose}
            variant="ghost"
          >
            {cancelText}
          </Button>
          <Button variant="primary" onClick={handleConfirm}>
            {confirmText}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
