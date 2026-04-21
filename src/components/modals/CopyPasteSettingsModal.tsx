import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { ADJUSTMENT_GROUPS, COPYABLE_ADJUSTMENT_KEYS, CopyPasteSettings, PasteMode } from '../../utils/adjustments';
import Button from '../ui/Button';
import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';

interface CopyPasteSettingsModalProps {
  isOpen: boolean;
  onClose(): void;
  onSave(settings: CopyPasteSettings): void;
  settings: CopyPasteSettings;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const formatLabel = (key: string) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());

const DEFAULT_SETTINGS: CopyPasteSettings = {
  mode: PasteMode.Merge,
  includedAdjustments: COPYABLE_ADJUSTMENT_KEYS,
  knownAdjustments: [],
};

const pasteModeOptions = [
  { id: PasteMode.Merge, label: 'Merge' },
  { id: PasteMode.Replace, label: 'Replace' },
];

interface PasteModeSwitchProps {
  selectedMode: PasteMode;
  onModeChange: (mode: PasteMode) => void;
  isVisible: boolean;
}

const PasteModeSwitch = ({ selectedMode, onModeChange, isVisible }: PasteModeSwitchProps) => {
  const [buttonRefs, setButtonRefs] = useState<Map<string, HTMLButtonElement>>(new Map());
  const [bubbleStyle, setBubbleStyle] = useState({});
  const containerRef = useRef<HTMLDivElement>(null);
  const isInitialAnimation = useRef(true);

  useEffect(() => {
    const selectedButton = buttonRefs.get(selectedMode);

    if (!isVisible || !selectedButton || !containerRef.current) {
      return;
    }

    const targetStyle = {
      x: selectedButton.offsetLeft,
      width: selectedButton.offsetWidth,
    };

    if (isInitialAnimation.current && containerRef.current.offsetWidth > 0) {
      let initialX;
      if (selectedMode === PasteMode.Replace) {
        initialX = containerRef.current.offsetWidth;
      } else {
        initialX = -targetStyle.width;
      }

      setBubbleStyle({
        x: [initialX, targetStyle.x],
        width: targetStyle.width,
      });
      isInitialAnimation.current = false;
    } else {
      setBubbleStyle(targetStyle);
    }
  }, [selectedMode, buttonRefs, isVisible]);

  useEffect(() => {
    if (!isVisible) {
      isInitialAnimation.current = true;
    }
  }, [isVisible]);

  return (
    <div ref={containerRef} className="relative flex w-full gap-1 bg-bg-primary p-1 rounded-md">
      <motion.div
        className="absolute top-1 bottom-1 z-0 bg-accent shadow-xs"
        style={{ borderRadius: 6 }}
        animate={bubbleStyle}
        transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
      />
      {pasteModeOptions.map((option) => (
        <button
          key={option.id}
          ref={(el) => {
            if (el) {
              const newRefs = new Map(buttonRefs);
              if (newRefs.get(option.id) !== el) {
                newRefs.set(option.id, el);
                setButtonRefs(newRefs);
              }
            }
          }}
          onClick={() => onModeChange(option.id)}
          className={clsx(
            'relative flex-1 flex items-center justify-center gap-2 py-1.5 text-sm rounded-md transition-colors',
            {
              'text-text-primary hover:bg-surface': selectedMode !== option.id,
              'text-button-text': selectedMode === option.id,
            },
          )}
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <span className="relative z-10 flex items-center">{option.label}</span>
        </button>
      ))}
    </div>
  );
};

export default function CopyPasteSettingsModal({ isOpen, onClose, onSave, settings }: CopyPasteSettingsModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [localSettings, setLocalSettings] = useState<CopyPasteSettings>(settings || DEFAULT_SETTINGS);

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

  const handleCheckboxChange = (key: string, checked: boolean) => {
    setLocalSettings((prev) => {
      const newSet = new Set(prev.includedAdjustments);
      if (checked) {
        newSet.add(key);
      } else {
        newSet.delete(key);
      }
      return { ...prev, includedAdjustments: Array.from(newSet) };
    });
  };

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
          Copy & Paste Settings
        </Text>
        <div className="grow overflow-y-auto pr-2 -mr-2 space-y-6">
          <div>
            <Text variant={TextVariants.heading} className="block mb-2">
              Paste Mode
            </Text>
            <PasteModeSwitch
              selectedMode={localSettings.mode}
              onModeChange={(mode) => setLocalSettings((p) => ({ ...p, mode }))}
              isVisible={show}
            />
            <Text variant={TextVariants.small} className="mt-2">
              <b>Merge:</b> Adds your copied changes, leaving other settings untouched.
              <br />
              <b>Replace:</b> Overwrites all selected settings, resetting the rest to their defaults.
            </Text>
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <Text variant={TextVariants.heading}>Included Adjustments</Text>
              <div className="flex gap-2">
                <Button
                  className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
                  size="sm"
                  onClick={handleSelectAll}
                >
                  Select All
                </Button>
                <Button
                  className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
                  size="sm"
                  onClick={handleSelectNone}
                >
                  Select None
                </Button>
              </div>
            </div>
            <div className="bg-bg-primary p-4 rounded-md max-h-64 overflow-y-auto">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-6">
                {Object.entries(ADJUSTMENT_GROUPS).map(([section, groups]) => (
                  <div key={section}>
                    <Text variant={TextVariants.heading} className="mb-2">
                      {capitalize(section)}
                    </Text>
                    {groups.map((group) => {
                      const isFullyChecked = group.keys.every((key) => localSettings.includedAdjustments.includes(key));

                      return (
                        <div key={group.label} className="mb-1.5 last:mb-0">
                          <Switch
                            label={group.label}
                            checked={isFullyChecked}
                            onChange={(checked) => handleGroupToggle(group.keys, checked)}
                            trackClassName="bg-surface"
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
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </div>
      </div>
    </div>
  );
}
