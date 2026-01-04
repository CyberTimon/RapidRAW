import { useCallback, useState } from 'react';

interface RatingControlProps {
  value: number;
  onChange: (rating: number) => void;
  size?: 'sm' | 'md' | 'lg';
  readonly?: boolean;
  showLabel?: boolean;
}

const sizeConfig = {
  sm: { starSize: 14, gap: 'gap-0.5' },
  md: { starSize: 18, gap: 'gap-1' },
  lg: { starSize: 24, gap: 'gap-1.5' },
};

export function RatingControl({
  value,
  onChange,
  size = 'md',
  readonly = false,
  showLabel = false,
}: RatingControlProps) {
  const [hoverValue, setHoverValue] = useState<number | null>(null);
  const { starSize, gap } = sizeConfig[size];

  const displayValue = hoverValue ?? value;

  const handleClick = useCallback(
    (rating: number) => {
      if (readonly) return;
      onChange(rating === value ? 0 : rating);
    },
    [onChange, value, readonly]
  );

  const handleMouseEnter = useCallback(
    (rating: number) => {
      if (!readonly) {
        setHoverValue(rating);
      }
    },
    [readonly]
  );

  const handleMouseLeave = useCallback(() => {
    setHoverValue(null);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, rating: number) => {
      if (readonly) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick(rating);
      }
    },
    [handleClick, readonly]
  );

  return (
    <div className="flex items-center gap-2">
      {showLabel && <span className="text-xs text-text-secondary min-w-[40px]">Rating</span>}
      <div
        className={`flex items-center ${gap}`}
        onMouseLeave={handleMouseLeave}
        role="radiogroup"
        aria-label="Rating"
      >
        {[1, 2, 3, 4, 5].map((rating) => (
          <button
            key={rating}
            type="button"
            onClick={() => handleClick(rating)}
            onMouseEnter={() => handleMouseEnter(rating)}
            onKeyDown={(e) => handleKeyDown(e, rating)}
            className={`
              focus:outline-none focus:ring-1 focus:ring-accent rounded-sm
              ${readonly ? 'cursor-default' : 'cursor-pointer'}
            `}
            disabled={readonly}
            role="radio"
            aria-checked={rating <= value}
            aria-label={`${rating} star${rating > 1 ? 's' : ''}`}
            title={`${rating} star${rating > 1 ? 's' : ''} (keyboard: ${rating})`}
          >
            <Star
              size={starSize}
              filled={rating <= displayValue}
              hovered={hoverValue !== null && rating <= hoverValue}
            />
          </button>
        ))}
      </div>
      {value > 0 && !readonly && (
        <button
          type="button"
          onClick={() => onChange(0)}
          className="text-xs text-text-secondary hover:text-text-primary"
          title="Clear rating (keyboard: 0)"
        >
          Clear
        </button>
      )}
    </div>
  );
}

interface StarProps {
  size: number;
  filled: boolean;
  hovered: boolean;
}

function Star({ size, filled, hovered }: StarProps) {
  const fillColor = filled
    ? hovered
      ? '#fbbf24'
      : '#f59e0b'
    : hovered
      ? '#fbbf2480'
      : 'transparent';

  const strokeColor = filled || hovered ? '#f59e0b' : '#6b7280';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fillColor}
      stroke={strokeColor}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

interface CompactRatingProps {
  value: number;
  size?: 'sm' | 'md';
}

export function CompactRating({ value, size = 'sm' }: CompactRatingProps) {
  const starSize = size === 'sm' ? 10 : 12;

  if (value === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-0.5" title={`${value} star${value > 1 ? 's' : ''}`}>
      {[1, 2, 3, 4, 5].map((rating) => (
        <Star key={rating} size={starSize} filled={rating <= value} hovered={false} />
      ))}
    </div>
  );
}
