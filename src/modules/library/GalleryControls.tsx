import { useBloc } from '@blac/react';
import { Button } from '../../primitives/Button';
import { Input } from '../../primitives/Input';
import { Dropdown } from '../../primitives/Dropdown';
import { LibraryBloc } from '../../blocs/library/LibraryBloc';
import { FilterBloc } from '../../blocs/library/FilterBloc';
import { SortBloc } from '../../blocs/library/SortBloc';
import { SettingsBloc } from '../../blocs/app/SettingsBloc';
import type { SortKey, ThumbnailSize } from '../../types/library';

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'name', label: 'Name' },
  { value: 'date', label: 'Date Modified' },
  { value: 'rating', label: 'Rating' },
  { value: 'date_taken', label: 'Date Taken' },
  { value: 'size', label: 'File Size' },
];

const THUMBNAIL_SIZE_OPTIONS: Array<{ value: ThumbnailSize; label: string }> = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

export function GalleryControls() {
  const [library] = useBloc(LibraryBloc);
  const [filter, filterBloc] = useBloc(FilterBloc);
  const [sort, sortBloc] = useBloc(SortBloc);
  const [settings, settingsBloc] = useBloc(SettingsBloc);

  const imageCount = library.images.length;

  const handleOpenFolder = async () => {
    // TODO: Wire up with TauriService
  };

  const handleGoHome = () => {
    // TODO: Wire up with LibraryBloc
  };

  return (
    <div className="h-full flex flex-col p-4 bg-bg-secondary border-b border-border-color">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold text-text-primary truncate">
            {library.currentFolderPath
              ? library.currentFolderPath.split(/[\\/]/).pop()
              : 'Library'}
          </h2>
          {library.currentFolderPath && (
            <p className="text-xs text-text-secondary truncate">{imageCount} images</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Input
            placeholder="Search..."
            className="w-48"
            leftIcon={
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            }
          />

          <Dropdown
            value={sort.key}
            options={SORT_OPTIONS}
            onChange={(key) => sortBloc.setKey(key)}
            className="w-36"
          />

          <Button
            variant="ghost"
            size="icon"
            onClick={() => sortBloc.toggleDirection()}
            title={sort.direction === 'asc' ? 'Ascending' : 'Descending'}
          >
            {sort.direction === 'asc' ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            )}
          </Button>

          <div className="w-px h-6 bg-border-color mx-1" />

          <div className="flex items-center gap-2">
            {[1, 2, 3, 4, 5].map((rating) => (
              <button
                key={rating}
                className={`p-1 rounded transition-colors ${
                  filter.minRating >= rating
                    ? 'text-accent'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
                onClick={() => filterBloc.setMinRating(filter.minRating === rating ? 0 : rating)}
                title={`Filter ${rating}+ stars`}
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
              </button>
            ))}
          </div>

          <div className="w-px h-6 bg-border-color mx-1" />

          <Dropdown
            value={settings.settings.thumbnailSize}
            options={THUMBNAIL_SIZE_OPTIONS}
            onChange={(size) => settingsBloc.setThumbnailSize(size)}
            className="w-28"
          />

          <Button variant="ghost" size="icon" onClick={handleOpenFolder} title="Open Folder">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
              />
            </svg>
          </Button>

          <Button variant="ghost" size="icon" onClick={handleGoHome} title="Go Home">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
              />
            </svg>
          </Button>
        </div>
      </div>

      {filterBloc.isActive && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-text-secondary">Active filters:</span>
          {filter.minRating > 0 && (
            <span className="px-2 py-0.5 text-xs bg-accent/20 text-accent rounded-full">
              {filter.minRating}+ stars
            </span>
          )}
          {filter.colors.length > 0 && (
            <span className="px-2 py-0.5 text-xs bg-accent/20 text-accent rounded-full">
              {filter.colors.length} colors
            </span>
          )}
          {filter.rawStatus !== 'all' && (
            <span className="px-2 py-0.5 text-xs bg-accent/20 text-accent rounded-full">
              {filter.rawStatus === 'raw' ? 'RAW only' : 'Non-RAW only'}
            </span>
          )}
          <button
            className="text-xs text-text-secondary hover:text-text-primary underline"
            onClick={() => filterBloc.clearFilters()}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
