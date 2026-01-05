import { useState, useEffect, useCallback } from 'react';
import { useBloc } from '@blac/react';
import { CheckCircle, XCircle, Loader2, Save } from 'lucide-react';
import { Modal } from '../../primitives/Modal';
import { Button } from '../../primitives/Button';
import { ModalBloc } from '../../blocs/app/ModalBloc';

export interface PanoramaModalData {
  error: string | null;
  finalImageBase64: string | null;
  progressMessage: string | null;
  onSave: () => Promise<string>;
  onOpenFile: (path: string) => void;
}

export function PanoramaModal() {
  const [state, modalBloc] = useBloc(ModalBloc);
  const isOpen = state.openModals.includes('panorama');
  const data = state.modalData['panorama'] as PanoramaModalData | undefined;

  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSavedPath(null);
      setIsSaving(false);
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    modalBloc.close('panorama');
  }, [modalBloc, isSaving]);

  const handleSave = async () => {
    if (!data) return;
    setIsSaving(true);
    try {
      const path = await data.onSave();
      setSavedPath(path);
    } catch (e) {
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpen = () => {
    if (savedPath && data) {
      data.onOpenFile(savedPath);
      handleClose();
    }
  };

  if (!isOpen || !data) return null;

  const renderContent = () => {
    if (data.error) {
      return (
        <>
          <XCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2 text-center">Panorama Failed</h3>
          <p className="text-sm text-text-secondary text-center p-2 rounded-md max-h-40 overflow-y-auto">
            {String(data.error)}
          </p>
        </>
      );
    }

    if (data.finalImageBase64) {
      return (
        <>
          {savedPath && (
            <>
              <CheckCircle className="w-16 h-16 mx-auto mb-4 text-green-500" />
              <h3 className="text-lg font-semibold text-text-primary mb-4 text-center">Panorama Saved!</h3>
            </>
          )}
          <div className="w-full bg-bg-primary rounded-md overflow-hidden border border-surface">
            <img src={data.finalImageBase64} alt="Stitched Panorama" className="w-full h-full object-contain" />
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
        <p className="text-sm text-text-secondary text-center min-h-[1.25rem]">{data.progressMessage}</p>
      </>
    );
  };

  const renderButtons = () => {
    if (data.error) {
      return <Button onClick={handleClose}>Close</Button>;
    }
    if (savedPath) {
      return (
        <>
          <Button variant="ghost" onClick={handleClose}>
            Close
          </Button>
          <Button onClick={handleOpen}>Open in Editor</Button>
        </>
      );
    }
    if (data.finalImageBase64) {
      return (
        <>
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save size={16} className="mr-2" />}
            {isSaving ? 'Saving...' : 'Save Panorama'}
          </Button>
        </>
      );
    }
    return null;
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Panorama" size="md">
      <div className="flex flex-col">{renderContent()}</div>
      <div className="mt-8 flex justify-end gap-3">{renderButtons()}</div>
    </Modal>
  );
}
