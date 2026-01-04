# Modules Specification

This document details all module components for the RapidRAW rewrite. Modules are the "molecules" of the UI - content components that connect to Blocs for state and render using Primitives.

## Module Hierarchy

```
modules/
  library/
    GalleryGrid.tsx           # Image grid with virtualization
    GalleryControls.tsx       # Search, filter, sort, view options
    FolderTree.tsx            # Folder navigation sidebar
    Filmstrip.tsx             # Horizontal thumbnail strip
    ImageCard.tsx             # Single image thumbnail
    WelcomeScreen.tsx         # Home/splash screen
  
  editor/
    ImagePreview.tsx          # Main image canvas with layers
    ImageHistogram.tsx        # Histogram display
    ImageWaveform.tsx         # Waveform/vectorscope display
    EditorToolbar.tsx         # Editor action buttons
    ZoomControls.tsx          # Zoom slider and buttons
    FullscreenViewer.tsx      # Fullscreen image view
  
  adjustments/
    ExposureControls.tsx      # Brightness, contrast, highlights, shadows
    ColorControls.tsx         # Temperature, tint, saturation, vibrance
    ToneCurves.tsx            # Curves editor
    DetailControls.tsx        # Sharpening, noise reduction
    EffectsControls.tsx       # Vignette, grain, dehaze
    HSLControls.tsx           # HSL color tuning
    LensCorrections.tsx       # Distortion, chromatic aberration
  
  panels/
    AdjustmentsPanel.tsx      # Container for all adjustment modules
    CropPanel.tsx             # Crop, rotate, straighten controls
    MasksPanel.tsx            # Mask editing interface
    PresetsPanel.tsx          # Preset browser and editor
    ExportPanel.tsx           # Export settings and progress
    MetadataPanel.tsx         # EXIF/metadata display and editing
    AIPanel.tsx               # AI features (subject select, inpainting)
    PanelSwitcher.tsx         # Panel tab navigation
  
  metadata/
    RatingControl.tsx         # Star rating widget
    ColorLabel.tsx            # Color label picker
    TagEditor.tsx             # Tag management
  
  common/
    LoadingSpinner.tsx        # Loading state indicator
    ErrorMessage.tsx          # Error display
    ContextMenu.tsx           # Right-click context menu
    ProgressBar.tsx           # Progress indicator
```

---

## Library Modules

### GalleryGrid

A virtualized grid of image thumbnails with support for selection, context menus, and keyboard navigation.

```typescript
// modules/library/GalleryGrid.tsx
import { useBloc, borrow } from '@blac/react';
import { VariableSizeList as List } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { LibraryBloc } from '../../blocs/library/LibraryBloc';
import { SelectionBloc } from '../../blocs/library/SelectionBloc';
import { ThumbnailBloc } from '../../blocs/library/ThumbnailBloc';
import { RatingsBloc } from '../../blocs/library/RatingsBloc';
import { SettingsBloc } from '../../blocs/app/SettingsBloc';
import { EditorBloc } from '../../blocs/editor/EditorBloc';
import { ContextMenuService } from '../../blocs/services/ContextMenuService';
import { ClipboardService } from '../../blocs/services/ClipboardService';
import { ModalBloc } from '../../blocs/modals/ModalBloc';
import { ImageCard } from './ImageCard';

interface GalleryRowData {
  type: 'images' | 'header';
  images?: ImageFile[];
  path?: string;
  count?: number;
}

export function GalleryGrid() {
  const [library] = useBloc(LibraryBloc);
  const [selection, selectionBloc] = useBloc(SelectionBloc);
  const [thumbnails] = useBloc(ThumbnailBloc);
  const [ratings] = useBloc(RatingsBloc);
  const [settings] = useBloc(SettingsBloc);

  const images = library.sortedFilteredImages;
  const { thumbnailSize, thumbnailAspectRatio } = settings.settings;

  const handleImageClick = (path: string, event: React.MouseEvent) => {
    selectionBloc.handleClick(path, event, images.map(i => i.path));
  };

  const handleImageDoubleClick = (path: string) => {
    borrow(EditorBloc).selectImage(path);
  };

  const handleContextMenu = (event: React.MouseEvent, path: string) => {
    event.preventDefault();
    if (!selection.selectedPaths.includes(path)) {
      selectionBloc.selectSingle(path);
    }
    borrow(ContextMenuService).show(event.clientX, event.clientY, [
      { label: 'Open in Editor', onClick: () => borrow(EditorBloc).selectImage(path) },
      { label: 'Rate', submenu: [/* rating options */] },
      { type: 'separator' },
      { label: 'Copy', onClick: () => borrow(ClipboardService).copyPaths(selection.selectedPaths) },
      { label: 'Move to...', onClick: () => borrow(ModalBloc).show('move-files') },
      { type: 'separator' },
      { label: 'Delete', onClick: () => borrow(ModalBloc).show('confirm-delete'), isDestructive: true },
    ]);
  };

  return (
    <div className="flex-1 w-full h-full" onClick={() => selectionBloc.clearSelection()}>
      <AutoSizer>
        {({ height, width }) => {
          const OUTER_PADDING = 12;
          const ITEM_GAP = 12;
          const minThumbWidth = THUMBNAIL_SIZES[thumbnailSize];
          
          const availableWidth = width - OUTER_PADDING * 2;
          const columnCount = Math.max(1, Math.floor((availableWidth + ITEM_GAP) / (minThumbWidth + ITEM_GAP)));
          const itemWidth = (availableWidth - ITEM_GAP * (columnCount - 1)) / columnCount;
          const rowHeight = itemWidth + ITEM_GAP;

          const rows: GalleryRowData[] = [];
          for (let i = 0; i < images.length; i += columnCount) {
            rows.push({ type: 'images', images: images.slice(i, i + columnCount) });
          }

          return (
            <List
              height={height}
              width={width}
              itemCount={rows.length}
              itemSize={() => rowHeight}
              itemData={{
                rows,
                itemWidth,
                columnCount,
                selection,
                thumbnails: thumbnails.thumbnails,
                ratings: ratings.ratings,
                aspectRatio: thumbnailAspectRatio,
                onImageClick: handleImageClick,
                onImageDoubleClick: handleImageDoubleClick,
                onContextMenu: handleContextMenu,
              }}
            >
              {GalleryRow}
            </List>
          );
        }}
      </AutoSizer>
    </div>
  );
}

const GalleryRow = memo(({ index, style, data }: ListChildComponentProps) => {
  const { rows, itemWidth, onImageClick, onImageDoubleClick, onContextMenu, ...rest } = data;
  const row = rows[index];

  if (row.type === 'header') {
    return (
      <div style={style} className="flex items-end pb-2 px-3">
        <FolderOpen size={16} className="text-text-secondary mr-2" />
        <span className="text-sm font-semibold text-text-secondary">{row.path}</span>
        <span className="text-xs text-text-secondary ml-auto">{row.count} images</span>
      </div>
    );
  }

  return (
    <div style={{ ...style, display: 'flex', gap: 12, padding: '0 12px' }}>
      {row.images.map((image: ImageFile) => (
        <ImageCard
          key={image.path}
          image={image}
          width={itemWidth}
          thumbnail={rest.thumbnails[image.path]}
          rating={rest.ratings[image.path] || 0}
          isSelected={rest.selection.selectedPaths.includes(image.path)}
          isActive={rest.selection.activePath === image.path}
          aspectRatio={rest.aspectRatio}
          onClick={(e) => onImageClick(image.path, e)}
          onDoubleClick={() => onImageDoubleClick(image.path)}
          onContextMenu={(e) => onContextMenu(e, image.path)}
        />
      ))}
    </div>
  );
});
```

