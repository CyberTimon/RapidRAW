import { useCallback, useEffect, useRef, ReactNode } from 'react';
import {
  Dialog,
  Heading,
  Modal as AriaModal,
  ModalOverlay,
} from 'react-aria-components';
import { tv } from 'tailwind-variants';
import { X } from 'lucide-react';
import { Button } from './Button';
import { focusRing } from './aria-utils';

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

const overlayStyles = tv({
  base: [
    'fixed inset-0 z-50 flex items-center justify-center',
    'bg-black/30 backdrop-blur-sm',
    'data-[entering]:animate-in data-[entering]:fade-in duration-200',
    'data-[exiting]:animate-out data-[exiting]:fade-out duration-150',
  ],
});

const modalStyles = tv({
  base: [
    'bg-surface rounded-lg shadow-xl p-6 w-full max-h-[90vh] flex flex-col outline-none',
    'data-[entering]:animate-in data-[entering]:zoom-in-95 data-[entering]:fade-in duration-200',
    'data-[exiting]:animate-out data-[exiting]:zoom-out-95 data-[exiting]:fade-out duration-150',
  ],
  variants: {
    size: {
      sm: 'max-w-sm',
      md: 'max-w-md',
      lg: 'max-w-lg',
      xl: 'max-w-xl',
      full: 'max-w-4xl',
    },
  },
  defaultVariants: {
    size: 'md',
  },
});

const closeButtonStyles = tv({
  base: [
    'p-1 rounded text-text-secondary hover:text-text-primary hover:bg-bg-primary',
    focusRing,
  ],
});

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
  const isDismissable = closeOnBackdropClick || closeOnEscape;

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={isDismissable}
      isKeyboardDismissDisabled={!closeOnEscape}
      className={overlayStyles()}
    >
      <AriaModal className={modalStyles({ size })}>
        <Dialog className="outline-none flex flex-col flex-1 overflow-hidden">
          {({ close }) => (
            <>
              {(title || showCloseButton) && (
                <div className="flex items-center justify-between mb-4">
                  {title && (
                    <Heading
                      slot="title"
                      className="text-lg font-semibold text-text-primary"
                    >
                      {title}
                    </Heading>
                  )}
                  {showCloseButton && (
                    <Button
                      onPress={close}
                      variant="ghost"
                      size="icon-sm"
                      className={closeButtonStyles()}
                      aria-label="Close modal"
                    >
                      <X size={20} />
                    </Button>
                  )}
                </div>
              )}
              <div className="flex-1 overflow-y-auto">{children}</div>
              {footer && <div className="flex justify-end gap-3 mt-5">{footer}</div>}
            </>
          )}
        </Dialog>
      </AriaModal>
    </ModalOverlay>
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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      showCloseButton={false}
      size="md"
    >
      <p className="text-sm text-text-secondary mb-6 whitespace-pre-wrap">{message}</p>
      <div className="flex justify-end gap-3">
        <Button
          className="bg-bg-primary shadow-transparent hover:bg-bg-primary text-white shadow-none"
          onPress={onClose}
          variant="ghost"
        >
          {cancelText}
        </Button>
        <Button onPress={handleConfirm} variant={confirmVariant} autoFocus>
          {confirmText}
        </Button>
      </div>
    </Modal>
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
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      showCloseButton={false}
      size="md"
    >
      <div>
        {label && (
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {label}
          </label>
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
          onPress={onClose}
          variant="ghost"
        >
          {cancelText}
        </Button>
        <Button variant="primary" onPress={handleConfirm}>
          {confirmText}
        </Button>
      </div>
    </Modal>
  );
}
