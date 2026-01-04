import { memo } from 'react';
import { useBloc } from '@blac/react';
import { SelectionBloc } from '../../blocs/library/SelectionBloc';
import { ThumbnailBloc } from '../../blocs/library/ThumbnailBloc';
import { RatingsBloc } from '../../blocs/library/RatingsBloc';
import type { ImageFile } from '../../types/library';
import { COLOR_LABELS } from '../../types/library';

interface ImageCardProps {
  image: ImageFile;
  size: number;
  aspectRatio: 'cover' | 'contain';
  showFilename?: boolean;
  showRating?: boolean;
  allPaths: string[];
  onDoubleClick?: (path: string) => void;
}

function RatingStars({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <svg
          key={star}
          className={`w-3 h-3 ${star <= rating ? 'text-yellow-400' : 'text-gray-500'}`}
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      ))}
    </div>
  );
}

export const ImageCard = memo(function ImageCard({
  image,
  size,
  aspectRatio,
  showFilename = true,
  showRating = true,
  allPaths,
  onDoubleClick,
}: ImageCardProps) {
  const [selection, selectionBloc] = useBloc(SelectionBloc);
  const [thumbnail] = useBloc(ThumbnailBloc);
  const [ratings] = useBloc(RatingsBloc);

  const isSelected = selection.selectedPaths.includes(image.path);
  const isActive = selection.activePath === image.path;
  const thumbnailUrl = thumbnail.thumbnails[image.path];
  const isPending = thumbnail.pending.includes(image.path);
  const rating = ratings.ratings[image.path] || 0;
  const colorLabel = ratings.colorLabels[image.path];
  const colorInfo = colorLabel
    ? COLOR_LABELS.find((c) => c.name === colorLabel)
    : undefined;

  const handleClick = (e: React.MouseEvent) => {
    selectionBloc.handleClick(
      image.path,
      { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey },
      allPaths
    );
  };

  const handleDoubleClick = () => {
    onDoubleClick?.(image.path);
  };

  return (
    <div
      className={`
        group relative rounded-lg overflow-hidden cursor-pointer transition-all duration-150
        ${isSelected ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg-primary' : ''}
        ${isActive ? 'ring-2 ring-accent' : ''}
        hover:ring-1 hover:ring-border-color
      `}
      style={{ width: size, height: size + (showFilename ? 24 : 0) }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className="relative bg-surface"
        style={{ width: size, height: size }}
      >
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={image.name}
            className={`w-full h-full ${
              aspectRatio === 'cover' ? 'object-cover' : 'object-contain'
            }`}
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            {isPending ? (
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-accent border-t-transparent" />
            ) : (
              <svg
                className="w-8 h-8 text-text-secondary"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            )}
          </div>
        )}

        {colorInfo && (
          <div
            className="absolute top-1 left-1 w-3 h-3 rounded-full border-2 border-white/50"
            style={{ backgroundColor: colorInfo.color }}
          />
        )}

        {image.isRaw && (
          <span className="absolute top-1 right-1 px-1.5 py-0.5 text-[10px] font-bold bg-black/60 text-white rounded">
            RAW
          </span>
        )}

        {showRating && rating > 0 && (
          <div className="absolute bottom-1 left-1 bg-black/60 rounded px-1 py-0.5">
            <RatingStars rating={rating} />
          </div>
        )}

        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />

        {isSelected && (
          <div className="absolute top-1 left-1 w-5 h-5 bg-accent rounded-full flex items-center justify-center">
            <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
            </svg>
          </div>
        )}
      </div>

      {showFilename && (
        <div className="h-6 px-2 flex items-center bg-surface/80">
          <span className="text-xs text-text-primary truncate w-full text-center">
            {image.name}
          </span>
        </div>
      )}
    </div>
  );
});