### GalleryControls

Search input, filter/sort dropdowns, view mode options.

```typescript
// modules/library/GalleryControls.tsx
import { useBloc, borrow } from '@blac/react';
import { FilterBloc } from '../../blocs/library/FilterBloc';
import { SortBloc } from '../../blocs/library/SortBloc';
import { SearchBloc } from '../../blocs/library/SearchBloc';
import { SettingsBloc } from '../../blocs/app/SettingsBloc';
import { LibraryBloc } from '../../blocs/library/LibraryBloc';
import { AppBloc } from '../../blocs/app/AppBloc';
import { ModalBloc } from '../../blocs/modals/ModalBloc';
import { Dropdown } from '../../primitives/Dropdown';
import { Button } from '../../primitives/Button';

export function GalleryControls() {
  const [search, searchBloc] = useBloc(SearchBloc);
  const [filter, filterBloc] = useBloc(FilterBloc);
  const [sort, sortBloc] = useBloc(SortBloc);
  const [settings, settingsBloc] = useBloc(SettingsBloc);
  const [library] = useBloc(LibraryBloc);

  return (
    <header className="p-4 flex justify-between items-center border-b border-border-color gap-4">
      <div className="min-w-0">
        <h2 className="text-2xl font-bold text-primary">Library</h2>
        <p className="text-sm text-text-secondary truncate">{library.currentFolderPath}</p>
      </div>

      <div className="flex items-center gap-3">
        <SearchInput
          value={search.query}
          tags={search.tags}
          mode={search.mode}
          isIndexing={search.isIndexing}
          onQueryChange={searchBloc.setQuery}
          onAddTag={searchBloc.addTag}
          onRemoveTag={searchBloc.removeTag}
          onToggleMode={searchBloc.toggleMode}
          onClear={searchBloc.clear}
        />

        <ViewOptionsDropdown
          thumbnailSize={settings.settings.thumbnailSize}
          thumbnailAspectRatio={settings.settings.thumbnailAspectRatio}
          viewMode={library.viewMode}
          filterState={filter}
          sortState={sort}
          onThumbnailSizeChange={(size) => settingsBloc.updateSettings({ thumbnailSize: size })}
          onAspectRatioChange={(ratio) => settingsBloc.updateSettings({ thumbnailAspectRatio: ratio })}
          onViewModeChange={library.setViewMode}
          onFilterChange={filterBloc}
          onSortChange={sortBloc}
        />

        <Button
          variant="ghost"
          size="icon"
          onClick={() => borrow(AppBloc).navigateToCommunity()}
          title="Community Presets"
        >
          <Users className="w-5 h-5" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => borrow(ModalBloc).show('open-folder')}
          title="Open Folder"
        >
          <Folder className="w-5 h-5" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => borrow(LibraryBloc).goHome()}
          title="Go Home"
        >
          <Home className="w-5 h-5" />
        </Button>
      </div>
    </header>
  );
}
```

### ImageCard

Single image thumbnail with rating, color label, and loading states.

```typescript
// modules/library/ImageCard.tsx
import { memo, useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ImageIcon, Star } from 'lucide-react';
import type { ImageFile, ThumbnailAspectRatio } from '../../types/library';

interface ImageCardProps {
  image: ImageFile;
  width: number;
  thumbnail?: string;
  rating: number;
  isSelected: boolean;
  isActive: boolean;
  aspectRatio: ThumbnailAspectRatio;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export const ImageCard = memo(function ImageCard({
  image,
  width,
  thumbnail,
  rating,
  isSelected,
  isActive,
  aspectRatio,
  onClick,
  onDoubleClick,
  onContextMenu,
}: ImageCardProps) {
  const [showPlaceholder, setShowPlaceholder] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);

  useEffect(() => {
    if (thumbnail) {
      setShowPlaceholder(false);
      return;
    }
    const timer = setTimeout(() => setShowPlaceholder(true), 500);
    return () => clearTimeout(timer);
  }, [thumbnail]);

  const { baseName, isVirtualCopy } = useMemo(() => {
    const fullFileName = image.path.split(/[\\/]/).pop() || '';
    const parts = fullFileName.split('?vc=');
    return { baseName: parts[0], isVirtualCopy: parts.length > 1 };
  }, [image.path]);

  const colorTag = image.tags?.find(t => t.startsWith('color:'))?.substring(6);
  const colorLabel = COLOR_LABELS.find(c => c.name === colorTag);

  const ringClass = isActive
    ? 'ring-2 ring-accent'
    : isSelected
    ? 'ring-2 ring-gray-400'
    : 'hover:ring-2 hover:ring-hover-color';

  return (
    <div
      className={`aspect-square bg-surface rounded-md overflow-hidden cursor-pointer group relative transition-all duration-150 ${ringClass}`}
      style={{ width, height: width }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={baseName}
    >
      {thumbnail ? (
        <div className="absolute inset-0 w-full h-full">
          {aspectRatio === 'contain' && (
            <img
              alt=""
              className="absolute inset-0 w-full h-full object-cover blur-md scale-110"
              src={thumbnail}
            />
          )}
          <img
            alt={baseName}
            className={`w-full h-full group-hover:scale-[1.02] transition-transform duration-300 relative ${
              aspectRatio === 'contain' ? 'object-contain' : 'object-cover'
            }`}
            src={thumbnail}
            onLoad={() => setImageLoaded(true)}
            style={{ opacity: imageLoaded ? 1 : 0, transition: 'opacity 300ms ease-in-out' }}
          />
        </div>
      ) : (
        <AnimatePresence>
          {showPlaceholder && (
            <motion.div
              className="absolute inset-0 w-full h-full flex items-center justify-center bg-surface"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <ImageIcon className="text-text-secondary animate-pulse" />
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {(colorLabel || rating > 0) && (
        <div className="absolute top-1.5 right-1.5 bg-bg-primary/50 rounded-full px-1.5 py-0.5 text-xs text-text-primary flex items-center gap-1 backdrop-blur-sm">
          {colorLabel && (
            <div
              className="w-3 h-3 rounded-full ring-1 ring-black/20"
              style={{ backgroundColor: colorLabel.color }}
            />
          )}
          {rating > 0 && (
            <>
              <span>{rating}</span>
              <Star size={12} className="text-accent fill-accent" />
            </>
          )}
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 flex items-end justify-between">
        <p className="text-white text-xs truncate pr-2">{baseName}</p>
        {isVirtualCopy && (
          <div className="flex-shrink-0 bg-bg-primary/50 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full backdrop-blur-sm">
            VC
          </div>
        )}
      </div>
    </div>
  );
});
```

