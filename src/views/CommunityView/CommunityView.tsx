import { useEffect, useCallback, useRef, useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useBloc } from '@blac/react';
import { CommunityBloc, type CommunityPreset, type PresetCategory, type SortOption } from '../../blocs/community/CommunityBloc';
import { PresetsBloc } from '../../blocs/editor/PresetsBloc';
import { Button } from '../../primitives/Button';
import { Input } from '../../primitives/Input';
import { Dropdown } from '../../primitives/Dropdown';

const GRID_CARD_WIDTH = 240;
const GRID_CARD_HEIGHT = 280;
const LIST_ITEM_HEIGHT = 80;
const GAP = 16;

const CATEGORIES: { value: PresetCategory; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
  { value: 'street', label: 'Street' },
  { value: 'film', label: 'Film' },
  { value: 'moody', label: 'Moody' },
  { value: 'bright', label: 'Bright' },
  { value: 'vintage', label: 'Vintage' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'cinematic', label: 'Cinematic' },
];

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'popular', label: 'Most Popular' },
  { value: 'newest', label: 'Newest' },
  { value: 'downloads', label: 'Most Downloaded' },
  { value: 'name', label: 'Name' },
];

function PresetCard({ preset, onSelect, onDownload }: {
  preset: CommunityPreset;
  onSelect: (preset: CommunityPreset) => void;
  onDownload: (preset: CommunityPreset) => void;
}) {
  return (
    <div
      className="group bg-surface rounded-lg overflow-hidden border border-border-color hover:border-accent cursor-pointer"
      onClick={() => onSelect(preset)}
    >
      <div className="aspect-[4/3] bg-bg-primary relative overflow-hidden">
        {preset.thumbnailUrl ? (
          <img
            src={preset.thumbnailUrl}
            alt={preset.name}
            className="w-full h-full object-cover group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-text-secondary">
            <svg
              width={48}
              height={48}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </div>
        )}
        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onDownload(preset);
            }}
          >
            Download
          </Button>
        </div>
      </div>
      <div className="p-3">
        <h3 className="font-medium text-text-primary truncate">{preset.name}</h3>
        <p className="text-sm text-text-secondary truncate">{preset.author}</p>
        <div className="flex items-center gap-3 mt-2 text-xs text-text-secondary">
          <span className="flex items-center gap-1">
            <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
            </svg>
            {preset.likes}
          </span>
          <span className="flex items-center gap-1">
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {preset.downloads}
          </span>
        </div>
      </div>
    </div>
  );
}

function useContainerWidth(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setWidth(entry.contentRect.width);
      }
    });

    observer.observe(container);
    setWidth(container.clientWidth);

    return () => observer.disconnect();
  }, [containerRef]);

  return width;
}

