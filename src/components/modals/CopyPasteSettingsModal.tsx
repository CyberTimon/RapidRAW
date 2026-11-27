import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ADJUSTMENT_GROUPS, COPYABLE_ADJUSTMENT_KEYS, CopyPasteSettings, PasteMode } from '../../utils/adjustments';
import Button from '../ui/Button';
import SegmentedControl from '../ui/SegmentedControl';
import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { useModalGate } from '../../store/useUIStore';
import { useVideoKind } from '../../store/videoIntegration';

interface CopyPasteSettingsModalProps {
  isOpen: boolean;
  onClose(): void;
  onSave(settings: CopyPasteSettings): void;
  settings: CopyPasteSettings;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const DEFAULT_SETTINGS: CopyPasteSettings = {
  mode: PasteMode.Merge,
  includedAdjustments: COPYABLE_ADJUSTMENT_KEYS,
  knownAdjustments: [],
  autoSync: false,
};

export default function CopyPasteSettingsModal({ isOpen, onClose, onSave, settings }: CopyPasteSettingsModalProps) {
  const { t } = useTranslation();
  const inVideo = useVideoKind() !== 'none';
  const [isMounted, setIsMounted] = useState(false);
  useModalGate(isOpen);
  const [show, setShow] = useState(false);
  const [localSettings, setLocalSettings] = useState<CopyPasteSettings>(settings || DEFAULT_SETTINGS);
  const pasteModeOptions = useMemo(
    () => [
      { id: PasteMode.Merge, label: t('modals.copyPaste.modeMerge'), tooltip: t('modals.copyPaste.descMerge') },
      { id: PasteMode.Replace, label: t('modals.copyPaste.modeReplace'), tooltip: t('modals.copyPaste.descReplace') },
    ],
    [t],
  );

  useEffect(() => {
    if (isOpen) {
      setLocalSettings(settings || DEFAULT_SETTINGS);
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => setIsMounted(false), 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen, settings]);

  const handleSave = useCallback(() => {
    onSave(localSettings);
    onClose();
  }, [localSettings, onSave, onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, handleKeyDown]);

  const handleSelectAll = () => {
    setLocalSettings((prev) => ({ ...prev, includedAdjustments: [...COPYABLE_ADJUSTMENT_KEYS] }));
  };

  const handleSelectNone = () => {
    setLocalSettings((prev) => ({ ...prev, includedAdjustments: [] }));
  };

  const handleGroupToggle = (keys: string[], checked: boolean) => {
    setLocalSettings((prev) => {
      const newSet = new Set(prev.includedAdjustments);
      keys.forEach((key) => {
        if (checked) newSet.add(key);
        else newSet.delete(key);
      });
      return { ...prev, includedAdjustments: Array.from(newSet) };
    });
  };

  if (!isMounted) return null;

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-xs transition-opacity duration-300 ease-in-out ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={onClose}
      role="dialog"
    >
      <div
        className={`bg-surface rounded-lg shadow-xl p-6 w-full max-w-2xl flex flex-col transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <Text variant={TextVariants.title} className="mb-4">
          {t('modals.copyPaste.title')}
        </Text>
        <div className="grow overflow-y-auto pr-2 -mr-2 space-y-6">
          <div>
            <Text variant={TextVariants.heading} className="block mb-2">
              {t('modals.copyPaste.pasteMode')}
            </Text>
            <SegmentedControl
              options={pasteModeOptions}
              value={localSettings.mode}
              onChange={(mode) => setLocalSettings((p) => ({ ...p, mode }))}
            />
          </div>

          {!inVideo && (
            <div>
              <Text variant={TextVariants.heading} className="block mb-2">
                {t('modals.copyPaste.autoSyncTitle')}
              </Text>
              <Switch
                label={t('modals.copyPaste.autoSyncLabel')}
                checked={localSettings.autoSync}
                onChange={(checked) => setLocalSettings((p) => ({ ...p, autoSync: checked }))}
              />
            </div>
          )}

          <div>
            <div className="flex justify-between items-center mb-2">
              <Text variant={TextVariants.heading}>{t('modals.copyPaste.includedAdjustments')}</Text>
              <div className="flex gap-2">
                <Button
                  className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
                  size="sm"
                  onClick={handleSelectAll}
                >
                  {t('modals.copyPaste.selectAll')}
                </Button>
                <Button
                  className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
                  size="sm"
                  onClick={handleSelectNone}
                >
                  {t('modals.copyPaste.selectNone')}
                </Button>
              </div>
            </div>
            <div className="bg-bg-primary p-4 rounded-md max-h-64 overflow-y-auto">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-6">
                {Object.entries(ADJUSTMENT_GROUPS).map(([section, groups]) => (
                  <div key={section}>
                    <Text variant={TextVariants.heading} className="mb-2">
                      {t(`editor.adjustments.sections.${section}`, { defaultValue: capitalize(section) })}
                    </Text>
                    {groups.map((group) => {
                      const isFullyChecked = group.keys.every((key) => localSettings.includedAdjustments.includes(key));

                      return (
                        <div key={group.label} className="mb-1.5 last:mb-0">
                          <Switch
                            label={t(group.label)}
                            checked={isFullyChecked}
                            onChange={(checked) => handleGroupToggle(group.keys, checked)}
                          />
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-surface">
          <Button
            className="px-4 py-2 rounded-md text-text-secondary bg-surface hover:bg-surface transition-colors"
            onClick={onClose}
          >
            {t('modals.copyPaste.cancel')}
          </Button>
          <Button onClick={handleSave}>{t('modals.copyPaste.save')}</Button>
        </div>
      </div>
    </div>
  );
}