### FolderTree

Folder navigation sidebar with expandable tree structure.

```typescript
// modules/library/FolderTree.tsx
import { useBloc, borrow } from '@blac/react';
import { FolderBloc } from '../../blocs/library/FolderBloc';
import { LibraryBloc } from '../../blocs/library/LibraryBloc';
import { SettingsBloc } from '../../blocs/app/SettingsBloc';
import { ChevronRight, ChevronDown, Folder, FolderOpen, Pin, PinOff } from 'lucide-react';

interface FolderNodeProps {
  node: FolderNode;
  depth: number;
  isActive: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onPin: (path: string) => void;
  onUnpin: (path: string) => void;
  isPinned: boolean;
}

function FolderNodeItem({ node, depth, isActive, onSelect, onToggle, onPin, onUnpin, isPinned }: FolderNodeProps) {
  const hasChildren = node.children && node.children.length > 0;
  const Icon = node.isExpanded ? FolderOpen : Folder;
  const ChevronIcon = node.isExpanded ? ChevronDown : ChevronRight;

  return (
    <div>
      <div
        className={`flex items-center py-1.5 px-2 rounded-md cursor-pointer group ${
          isActive ? 'bg-accent text-button-text' : 'hover:bg-surface'
        }`}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={() => onSelect(node.path)}
      >
        {hasChildren ? (
          <button
            className="p-0.5 mr-1 hover:bg-black/10 rounded"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.path);
            }}
          >
            <ChevronIcon size={14} />
          </button>
        ) : (
          <span className="w-5" />
        )}
        <Icon size={16} className="mr-2 flex-shrink-0" />
        <span className="truncate flex-1 text-sm">{node.name}</span>
        <button
          className={`p-1 rounded opacity-0 group-hover:opacity-100 ${isPinned ? 'opacity-100' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            isPinned ? onUnpin(node.path) : onPin(node.path);
          }}
          title={isPinned ? 'Unpin folder' : 'Pin folder'}
        >
          {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
      </div>
      {node.isExpanded && node.children?.map(child => (
        <FolderNodeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          isActive={child.path === isActive}
          onSelect={onSelect}
          onToggle={onToggle}
          onPin={onPin}
          onUnpin={onUnpin}
          isPinned={isPinned}
        />
      ))}
    </div>
  );
}

