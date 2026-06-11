import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import Switch from '../ui/Switch';
import { Preset } from '../ui/AppProperties';
import { ADJUSTMENT_GROUPS } from '../../utils/adjustments';

interface ConfigurePresetModalProps {
  isOpen: boolean;
  onClose(): void;
  onSave(name: string, includeMasks: boolean, includeCropTransform: boolean, presetType: 'tool' | 'style'): void;
  initialPreset?: Preset | null;
}

interface PresetTypeSwitchProps {
  selectedType: 'tool' | 'style';
  onChange: (type: 'tool' | 'style') => void;
}

const PresetTypeSwitch = ({ selectedType, onChange }: PresetTypeSwitchProps) => {
  const { t } = useTranslation();
  const [bubbleStyle, setBubbleStyle] = useState({});
  const isInitialAnimation = useRef(true);

  const presetTypeOptions = useMemo(
    () => [
      {
        id: 'style' as const,
        label: t('modals.configurePreset.typeStyleLabel'),
        title: t('modals.configurePreset.typeStyleDesc'),
      },
      {
        id: 'tool' as const,
        label: t('modals.configurePreset.typeToolLabel'),
        title: t('modals.configurePreset.typeToolDesc'),
      },
    ],
    [t],
  );

  useEffect(() => {
    const selectedIndex = presetTypeOptions.findIndex((m) => m.id === selectedType);
    const safeIndex = selectedIndex >= 0 ? selectedIndex : 0;

    const widthPercent = 100 / presetTypeOptions.length;
    const targetX = `${safeIndex * 100}%`;
    const targetWidth = `${widthPercent}%`;

    if (isInitialAnimation.current) {
      let initialX = selectedType === 'style' ? '-25%' : '100%';

      setBubbleStyle({
        x: [initialX, targetX],
        width: targetWidth,
      });
      isInitialAnimation.current = false;
    } else {
      setBubbleStyle({
        x: targetX,
        width: targetWidth,
      });
    }
  }, [selectedType, presetTypeOptions]);

  return (
    <div className="w-full p-1.5 bg-card-active rounded-md mt-2">
      <div className="relative flex w-full">
        <motion.div
          className="absolute top-0 bottom-0 z-0 bg-accent"
          style={{ borderRadius: 4 }}
          animate={bubbleStyle}
          transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
        />
        {presetTypeOptions.map((option) => (
          <button
            key={option.id}
            data-tooltip={option.title}
            onClick={(e) => {
              e.preventDefault();
              onChange(option.id);
            }}
            className={clsx(
              'relative flex-1 flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
              {
                'text-text-primary hover:bg-surface': selectedType !== option.id,
                'text-button-text': selectedType === option.id,
              },
            )}
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <span className="relative z-10 flex items-center">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default function ConfigurePresetModal({ isOpen, onClose, onSave, initialPreset }: ConfigurePresetModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [includeMasks, setIncludeMasks] = useState(false);
  const [includeCropTransform, setIncludeCropTransform] = useState(false);
  const [presetType, setPresetType] = useState<'tool' | 'style'>('style');
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setName(initialPreset?.name || '');
      setIncludeMasks(
        initialPreset?.includeMasks ??
          (initialPreset?.adjustments?.masks && initialPreset.adjustments.masks.length > 0) ??
          false,
      );

      const GEOMETRY_KEYS = ADJUSTMENT_GROUPS.geometry.flatMap((group) => group.keys);
      const hasGeometry =
        initialPreset?.adjustments && Object.keys(initialPreset.adjustments).some((key) => GEOMETRY_KEYS.includes(key));
      setIncludeCropTransform(initialPreset?.includeCropTransform ?? hasGeometry ?? false);

      setPresetType(initialPreset?.presetType || 'style');
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setName('');
        setIncludeMasks(false);
        setIncludeCropTransform(false);
        setPresetType('style');
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen, initialPreset]);

  const handleSave = useCallback(() => {
    if (name.trim()) {
      onSave(name.trim(), includeMasks, includeCropTransform, presetType);
      onClose();
    }
  }, [name, includeMasks, includeCropTransform, presetType, onSave, onClose]);

  const handleKeyDown = useCallback(
    (e: any) => {
      if (e.key === 'Enter') {
        handleSave();
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [handleSave, onClose],
  );

  if (!isMounted) {
    return null;
  }

  return (
    <div
      className={`
        fixed inset-0 flex items-center justify-center z-50
        bg-black/30 backdrop-blur-xs
        transition-opacity duration-300 ease-in-out
        ${show ? 'opacity-100' : 'opacity-0'}
      `}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`
          bg-surface rounded-lg shadow-xl p-6 w-full max-w-sm
          transform transition-all duration-300 ease-out
          ${show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'}
        `}
        onClick={(e: any) => e.stopPropagation()}
      >
        <Text variant={TextVariants.title} className="mb-4">
          {initialPreset ? t('modals.configurePreset.titleConfigure') : t('modals.configurePreset.titleSave')}
        </Text>
        <input
          autoFocus
          className="w-full bg-bg-primary text-text-primary border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          onChange={(e: any) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('modals.configurePreset.placeholder')}
          type="text"
          value={name}
        />

        <div className="mt-5 mb-4 p-1 space-y-4">
          <Switch label={t('modals.configurePreset.includeMasks')} checked={includeMasks} onChange={setIncludeMasks} />
          <Switch
            label={t('modals.configurePreset.includeCropTransform')}
            checked={includeCropTransform}
            onChange={setIncludeCropTransform}
          />
        </div>

        <PresetTypeSwitch selectedType={presetType} onChange={setPresetType} />

        <div className="flex justify-end gap-3 mt-6">
          <button
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
            onClick={onClose}
          >
            {t('modals.configurePreset.cancel')}
          </button>
          <button
            className="px-4 py-2 rounded-md bg-accent text-button-text font-semibold hover:bg-accent-hover disabled:bg-gray-500 disabled:text-white disabled:cursor-not-allowed transition-colors"
            disabled={!name.trim()}
            onClick={handleSave}
          >
            {t('modals.configurePreset.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