function VirtualizedPresetList({
  presets,
  viewMode,
  isLoading,
  onSelect,
  onDownload,
}: {
  presets: CommunityPreset[];
  viewMode: 'grid' | 'list';
  isLoading: boolean;
  onSelect: (preset: CommunityPreset) => void;
  onDownload: (preset: CommunityPreset) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerWidth = useContainerWidth(containerRef);
  const padding = 16;

  const columnCount = useMemo(() => {
    if (viewMode === 'list') return 1;
    if (containerWidth === 0) return 1;
    const availableWidth = containerWidth - padding * 2;
    return Math.max(1, Math.floor((availableWidth + GAP) / (GRID_CARD_WIDTH + GAP)));
  }, [containerWidth, viewMode]);

  const rowCount = useMemo(
    () => Math.ceil(presets.length / columnCount),
    [presets.length, columnCount]
  );

  const rowHeight = viewMode === 'grid' ? GRID_CARD_HEIGHT + GAP : LIST_ITEM_HEIGHT + GAP;

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => containerRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
    useFlushSync: false,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (presets.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-text-secondary">
        <svg width={48} height={48} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-4">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <p>No presets found</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-auto"
      style={{ padding }}
    >
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualRow) => {
          const startIndex = virtualRow.index * columnCount;
          const rowPresets = presets.slice(startIndex, startIndex + columnCount);

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {viewMode === 'grid' ? (
                <div style={{ display: 'flex', gap: `${GAP}px` }}>
                  {rowPresets.map((preset) => (
                    <div key={preset.id} style={{ width: GRID_CARD_WIDTH }}>
                      <PresetCard
                        preset={preset}
                        onSelect={onSelect}
                        onDownload={onDownload}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                rowPresets.map((preset) => (
                  <div
                    key={preset.id}
                    className="flex items-center gap-4 p-3 bg-surface rounded-lg border border-border-color hover:border-accent cursor-pointer"
                    onClick={() => onSelect(preset)}
                  >
                    <div className="w-20 h-14 rounded overflow-hidden bg-bg-primary flex-shrink-0">
                      {preset.thumbnailUrl && (
                        <img src={preset.thumbnailUrl} alt={preset.name} className="w-full h-full object-cover" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-text-primary truncate">{preset.name}</h3>
                      <p className="text-sm text-text-secondary truncate">{preset.author}</p>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-text-secondary">
                      <span className="flex items-center gap-1">
                        <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                        </svg>
                        {preset.likes}
                      </span>
                      <span className="flex items-center gap-1">
                        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        {preset.downloads}
                      </span>
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDownload(preset);
                      }}
                    >
                      Download
                    </Button>
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PresetDetail({ preset, onClose, onDownload, onLike }: {
  preset: CommunityPreset;
  onClose: () => void;
  onDownload: (preset: CommunityPreset) => void;
  onLike: (presetId: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-surface rounded-lg max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aspect-video bg-bg-primary relative">
          {preset.thumbnailUrl ? (
            <img src={preset.thumbnailUrl} alt={preset.name} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-text-secondary">
              No preview
            </div>
          )}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white"
          >
            <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="p-6 overflow-y-auto">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-xl font-semibold text-text-primary">{preset.name}</h2>
              <p className="text-text-secondary">by {preset.author}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => onLike(preset.id)}>
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                </svg>
                <span className="ml-1">{preset.likes}</span>
              </Button>
              <Button variant="primary" onClick={() => onDownload(preset)}>
                Download
              </Button>
            </div>
          </div>
          <p className="text-text-secondary mb-4">{preset.description}</p>
          <div className="flex flex-wrap gap-2 mb-4">
            {preset.tags.map((tag) => (
              <span key={tag} className="px-2 py-1 bg-surface-hover rounded text-xs text-text-secondary">
                #{tag}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-4 text-sm text-text-secondary">
            <span>{preset.downloads.toLocaleString()} downloads</span>
            <span>Added {new Date(preset.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CommunityView() {
  const [state, communityBloc] = useBloc(CommunityBloc);
  const [, presetsBloc] = useBloc(PresetsBloc);

  const {
    filteredPresets,
    selectedPreset,
    isLoading,
    error,
    searchQuery,
    selectedCategory,
    sortBy,
    viewMode,
  } = state;

  useEffect(() => {
    communityBloc.loadPresets();
  }, [communityBloc]);

  const handleDownload = useCallback(
    async (preset: CommunityPreset) => {
      await communityBloc.downloadPreset(preset);
      presetsBloc.addPreset(preset.name, preset.adjustments);
      communityBloc.selectPreset(null);
    },
    [communityBloc, presetsBloc]
  );

  const handleLike = useCallback(
    async (presetId: string) => {
      await communityBloc.likePreset(presetId);
    },
    [communityBloc]
  );

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-500 mb-4">
            <svg width={48} height={48} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mx-auto">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <p className="text-text-secondary mb-4">{error}</p>
          <Button onClick={() => communityBloc.loadPresets()}>Try Again</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col bg-bg-primary">
      <div className="flex-shrink-0 border-b border-border-color p-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-semibold text-text-primary">Community Presets</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => communityBloc.setViewMode('grid')}
              className={`p-2 rounded ${viewMode === 'grid' ? 'bg-surface-hover text-text-primary' : 'text-text-secondary'}`}
            >
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
            </button>
            <button
              onClick={() => communityBloc.setViewMode('list')}
              className={`p-2 rounded ${viewMode === 'list' ? 'bg-surface-hover text-text-primary' : 'text-text-secondary'}`}
            >
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[200px]">
            <Input
              placeholder="Search presets..."
              value={searchQuery}
              onChange={(e) => communityBloc.setSearchQuery(e.target.value)}
            />
          </div>
          <Dropdown
            value={selectedCategory}
            onChange={(value) => communityBloc.setCategory(value as PresetCategory)}
            options={CATEGORIES}
          />
          <Dropdown
            value={sortBy}
            onChange={(value) => communityBloc.setSortBy(value as SortOption)}
            options={SORT_OPTIONS}
          />
        </div>

        <div className="flex gap-2 mt-3 overflow-x-auto pb-1">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.value}
              onClick={() => communityBloc.setCategory(cat.value)}
              className={`
                px-3 py-1.5 rounded-full text-sm whitespace-nowrap
                ${selectedCategory === cat.value
                  ? 'bg-accent text-white'
                  : 'bg-surface-hover text-text-secondary hover:text-text-primary'
                }
              `}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      <VirtualizedPresetList
        presets={filteredPresets}
        viewMode={viewMode}
        isLoading={isLoading}
        onSelect={communityBloc.selectPreset}
        onDownload={handleDownload}
      />

      {selectedPreset && (
        <PresetDetail
          preset={selectedPreset}
          onClose={() => communityBloc.selectPreset(null)}
          onDownload={handleDownload}
          onLike={handleLike}
        />
      )}
    </div>
  );
}