export function FolderTree() {
  const [folders, foldersBloc] = useBloc(FolderBloc);
  const [library] = useBloc(LibraryBloc);
  const [settings, settingsBloc] = useBloc(SettingsBloc);

  const handleSelect = (path: string) => {
    borrow(LibraryBloc).openFolder(path);
  };

  const handlePin = (path: string) => {
    const newPinned = [...settings.settings.pinnedFolders, path];
    settingsBloc.updateSettings({ pinnedFolders: newPinned });
  };

  const handleUnpin = (path: string) => {
    const newPinned = settings.settings.pinnedFolders.filter(p => p !== path);
    settingsBloc.updateSettings({ pinnedFolders: newPinned });
  };

  return (
    <div className="h-full overflow-y-auto p-2">
      {settings.settings.pinnedFolders.length > 0 && (
        <div className="mb-4">
          <h3 className="text-xs font-semibold text-text-secondary uppercase px-2 mb-2">Pinned</h3>
          {settings.settings.pinnedFolders.map(path => (
            <div
              key={path}
              className={`flex items-center py-1.5 px-2 rounded-md cursor-pointer group ${
                library.currentFolderPath === path ? 'bg-accent text-button-text' : 'hover:bg-surface'
              }`}
              onClick={() => handleSelect(path)}
            >
              <FolderOpen size={16} className="mr-2" />
              <span className="truncate flex-1 text-sm">{path.split(/[\\/]/).pop()}</span>
              <button
                className="p-1 rounded opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  handleUnpin(path);
                }}
              >
                <PinOff size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <h3 className="text-xs font-semibold text-text-secondary uppercase px-2 mb-2">Folders</h3>
      {folders.tree && (
        <FolderNodeItem
          node={folders.tree}
          depth={0}
          isActive={library.currentFolderPath === folders.tree.path}
          onSelect={handleSelect}
          onToggle={foldersBloc.toggleExpand}
          onPin={handlePin}
          onUnpin={handleUnpin}
          isPinned={settings.settings.pinnedFolders.includes(folders.tree.path)}
        />
      )}
    </div>
  );
}
```

### Filmstrip

Horizontal thumbnail strip for navigation in editor view.

```typescript
// modules/library/Filmstrip.tsx
import { useBloc } from '@blac/react';
import { useRef, useEffect } from 'react';
import { LibraryBloc } from '../../blocs/library/LibraryBloc';
import { EditorBloc } from '../../blocs/editor/EditorBloc';
import { ThumbnailBloc } from '../../blocs/library/ThumbnailBloc';
import { RatingsBloc } from '../../blocs/library/RatingsBloc';

export function Filmstrip() {
  const [library] = useBloc(LibraryBloc);
  const [editor, editorBloc] = useBloc(EditorBloc);
  const [thumbnails] = useBloc(ThumbnailBloc);
  const [ratings] = useBloc(RatingsBloc);
  const containerRef = useRef<HTMLDivElement>(null);

  const images = library.sortedFilteredImages;
  const currentPath = editor.selectedImage?.path;

  useEffect(() => {
    if (!currentPath || !containerRef.current) return;
    
    const index = images.findIndex(img => img.path === currentPath);
    if (index >= 0) {
      const element = containerRef.current.children[index] as HTMLElement;
      element?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [currentPath, images]);

  const handleNavigate = (direction: 'prev' | 'next') => {
    if (!currentPath) return;
    const index = images.findIndex(img => img.path === currentPath);
    const newIndex = direction === 'prev' ? index - 1 : index + 1;
    
    if (newIndex >= 0 && newIndex < images.length) {
      editorBloc.selectImage(images[newIndex].path);
    }
  };

  return (
    <div className="h-full flex items-center bg-bg-secondary border-t border-border-color">
      <button
        className="p-2 hover:bg-surface rounded-md disabled:opacity-30"
        onClick={() => handleNavigate('prev')}
        disabled={!currentPath || images.findIndex(img => img.path === currentPath) === 0}
      >
        <ChevronLeft size={20} />
      </button>

      <div
        ref={containerRef}
        className="flex-1 flex items-center gap-2 overflow-x-auto px-2 scrollbar-thin"
      >
        {images.map(image => {
          const isActive = image.path === currentPath;
          const thumbnail = thumbnails.thumbnails[image.path];
          const rating = ratings.ratings[image.path] || 0;

          return (
            <div
              key={image.path}
              className={`flex-shrink-0 w-20 h-20 rounded-md overflow-hidden cursor-pointer transition-all ${
                isActive ? 'ring-2 ring-accent scale-105' : 'hover:ring-2 hover:ring-hover-color opacity-70 hover:opacity-100'
              }`}
              onClick={() => editorBloc.selectImage(image.path)}
            >
              {thumbnail ? (
                <img src={thumbnail} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-surface flex items-center justify-center">
                  <ImageIcon size={20} className="text-text-secondary" />
                </div>
              )}
              {rating > 0 && (
                <div className="absolute bottom-0.5 right-0.5 bg-black/50 rounded px-1 text-[10px] text-white">
                  {rating}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        className="p-2 hover:bg-surface rounded-md disabled:opacity-30"
        onClick={() => handleNavigate('next')}
        disabled={!currentPath || images.findIndex(img => img.path === currentPath) === images.length - 1}
      >
        <ChevronRight size={20} />
      </button>
    </div>
  );
}
```

---

## Editor Modules

### ImagePreview

Main image canvas with layer management, mask overlays, and zoom/pan.

```typescript
// modules/editor/ImagePreview.tsx
import { useBloc } from '@blac/react';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Stage, Layer, Line, Circle, Ellipse, Rect, Group, Transformer } from 'react-konva';
import { EditorBloc } from '../../blocs/editor/EditorBloc';
import { PreviewBloc } from '../../blocs/editor/PreviewBloc';
import { ZoomBloc } from '../../blocs/editor/ZoomBloc';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc';
import { MasksBloc } from '../../blocs/panels/MasksBloc';
import { CropBloc } from '../../blocs/panels/CropBloc';
import { useImageRenderSize } from '../../hooks/useImageRenderSize';

interface ImageLayer {
  id: string;
  url: string | null;
  opacity: number;
}

export function ImagePreview() {
  const [editor] = useBloc(EditorBloc);
  const [preview] = useBloc(PreviewBloc);
  const [zoom, zoomBloc] = useBloc(ZoomBloc);
  const [adjustments] = useBloc(AdjustmentsBloc);
  const [masks, masksBloc] = useBloc(MasksBloc);
  const [crop] = useBloc(CropBloc);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const [layers, setLayers] = useState<ImageLayer[]>([]);
  const imagePathRef = useRef<string | null>(null);

  const imageRenderSize = useImageRenderSize(
    editor.selectedImage,
    containerRef,
    adjustments.crop
  );

  // Layer management - crossfade between previews
  useEffect(() => {
    const { path, originalUrl, thumbnailUrl } = editor.selectedImage || {};
    const imageChanged = path !== imagePathRef.current;
    const currentPreviewUrl = preview.finalPreviewUrl;

    if (imageChanged) {
      imagePathRef.current = path || null;
      const initialUrl = thumbnailUrl || originalUrl;
      setLayers(initialUrl ? [{ id: initialUrl, url: initialUrl, opacity: 1 }] : []);
      return;
    }

    if (currentPreviewUrl && !layers.some(l => l.id === currentPreviewUrl)) {
      setLayers(prev => [...prev, { id: currentPreviewUrl, url: currentPreviewUrl, opacity: 0 }]);
    }
  }, [editor.selectedImage, preview.finalPreviewUrl]);

  // Fade in new layers
  useEffect(() => {
    const layerToFadeIn = layers.find(l => l.opacity === 0);
    if (layerToFadeIn) {
      const timer = setTimeout(() => {
        setLayers(prev => prev.map(l => 
          l.id === layerToFadeIn.id ? { ...l, opacity: 1 } : l
        ));
      }, 10);
      return () => clearTimeout(timer);
    }
  }, [layers]);

  const handleTransitionEnd = useCallback((finishedId: string) => {
    setLayers(prev => {
      const finishedIndex = prev.findIndex(l => l.id === finishedId);
      if (finishedIndex < 0 || prev.length <= 1) return prev;
      return prev.slice(finishedIndex);
    });
  }, []);

  // Mouse handling for masks, zoom, pan
  const handleMouseDown = useCallback((e: any) => {
    if (masks.isDrawing) {
      masksBloc.startDrawing(e);
    }
  }, [masks.isDrawing, masksBloc]);

  const handleMouseMove = useCallback((e: any) => {
    if (masks.isDrawing) {
      masksBloc.continueDrawing(e);
    }
  }, [masks.isDrawing, masksBloc]);

  const handleMouseUp = useCallback(() => {
    if (masks.isDrawing) {
      masksBloc.finishDrawing();
    }
  }, [masks.isDrawing, masksBloc]);

  const handleWheel = useCallback((e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      zoomBloc.setScale(zoom.scale * delta);
    }
  }, [zoom.scale, zoomBloc]);

  if (!editor.selectedImage) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-secondary">
        <p className="text-text-secondary">No image selected</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative flex-1 bg-bg-primary overflow-hidden"
      onWheel={handleWheel}
    >
      {/* Image layers */}
      <div className="absolute inset-0 flex items-center justify-center">
        {layers.map(layer => layer.url && (
          <img
            key={layer.id}
            src={layer.url}
            alt=""
            className="absolute max-w-full max-h-full object-contain"
            style={{
              opacity: layer.opacity,
              transition: 'opacity 150ms ease-in-out',
              transform: `scale(${zoom.scale}) translate(${zoom.positionX}px, ${zoom.positionY}px)`,
            }}
            onTransitionEnd={() => handleTransitionEnd(layer.id)}
          />
        ))}
      </div>

      {/* Mask overlay */}
      {masks.isActive && masks.overlayUrl && (
        <img
          src={masks.overlayUrl}
          alt="Mask Overlay"
          className="absolute pointer-events-none"
          style={{
            width: imageRenderSize.width,
            height: imageRenderSize.height,
            left: imageRenderSize.offsetX,
            top: imageRenderSize.offsetY,
            opacity: masks.showOverlay ? 1 : 0,
            transition: 'opacity 125ms ease-in-out',
          }}
        />
      )}

      {/* Konva stage for mask editing */}
      <Stage
        width={imageRenderSize.width}
        height={imageRenderSize.height}
        style={{
          position: 'absolute',
          left: imageRenderSize.offsetX,
          top: imageRenderSize.offsetY,
          cursor: masks.isDrawing ? 'crosshair' : 'default',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <Layer>
          {masks.activeContainer?.subMasks.map(subMask => (
            <MaskShape
              key={subMask.id}
              subMask={subMask}
              isSelected={subMask.id === masks.activeSubMaskId}
              scale={imageRenderSize.scale}
              cropOffset={{ x: adjustments.crop?.x || 0, y: adjustments.crop?.y || 0 }}
              onSelect={() => masksBloc.selectSubMask(subMask.id)}
              onUpdate={(updates) => masksBloc.updateSubMask(subMask.id, updates)}
            />
          ))}
        </Layer>
      </Stage>

      {/* Loading indicator */}
      {preview.isAdjusting && (
        <div className="absolute top-4 right-4 bg-bg-primary/80 rounded-full p-2">
          <Loader2 className="w-4 h-4 animate-spin text-accent" />
        </div>
      )}
    </div>
  );
}
```

### ZoomControls

Zoom slider, fit-to-window, and 100% zoom buttons.

```typescript
// modules/editor/ZoomControls.tsx
import { useBloc } from '@blac/react';
import { ZoomBloc } from '../../blocs/editor/ZoomBloc';
import { Slider } from '../../primitives/Slider';
import { Button } from '../../primitives/Button';
import { ZoomIn, ZoomOut, Maximize, Square } from 'lucide-react';

export function ZoomControls() {
  const [zoom, zoomBloc] = useBloc(ZoomBloc);

  const zoomPercentage = Math.round(zoom.scale * 100);

  return (
    <div className="flex items-center gap-2 bg-surface rounded-lg px-3 py-2">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => zoomBloc.zoomOut()}
        disabled={zoom.scale <= 0.1}
      >
        <ZoomOut size={16} />
      </Button>

      <Slider
        value={zoom.scale}
        min={0.1}
        max={5}
        step={0.01}
        onChange={zoomBloc.setScale}
        className="w-24"
      />

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => zoomBloc.zoomIn()}
        disabled={zoom.scale >= 5}
      >
        <ZoomIn size={16} />
      </Button>

      <span className="text-xs text-text-secondary w-12 text-center">
        {zoomPercentage}%
      </span>

      <div className="w-px h-4 bg-border-color mx-1" />

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => zoomBloc.fitToWindow()}
        title="Fit to window"
      >
        <Maximize size={16} />
      </Button>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => zoomBloc.zoom100Percent()}
        title="100%"
      >
        <Square size={16} />
      </Button>

      {zoom.isLoadingFullRes && (
        <Loader2 className="w-4 h-4 animate-spin text-accent ml-2" />
      )}
    </div>
  );
}
```

### EditorToolbar

Editor action buttons: show original, fullscreen, export, etc.

```typescript
// modules/editor/EditorToolbar.tsx
import { useBloc, borrow } from '@blac/react';
import { EditorBloc } from '../../blocs/editor/EditorBloc';
import { PreviewBloc } from '../../blocs/editor/PreviewBloc';
import { HistoryBloc } from '../../blocs/editor/HistoryBloc';
import { FullscreenBloc } from '../../blocs/editor/FullscreenBloc';
import { ExportBloc } from '../../blocs/panels/ExportBloc';
import { ClipboardService } from '../../blocs/services/ClipboardService';
import { ModalBloc } from '../../blocs/modals/ModalBloc';
import { Button } from '../../primitives/Button';
import { ZoomControls } from './ZoomControls';
import {
  Eye, EyeOff, Undo2, Redo2, Maximize2, Download, Copy, Grid3X3, ChevronLeft
} from 'lucide-react';

export function EditorToolbar() {
  const [editor, editorBloc] = useBloc(EditorBloc);
  const [preview, previewBloc] = useBloc(PreviewBloc);
  const [history] = useBloc(HistoryBloc);
  const [fullscreen, fullscreenBloc] = useBloc(FullscreenBloc);

  const handleShowOriginal = (show: boolean) => {
    previewBloc.setShowOriginal(show);
  };

  return (
    <div className="absolute top-4 left-4 right-4 flex items-center justify-between z-10 pointer-events-none">
      {/* Left side */}
      <div className="flex items-center gap-2 pointer-events-auto">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => editorBloc.closeEditor()}
        >
          <ChevronLeft size={16} className="mr-1" />
          Library
        </Button>

        <div className="w-px h-6 bg-border-color mx-2" />

        <Button
          variant="ghost"
          size="icon"
          onMouseDown={() => handleShowOriginal(true)}
          onMouseUp={() => handleShowOriginal(false)}
          onMouseLeave={() => handleShowOriginal(false)}
          title="Hold to show original (\\)"
        >
          {preview.showOriginal ? <EyeOff size={18} /> : <Eye size={18} />}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => borrow(HistoryBloc).undo()}
          disabled={!history.canUndo}
          title="Undo (Cmd+Z)"
        >
          <Undo2 size={18} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => borrow(HistoryBloc).redo()}
          disabled={!history.canRedo}
          title="Redo (Cmd+Shift+Z)"
        >
          <Redo2 size={18} />
        </Button>
      </div>

      {/* Center - Zoom controls */}
      <div className="pointer-events-auto">
        <ZoomControls />
      </div>

      {/* Right side */}
      <div className="flex items-center gap-2 pointer-events-auto">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => fullscreenBloc.toggle()}
          title="Fullscreen (F)"
        >
          <Maximize2 size={18} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => borrow(ClipboardService).copyAdjustments()}
          title="Copy adjustments (Cmd+C)"
        >
          <Copy size={18} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => borrow(ModalBloc).show('compare')}
          title="Compare"
        >
          <Grid3X3 size={18} />
        </Button>

        <Button
          variant="primary"
          size="sm"
          onClick={() => borrow(ExportBloc).quickExport()}
        >
          <Download size={16} className="mr-1" />
          Export
        </Button>
      </div>
    </div>
  );
}
```

---

## Adjustment Modules

### ExposureControls

Basic exposure controls: brightness, contrast, highlights, shadows, whites, blacks.

```typescript
// modules/adjustments/ExposureControls.tsx
import { useBloc } from '@blac/react';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc';
import { Slider } from '../../primitives/Slider';
import { ToneMapperSwitch } from './ToneMapperSwitch';

