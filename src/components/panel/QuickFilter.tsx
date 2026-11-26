import { Check, Star } from 'lucide-react';
import clsx from 'clsx';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { FlagStatus, ImageFlag, RATING_OPERATORS } from '../../types/library';
import { FLAG_ICONS } from '../../utils/imageFlags';
import { COLOR_LABELS } from '../../utils/adjustments';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';

const ALL_COLORS = [...COLOR_LABELS, { name: 'none', color: '#9ca3af' }];

export function useQuickFilterToggle(key: 'quickFilter' | 'dockedQuickFilter') {
  const isExpanded = useUIStore((s) => Boolean(s.uiVisibility[key]));
  const setUI = useUIStore((s) => s.setUI);
  const toggle = () => setUI((s) => ({ uiVisibility: { ...s.uiVisibility, [key]: !s.uiVisibility[key] } }));
  return { isExpanded, toggle };
}

export function QuickFilterControls({ className }: { className: string }) {
  const { t } = useTranslation();
  const { filterCriteria, setFilterCriteria } = useLibraryStore(
    useShallow((state) => ({
      filterCriteria: state.filterCriteria,
      setFilterCriteria: state.setFilterCriteria,
    })),
  );
  const ratingOp = RATING_OPERATORS[filterCriteria.ratingOperator ?? 'gte'];
  const PickIcon = FLAG_ICONS[ImageFlag.Pick];
  const RejectIcon = FLAG_ICONS[ImageFlag.Reject];

  const toggleFlagFilter = (status: FlagStatus) =>
    setFilterCriteria((prev) => ({
      ...prev,
      flagStatus: prev.flagStatus === status ? FlagStatus.All : status,
    }));

  const toggleColor = (name: string) => {
    const currentColors = filterCriteria.colors || [];
    const colors = currentColors.includes(name) ? currentColors.filter((c) => c !== name) : [...currentColors, name];
    setFilterCriteria((prev) => ({ ...prev, colors }));
  };

  return (
    <div className={className}>
      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((starValue) => {
          const isFilled = filterCriteria.rating > 0 && starValue <= filterCriteria.rating;
          return (
            <button
              key={`qf-star-${starValue}`}
              data-tooltip={`${starValue} ${t(ratingOp.suffixKey)}`}
              onClick={() =>
                setFilterCriteria((prev) => ({
                  ...prev,
                  rating: prev.rating === starValue ? 0 : starValue,
                }))
              }
              className="p-0.5 focus:outline-none"
            >
              <Star
                size={16}
                className={clsx(
                  'transition-colors duration-150',
                  isFilled ? 'text-accent fill-accent' : 'text-text-secondary hover:text-accent',
                )}
              />
            </button>
          );
        })}
        <button
          onClick={() => setFilterCriteria((prev) => ({ ...prev, ratingOperator: ratingOp.next }))}
          data-tooltip={t(ratingOp.labelKey)}
          className="ml-1 w-5 h-5 flex items-center justify-center rounded text-sm font-semibold text-text-secondary hover:text-text-primary focus:outline-none"
        >
          {ratingOp.symbol}
        </button>
      </div>

      <div className="h-4 w-px bg-border-color"></div>

      <div className="flex items-center gap-1.5">
        <button
          className="focus:outline-none transition-transform active:scale-95 hover:scale-110"
          onClick={() => toggleFlagFilter(FlagStatus.Picked)}
          data-tooltip={t('library.filters.flag.picked')}
        >
          <PickIcon
            size={16}
            className={clsx(
              'transition-colors duration-150',
              filterCriteria.flagStatus === FlagStatus.Picked
                ? 'text-accent fill-accent'
                : 'text-text-secondary hover:text-accent',
            )}
          />
        </button>
        <button
          className="focus:outline-none transition-transform active:scale-95 hover:scale-110"
          onClick={() => toggleFlagFilter(FlagStatus.Rejected)}
          data-tooltip={t('library.filters.flag.rejected')}
        >
          <RejectIcon
            size={16}
            className={clsx(
              'transition-colors duration-150',
              filterCriteria.flagStatus === FlagStatus.Rejected
                ? 'text-accent'
                : 'text-text-secondary hover:text-accent',
            )}
          />
        </button>
      </div>

      <div className="h-4 w-px bg-border-color"></div>

      <div className="flex items-center gap-1.5">
        {ALL_COLORS.map((color) => {
          const isSelected = (filterCriteria.colors || []).includes(color.name);
          const tooltipTitle =
            color.name === 'none'
              ? t('library.header.viewOptions.noLabel')
              : t(`contextMenus.colors.${color.name}`, {
                  defaultValue: color.name.charAt(0).toUpperCase() + color.name.slice(1),
                });

          return (
            <button
              key={`qf-color-${color.name}`}
              onClick={() => toggleColor(color.name)}
              className={clsx(
                'w-4 h-4 rounded-full transition-transform hover:scale-105 flex items-center justify-center focus:outline-none',
                isSelected ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg-primary' : '',
              )}
              style={{ backgroundColor: color.color }}
              data-tooltip={tooltipTitle}
            >
              {isSelected && <Check size={10} className="text-white drop-shadow-md" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
