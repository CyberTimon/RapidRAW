import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, XCircle, Loader2, Save } from 'lucide-react';
import Button from '../ui/Button';

interface PanoramaModalProps {
  error: string | null;
  finalImageBase64: string | null;
  isOpen: boolean;
  onClose(): void;
  onOpenFile(path: string): void;
  onSave(): Promise<string>;
  progressMessage: string | null;
}

export default function PanoramaModal({
  error,
  finalImageBase64,
  isOpen,
  onClose,
  onOpenFile,
  onSave,
  progressMessage,
}: PanoramaModalProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setIsSaving(false);
        setSavedPath(null);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    if (isSaving) {
      return;
    }
    onClose();
  }, [onClose, isSaving]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const path = await onSave();
      setSavedPath(path);
    } catch (e) {
      // Error handling can be added here if needed
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpen = () => {
    if (savedPath) {
      onOpenFile(savedPath);
      handleClose();
    }
  };

  const handleKeyDown = useCallback(
    (e: any) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    },
    [handleClose],
  );

  const renderContent = () => {
    if (error) {
      return (
        <>
          <XCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2 text-center">Panorama Failed</h3>
          <p className="text-sm text-text-secondary text-center p-2 rounded-md max-h-40 overflow-y-auto">
            {String(error)}
          </p>
        </>
      );
    }

    if (finalImageBase64) {
      return (
        <>
          {savedPath && (
            <>
              <CheckCircle className="w-16 h-16 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-text-primary mb-4 text-center">Panorama Saved!</h3>
            </>
          )}
          <div className="w-full bg-bg-primary rounded-md overflow-hidden border border-surface">
            <img src={finalImageBase64} alt="Stitched Panorama" className="w-full h-full object-contain" />
          </div>
        </>
      );
    }

    return (
      <>
        <div className="w-16 h-16 mx-auto mb-4">
          <Loader2 className="w-16 h-16 text-accent animate-spin" />
        </div>
        <h3 className="text-lg font-semibold text-text-primary mb-2 text-center">Stitching Panorama</h3>
        <p className="text-sm text-text-secondary text-center min-h-[1.25rem]">{progressMessage}</p>
      </>
    );
  };

  const renderButtons = () => {
    if (error) {
      return (
        <Button onClick={handleClose} className="w-full">
          Close
        </Button>
      );
    }
    if (savedPath) {
      return (
        <>
          <button
            onClick={handleClose}
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors"
          >
            Close
          </button>
          <Button onClick={handleOpen}>Open in Editor</Button>
        </>
      );
    }
    if (finalImageBase64) {
      return (
        <>
          <button
            onClick={handleClose}
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors"
          >
            Cancel
          </button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="animate-spin mr-2" /> : <Save size={16} className="mr-2" />}
            {isSaving ? 'Saving...' : 'Save Panorama'}
          </Button>
        </>
      );
    }
    return null;
  };

  if (!isMounted) {
    return null;
  }

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-sm transition-opacity duration-300 ease-in-out ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`bg-surface rounded-lg shadow-xl p-6 w-full max-w-xl transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <div className="flex flex-col">
          {renderContent()}
          <div className="mt-8 flex justify-end gap-3">{renderButtons()}</div>
        </div>
      </div>
    </div>
  );
}