export function ExposureControls() {
  const [adjustments, bloc] = useBloc(AdjustmentsBloc);

  return (
    <div className="space-y-4">
      <ToneMapperSwitch
        selectedMapper={adjustments.toneMapper || 'agx'}
        exposureValue={adjustments.exposure}
        onMapperChange={bloc.setToneMapper}
        onExposureChange={bloc.setExposure}
      />

      <Slider
        label="Brightness"
        value={adjustments.brightness}
        min={-5}
        max={5}
        step={0.01}
        onChange={bloc.setBrightness}
      />

      <Slider
        label="Contrast"
        value={adjustments.contrast}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setContrast}
      />

      <Slider
        label="Highlights"
        value={adjustments.highlights}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setHighlights}
      />

      <Slider
        label="Shadows"
        value={adjustments.shadows}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setShadows}
      />

      <Slider
        label="Whites"
        value={adjustments.whites}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setWhites}
      />

      <Slider
        label="Blacks"
        value={adjustments.blacks}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setBlacks}
      />
    </div>
  );
}
```

### ColorControls

Color and white balance controls: temperature, tint, saturation, vibrance.

```typescript
// modules/adjustments/ColorControls.tsx
import { useBloc } from '@blac/react';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc';
import { Slider } from '../../primitives/Slider';
import { Button } from '../../primitives/Button';
import { Pipette } from 'lucide-react';

