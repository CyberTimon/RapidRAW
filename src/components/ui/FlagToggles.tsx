import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { ImageFlag } from './AppProperties';
import { FLAG_ICONS } from '../../utils/imageFlags';

const FLAG_TOOLTIP_KEYS = {
  [ImageFlag.Pick]: 'ui.flags.togglePick',
  [ImageFlag.Reject]: 'ui.flags.toggleReject',
} as const;

interface FlagTogglesProps {
  flag: ImageFlag | null;
  onToggle(flag: ImageFlag): void;
  inactiveClassName: string;
  disabled?: boolean;
  size?: number;
}

export default function FlagToggles({
  flag,
  onToggle,
  inactiveClassName,
  disabled = false,
  size = 18,
}: FlagTogglesProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-1.5">
      {Object.values(ImageFlag).map((option) => {
        const Icon = FLAG_ICONS[option];
        return (
          <button
            key={option}
            className="focus:outline-hidden transition-transform active:scale-95 hover:scale-110 disabled:cursor-not-allowed disabled:hover:scale-100"
            disabled={disabled}
            onClick={() => onToggle(option)}
            data-tooltip={t(FLAG_TOOLTIP_KEYS[option])}
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
