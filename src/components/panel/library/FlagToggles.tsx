import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { ImageFlag } from '../../../types/library';
import { FLAG_ICONS } from '../../../utils/imageFlags';
import { useShortcuts } from '../../../hooks/useShortcuts';

const FLAG_TOOLTIP_KEYS = {
  [ImageFlag.Pick]: 'ui.flags.togglePick',
  [ImageFlag.Reject]: 'ui.flags.toggleReject',
} as const;

const FLAG_SHORTCUTS = {
  [ImageFlag.Pick]: 'toggle_pick',
  [ImageFlag.Reject]: 'toggle_reject',
};

interface FlagTogglesProps {
  flag: ImageFlag | null;
  onToggle(flag: ImageFlag): void;
  inactiveClassName: string;
  disabled?: boolean;
  size?: number;
  showShortcuts?: boolean;
  className?: string;
}

export default function FlagToggles({
  flag,
  onToggle,
  inactiveClassName,
  disabled = false,
  size = 18,
  showShortcuts = false,
  className,
}: FlagTogglesProps) {
  const { t } = useTranslation();
  const shortcut = useShortcuts();

  return (
    <div className={clsx('flex items-center gap-1.5', className)}>
      {Object.values(ImageFlag).map((option) => {
        const Icon = FLAG_ICONS[option];
        return (
          <button
            key={option}
            className="focus:outline-hidden transition-transform active:scale-95 hover:scale-110 disabled:cursor-not-allowed disabled:hover:scale-100"
            disabled={disabled}
            onClick={() => onToggle(option)}
            data-tooltip={t(FLAG_TOOLTIP_KEYS[option])}
            {...shortcut(showShortcuts && !disabled ? FLAG_SHORTCUTS[option] : null)}
          >
            <Icon
              size={size}
              className={clsx(
                'transition-colors duration-200',
                disabled
                  ? 'text-text-secondary opacity-40'
                  : flag === option
                    ? clsx('text-accent', option === ImageFlag.Pick && 'fill-accent')
                    : inactiveClassName,
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