interface ColorControlsProps {
  onWhiteBalancePicker?: () => void;
  isWbPickerActive?: boolean;
}

export function ColorControls({ onWhiteBalancePicker, isWbPickerActive }: ColorControlsProps) {
  const [adjustments, bloc] = useBloc(AdjustmentsBloc);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">White Balance</span>
        {onWhiteBalancePicker && (
          <Button
            variant={isWbPickerActive ? 'primary' : 'ghost'}
            size="icon-sm"
            onClick={onWhiteBalancePicker}
            title="Pick white balance from image"
          >
            <Pipette size={14} />
          </Button>
        )}
      </div>

      <Slider
        label="Temperature"
        value={adjustments.temperature}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setTemperature}
        trackClassName="bg-gradient-to-r from-blue-400 to-orange-400"
      />

      <Slider
        label="Tint"
        value={adjustments.tint}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setTint}
        trackClassName="bg-gradient-to-r from-green-400 to-pink-400"
      />

      <div className="h-px bg-border-color my-4" />

      <Slider
        label="Saturation"
        value={adjustments.saturation}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setSaturation}
      />

      <Slider
        label="Vibrance"
        value={adjustments.vibrance}
        min={-100}
        max={100}
        step={1}
        onChange={bloc.setVibrance}
      />
    </div>
  );
}
```

### ToneCurves

Curves editor for fine-tuned tonal adjustments.

```typescript
// modules/adjustments/ToneCurves.tsx
import { useBloc } from '@blac/react';
import { useState, useRef, useCallback } from 'react';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc';
import { PreviewBloc } from '../../blocs/editor/PreviewBloc';
import { Tabs } from '../../primitives/Tabs';

type CurveChannel = 'rgb' | 'red' | 'green' | 'blue';

interface CurvePoint {
  x: number;
  y: number;
}

export function ToneCurves() {
  const [adjustments, bloc] = useBloc(AdjustmentsBloc);
  const [preview] = useBloc(PreviewBloc);
  const [activeChannel, setActiveChannel] = useState<CurveChannel>('rgb');
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const curvePoints = adjustments.curves?.[activeChannel] || [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ];

  const handlePointDrag = useCallback((index: number, e: React.MouseEvent) => {
    if (!svgRef.current) return;

    const rect = svgRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(255, ((e.clientX - rect.left) / rect.width) * 255));
    const y = Math.max(0, Math.min(255, 255 - ((e.clientY - rect.top) / rect.height) * 255));

    const newPoints = [...curvePoints];
    newPoints[index] = { x, y };
    
    // Sort by x to maintain curve order
    newPoints.sort((a, b) => a.x - b.x);
    
    bloc.setCurve(activeChannel, newPoints);
  }, [curvePoints, activeChannel, bloc]);

  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (!svgRef.current) return;
    
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 255;
    const y = 255 - ((e.clientY - rect.top) / rect.height) * 255;

    const newPoints = [...curvePoints, { x, y }].sort((a, b) => a.x - b.x);
    bloc.setCurve(activeChannel, newPoints);
  }, [curvePoints, activeChannel, bloc]);

  const pathD = generateCurvePath(curvePoints);

  const channelColors: Record<CurveChannel, string> = {
    rgb: '#ffffff',
    red: '#ef4444',
    green: '#22c55e',
    blue: '#3b82f6',
  };

  return (
    <div className="space-y-4">
      <Tabs
        value={activeChannel}
        onChange={(v) => setActiveChannel(v as CurveChannel)}
        options={[
          { value: 'rgb', label: 'RGB' },
          { value: 'red', label: 'R' },
          { value: 'green', label: 'G' },
          { value: 'blue', label: 'B' },
        ]}
      />

      <div className="relative aspect-square bg-bg-primary rounded-lg overflow-hidden">
        {/* Histogram background */}
        {preview.histogram && (
          <HistogramBackground data={preview.histogram} channel={activeChannel} />
        )}

        {/* Grid */}
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 256 256">
          <defs>
            <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
              <path d="M 64 0 L 0 0 0 64" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1"/>
            </pattern>
          </defs>
          <rect width="256" height="256" fill="url(#grid)" />
          <line x1="0" y1="256" x2="256" y2="0" stroke="rgba(255,255,255,0.2)" strokeWidth="1" strokeDasharray="4" />
        </svg>

        {/* Curve */}
        <svg
          ref={svgRef}
          className="absolute inset-0 w-full h-full cursor-crosshair"
          viewBox="0 0 256 256"
          onClick={handleCanvasClick}
        >
          <path
            d={pathD}
            fill="none"
            stroke={channelColors[activeChannel]}
            strokeWidth="2"
          />
          {curvePoints.map((point, i) => (
            <circle
              key={i}
              cx={point.x}
              cy={255 - point.y}
              r={selectedPoint === i ? 6 : 4}
              fill={selectedPoint === i ? channelColors[activeChannel] : 'white'}
              stroke={channelColors[activeChannel]}
              strokeWidth="2"
              className="cursor-move"
              onMouseDown={(e) => {
                e.stopPropagation();
                setSelectedPoint(i);
              }}
            />
          ))}
        </svg>
      </div>

      <Button
        variant="ghost"
        size="sm"
        className="w-full"
        onClick={() => bloc.setCurve(activeChannel, [{ x: 0, y: 0 }, { x: 255, y: 255 }])}
      >
        Reset Curve
      </Button>
    </div>
  );
}

