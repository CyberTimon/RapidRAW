import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Maximize2, XCircle, FolderOpen } from 'lucide-react';
import { listen, type Event } from '@tauri-apps/api/event';
import Button from '../ui/Button';
import Dropdown from '../ui/Dropdown';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';

interface UpscaleModalProps {
  isOpen: boolean;
  onClose(): void;
  onUpscale(scale: number): void;
  onOpenFile(path: string): void;
  error: string | null;
  isProcessing: boolean;
  percent: number;
  results: string[];
  targetPaths: string[];
}

const SCALE_OPTIONS = [
  { label: '2×', value: 2 },
  { label: '4×', value: 4 },
];

export default function UpscaleModal({
  isOpen,
  onClose,
  onUpscale,
  onOpenFile,
  error,
  isProcessing,
  percent,
  results,
  targetPaths,
}: UpscaleModalProps) {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [scale, setScale] = useState(2);
  const [livePercent, setLivePercent] = useState(0);
  const isBatch = targetPaths.length > 1;

  useEffect(() => {
    const unlisten = listen<{ percent?: number }>('upscale-progress', (e: Event<{ percent?: number }>) => {
      setLivePercent(Number(e?.payload?.percent) || 0);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      setLivePercent(0);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    }
    setShow(false);
    const timer = setTimeout(() => setIsMounted(false), 300);
    return () => clearTimeout(timer);
  }, [isOpen]);

  if (!isMounted) return null;

  const shownPercent = isProcessing ? Math.max(percent, livePercent) : percent;

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/40 backdrop-blur-xs transition-opacity duration-300 ease-in-out ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isProcessing) onClose();
      }}
    >
      <div
        className={`bg-surface rounded-xl shadow-2xl p-6 w-full max-w-md transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
      >
        <Text variant={TextVariants.title} className="mb-1">
          {isBatch ? t('modals.upscale.titleBatch') : t('modals.upscale.titleSingle')}
        </Text>
        <Text className="mb-4">{t('modals.upscale.description')}</Text>

        {error && (
          <div className="flex items-start gap-2 mb-4 text-red-500">
            <XCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <Text color={TextColors.error} className="break-words">
              {error}
            </Text>
          </div>
        )}

        {isProcessing ? (
          <div className="py-6 flex flex-col items-center">
            <Loader2 className="animate-spin mb-3" size={28} />
            <Text className="mb-2">{t('modals.upscale.processing')}</Text>
            <div className="w-full h-2 rounded-full bg-bg-primary overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-200"
                style={{ width: `${Math.round(shownPercent)}%` }}
              />
            </div>
            <Text className="mt-2">{t('modals.upscale.percentText', { percent: Math.round(shownPercent) })}</Text>
          </div>
        ) : results.length > 0 ? (
          <div className="py-4 flex flex-col items-center">
            <Text className="mb-3">
              {t('modals.upscale.doneText', { count: results.length, scale: `${scale}×` })}
            </Text>
            <div className="max-h-40 overflow-y-auto w-full space-y-1">
              {results.map((path) => (
                <button
                  key={path}
                  className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded hover:bg-bg-primary"
                  onClick={() => {
                    onOpenFile(path);
                    onClose();
                  }}
                >
                  <FolderOpen className="w-4 h-4 shrink-0" />
                  <span className="truncate text-sm">{path}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mb-2">
            <Text className="mb-1">{t('modals.upscale.scaleLabel')}</Text>
            <Dropdown<number>
              options={SCALE_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
              value={scale}
              onChange={setScale}
            />
            <Text className="mt-3 block">
              {isBatch
                ? t('modals.upscale.targetCount', { count: targetPaths.length })
                : t('modals.upscale.speedNotice')}
            </Text>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-3 pt-4 border-t border-surface/50">
          <Button onClick={onClose} disabled={isProcessing}>
            {t('modals.upscale.close')}
          </Button>
          {results.length === 0 && (
            <Button onClick={() => onUpscale(scale)} disabled={isProcessing || targetPaths.length === 0}>
              {isProcessing ? (
                <Loader2 className="animate-spin mr-2" size={16} />
              ) : (
                <Maximize2 className="mr-2" size={16} />
              )}
              {t('modals.upscale.start', { scale: `${scale}×` })}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
