import { useEffect, useState, type MouseEvent, type MutableRefObject, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { Check, ChevronDown, ChevronUp, Star as StarIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Text from '../../ui/Text';
import { RATING_OPERATORS, RatingOperator, SortDirection } from '../../../types/library';
import { THUMBNAIL_SIZE_STEPS } from '../../../types/settings';
import { TEXT_COLOR_KEYS, TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { COLOR_LABELS, Color } from '../../../utils/adjustments';

const THUMBNAIL_SIZE_GLYPH_MIN = 6;
const THUMBNAIL_SIZE_GLYPH_STEP = 2;

const sizeGlyph = (size: number) =>
  function SizeGlyph({ className }: { className?: string }) {
    return <span className={clsx('block rounded-[3px] bg-current', className)} style={{ width: size, height: size }} />;
  };

export const SIZE_GLYPHS = THUMBNAIL_SIZE_STEPS.map((_, index) =>
  sizeGlyph(THUMBNAIL_SIZE_GLYPH_MIN + index * THUMBNAIL_SIZE_GLYPH_STEP),
);

export const FILTER_COLORS: Array<Color> = [...COLOR_LABELS, { name: 'none', color: '#9ca3af' }];

interface ViewOptionSectionProps {
  title: string;
  action?: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
}

export function ViewOptionSection({ title, action, bodyClassName = 'px-3 mt-1', children }: ViewOptionSectionProps) {
  return (
    <div>
      {action ? (
        <div className="px-3 py-1 relative flex items-center">
          <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="uppercase">
            {title}
          </Text>
          {action}
        </div>
      ) : (
        <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-1 uppercase">
          {title}
        </Text>
      )}
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}

export function SortOrderButton({ order, onToggle }: { order: string; onToggle(): void }) {
  const { t } = useTranslation();
  const isAscending = order === SortDirection.Ascending;
  return (
    <button
      onClick={onToggle}
      data-tooltip={
        isAscending ? t('library.header.viewOptions.sortDescending') : t('library.header.viewOptions.sortAscending')
      }
      className="absolute top-1/2 right-3 -translate-y-1/2 p-1 bg-transparent border-none text-text-secondary hover:text-text-primary rounded-sm transition-colors"
    >
      {isAscending ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
    </button>
  );
}

interface RatingFilterSwitchProps {
  rating: number;
  operator: RatingOperator;
  ratingFilterOptions: Array<{ value: number; label: string }>;
  onChange(rating: number): void;
  onOperatorChange(operator: RatingOperator): void;
}

export const RatingSegmentedSwitch = ({
  rating,
  onChange,
  ratingFilterOptions,
  operator,
  onOperatorChange,
}: RatingFilterSwitchProps) => {
  const { t } = useTranslation();
  const [bubbleStyle, setBubbleStyle] = useState({});

  const activeIndex = rating === 0 ? 0 : rating <= -1 ? 1 : 2;

  useEffect(() => {
    setBubbleStyle({ x: `${activeIndex * 100}%`, width: '33.333333%' });
  }, [activeIndex]);

  const op = RATING_OPERATORS[operator] ?? RATING_OPERATORS.gte;

  return (
    <div className="flex w-full items-stretch gap-1">
      <div className="flex-1 min-w-0 bg-bg-primary p-1 rounded-md">
        <div className="relative flex w-full">
          <motion.div
            className="absolute top-0 bottom-0 left-0 z-0 bg-card-active shadow-sm"
            style={{ borderRadius: 6 }}
            animate={bubbleStyle}
            initial={false}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
          />

          <button
            onClick={() => onChange(0)}
            className={clsx(
              'relative flex-1 flex items-center justify-center px-1 py-1.5 text-sm font-medium rounded-md transition-colors truncate',
              activeIndex === 0 ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary hover:bg-surface',
            )}
          >
            <span className="relative z-10">{ratingFilterOptions.find((o) => o.value === 0)?.label || 'All'}</span>
          </button>

          <button
            onClick={() => onChange(-1)}
            className={clsx(
              'relative flex-1 flex items-center justify-center px-1 py-1.5 text-sm font-medium rounded-md transition-colors truncate',
              activeIndex === 1 ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary hover:bg-surface',
            )}
          >
            <span className="relative z-10">{ratingFilterOptions.find((o) => o.value === -1)?.label || 'Unrated'}</span>
          </button>

          <div
            className={clsx(
              'relative flex-1 flex items-center justify-center gap-0.5 px-1 py-1.5 transition-colors',
              activeIndex === 2 ? 'text-text-primary' : 'text-text-secondary',
            )}
          >
            <div className="flex items-center z-10">
              {[...Array(5)].map((_, index) => {
                const starValue = index + 1;
                const isFilled = rating > 0 && starValue <= rating;
                const optionLabel = `${starValue} ${t(op.suffixKey)}`;

                return (
                  <button
                    key={starValue}
                    data-tooltip={optionLabel}
                    onClick={(e) => {
                      e.stopPropagation();
                      onChange(rating === starValue ? 0 : starValue);
                    }}
                    className="focus:outline-hidden transition-transform hover:scale-110 flex items-center justify-center p-0.5"
                  >
                    <StarIcon
                      size={14}
                      className={`transition-colors duration-150 ${
                        isFilled
                          ? 'text-text-primary fill-text-primary'
                          : activeIndex === 2
                            ? 'text-text-primary/60 hover:text-text-primary'
                            : 'text-text-secondary hover:text-text-primary'
                      }`}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <button
        onClick={() => onOperatorChange(op.next)}
        data-tooltip={t(op.labelKey)}
        className="w-8 shrink-0 flex items-center justify-center rounded-md bg-bg-primary text-sm font-semibold text-text-primary hover:bg-card-active transition-colors"
      >
        {op.symbol}
      </button>
    </div>
  );
};

interface ColorLabelFilterProps {
  value: Array<string>;
  lastClicked: MutableRefObject<string | null>;
  onChange(colors: Array<string>): void;
}

export function ColorLabelFilter({ value, lastClicked, onChange }: ColorLabelFilterProps) {
  const { t } = useTranslation();

  const handleClick = (colorName: string, event: MouseEvent) => {
    const isCtrlPressed = event.ctrlKey || event.metaKey;
    const anchor = lastClicked.current;
    lastClicked.current = colorName;

    if (event.shiftKey && anchor) {
      const lastIndex = FILTER_COLORS.findIndex((c) => c.name === anchor);
      const currentIndex = FILTER_COLORS.findIndex((c) => c.name === colorName);
      if (lastIndex === -1 || currentIndex === -1) return;
      const start = Math.min(lastIndex, currentIndex);
      const end = Math.max(lastIndex, currentIndex);
      const range = FILTER_COLORS.slice(start, end + 1).map((c) => c.name);
      onChange(Array.from(new Set([...(isCtrlPressed ? value : [anchor]), ...range])));
    } else if (isCtrlPressed) {
      onChange(value.includes(colorName) ? value.filter((c) => c !== colorName) : [...value, colorName]);
    } else {
      onChange(value.length === 1 && value[0] === colorName ? [] : [colorName]);
    }
  };

  return (
    <div className="flex flex-wrap gap-2.5 py-1.5">
      {FILTER_COLORS.map((color) => {
        const isSelected = value.includes(color.name);
        const title =
          color.name === 'none'
            ? t('library.header.viewOptions.noLabel')
            : t(`contextMenus.colors.${color.name}`, {
                defaultValue: color.name.charAt(0).toUpperCase() + color.name.slice(1),
              });
        return (
          <button
            key={color.name}
            data-tooltip={title}
            onClick={(event) => handleClick(color.name, event)}
            className="w-5 h-5 rounded-full focus:outline-hidden focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-surface transition-transform hover:scale-110"
            role="menuitem"
          >
            <div className="relative w-full h-full">
              <div className="w-full h-full rounded-full" style={{ backgroundColor: color.color }}></div>
              {isSelected && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-full">
                  <Check size={12} className={TEXT_COLOR_KEYS[TextColors.white]} />
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