function generateCurvePath(points: CurvePoint[]): string {
  if (points.length < 2) return '';
  
  // Generate smooth bezier curve through points
  let path = `M ${points[0].x} ${255 - points[0].y}`;
  
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const cp1x = p0.x + (p1.x - p0.x) / 3;
    const cp1y = 255 - p0.y;
    const cp2x = p1.x - (p1.x - p0.x) / 3;
    const cp2y = 255 - p1.y;
    path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p1.x} ${255 - p1.y}`;
  }
  
  return path;
}
```

---

## Panel Modules

### AdjustmentsPanel

Container for all adjustment control modules with collapsible sections.

```typescript
// modules/panels/AdjustmentsPanel.tsx
import { useBloc } from '@blac/react';
import { PanelBloc } from '../../blocs/panels/PanelBloc';
import { CollapsibleSection } from '../../primitives/CollapsibleSection';
import { ExposureControls } from '../adjustments/ExposureControls';
import { ColorControls } from '../adjustments/ColorControls';
import { ToneCurves } from '../adjustments/ToneCurves';
import { DetailControls } from '../adjustments/DetailControls';
import { EffectsControls } from '../adjustments/EffectsControls';
import { HSLControls } from '../adjustments/HSLControls';

export function AdjustmentsPanel() {
  const [panel, panelBloc] = useBloc(PanelBloc);

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="p-4 space-y-2">
        <CollapsibleSection
          title="Basic"
          isCollapsed={panel.collapsedSections['basic']}
          onToggle={() => panelBloc.toggleSection('basic')}
        >
          <ExposureControls />
        </CollapsibleSection>

        <CollapsibleSection
          title="Color"
          isCollapsed={panel.collapsedSections['color']}
          onToggle={() => panelBloc.toggleSection('color')}
        >
          <ColorControls />
        </CollapsibleSection>

        <CollapsibleSection
          title="Curves"
          isCollapsed={panel.collapsedSections['curves']}
          onToggle={() => panelBloc.toggleSection('curves')}
        >
          <ToneCurves />
        </CollapsibleSection>

        <CollapsibleSection
          title="HSL"
          isCollapsed={panel.collapsedSections['hsl']}
          onToggle={() => panelBloc.toggleSection('hsl')}
        >
          <HSLControls />
        </CollapsibleSection>

        <CollapsibleSection
          title="Detail"
          isCollapsed={panel.collapsedSections['detail']}
          onToggle={() => panelBloc.toggleSection('detail')}
        >
          <DetailControls />
        </CollapsibleSection>

        <CollapsibleSection
          title="Effects"
          isCollapsed={panel.collapsedSections['effects']}
          onToggle={() => panelBloc.toggleSection('effects')}
        >
          <EffectsControls />
        </CollapsibleSection>
      </div>
    </div>
  );
}
```

### PanelSwitcher

Tab navigation for switching between editor panels.

```typescript
// modules/panels/PanelSwitcher.tsx
import { useBloc } from '@blac/react';
import { PanelBloc, PanelId } from '../../blocs/panels/PanelBloc';
import { Button } from '../../primitives/Button';
import {
  SlidersHorizontal, Crop, Layers, Palette, Download, FileText, Sparkles
} from 'lucide-react';

const PANELS: Array<{ id: PanelId; icon: React.ComponentType<any>; label: string }> = [
  { id: 'adjustments', icon: SlidersHorizontal, label: 'Adjustments' },
  { id: 'crop', icon: Crop, label: 'Crop & Transform' },
  { id: 'masks', icon: Layers, label: 'Masks' },
  { id: 'presets', icon: Palette, label: 'Presets' },
  { id: 'export', icon: Download, label: 'Export' },
  { id: 'metadata', icon: FileText, label: 'Metadata' },
  { id: 'ai', icon: Sparkles, label: 'AI Tools' },
];

export function PanelSwitcher() {
  const [panel, panelBloc] = useBloc(PanelBloc);

  return (
    <div className="flex border-b border-border-color bg-bg-secondary">
      {PANELS.map(({ id, icon: Icon, label }) => (
        <Button
          key={id}
          variant="ghost"
          size="icon"
          className={`rounded-none border-b-2 ${
            panel.activePanel === id
              ? 'border-accent text-accent'
              : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
          onClick={() => panelBloc.setActivePanel(id)}
          title={label}
        >
          <Icon size={18} />
        </Button>
      ))}
    </div>
  );
}
```

---

## Metadata Modules

### RatingControl

Star rating widget with keyboard support.

```typescript
// modules/metadata/RatingControl.tsx
import { useBloc } from '@blac/react';
import { RatingsBloc } from '../../blocs/library/RatingsBloc';
import { EditorBloc } from '../../blocs/editor/EditorBloc';
import { Star } from 'lucide-react';

