import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, Loader2, Save, Layers, Map } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import Button from '../ui/Button';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';

interface FocusStackModalProps {
  error: string | null;
  finalImageBase64: string | null;
  depthMapBase64?: string | null;
  imageCount?: number;
  isOpen: boolean;
  isProcessing: boolean;
  loadingImageUrl?: string | null;
  onClose(): void;
  onOpenFile(path: string): void;
  onSave(): Promise<string>;
  onMerge(): void;
  progressMessage: string | null;
}

export default function FocusStackModal({
  error,
  finalImageBase64,
  depthMapBase64,
  imageCount,
  isOpen,
  isProcessing,
  loadingImageUrl,
  onClose,
  onOpenFile,
  onSave,
  onMerge,
  progressMessage,
}: FocusStackModalProps) {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [showDepthMap, setShowDepthMap] = useState(false);

  const mouseDownTarget = useRef<EventTarget | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setSavedPath(null);
        setIsSaving(false);
        setShowDepthMap(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    onClose();
  }, [onClose, isSaving]);

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    mouseDownTarget.current = e.target;
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && mouseDownTarget.current === e.currentTarget) {
      handleClose();
    }
    mouseDownTarget.current = null;
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const path = await onSave();
      setSavedPath(path);
    } catch (e) {
      console.error(e);
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

  const renderContent = () => {
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center py-10 h-[460px]">
          <div className="flex items-center justify-center mb-6">
            <XCircle className="w-12 h-12 text-red-500" />
          </div>
          <Text variant={TextVariants.title} className="mb-2 text-center">
            {t('modals.focusStack.failed')}
          </Text>
          <Text className="text-center p-4 rounded-lg bg-bg-primary max-w-md mt-2 leading-relaxed">
            {String(error)}
          </Text>
        </div>
      );
    }

    if (finalImageBase64 && !isProcessing) {
      const activeSrc = showDepthMap && depthMapBase64 ? depthMapBase64 : finalImageBase64;

      return (
        <div className="w-full flex flex-col items-center">
          <div className="group relative w-full max-h-[500px] bg-[#111] rounded-lg overflow-hidden border border-surface flex items-center justify-center select-none">
            <img
              src={activeSrc}
              alt={showDepthMap ? 'Depth Map' : 'Stacked Focus'}
              className="w-full h-full object-contain max-h-[500px] transition-all duration-200"
              draggable={false}
            />

            {depthMapBase64 && (
              <div
                className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-black/70 backdrop-blur-md p-1.5 rounded-full border border-white/10 shadow-xl z-20 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => setShowDepthMap(false)}
                  className={clsx(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors select-none',
                    !showDepthMap ? 'bg-accent text-button-text' : 'text-white/60 hover:bg-white/10 hover:text-white',
                  )}
                >
                  <Layers size={14} />
                  <span>{t('modals.focusStack.result')}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowDepthMap(true)}
                  className={clsx(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors select-none',
                    showDepthMap ? 'bg-accent text-button-text' : 'text-white/60 hover:bg-white/10 hover:text-white',
                  )}
                >
                  <Map size={14} />
                  <span>{t('modals.focusStack.depthMap')}</span>
                </button>
              </div>
            )}
          </div>

          {savedPath && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
              <Text
                as="div"
                variant={TextVariants.heading}
                color={TextColors.success}
                className="flex items-center justify-center gap-2 mt-4"
              >
                <CheckCircle className="w-5 h-5" />
                <span>{t('modals.focusStack.savedSuccess')}</span>
              </Text>
            </motion.div>
          )}
        </div>
      );
    }

    if (isProcessing) {
      return (
        <div className="flex h-[460px] overflow-hidden rounded-lg border border-surface">
          <div className="w-2/5 relative overflow-hidden shrink-0 bg-[#0a0a0a] flex items-center justify-center">
            {loadingImageUrl ? (
              <img src={loadingImageUrl} alt="Source preview" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-surface/50" />
            )}
          </div>
          <div className="flex-1 flex flex-col items-center justify-center px-12 bg-bg-primary">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1, duration: 0.4 }}
              className="flex flex-col items-center w-full"
            >
              <Text variant={TextVariants.title} className="mb-2 text-center">
                {t('modals.focusStack.stacking')}
              </Text>
              <Text className="text-center font-mono h-6 flex justify-center items-center">
                {progressMessage || t('modals.focusStack.initializing')}
              </Text>
              <div className="mt-8 w-64 relative">
                <div className="h-1 bg-surface rounded-full overflow-hidden relative w-full shadow-xs">
                  <motion.div
                    className="absolute inset-y-0 w-[80%] bg-linear-to-r from-transparent via-accent to-transparent mix-blend-screen"
                    style={{ filter: 'blur(3px)' }}
                    animate={{ x: ['-150%', '150%'] }}
                    transition={{ repeat: Infinity, duration: 1.5, ease: [0.4, 0, 0.2, 1] }}
                  />
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center h-[460px]">
        <div className="flex items-center justify-center mb-6">
          <Layers className="w-12 h-12 text-accent" />
        </div>
        <Text variant={TextVariants.title} className="mb-3 text-center">
          {t('modals.focusStack.title')}
        </Text>
        <Text className="text-center max-w-md leading-relaxed text-text-secondary">
          {imageCount
            ? t('modals.focusStack.descriptionWithCount', { count: imageCount })
            : t('modals.focusStack.description')}
        </Text>
      </div>
    );
  };

  const renderButtons = () => {
    if (error) {
      return (
        <Button onClick={handleClose} className="w-full">
          {t('modals.focusStack.close')}
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
            {t('modals.focusStack.close')}
          </button>
          <Button onClick={handleOpen}>{t('modals.focusStack.openInEditor')}</Button>
        </>
      );
    }

    const disabled = isProcessing || isSaving;

    return (
      <div className={`w-full flex items-center justify-end gap-2 ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <button
          onClick={handleClose}
          className="px-4 py-2 rounded-md text-text-secondary hover:bg-card-active transition-colors text-sm"
        >
          {finalImageBase64 ? t('modals.focusStack.close') : t('modals.focusStack.cancel')}
        </button>

        {!finalImageBase64 && (
          <Button onClick={onMerge} disabled={isProcessing} variant="primary">
            {isProcessing ? <Loader2 className="animate-spin mr-2" size={16} /> : <Layers className="mr-2" size={16} />}
            {t('modals.focusStack.start')}
          </Button>
        )}

        {finalImageBase64 && (
          <Button onClick={handleSave} disabled={isSaving || isProcessing}>
            {isSaving ? <Loader2 className="animate-spin mr-2" size={16} /> : <Save className="mr-2" size={16} />}
            {t('modals.focusStack.save')}
          </Button>
        )}
      </div>
    );
  };

  if (!isMounted) return null;

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/40 backdrop-blur-xs transition-opacity duration-300 ease-in-out ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <AnimatePresence>
        {show && (
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: -16 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: -16 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="bg-surface rounded-xl shadow-2xl p-6 w-full max-w-4xl"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col">
              {renderContent()}
              <div className={`mt-4 flex justify-end gap-3 ${savedPath ? '' : 'pt-4 border-t border-surface/50'}`}>
                {renderButtons()}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