interface RatingControlProps {
  path?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function RatingControl({ path, size = 'md' }: RatingControlProps) {
  const [ratings, ratingsBloc] = useBloc(RatingsBloc);
  const [editor] = useBloc(EditorBloc);

  const targetPath = path || editor.selectedImage?.path;
  if (!targetPath) return null;

  const currentRating = ratings.ratings[targetPath] || 0;
  
  const sizes = {
    sm: 14,
    md: 18,
    lg: 24,
  };
  const iconSize = sizes[size];

  const handleSetRating = (rating: number) => {
    // Toggle off if clicking same rating
    const newRating = currentRating === rating ? 0 : rating;
    ratingsBloc.setRating(targetPath, newRating);
  };

  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((rating) => (
        <button
          key={rating}
          onClick={() => handleSetRating(rating)}
          className="p-0.5 hover:scale-110 transition-transform"
          title={`Rate ${rating} star${rating > 1 ? 's' : ''}`}
        >
          <Star
            size={iconSize}
            className={
              rating <= currentRating
                ? 'text-accent fill-accent'
                : 'text-text-secondary hover:text-accent'
            }
          />
        </button>
      ))}
    </div>
  );
}
```

### ColorLabel

Color label picker widget.

```typescript
// modules/metadata/ColorLabel.tsx
import { useBloc } from '@blac/react';
import { RatingsBloc } from '../../blocs/library/RatingsBloc';
import { EditorBloc } from '../../blocs/editor/EditorBloc';
import { Check } from 'lucide-react';

const COLOR_LABELS = [
  { name: 'red', color: '#ef4444' },
  { name: 'orange', color: '#f97316' },
  { name: 'yellow', color: '#eab308' },
  { name: 'green', color: '#22c55e' },
  { name: 'blue', color: '#3b82f6' },
  { name: 'purple', color: '#a855f7' },
  { name: 'none', color: '#9ca3af' },
];

interface ColorLabelProps {
  path?: string;
}

export function ColorLabel({ path }: ColorLabelProps) {
  const [ratings, ratingsBloc] = useBloc(RatingsBloc);
  const [editor] = useBloc(EditorBloc);

  const targetPath = path || editor.selectedImage?.path;
  if (!targetPath) return null;

  const currentColor = ratings.colorLabels[targetPath] || 'none';

  const handleSetColor = (color: string) => {
    ratingsBloc.setColorLabel(targetPath, color === currentColor ? 'none' : color);
  };

  return (
    <div className="flex items-center gap-2">
      {COLOR_LABELS.map((label) => (
        <button
          key={label.name}
          onClick={() => handleSetColor(label.name)}
          className="w-6 h-6 rounded-full focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 hover:scale-110 transition-transform relative"
          style={{ backgroundColor: label.color }}
          title={label.name === 'none' ? 'No Label' : label.name}
        >
          {currentColor === label.name && label.name !== 'none' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-full">
              <Check size={14} className="text-white" />
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
```

---

## Module Registry

All modules are registered for dynamic loading by the layout system.

```typescript
// modules/registry.ts
import { lazy } from 'react';

export const moduleRegistry = {
  // Library modules
  'gallery-grid': lazy(() => import('./library/GalleryGrid')),
  'gallery-controls': lazy(() => import('./library/GalleryControls')),
  'folder-tree': lazy(() => import('./library/FolderTree')),
  'filmstrip': lazy(() => import('./library/Filmstrip')),
  'welcome-screen': lazy(() => import('./library/WelcomeScreen')),

  // Editor modules
  'image-preview': lazy(() => import('./editor/ImagePreview')),
  'image-histogram': lazy(() => import('./editor/ImageHistogram')),
  'image-waveform': lazy(() => import('./editor/ImageWaveform')),
  'editor-toolbar': lazy(() => import('./editor/EditorToolbar')),
  'zoom-controls': lazy(() => import('./editor/ZoomControls')),

  // Adjustment modules
  'exposure-controls': lazy(() => import('./adjustments/ExposureControls')),
  'color-controls': lazy(() => import('./adjustments/ColorControls')),
  'tone-curves': lazy(() => import('./adjustments/ToneCurves')),
  'detail-controls': lazy(() => import('./adjustments/DetailControls')),
  'effects-controls': lazy(() => import('./adjustments/EffectsControls')),
  'hsl-controls': lazy(() => import('./adjustments/HSLControls')),

  // Panel modules
  'adjustments-panel': lazy(() => import('./panels/AdjustmentsPanel')),
  'crop-panel': lazy(() => import('./panels/CropPanel')),
  'masks-panel': lazy(() => import('./panels/MasksPanel')),
  'presets-panel': lazy(() => import('./panels/PresetsPanel')),
  'export-panel': lazy(() => import('./panels/ExportPanel')),
  'metadata-panel': lazy(() => import('./panels/MetadataPanel')),
  'ai-panel': lazy(() => import('./panels/AIPanel')),
  'panel-switcher': lazy(() => import('./panels/PanelSwitcher')),

  // Metadata modules
  'rating-control': lazy(() => import('./metadata/RatingControl')),
  'color-label': lazy(() => import('./metadata/ColorLabel')),
  'tag-editor': lazy(() => import('./metadata/TagEditor')),

  // Common modules
  'context-menu': lazy(() => import('./common/ContextMenu')),
  'loading-spinner': lazy(() => import('./common/LoadingSpinner')),
  'error-message': lazy(() => import('./common/ErrorMessage')),
};

export type ModuleId = keyof typeof moduleRegistry;
```

---

## Key Patterns

### 1. Bloc Access Pattern

All modules use `useBloc` for state and actions:

```typescript
// Read state and get actions
const [state, bloc] = useBloc(SomeBloc);

// Use state in render
<div>{state.someValue}</div>

// Call actions
<button onClick={() => bloc.someAction()}>Action</button>
```

### 2. Cross-Bloc Communication

Modules can access other blocs via `borrow()`:

```typescript
// In a component
const handleClick = () => {
  borrow(EditorBloc).selectImage(path);
  borrow(AppBloc).navigateToEditor();
};
```

### 3. No Local State Where Possible

Prefer bloc state over React state:

```typescript
// Avoid
const [isOpen, setIsOpen] = useState(false);

// Prefer
const [ui, uiBloc] = useBloc(UIBloc);
// Use ui.isPanelOpen and uiBloc.togglePanel()
```

### 4. Memoization via Blac

Blac handles state change detection, so manual memoization is rarely needed:

```typescript
// Blac automatically tracks which state properties are accessed
// and only re-renders when those specific properties change
const [adjustments] = useBloc(AdjustmentsBloc);
// Only re-renders when adjustments.exposure changes, not other properties
return <Slider value={adjustments.exposure} />;
```
