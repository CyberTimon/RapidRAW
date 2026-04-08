import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Folder,
  FolderInput,
  Home,
  Image as ImageIcon,
  Loader2,
  FolderOpen,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Star as StarIcon,
  Search,
  Users,
  X,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { List, useListCallbackRef } from 'react-window';
import Button from '../ui/Button';
import SettingsPanel from './SettingsPanel';
import { ThemeProps, THEMES, DEFAULT_THEME_ID } from '../../utils/themes';
import {
  AppSettings,
  FilterCriteria,
  ImageFile,
  Invokes,
  LibraryViewMode,
  Progress,
  RawStatus,
  SortCriteria,
  SortDirection,
  SupportedTypes,
  ThumbnailSize,
  ThumbnailAspectRatio,
} from '../ui/AppProperties';
import { Color, COLOR_LABELS } from '../../utils/adjustments';
import { ImportState, Status } from '../ui/ExportImportProperties';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

export interface ColumnWidths {
  thumbnail: number;
  name: number;
  date: number;
  rating: number;
  color: number;
}

interface DropdownMenuProps {
  buttonContent: any;
  buttonTitle: string;
  children: any;
  contentClassName: string;
}

interface FilterOptionProps {
  filterCriteria: FilterCriteria;
  setFilterCriteria(criteria: any): void;
}

interface KeyValueLabel {
  key?: string;
  label?: string;
  value?: number;
}

interface SearchCriteria {
  tags: string[];
  text: string;
  mode: 'AND' | 'OR';
}

interface MainLibraryProps {
  activePath: string | null;
  aiModelDownloadStatus: string | null;
  appSettings: AppSettings | null;
  currentFolderPath: string | null;
  filterCriteria: FilterCriteria;
  imageList: Array<ImageFile>;
  imageRatings: Record<string, number>;
  importState: ImportState;
  indexingProgress: Progress;
  isLoading: boolean;
  isIndexing: boolean;
  isAndroid: boolean;
  isTreeLoading: boolean;
  libraryScrollTop: number;
  libraryViewMode: LibraryViewMode;
  multiSelectedPaths: Array<string>;
  onClearSelection(): void;
  onContextMenu(event: any, path: string): void;
  onContinueSession(): void;
  onEmptyAreaContextMenu(event: any): void;
  onGoHome(): void;
  onImageClick(path: string, event: any): void;
  onImageDoubleClick(path: string): void;
  onLibraryRefresh(): void;
  onOpenFolder(): void;
  onSettingsChange(settings: AppSettings): Promise<void>;
  onThumbnailAspectRatioChange(aspectRatio: ThumbnailAspectRatio): void;
  onThumbnailSizeChange(size: ThumbnailSize): void;
  onRequestThumbnails?(paths: string[]): void;
  rootPath: string | null;
  searchCriteria: SearchCriteria;
  setFilterCriteria(criteria: FilterCriteria): void;
  setLibraryScrollTop(scrollTop: number): void;
  setLibraryViewMode(mode: LibraryViewMode): void;
  setSearchCriteria(criteria: SearchCriteria | ((prev: SearchCriteria) => SearchCriteria)): void;
  setSortCriteria(criteria: SortCriteria | ((prev: SortCriteria) => SortCriteria)): void;
  sortCriteria: SortCriteria;
  theme: string;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  thumbnails: Record<string, string>;
  thumbnailProgress: Progress;
  thumbnailSize: ThumbnailSize;
  onNavigateToCommunity(): void;
  listColumnWidths: ColumnWidths;
  setListColumnWidths: React.Dispatch<React.SetStateAction<ColumnWidths>>;
}

interface SearchInputProps {
  indexingProgress: Progress;
  isIndexing: boolean;
  searchCriteria: SearchCriteria;
  setSearchCriteria(criteria: SearchCriteria | ((prev: SearchCriteria) => SearchCriteria)): void;
}

interface SortOptionsProps {
  sortCriteria: SortCriteria;
  setSortCriteria(criteria: SortCriteria): void;
  sortOptions: Array<Omit<SortCriteria, 'order'> & { label?: string; disabled?: boolean }>;
}

interface ImageLayer {
  id: string;
  url: string;
  opacity: number;
}

interface ThumbnailProps {
  data: string | undefined;
  isActive: boolean;
  isSelected: boolean;
  onContextMenu(e: any): void;
  onImageClick(path: string, event: any): void;
  onImageDoubleClick(path: string): void;
  onLoad(): void;
  path: string;
  rating: number;
  tags: Array<string>;
  aspectRatio: ThumbnailAspectRatio;
}

interface ListItemProps extends ThumbnailProps {
  modified: number;
  columnWidths: ColumnWidths;
}

interface ThumbnailSizeOption {
  id: ThumbnailSize;
  label: string;
  size: number;
}

interface ThumbnailSizeProps {
  onSelectSize(sizeOptions: ThumbnailSize): void;
  selectedSize: ThumbnailSize;
}

interface ThumbnailAspectRatioOption {
  id: ThumbnailAspectRatio;
  label: string;
}

interface ThumbnailAspectRatioProps {
  onSelectAspectRatio(aspectRatio: ThumbnailAspectRatio): void;
  selectedAspectRatio: ThumbnailAspectRatio;
}

interface ViewOptionsProps {
  filterCriteria: FilterCriteria;
  libraryViewMode: LibraryViewMode;
  onSelectSize(size: ThumbnailSize): any;
  onSelectAspectRatio(aspectRatio: ThumbnailAspectRatio): any;
  setFilterCriteria(criteria: Partial<FilterCriteria>): void;
  setLibraryViewMode(mode: LibraryViewMode): void;
  setSortCriteria(criteria: SortCriteria): void;
  sortCriteria: SortCriteria;
  sortOptions: Array<Omit<SortCriteria, 'order'> & { label?: string; disabled?: boolean }>;
  thumbnailSize: ThumbnailSize;
  thumbnailAspectRatio: ThumbnailAspectRatio;
}

const ratingFilterOptions: Array<KeyValueLabel> = [
  { value: 0, label: 'Show All' },
  { value: 1, label: '1 & up' },
  { value: 2, label: '2 & up' },
  { value: 3, label: '3 & up' },
  { value: 4, label: '4 & up' },
  { value: 5, label: '5 only' },
];

const rawStatusOptions: Array<KeyValueLabel> = [
  { key: RawStatus.All, label: 'All Types' },
  { key: RawStatus.RawOnly, label: 'RAW Only' },
  { key: RawStatus.NonRawOnly, label: 'Non-RAW Only' },
  { key: RawStatus.RawOverNonRaw, label: 'Prefer RAW' },
];

const thumbnailSizeOptions: Array<ThumbnailSizeOption> = [
  { id: ThumbnailSize.Small, label: 'Small', size: 160 },
  { id: ThumbnailSize.Medium, label: 'Medium', size: 240 },
  { id: ThumbnailSize.Large, label: 'Large', size: 320 },
  { id: ThumbnailSize.List, label: 'List', size: 48 },
];

const thumbnailAspectRatioOptions: Array<ThumbnailAspectRatioOption> = [
  { id: ThumbnailAspectRatio.Cover, label: 'Fill Square' },
  { id: ThumbnailAspectRatio.Contain, label: 'Original Ratio' },
];

const groupImagesByFolder = (images: ImageFile[], rootPath: string | null) => {
  const groups: Record<string, ImageFile[]> = {};

  images.forEach((img) => {
    const physicalPath = img.path.split('?vc=')[0];
    const separator = physicalPath.includes('/') ? '/' : '\\';
    const lastSep = physicalPath.lastIndexOf(separator);
    const dir = lastSep > -1 ? physicalPath.substring(0, lastSep) : physicalPath;

    if (!groups[dir]) {
      groups[dir] = [];
    }
    groups[dir].push(img);
  });

  const sortedKeys = Object.keys(groups).sort((a, b) => {
    if (a === rootPath) return -1;
    if (b === rootPath) return 1;
    return a.localeCompare(b);
  });

  return sortedKeys.map((dir) => ({
    path: dir,
    images: groups[dir],
  }));
};

function ListHeader({
  widths,
  setWidths,
  containerRef,
  sortCriteria,
  onSortChange,
}: {
  widths: ColumnWidths;
  setWidths: React.Dispatch<React.SetStateAction<ColumnWidths>>;
  containerRef: React.RefObject<HTMLDivElement>;
  sortCriteria: SortCriteria;
  onSortChange: (key: string) => void;
}) {
  const handleResize = (e: React.MouseEvent, leftCol: keyof ColumnWidths, rightCol: keyof ColumnWidths) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startLeftWidth = widths[leftCol];
    const startRightWidth = widths[rightCol];
    const containerWidth = containerRef.current?.clientWidth || 1000;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaPercent = (deltaX / containerWidth) * 100;

      let newLeft = startLeftWidth + deltaPercent;
      let newRight = startRightWidth - deltaPercent;

      if (newLeft < 1) {
        newRight -= 1 - newLeft;
        newLeft = 1;
      }
      if (newRight < 1) {
        newLeft -= 1 - newRight;
        newRight = 1;
      }

      setWidths((prev) => ({
        ...prev,
        [leftCol]: newLeft,
        [rightCol]: newRight,
      }));
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const Column = ({
    title,
    widthKey,
    nextKey,
    sortKey,
  }: {
    title: string;
    widthKey: keyof ColumnWidths;
    nextKey?: keyof ColumnWidths;
    sortKey?: string;
  }) => {
    const isSorted = sortCriteria.key === sortKey;
    const isAsc = sortCriteria.order === SortDirection.Ascending;

    return (
      <div
        style={{ width: `${widths[widthKey]}%` }}
        className={`relative flex items-center px-3 h-full select-none ${
          sortKey ? 'cursor-pointer hover:bg-bg-primary/50 transition-colors' : ''
        }`}
        onClick={() => sortKey && onSortChange(sortKey)}
      >
        <Text
          variant={TextVariants.small}
          weight={TextWeights.semibold}
          color={isSorted ? TextColors.primary : TextColors.secondary}
          className="uppercase tracking-wider text-[11px]"
        >
          {title}
        </Text>
        {isSorted && (
          <span className="ml-1 flex items-center text-accent">
            {isAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </span>
        )}
        {nextKey && (
          <div
            className="absolute right-[-3px] top-1.5 bottom-1.5 w-[6px] cursor-col-resize z-10 group flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => handleResize(e, widthKey, nextKey)}
          >
            <div className="w-px h-full bg-border-color/40 group-hover:bg-accent transition-colors" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex items-center w-full h-9 bg-bg-secondary/80 backdrop-blur-sm border-b border-border-color/50 shrink-0">
      <Column title="" widthKey="thumbnail" nextKey="name" />
      <Column title="Name" widthKey="name" nextKey="date" sortKey="name" />
      <Column title="Modified" widthKey="date" nextKey="rating" sortKey="date" />
      <Column title="Rating" widthKey="rating" nextKey="color" sortKey="rating" />
      <Column title="Label" widthKey="color" />
    </div>
  );
}

function SearchInput({ indexingProgress, isIndexing, searchCriteria, setSearchCriteria }: SearchInputProps) {
  const [isSearchActive, setIsSearchActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { tags, text, mode } = searchCriteria;

  const [contentWidth, setContentWidth] = useState(0);

  useEffect(() => {
    if (isSearchActive) {
      inputRef.current?.focus();
    }
  }, [isSearchActive]);

  useEffect(() => {
    function handleClickOutside(event: any) {
      if (containerRef.current && !containerRef.current.contains(event.target) && tags.length === 0 && !text) {
        setIsSearchActive(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [tags, text]);

  useEffect(() => {
    if (contentRef.current) {
      const timer = setTimeout(() => {
        if (contentRef.current) {
          setContentWidth(contentRef.current.scrollWidth);
        }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [tags, text, isSearchActive]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchCriteria((prev) => ({ ...prev, text: e.target.value }));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === ',' || e.key === 'Enter') && text.trim()) {
      e.preventDefault();
      setSearchCriteria((prev) => ({
        ...prev,
        tags: [...prev.tags, text.trim()],
        text: '',
      }));
    } else if (e.key === 'Backspace' && !text && tags.length > 0) {
      e.preventDefault();
      const lastTag = tags[tags.length - 1];
      setSearchCriteria((prev) => ({
        ...prev,
        tags: prev.tags.slice(0, -1),
        text: lastTag,
      }));
    }
  };

  const removeTag = (tagToRemove: string) => {
    setSearchCriteria((prev) => ({
      ...prev,
      tags: prev.tags.filter((tag) => tag !== tagToRemove),
    }));
  };

  const clearSearch = () => {
    setSearchCriteria({ tags: [], text: '', mode: 'OR' });
    setIsSearchActive(false);
    inputRef.current?.blur();
  };

  const toggleMode = () => {
    setSearchCriteria((prev) => ({
      ...prev,
      mode: prev.mode === 'AND' ? 'OR' : 'AND',
    }));
  };

  const isActive = isSearchActive || tags.length > 0 || !!text;
  const placeholderText =
    isIndexing && indexingProgress.total > 0
      ? `Indexing... (${indexingProgress.current}/${indexingProgress.total})`
      : isIndexing
        ? 'Indexing Images...'
        : tags.length > 0
          ? 'Add another tag...'
          : 'Search by tag or filename...';

  const INACTIVE_WIDTH = 48;
  const PADDING_AND_ICONS_WIDTH = 105;
  const MAX_WIDTH = 640;

  const calculatedWidth = Math.min(MAX_WIDTH, contentWidth + PADDING_AND_ICONS_WIDTH);

  return (
    <motion.div
      animate={{ width: isActive ? calculatedWidth : INACTIVE_WIDTH }}
      className="relative flex items-center bg-surface rounded-md h-12"
      initial={false}
      layout
      ref={containerRef}
      transition={{ type: 'spring', stiffness: 400, damping: 35 }}
      onClick={() => inputRef.current?.focus()}
    >
      <button
        className="absolute left-0 top-0 h-12 w-12 flex items-center justify-center text-text-primary z-10 shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          if (!isActive) {
            setIsSearchActive(true);
          }
          inputRef.current?.focus();
        }}
        data-tooltip="Search"
      >
        <Search className="w-4 h-4" />
      </button>

      <div
        className="flex items-center gap-1 pl-12 pr-16 w-full h-full overflow-x-hidden"
        style={{ opacity: isActive ? 1 : 0, pointerEvents: isActive ? 'auto' : 'none', transition: 'opacity 0.2s' }}
      >
        <div ref={contentRef} className="flex items-center gap-2 h-full flex-nowrap min-w-[300px]">
          {tags.map((tag) => (
            <motion.div
              key={tag}
              layout
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5 }}
              className="flex items-center gap-1 bg-bg-primary px-2 py-1 rounded-sm group cursor-pointer shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                removeTag(tag);
              }}
            >
              <Text variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
                {tag}
              </Text>
              <span className="rounded-full group-hover:bg-black/20 p-0.5 transition-colors">
                <X size={12} />
              </span>
            </motion.div>
          ))}
          <input
            className="grow w-full h-full bg-transparent text-text-primary placeholder-text-secondary border-none focus:outline-hidden"
            disabled={isIndexing}
            onBlur={() => {
              if (tags.length === 0 && !text) {
                setIsSearchActive(false);
              }
            }}
            onChange={handleInputChange}
            onFocus={() => setIsSearchActive(true)}
            onKeyDown={handleKeyDown}
            placeholder={placeholderText}
            ref={inputRef}
            type="text"
            value={text}
          />
        </div>
      </div>

      <div
        className="absolute inset-y-0 right-0 flex items-center gap-1 pr-2"
        style={{ opacity: isActive ? 1 : 0, pointerEvents: isActive ? 'auto' : 'none', transition: 'opacity 0.2s' }}
      >
        <AnimatePresence>
          {text.trim().length > 0 && tags.length === 0 && text.trim().length < 6 && !isIndexing && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.15 }}
              className="shrink-0 bg-bg-primary px-2 py-1 rounded-md whitespace-nowrap"
            >
              <Text variant={TextVariants.small}>
                Separate tags with <kbd className="font-sans font-semibold">,</kbd>
              </Text>
            </motion.div>
          )}
        </AnimatePresence>

        {tags.length > 0 && (
          <button
            onClick={toggleMode}
            className="p-1.5 rounded-md hover:bg-bg-primary w-10 shrink-0"
            data-tooltip={`Match ${mode === 'AND' ? 'ALL' : 'ANY'} tags`}
          >
            <Text variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.semibold}>
              {mode}
            </Text>
          </button>
        )}
        {(tags.length > 0 || text) && !isIndexing && (
          <button
            onClick={clearSearch}
            className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-primary shrink-0"
            data-tooltip="Clear search"
          >
            <X className="h-5 w-5" />
          </button>
        )}
        {isIndexing && (
          <div className="flex items-center pr-1 pointer-events-none shrink-0">
            <Loader2 className="h-5 w-5 text-text-secondary animate-spin" />
          </div>
        )}
      </div>
    </motion.div>
  );
}

function ColorFilterOptions({ filterCriteria, setFilterCriteria }: FilterOptionProps) {
  const [lastClickedColor, setLastClickedColor] = useState<string | null>(null);
  const allColors = useMemo(() => [...COLOR_LABELS, { name: 'none', color: '#9ca3af' }], []);

  const handleColorClick = (colorName: string, event: any) => {
    const { ctrlKey, metaKey, shiftKey } = event;
    const isCtrlPressed = ctrlKey || metaKey;
    const currentColors = filterCriteria.colors || [];

    if (shiftKey && lastClickedColor) {
      const lastIndex = allColors.findIndex((c) => c.name === lastClickedColor);
      const currentIndex = allColors.findIndex((c) => c.name === colorName);
      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        const range = allColors.slice(start, end + 1).map((c: Color) => c.name);
        const baseSelection = isCtrlPressed ? currentColors : [lastClickedColor];
        const newColors = Array.from(new Set([...baseSelection, ...range]));
        setFilterCriteria((prev: FilterCriteria) => ({ ...prev, colors: newColors }));
      }
    } else if (isCtrlPressed) {
      const newColors = currentColors.includes(colorName)
        ? currentColors.filter((c: string) => c !== colorName)
        : [...currentColors, colorName];
      setFilterCriteria((prev: FilterCriteria) => ({ ...prev, colors: newColors }));
    } else {
      const newColors = currentColors.length === 1 && currentColors[0] === colorName ? [] : [colorName];
      setFilterCriteria((prev: FilterCriteria) => ({ ...prev, colors: newColors }));
    }
    setLastClickedColor(colorName);
  };

  return (
    <div>
      <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
        Filter by Color Label
      </Text>
      <div className="flex flex-wrap gap-3 px-3 py-2">
        {allColors.map((color: Color) => {
          const isSelected = (filterCriteria.colors || []).includes(color.name);
          const title = color.name === 'none' ? 'No Label' : color.name.charAt(0).toUpperCase() + color.name.slice(1);
          return (
            <button
              key={color.name}
              data-tooltip={title}
              onClick={(e: any) => handleColorClick(color.name, e)}
              className="w-6 h-6 rounded-full focus:outline-hidden focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-surface transition-transform hover:scale-110"
              role="menuitem"
            >
              <div className="relative w-full h-full">
                <div className="w-full h-full rounded-full" style={{ backgroundColor: color.color }}></div>
                {isSelected && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-full">
                    <Check size={14} className="text-white" />
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DropdownMenu({ buttonContent, buttonTitle, children, contentClassName = 'w-56' }: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<any>(null);

  useEffect(() => {
    const handleClickOutside = (event: any) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        aria-expanded={isOpen}
        aria-haspopup="true"
        className="h-12 w-12 bg-surface text-text-primary shadow-none p-0 flex items-center justify-center"
        onClick={() => setIsOpen(!isOpen)}
        data-tooltip={buttonTitle}
      >
        {buttonContent}
      </Button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            className={`absolute right-0 mt-2 ${contentClassName} origin-top-right z-20`}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1, ease: 'easeOut' }}
          >
            <div
              className="bg-surface/90 backdrop-blur-md rounded-lg shadow-xl"
              role="menu"
              aria-orientation="vertical"
            >
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ThumbnailSizeOptions({ selectedSize, onSelectSize }: ThumbnailSizeProps) {
  return (
    <>
      <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
        Thumbnail Size
      </Text>
      {thumbnailSizeOptions.map((option: ThumbnailSizeOption) => {
        const isSelected = selectedSize === option.id;
        return (
          <button
            className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
              isSelected ? 'bg-card-active' : 'hover:bg-bg-primary'
            }`}
            key={option.id}
            onClick={() => onSelectSize(option.id)}
            role="menuitem"
          >
            <Text
              variant={TextVariants.label}
              color={TextColors.primary}
              weight={isSelected ? TextWeights.semibold : TextWeights.normal}
            >
              {option.label}
            </Text>
            {isSelected && <Check size={16} />}
          </button>
        );
      })}
    </>
  );
}

function ThumbnailAspectRatioOptions({ selectedAspectRatio, onSelectAspectRatio }: ThumbnailAspectRatioProps) {
  return (
    <>
      <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
        Thumbnail Fit
      </Text>
      {thumbnailAspectRatioOptions.map((option: ThumbnailAspectRatioOption) => {
        const isSelected = selectedAspectRatio === option.id;
        return (
          <button
            className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
              isSelected ? 'bg-card-active' : 'hover:bg-bg-primary'
            }`}
            key={option.id}
            onClick={() => onSelectAspectRatio(option.id)}
            role="menuitem"
          >
            <Text
              variant={TextVariants.label}
              color={TextColors.primary}
              weight={isSelected ? TextWeights.semibold : TextWeights.normal}
            >
              {option.label}
            </Text>
            {isSelected && <Check size={16} />}
          </button>
        );
      })}
    </>
  );
}

function FilterOptions({ filterCriteria, setFilterCriteria }: FilterOptionProps) {
  const handleRatingFilterChange = (rating: number | undefined) => {
    setFilterCriteria((prev: Partial<FilterCriteria>) => ({ ...prev, rating }));
  };

  const handleRawStatusChange = (rawStatus: RawStatus | undefined) => {
    setFilterCriteria((prev: Partial<FilterCriteria>) => ({ ...prev, rawStatus }));
  };

  return (
    <>
      <div className="space-y-4">
        <div>
          <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
            Filter by Rating
          </Text>
          {ratingFilterOptions.map((option: KeyValueLabel) => {
            const isSelected = filterCriteria.rating === option.value;
            return (
              <button
                className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
                  isSelected ? 'bg-card-active' : 'hover:bg-bg-primary'
                }`}
                key={option.value}
                onClick={() => handleRatingFilterChange(option.value)}
                role="menuitem"
              >
                <span className="flex items-center gap-2">
                  {option.value && option.value > 0 && <StarIcon size={16} className="text-accent fill-accent" />}
                  <Text
                    variant={TextVariants.label}
                    color={TextColors.primary}
                    weight={isSelected ? TextWeights.semibold : TextWeights.normal}
                  >
                    {option.label}
                  </Text>
                </span>
                {isSelected && <Check size={16} />}
              </button>
            );
          })}
        </div>

        <div>
          <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
            Filter by File Type
          </Text>
          {rawStatusOptions.map((option: KeyValueLabel) => {
            const isSelected = (filterCriteria.rawStatus || RawStatus.All) === option.key;
            return (
              <button
                className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
                  isSelected ? 'bg-card-active' : 'hover:bg-bg-primary'
                }`}
                key={option.key}
                onClick={() => handleRawStatusChange(option.key as RawStatus)}
                role="menuitem"
              >
                <Text
                  variant={TextVariants.label}
                  color={TextColors.primary}
                  weight={isSelected ? TextWeights.semibold : TextWeights.normal}
                >
                  {option.label}
                </Text>
                {isSelected && <Check size={16} />}
              </button>
            );
          })}
        </div>
      </div>
      <div className="py-2"></div>
      <ColorFilterOptions filterCriteria={filterCriteria} setFilterCriteria={setFilterCriteria} />
    </>
  );
}

function SortOptions({ sortCriteria, setSortCriteria, sortOptions }: SortOptionsProps) {
  const handleKeyChange = (key: string) => {
    setSortCriteria((prev: SortCriteria) => ({ ...prev, key }));
  };

  const handleOrderToggle = () => {
    setSortCriteria((prev: SortCriteria) => ({
      ...prev,
      order: prev.order === SortDirection.Ascending ? SortDirection.Descening : SortDirection.Ascending,
    }));
  };

  return (
    <>
      <div className="px-3 py-2 relative flex items-center">
        <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="uppercase">
          Sort by
        </Text>
        <button
          onClick={handleOrderToggle}
          data-tooltip={`Sort ${sortCriteria.order === SortDirection.Ascending ? 'Descending' : 'Ascending'}`}
          className="absolute top-1/2 right-3 -translate-y-1/2 p-1 bg-transparent border-none text-text-secondary hover:text-text-primary focus:outline-hidden focus:ring-1 focus:ring-accent rounded-sm"
        >
          {sortCriteria.order === SortDirection.Ascending ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m18 15-6-6-6 6" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          )}
        </button>
      </div>
      {sortOptions.map((option) => {
        const isSelected = sortCriteria.key === option.key;
        return (
          <button
            className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
              isSelected ? 'bg-card-active' : 'hover:bg-bg-primary'
            } ${option.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            key={option.key}
            onClick={() => !option.disabled && handleKeyChange(option.key)}
            role="menuitem"
            disabled={option.disabled}
            data-tooltip={option.disabled ? 'Enable EXIF Reading in Settings to use this option.' : undefined}
          >
            <Text
              variant={TextVariants.label}
              color={TextColors.primary}
              weight={isSelected ? TextWeights.semibold : TextWeights.normal}
            >
              {option.label}
            </Text>
            {isSelected && <Check size={16} />}
          </button>
        );
      })}
    </>
  );
}

function ViewModeOptions({ mode, setMode }: { mode: LibraryViewMode; setMode: (m: LibraryViewMode) => void }) {
  return (
    <>
      <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
        Display Mode
      </Text>
      <button
        className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
          mode === LibraryViewMode.Flat ? 'bg-card-active' : 'hover:bg-bg-primary'
        }`}
        onClick={() => setMode(LibraryViewMode.Flat)}
        role="menuitem"
      >
        <Text
          variant={TextVariants.label}
          color={TextColors.primary}
          weight={mode === LibraryViewMode.Flat ? TextWeights.semibold : TextWeights.normal}
        >
          Current Folder
        </Text>
        {mode === LibraryViewMode.Flat && <Check size={16} />}
      </button>
      <button
        className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
          mode === LibraryViewMode.Recursive ? 'bg-card-active' : 'hover:bg-bg-primary'
        }`}
        onClick={() => setMode(LibraryViewMode.Recursive)}
        role="menuitem"
      >
        <Text
          variant={TextVariants.label}
          color={TextColors.primary}
          weight={mode === LibraryViewMode.Recursive ? TextWeights.semibold : TextWeights.normal}
        >
          Recursive
        </Text>
        {mode === LibraryViewMode.Recursive && <Check size={16} />}
      </button>
    </>
  );
}

function ViewOptionsDropdown({
  filterCriteria,
  libraryViewMode,
  onSelectSize,
  onSelectAspectRatio,
  setFilterCriteria,
  setLibraryViewMode,
  setSortCriteria,
  sortCriteria,
  sortOptions,
  thumbnailSize,
  thumbnailAspectRatio,
}: ViewOptionsProps) {
  const isFilterActive =
    filterCriteria.rating > 0 ||
    (filterCriteria.rawStatus && filterCriteria.rawStatus !== RawStatus.All) ||
    (filterCriteria.colors && filterCriteria.colors.length > 0);

  return (
    <DropdownMenu
      buttonContent={
        <>
          <SlidersHorizontal className="w-8 h-8" />
          {isFilterActive && <div className="absolute -top-1 -right-1 bg-accent rounded-full w-3 h-3" />}
        </>
      }
      buttonTitle="View Options"
      contentClassName="w-[720px]"
    >
      <div className="flex">
        <div className="w-1/4 p-2 border-r border-border-color">
          <ThumbnailSizeOptions selectedSize={thumbnailSize} onSelectSize={onSelectSize} />
          <div className="pt-2">
            <ThumbnailAspectRatioOptions
              selectedAspectRatio={thumbnailAspectRatio}
              onSelectAspectRatio={onSelectAspectRatio}
            />
          </div>
          <div className="pt-2">
            <ViewModeOptions mode={libraryViewMode} setMode={setLibraryViewMode} />
          </div>
        </div>
        <div className="w-2/4 p-2 border-r border-border-color">
          <FilterOptions filterCriteria={filterCriteria} setFilterCriteria={setFilterCriteria} />
        </div>
        <div className="w-1/4 p-2">
          <SortOptions sortCriteria={sortCriteria} setSortCriteria={setSortCriteria} sortOptions={sortOptions} />
        </div>
      </div>
    </DropdownMenu>
  );
}

function ListItem({
  data,
  isActive,
  isSelected,
  onContextMenu,
  onImageClick,
  onImageDoubleClick,
  onLoad,
  path,
  rating,
  tags,
  modified,
  aspectRatio: thumbnailAspectRatio,
  columnWidths,
}: ListItemProps) {
  const [showPlaceholder, setShowPlaceholder] = useState(false);
  const [layers, setLayers] = useState<ImageLayer[]>([]);
  const latestThumbDataRef = useRef<string | undefined>(undefined);

  const { baseName, isVirtualCopy } = useMemo(() => {
    const fullFileName = path.split(/[\\/]/).pop() || '';
    const parts = fullFileName.split('?vc=');
    return {
      baseName: parts[0],
      isVirtualCopy: parts.length > 1,
    };
  }, [path]);

  useEffect(() => {
    if (data) {
      setShowPlaceholder(false);
      return;
    }
    const timer = setTimeout(() => {
      setShowPlaceholder(true);
    }, 500);
    return () => clearTimeout(timer);
  }, [data]);

  useEffect(() => {
    if (!data) {
      setLayers([]);
      latestThumbDataRef.current = undefined;
      return;
    }

    if (data !== latestThumbDataRef.current) {
      latestThumbDataRef.current = data;
      setLayers((prev) => {
        if (prev.some((l) => l.id === data)) return prev;
        return [...prev, { id: data, url: data, opacity: 0 }];
      });
    }
  }, [data]);

  useEffect(() => {
    const layerToFadeIn = layers.find((l) => l.opacity === 0);
    if (layerToFadeIn) {
      const timer = setTimeout(() => {
        setLayers((prev) => prev.map((l) => (l.id === layerToFadeIn.id ? { ...l, opacity: 1 } : l)));
        onLoad();
      }, 10);
      return () => clearTimeout(timer);
    }
  }, [layers, onLoad]);

  const handleTransitionEnd = useCallback((finishedId: string) => {
    setLayers((prev) => {
      const finishedIndex = prev.findIndex((l) => l.id === finishedId);
      if (finishedIndex < 0 || prev.length <= 1) return prev;
      return prev.slice(finishedIndex);
    });
  }, []);

  const colorTag = tags?.find((t: string) => t.startsWith('color:'))?.substring(6);
  const colorLabel = COLOR_LABELS.find((c: Color) => c.name === colorTag);

  const dateObj = new Date(modified > 1e11 ? modified : modified * 1000);
  const dateStr =
    dateObj.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' ' +
    dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const stateClass = isActive
    ? 'ring-1 ring-inset ring-accent bg-accent/10'
    : isSelected
      ? 'ring-1 ring-inset ring-accent/50 bg-accent/5'
      : 'hover:bg-surface/80';

  return (
    <div
      className={`flex items-center w-full h-full border-b border-border-color/30 cursor-pointer transition-colors duration-150 ${stateClass}`}
      onClick={(e: any) => {
        e.stopPropagation();
        onImageClick(path, e);
      }}
      onContextMenu={onContextMenu}
      onDoubleClick={() => onImageDoubleClick(path)}
    >
      <div
        style={{ width: `${columnWidths.thumbnail}%` }}
        className="flex items-center justify-center p-1.5 h-full overflow-hidden"
      >
        <div className="w-full h-full relative overflow-hidden rounded-sm bg-surface flex items-center justify-center">
          {layers.length > 0 && (
            <div className="absolute inset-0 w-full h-full flex items-center justify-center">
              {layers.map((layer) => (
                <div
                  key={layer.id}
                  className="absolute inset-0 w-full h-full"
                  style={{ opacity: layer.opacity, transition: 'opacity 300ms ease-in-out' }}
                  onTransitionEnd={() => handleTransitionEnd(layer.id)}
                >
                  {thumbnailAspectRatio === ThumbnailAspectRatio.Contain && (
                    <img
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover blur-md scale-110 brightness-[0.4]"
                      src={layer.url}
                    />
                  )}
                  <img
                    alt={baseName}
                    className={`w-full h-full relative ${
                      thumbnailAspectRatio === ThumbnailAspectRatio.Contain ? 'object-contain' : 'object-cover'
                    }`}
                    decoding="async"
                    loading="lazy"
                    src={layer.url}
                  />
                </div>
              ))}
            </div>
          )}

          <AnimatePresence>
            {layers.length === 0 && showPlaceholder && (
              <motion.div
                className="absolute inset-0 w-full h-full flex items-center justify-center"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
              >
                <ImageIcon size={14} className="text-text-secondary animate-pulse" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Name */}
      <div style={{ width: `${columnWidths.name}%` }} className="flex items-center gap-2 px-3 h-full overflow-hidden">
        <Text variant={TextVariants.small} className="truncate" weight={TextWeights.medium} color={TextColors.primary}>
          {baseName}
        </Text>
        {isVirtualCopy && (
          <Text
            as="div"
            variant={TextVariants.small}
            color={TextColors.secondary}
            weight={TextWeights.bold}
            className="shrink-0 bg-bg-primary px-1.5 py-0.5 rounded-full leading-none border border-border-color"
            data-tooltip="Virtual Copy"
          >
            VC
          </Text>
        )}
      </div>

      <div style={{ width: `${columnWidths.date}%` }} className="flex items-center px-3 h-full overflow-hidden">
        <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate">
          {dateStr}
        </Text>
      </div>

      <div style={{ width: `${columnWidths.rating}%` }} className="flex items-center px-3 h-full overflow-hidden">
        {rating > 0 && (
          <div className="flex items-center gap-1">
            <StarIcon size={12} className="text-accent fill-accent" />
            <Text variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
              {rating}
            </Text>
          </div>
        )}
      </div>

      <div style={{ width: `${columnWidths.color}%` }} className="flex items-center px-3 h-full overflow-hidden">
        {colorLabel && (
          <div className="flex items-center gap-1.5">
            <div
              className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-black/20"
              style={{ backgroundColor: colorLabel.color }}
            />
            <Text variant={TextVariants.small} color={TextColors.secondary} className="capitalize truncate">
              {colorLabel.name}
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}

function Thumbnail({
  data,
  isActive,
  isSelected,
  onContextMenu,
  onImageClick,
  onImageDoubleClick,
  onLoad,
  path,
  rating,
  tags,
  aspectRatio: thumbnailAspectRatio,
}: ThumbnailProps) {
  const [showPlaceholder, setShowPlaceholder] = useState(false);
  const [layers, setLayers] = useState<ImageLayer[]>([]);
  const latestThumbDataRef = useRef<string | undefined>(undefined);

  const { baseName, isVirtualCopy } = useMemo(() => {
    const fullFileName = path.split(/[\\/]/).pop() || '';
    const parts = fullFileName.split('?vc=');
    return {
      baseName: parts[0],
      isVirtualCopy: parts.length > 1,
    };
  }, [path]);

  useEffect(() => {
    if (data) {
      setShowPlaceholder(false);
      return;
    }
    const timer = setTimeout(() => {
      setShowPlaceholder(true);
    }, 500);
    return () => clearTimeout(timer);
  }, [data]);

  useEffect(() => {
    if (!data) {
      setLayers([]);
      latestThumbDataRef.current = undefined;
      return;
    }

    if (data !== latestThumbDataRef.current) {
      latestThumbDataRef.current = data;

      setLayers((prev) => {
        if (prev.some((l) => l.id === data)) {
          return prev;
        }
        return [...prev, { id: data, url: data, opacity: 0 }];
      });
    }
  }, [data]);

  useEffect(() => {
    const layerToFadeIn = layers.find((l) => l.opacity === 0);
    if (layerToFadeIn) {
      const timer = setTimeout(() => {
        setLayers((prev) => prev.map((l) => (l.id === layerToFadeIn.id ? { ...l, opacity: 1 } : l)));
        onLoad();
      }, 10);

      return () => clearTimeout(timer);
    }
  }, [layers, onLoad]);

  const handleTransitionEnd = useCallback((finishedId: string) => {
    setLayers((prev) => {
      const finishedIndex = prev.findIndex((l) => l.id === finishedId);
      if (finishedIndex < 0 || prev.length <= 1) {
        return prev;
      }
      return prev.slice(finishedIndex);
    });
  }, []);

  const ringClass = isActive
    ? 'ring-2 ring-accent'
    : isSelected
      ? 'ring-2 ring-gray-400'
      : 'hover:ring-2 hover:ring-hover-color';
  const colorTag = tags?.find((t: string) => t.startsWith('color:'))?.substring(6);
  const colorLabel = COLOR_LABELS.find((c: Color) => c.name === colorTag);

  return (
    <div
      className={`aspect-square bg-surface rounded-md overflow-hidden cursor-pointer group relative transition-all duration-150 ${ringClass}`}
      onClick={(e: any) => {
        e.stopPropagation();
        onImageClick(path, e);
      }}
      onContextMenu={onContextMenu}
      onDoubleClick={() => onImageDoubleClick(path)}
    >
      {layers.length > 0 && (
        <div className="absolute inset-0 w-full h-full">
          {layers.map((layer) => (
            <div
              key={layer.id}
              className="absolute inset-0 w-full h-full"
              style={{
                opacity: layer.opacity,
                transition: 'opacity 300ms ease-in-out',
              }}
              onTransitionEnd={() => handleTransitionEnd(layer.id)}
            >
              {thumbnailAspectRatio === ThumbnailAspectRatio.Contain && (
                <img
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover blur-md scale-110 brightness-[0.4]"
                  src={layer.url}
                />
              )}
              <img
                alt={path.split(/[\\/]/).pop()}
                className={`w-full h-full group-hover:scale-[1.02] transition-transform duration-300 ${
                  thumbnailAspectRatio === ThumbnailAspectRatio.Contain ? 'object-contain' : 'object-cover'
                } relative`}
                decoding="async"
                loading="lazy"
                src={layer.url}
              />
            </div>
          ))}
        </div>
      )}

      <AnimatePresence>
        {layers.length === 0 && showPlaceholder && (
          <motion.div
            className="absolute inset-0 w-full h-full flex items-center justify-center bg-surface"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
          >
            <ImageIcon className="text-text-secondary animate-pulse" />
          </motion.div>
        )}
      </AnimatePresence>

      {(colorLabel || rating > 0) && (
        <div className="absolute top-1.5 right-1.5 bg-bg-primary/50 rounded-full px-1.5 py-0.5 flex items-center gap-1 backdrop-blur-xs">
          {colorLabel && (
            <div
              className="w-3 h-3 rounded-full ring-1 ring-black/20"
              style={{ backgroundColor: colorLabel.color }}
              data-tooltip={`Color: ${colorLabel.name}`}
            ></div>
          )}
          {rating > 0 && (
            <>
              <Text variant={TextVariants.label} color={TextColors.primary}>
                {rating}
              </Text>
              <StarIcon size={16} className="text-accent fill-accent" />
            </>
          )}
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-linear-to-t from-black/70 to-transparent p-2 flex items-end justify-between">
        <Text variant={TextVariants.small} color={TextColors.white} className="truncate pr-2">
          {baseName}
        </Text>
        {isVirtualCopy && (
          <Text
            as="div"
            variant={TextVariants.small}
            color={TextColors.white}
            weight={TextWeights.bold}
            className="shrink-0 bg-bg-primary/50 px-1.5 py-0.5 rounded-full backdrop-blur-xs"
            data-tooltip="Virtual Copy"
          >
            VC
          </Text>
        )}
      </div>
    </div>
  );
}

const Row = ({
  index,
  style,
  rows,
  activePath,
  multiSelectedPaths,
  onContextMenu,
  onImageClick,
  onImageDoubleClick,
  thumbnails,
  thumbnailAspectRatio,
  loadedThumbnails,
  imageRatings,
  rootPath,
  itemWidth,
  itemHeight,
  outerPadding,
  gap,
  isListView,
  columnWidths,
}: any) => {
  const row = rows[index];
  if (row.type === 'footer') return null;
  const shiftedStyle = {
    ...style,
    transform: (style.transform as string).replace(
      /translateY\(([^)]+)\)/,
      (_: string, y: string) => `translateY(${parseFloat(y) + outerPadding}px)`,
    ),
  };

  if (row.type === 'header') {
    let displayPath = row.path;
    if (rootPath && row.path.startsWith(rootPath)) {
      displayPath = row.path.substring(rootPath.length);
      if (displayPath.startsWith('/') || displayPath.startsWith('\\')) {
        displayPath = displayPath.substring(1);
      }
    }
    if (!displayPath) displayPath = 'Current Folder';

    return (
      <div
        style={{
          ...shiftedStyle,
          left: 0,
          width: '100%',
          paddingLeft: outerPadding === 0 ? 12 : outerPadding,
          paddingRight: outerPadding === 0 ? 12 : outerPadding,
          boxSizing: 'border-box',
        }}
        className="flex items-end pb-2 pt-2"
      >
        <div className="flex items-center gap-2 w-full border-b border-border-color/50 pb-1">
          <FolderOpen size={16} className="text-text-secondary" />
          <Text variant={TextVariants.label} weight={TextWeights.semibold} className="truncate" data-tooltip={row.path}>
            {displayPath}
          </Text>
          <Text variant={TextVariants.small} color={TextColors.secondary} className="ml-auto">
            {row.count} images
          </Text>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        ...shiftedStyle,
        left: outerPadding,
        right: outerPadding,
        width: isListView ? '100%' : 'auto',
        display: 'flex',
        gap: gap,
      }}
    >
      {row.images.map((imageFile: ImageFile) => (
        <div
          key={imageFile.path}
          style={{
            width: isListView ? '100%' : itemWidth,
            height: itemHeight,
          }}
        >
          {isListView ? (
            <ListItem
              data={thumbnails[imageFile.path]}
              isActive={activePath === imageFile.path}
              isSelected={multiSelectedPaths.includes(imageFile.path)}
              onContextMenu={(e: any) => onContextMenu(e, imageFile.path)}
              onImageClick={onImageClick}
              onImageDoubleClick={onImageDoubleClick}
              onLoad={() => loadedThumbnails.add(imageFile.path)}
              path={imageFile.path}
              rating={imageRatings?.[imageFile.path] || 0}
              tags={imageFile.tags || []}
              aspectRatio={thumbnailAspectRatio}
              modified={imageFile.modified}
              columnWidths={columnWidths}
            />
          ) : (
            <Thumbnail
              data={thumbnails[imageFile.path]}
              isActive={activePath === imageFile.path}
              isSelected={multiSelectedPaths.includes(imageFile.path)}
              onContextMenu={(e: any) => onContextMenu(e, imageFile.path)}
              onImageClick={onImageClick}
              onImageDoubleClick={onImageDoubleClick}
              onLoad={() => loadedThumbnails.add(imageFile.path)}
              path={imageFile.path}
              rating={imageRatings?.[imageFile.path] || 0}
              tags={imageFile.tags || []}
              aspectRatio={thumbnailAspectRatio}
            />
          )}
        </div>
      ))}
    </div>
  );
};

export default function MainLibrary({
  activePath,
  aiModelDownloadStatus,
  appSettings,
  currentFolderPath,
  filterCriteria,
  imageList,
  imageRatings,
  importState,
  indexingProgress,
  isIndexing,
  isAndroid,
  isLoading,
  isTreeLoading: _isTreeLoading,
  libraryScrollTop,
  libraryViewMode,
  multiSelectedPaths,
  onClearSelection,
  onContextMenu,
  onContinueSession,
  onEmptyAreaContextMenu,
  onGoHome,
  onImageClick,
  onImageDoubleClick,
  onLibraryRefresh,
  onOpenFolder,
  onSettingsChange,
  onThumbnailAspectRatioChange,
  onThumbnailSizeChange,
  onRequestThumbnails,
  rootPath,
  searchCriteria,
  setFilterCriteria,
  setLibraryScrollTop,
  setLibraryViewMode,
  setSearchCriteria,
  setSortCriteria,
  sortCriteria,
  theme,
  thumbnailAspectRatio,
  thumbnails,
  thumbnailProgress,
  thumbnailSize,
  onNavigateToCommunity,
  listColumnWidths,
  setListColumnWidths,
}: MainLibraryProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [, setSupportedTypes] = useState<SupportedTypes | null>(null);
  const libraryContainerRef = useRef<HTMLDivElement>(null);
  const [gridSize, setGridSize] = useState({ height: 0, width: 0 });
  const gridObserverRef = useRef<ResizeObserver | null>(null);
  const gridContainerRef = useCallback((el: HTMLDivElement | null) => {
    if (gridObserverRef.current) {
      gridObserverRef.current.disconnect();
      gridObserverRef.current = null;
    }
    if (el) {
      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          const { height, width } = entry.contentRect;
          setGridSize((prev) => (prev.height === height && prev.width === width ? prev : { height, width }));
        }
      });
      ro.observe(el);
      gridObserverRef.current = ro;
    }
  }, []);
  const [listHandle, setListHandle] = useListCallbackRef();
  const [isUpdateAvailable, setIsUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState('');
  const [isBusyDelayed, setIsBusyDelayed] = useState(false);
  const [isProgressHovered, setIsProgressHovered] = useState(false);
  const loadedThumbnailsRef = useRef(new Set<string>());

  const handleHeaderSort = useCallback(
    (key: string) => {
      onClearSelection();
      setSortCriteria((prev) => {
        if (prev.key === key) {
          if (prev.order === SortDirection.Ascending) {
            return { ...prev, order: SortDirection.Descening };
          } else {
            return { key: 'name', order: SortDirection.Ascending };
          }
        }
        return { key, order: SortDirection.Ascending };
      });
    },
    [onClearSelection, setSortCriteria],
  );

  const prevScrollState = useRef({
    path: null as string | null,
    top: -1,
    folder: null as string | null,
  });

  const groups = useMemo(() => {
    if (libraryViewMode === LibraryViewMode.Flat) return null;
    return groupImagesByFolder(imageList, currentFolderPath);
  }, [imageList, currentFolderPath, libraryViewMode]);

  const handleSortChange = useCallback(
    (criteria: SortCriteria | ((prev: SortCriteria) => SortCriteria)) => {
      onClearSelection();
      setSortCriteria(criteria);
    },
    [onClearSelection, setSortCriteria],
  );

  const sortOptions = useMemo(() => {
    const exifEnabled = appSettings?.enableExifReading ?? false;
    return [
      { key: 'name', label: 'File Name' },
      { key: 'date', label: 'Date Modified' },
      { key: 'rating', label: 'Rating' },
      { key: 'date_taken', label: 'Date Taken', disabled: !exifEnabled },
      { key: 'focal_length', label: 'Focal Length', disabled: !exifEnabled },
      { key: 'iso', label: 'ISO', disabled: !exifEnabled },
      { key: 'shutter_speed', label: 'Shutter Speed', disabled: !exifEnabled },
      { key: 'aperture', label: 'Aperture', disabled: !exifEnabled },
    ];
  }, [appSettings?.enableExifReading]);

  useEffect(() => {
    if (!listHandle?.element) return;

    const element = listHandle.element;
    const clientHeight = element.clientHeight;

    if (activePath && libraryContainerRef.current) {
      const width = libraryContainerRef.current.clientWidth;
      if (width > 0 && clientHeight > 0) {
        const isListView = thumbnailSize === ThumbnailSize.List;
        const OUTER_PADDING = isListView ? 0 : 12;
        const ITEM_GAP = isListView ? 0 : 12;
        const minThumbWidth = thumbnailSizeOptions.find((o) => o.id === thumbnailSize)?.size || 240;
        const availableWidth = width - OUTER_PADDING * 2;
        const columnCount = isListView
          ? 1
          : Math.max(1, Math.floor((availableWidth + ITEM_GAP) / (minThumbWidth + ITEM_GAP)));
        const itemWidth = isListView ? availableWidth : (availableWidth - ITEM_GAP * (columnCount - 1)) / columnCount;
        const listRowHeight = Math.max(36, Math.min(300, (availableWidth * listColumnWidths.thumbnail) / 100));
        const rowHeight = isListView ? listRowHeight : itemWidth + ITEM_GAP;
        const headerHeight = 40;

        let targetTop = 0;
        let found = false;

        if (libraryViewMode === LibraryViewMode.Recursive) {
          const grps = groupImagesByFolder(imageList, currentFolderPath);
          for (const group of grps) {
            if (group.images.length === 0) continue;
            targetTop += headerHeight;
            const idx = group.images.findIndex((img) => img.path === activePath);
            if (idx !== -1) {
              targetTop += Math.floor(idx / columnCount) * rowHeight;
              found = true;
              break;
            }
            targetTop += Math.ceil(group.images.length / columnCount) * rowHeight;
          }
        } else {
          const idx = imageList.findIndex((img) => img.path === activePath);
          if (idx !== -1) {
            targetTop = Math.floor(idx / columnCount) * rowHeight;
            found = true;
          }
        }

        if (found) {
          const itemBottom = targetTop + rowHeight;
          const savedTop = Math.max(0, libraryScrollTop);
          const isVisibleAtSaved = targetTop < savedTop + clientHeight && itemBottom > savedTop;

          if (isVisibleAtSaved && libraryScrollTop > 0) {
            element.scrollTop = libraryScrollTop;
          } else {
            element.scrollTop = Math.max(0, targetTop - clientHeight / 2 + rowHeight / 2);
          }

          prevScrollState.current = {
            path: activePath,
            top: targetTop,
            folder: currentFolderPath,
          };
          return;
        }
      }
    }

    if (libraryScrollTop > 0) {
      element.scrollTop = libraryScrollTop;
    }
  }, [listHandle]);

  useEffect(() => {
    if (!activePath || !libraryContainerRef.current || multiSelectedPaths.length > 1) return;

    const container = libraryContainerRef.current;
    const width = container.clientWidth;
    const isListView = thumbnailSize === ThumbnailSize.List;
    const OUTER_PADDING = isListView ? 0 : 12;
    const ITEM_GAP = isListView ? 0 : 12;
    const minThumbWidth = thumbnailSizeOptions.find((o) => o.id === thumbnailSize)?.size || 240;

    const availableWidth = width - OUTER_PADDING * 2;
    const columnCount = isListView
      ? 1
      : Math.max(1, Math.floor((availableWidth + ITEM_GAP) / (minThumbWidth + ITEM_GAP)));
    const itemWidth = isListView ? availableWidth : (availableWidth - ITEM_GAP * (columnCount - 1)) / columnCount;

    const listRowHeight = Math.max(36, Math.min(300, (availableWidth * listColumnWidths.thumbnail) / 100));
    const rowHeight = isListView ? listRowHeight : itemWidth + ITEM_GAP;
    const headerHeight = 40;

    let targetTop = 0;
    let found = false;

    if (libraryViewMode === LibraryViewMode.Recursive) {
      const groups = groupImagesByFolder(imageList, currentFolderPath);
      for (const group of groups) {
        if (group.images.length === 0) continue;

        targetTop += headerHeight;

        const imageIndex = group.images.findIndex((img) => img.path === activePath);
        if (imageIndex !== -1) {
          const rowIndex = Math.floor(imageIndex / columnCount);
          targetTop += rowIndex * rowHeight;
          found = true;
          break;
        }

        const rowsInGroup = Math.ceil(group.images.length / columnCount);
        targetTop += rowsInGroup * rowHeight;
      }
    } else {
      const index = imageList.findIndex((img) => img.path === activePath);
      if (index !== -1) {
        const rowIndex = Math.floor(index / columnCount);
        targetTop = rowIndex * rowHeight;
        found = true;
      }
    }

    if (found && listHandle?.element) {
      const prev = prevScrollState.current;

      const shouldScroll =
        activePath !== prev.path || Math.abs(targetTop - prev.top) > 1 || currentFolderPath !== prev.folder;

      if (shouldScroll) {
        const element = listHandle.element;
        const clientHeight = element.clientHeight;
        const scrollTop = element.scrollTop;
        const itemBottom = targetTop + rowHeight;
        const SCROLL_OFFSET = 120;

        if (itemBottom > scrollTop + clientHeight) {
          element.scrollTo({
            top: itemBottom - clientHeight + SCROLL_OFFSET,
            behavior: 'smooth',
          });
        } else if (targetTop < scrollTop) {
          element.scrollTo({
            top: targetTop - SCROLL_OFFSET,
            behavior: 'smooth',
          });
        }

        prevScrollState.current = {
          path: activePath,
          top: targetTop,
          folder: currentFolderPath,
        };
      }
    }
  }, [
    activePath,
    imageList,
    libraryViewMode,
    thumbnailSize,
    currentFolderPath,
    multiSelectedPaths.length,
    listHandle,
    listColumnWidths.thumbnail,
  ]);

  useEffect(() => {
    const exifEnabled = appSettings?.enableExifReading ?? true;
    const exifSortKeys = ['date_taken', 'iso', 'shutter_speed', 'aperture', 'focal_length'];
    const isCurrentSortExif = exifSortKeys.includes(sortCriteria.key);

    if (!exifEnabled && isCurrentSortExif) {
      setSortCriteria({ key: 'name', order: SortDirection.Ascending });
    }
  }, [appSettings?.enableExifReading, sortCriteria.key, setSortCriteria]);

  const isBusy =
    isLoading ||
    ((thumbnailProgress?.total ?? 0) > 0 && (thumbnailProgress?.current ?? 0) < (thumbnailProgress?.total ?? 0));

  useEffect(() => {
    let timer: number | undefined;

    if (isBusy) {
      timer = window.setTimeout(() => setIsBusyDelayed(true), 1000);
    } else {
      timer = window.setTimeout(() => setIsBusyDelayed(false), 500);
    }

    return () => clearTimeout(timer);
  }, [isBusy]);

  useEffect(() => {
    const compareVersions = (v1: string, v2: string) => {
      const parts1 = v1.split('.').map(Number);
      const parts2 = v2.split('.').map(Number);
      const len = Math.max(parts1.length, parts2.length);
      for (let i = 0; i < len; i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 < p2) return -1;
        if (p1 > p2) return 1;
      }
      return 0;
    };

    const checkVersion = async () => {
      try {
        const currentVersion = await getVersion();
        setAppVersion(currentVersion);

        const response = await fetch('https://api.github.com/repos/CyberTimon/RapidRAW/releases/latest');
        if (!response.ok) {
          console.error('Failed to fetch latest release info from GitHub.');
          return;
        }
        const data = await response.json();
        const latestTag = data.tag_name;
        if (!latestTag) return;

        const latestVersionStr = latestTag.startsWith('v') ? latestTag.substring(1) : latestTag;
        setLatestVersion(latestVersionStr);

        if (compareVersions(currentVersion, latestVersionStr) < 0) {
          setIsUpdateAvailable(true);
        }
      } catch (error) {
        console.error('Error checking for updates:', error);
      }
    };

    checkVersion();
  }, []);

  useEffect(() => {
    invoke(Invokes.GetSupportedFileTypes)
      .then((types: any) => setSupportedTypes(types))
      .catch((err) => console.error('Failed to load supported file types:', err));
  }, []);

  useEffect(() => {
    const handleWheel = (event: any) => {
      const container = libraryContainerRef.current;
      if (!container || !container.contains(event.target)) {
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const currentIndex = thumbnailSizeOptions.findIndex((o: ThumbnailSizeOption) => o.id === thumbnailSize);
        if (currentIndex === -1) {
          return;
        }

        const nextIndex =
          event.deltaY < 0
            ? Math.min(currentIndex + 1, thumbnailSizeOptions.length - 1)
            : Math.max(currentIndex - 1, 0);
        if (nextIndex !== currentIndex) {
          onThumbnailSizeChange(thumbnailSizeOptions[nextIndex].id);
        }
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.removeEventListener('wheel', handleWheel);
    };
  }, [thumbnailSize, onThumbnailSizeChange]);

  if (!rootPath) {
    if (!appSettings) {
      return;
    }
    const hasLastPath = !!appSettings.lastRootPath;
    const currentThemeId = theme || DEFAULT_THEME_ID;
    const selectedTheme: ThemeProps | undefined =
      THEMES.find((t: ThemeProps) => t.id === currentThemeId) ||
      THEMES.find((t: ThemeProps) => t.id === DEFAULT_THEME_ID);
    const splashImage = selectedTheme?.splashImage;
    return (
      <div className={`flex-1 flex h-full bg-bg-secondary overflow-hidden shadow-lg`}>
        <div className="w-1/2 hidden md:block relative">
          <AnimatePresence>
            <motion.img
              alt="Splash screen background"
              animate={{ opacity: 1 }}
              className="absolute inset-0 w-full h-full object-cover"
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              key={splashImage}
              src={splashImage}
              transition={{ duration: 0.5, ease: 'easeInOut' }}
            />
          </AnimatePresence>
        </div>
        <div className="w-full md:w-1/2 flex flex-col p-8 lg:p-16 relative">
          {showSettings ? (
            <SettingsPanel
              appSettings={appSettings}
              onBack={() => setShowSettings(false)}
              onLibraryRefresh={onLibraryRefresh}
              onSettingsChange={onSettingsChange}
              rootPath={rootPath}
            />
          ) : (
            <>
              <div className="my-auto text-left">
                <Text variant={TextVariants.displayLarge}>RapidRAW</Text>
                <Text
                  variant={TextVariants.heading}
                  color={TextColors.secondary}
                  weight={TextWeights.normal}
                  className="mb-10 max-w-md"
                >
                  {hasLastPath ? (
                    <>
                      Welcome back!
                      <br />
                      Continue where you left off or start a new session.
                    </>
                  ) : (
                    `A blazingly fast, GPU-accelerated RAW image editor. ${
                      isAndroid ? 'Open the library to begin.' : 'Open a folder to begin.'
                    }`
                  )}
                </Text>
                <div className="flex flex-col w-full max-w-xs gap-4">
                  {hasLastPath && (
                    <Button
                      className="rounded-md h-11 w-full flex justify-center items-center"
                      onClick={onContinueSession}
                      size="lg"
                    >
                      <RefreshCw size={20} className="mr-2" /> Continue Session
                    </Button>
                  )}
                  <div className="flex items-center gap-2">
                    <Button
                      className={`rounded-md grow flex justify-center items-center h-11 ${
                        hasLastPath ? 'bg-surface text-text-primary shadow-none' : ''
                      }`}
                      onClick={onOpenFolder}
                      size="lg"
                    >
                      <Folder size={20} className="mr-2" />
                      {isAndroid ? 'Open Library' : hasLastPath ? 'Change Folder' : 'Open Folder'}
                    </Button>
                    <Button
                      className="px-3 bg-surface text-text-primary shadow-none h-11"
                      onClick={() => setShowSettings(true)}
                      size="lg"
                      data-tooltip="Go to Settings"
                      variant="ghost"
                    >
                      <Settings size={20} />
                    </Button>
                  </div>
                </div>
              </div>
              <Text variant={TextVariants.small} as="div" className="absolute bottom-8 left-8 lg:left-16 space-y-1">
                <p>
                  Images by{' '}
                  <a
                    href="https://instagram.com/timonkaech.photography"
                    className="hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Timon Käch
                  </a>
                </p>
                {appVersion && (
                  <div className="flex items-center space-x-2">
                    <p>
                      <span
                        className={`group transition-all duration-300 ease-in-out rounded-md py-1 ${
                          isUpdateAvailable ? 'cursor-pointer border border-yellow-500 px-2 hover:bg-yellow-500/20' : ''
                        }`}
                        onClick={() => {
                          if (isUpdateAvailable) {
                            open('https://github.com/CyberTimon/RapidRAW/releases/latest');
                          }
                        }}
                        data-tooltip={
                          isUpdateAvailable
                            ? `Click to download version ${latestVersion}`
                            : `You are on the latest version`
                        }
                      >
                        <span className={isUpdateAvailable ? 'group-hover:hidden' : ''}>Version {appVersion}</span>
                        {isUpdateAvailable && (
                          <span className="hidden group-hover:inline text-yellow-400">New version available!</span>
                        )}
                      </span>
                    </p>
                    <span>-</span>
                    <p>
                      <a
                        href="https://ko-fi.com/cybertimon"
                        className="hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Donate on Ko-Fi
                      </a>
                      <span className="mx-1">or</span>
                      <a
                        href="https://github.com/CyberTimon/RapidRAW"
                        className="hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Contribute on GitHub
                      </a>
                    </p>
                  </div>
                )}
              </Text>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col h-full min-w-0 bg-bg-secondary rounded-lg overflow-hidden"
      ref={libraryContainerRef}
    >
      <header
        className="p-4 shrink-0 flex justify-between items-center border-b border-border-color gap-4"
        onMouseEnter={() => setIsProgressHovered(true)}
        onMouseLeave={() => setIsProgressHovered(false)}
      >
        <div className="min-w-0">
          <Text variant={TextVariants.headline}>Library</Text>
          <div className="flex items-center gap-2">
            {currentFolderPath ? (
              <Text className="truncate">{currentFolderPath}</Text>
            ) : (
              <p className="text-sm invisible select-none pointer-events-none h-5 overflow-hidden"></p>
            )}
            <div
              className={`flex items-center gap-2 overflow-hidden transition-all duration-300 whitespace-nowrap ${
                isBusyDelayed ? 'max-w-xs opacity-100' : 'max-w-0 opacity-0'
              }`}
            >
              <Loader2 size={14} className="animate-spin text-text-secondary shrink-0" />
              <div
                className={`flex items-center transition-all duration-300 ease-out overflow-hidden ${
                  isProgressHovered && isBusyDelayed && (thumbnailProgress?.total ?? 0) > 0
                    ? 'max-w-xs opacity-100'
                    : 'max-w-0 opacity-0'
                }`}
              >
                <Text variant={TextVariants.small} color={TextColors.secondary} className="whitespace-nowrap">
                  ({thumbnailProgress?.current ?? 0}/{thumbnailProgress?.total ?? 0})
                </Text>
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {importState.status === Status.Importing && (
            <Text as="div" color={TextColors.accent} className="flex items-center gap-2 animate-pulse">
              <FolderInput size={16} />
              <span>
                Importing... ({importState.progress?.current}/{importState.progress?.total})
              </span>
            </Text>
          )}
          {importState.status === Status.Success && (
            <Text as="div" color={TextColors.success} className="flex items-center gap-2">
              <Check size={16} />
              <span>Import Complete!</span>
            </Text>
          )}
          {importState.status === Status.Error && (
            <Text as="div" color={TextColors.error} className="flex items-center gap-2">
              <AlertTriangle size={16} />
              <span>Import Failed!</span>
            </Text>
          )}
          <SearchInput
            indexingProgress={indexingProgress}
            isIndexing={isIndexing}
            searchCriteria={searchCriteria}
            setSearchCriteria={setSearchCriteria}
          />
          <ViewOptionsDropdown
            filterCriteria={filterCriteria}
            libraryViewMode={libraryViewMode}
            onSelectSize={onThumbnailSizeChange}
            onSelectAspectRatio={onThumbnailAspectRatioChange}
            setFilterCriteria={setFilterCriteria}
            setLibraryViewMode={setLibraryViewMode}
            setSortCriteria={handleSortChange}
            sortCriteria={sortCriteria}
            sortOptions={sortOptions}
            thumbnailSize={thumbnailSize}
            thumbnailAspectRatio={thumbnailAspectRatio}
          />
          <Button
            className="h-12 w-12 bg-surface text-text-primary shadow-none p-0 flex items-center justify-center"
            onClick={onNavigateToCommunity}
            data-tooltip="Community Presets"
          >
            <Users className="w-8 h-8" />
          </Button>
          <Button
            className="h-12 w-12 bg-surface text-text-primary shadow-none p-0 flex items-center justify-center"
            onClick={onOpenFolder}
            data-tooltip="Open another folder"
          >
            <Folder className="w-8 h-8" />
          </Button>
          <Button
            className="h-12 w-12 bg-surface text-text-primary shadow-none p-0 flex items-center justify-center"
            onClick={onGoHome}
            data-tooltip="Go to Home"
          >
            <Home className="w-8 h-8" />
          </Button>
        </div>
      </header>
      {imageList.length > 0 ? (
        <div
          ref={gridContainerRef}
          className="flex-1 w-full h-full"
          onClick={onClearSelection}
          onContextMenu={onEmptyAreaContextMenu}
        >
          {gridSize.height > 0 &&
            gridSize.width > 0 &&
            (() => {
              const isListView = thumbnailSize === ThumbnailSize.List;
              const OUTER_PADDING = isListView ? 0 : 12;
              const ITEM_GAP = isListView ? 0 : 12;
              const minThumbWidth = thumbnailSizeOptions.find((o) => o.id === thumbnailSize)?.size || 240;

              const availableWidth = gridSize.width - OUTER_PADDING * 2;
              const columnCount = isListView
                ? 1
                : Math.max(1, Math.floor((availableWidth + ITEM_GAP) / (minThumbWidth + ITEM_GAP)));
              const itemWidth = isListView
                ? availableWidth
                : (availableWidth - ITEM_GAP * (columnCount - 1)) / columnCount;

              const listRowHeight = Math.max(36, Math.min(300, (availableWidth * listColumnWidths.thumbnail) / 100));
              const rowHeight = isListView ? listRowHeight : itemWidth + ITEM_GAP;
              const headerHeight = 40;

              const rows: any[] = [];

              if (libraryViewMode === LibraryViewMode.Recursive && groups) {
                groups.forEach((group) => {
                  if (group.images.length === 0) return;

                  rows.push({ type: 'header', path: group.path, count: group.images.length });

                  for (let i = 0; i < group.images.length; i += columnCount) {
                    rows.push({
                      type: 'images',
                      images: group.images.slice(i, i + columnCount),
                      startIndex: i,
                    });
                  }
                });
              } else {
                for (let i = 0; i < imageList.length; i += columnCount) {
                  rows.push({
                    type: 'images',
                    images: imageList.slice(i, i + columnCount),
                    startIndex: i,
                  });
                }
              }

              rows.push({ type: 'footer' });

              const getItemSize = (index: number) => {
                if (rows[index].type === 'footer') return isListView ? 24 : OUTER_PADDING;
                return rows[index].type === 'header' ? headerHeight : rowHeight;
              };

              return (
                <div className="flex flex-col w-full h-full">
                  {isListView && (
                    <ListHeader
                      widths={listColumnWidths}
                      setWidths={setListColumnWidths}
                      containerRef={libraryContainerRef}
                      sortCriteria={sortCriteria}
                      onSortChange={handleHeaderSort}
                    />
                  )}
                  <div
                    key={`${gridSize.width}-${thumbnailSize}-${libraryViewMode}`}
                    style={{
                      height: isListView ? gridSize.height - 36 : gridSize.height,
                      width: gridSize.width,
                    }}
                  >
                    <List
                      listRef={setListHandle}
                      rowCount={rows.length}
                      rowHeight={getItemSize}
                      onScroll={(e: React.UIEvent<HTMLElement>) => setLibraryScrollTop(e.currentTarget.scrollTop)}
                      onRowsRendered={({ startIndex, stopIndex }) => {
                        if (!onRequestThumbnails) return;
                        const pathsToRequest: string[] = [];

                        for (let i = startIndex; i <= stopIndex; i++) {
                          const row = rows[i];
                          if (row && row.type === 'images') {
                            row.images.forEach((img: ImageFile) => {
                              if (!thumbnails[img.path]) {
                                pathsToRequest.push(img.path);
                              }
                            });
                          }
                        }

                        if (pathsToRequest.length > 0) {
                          onRequestThumbnails(pathsToRequest);
                        }
                      }}
                      className="custom-scrollbar"
                      rowComponent={Row}
                      rowProps={{
                        rows,
                        activePath,
                        multiSelectedPaths,
                        onContextMenu,
                        onImageClick,
                        onImageDoubleClick,
                        thumbnails,
                        thumbnailAspectRatio,
                        loadedThumbnails: loadedThumbnailsRef.current,
                        imageRatings,
                        rootPath: currentFolderPath,
                        itemWidth,
                        itemHeight: isListView ? listRowHeight : itemWidth,
                        outerPadding: OUTER_PADDING,
                        gap: ITEM_GAP,
                        isListView,
                        columnWidths: listColumnWidths,
                      }}
                    />
                  </div>
                </div>
              );
            })()}
        </div>
      ) : isIndexing || aiModelDownloadStatus || importState.status === Status.Importing ? (
        <div className="flex-1 flex flex-col items-center justify-center" onContextMenu={onEmptyAreaContextMenu}>
          <Loader2 className="h-12 w-12 text-secondary animate-spin mb-4" />
          <Text variant={TextVariants.heading} color={TextColors.secondary}>
            {aiModelDownloadStatus
              ? `Downloading ${aiModelDownloadStatus}...`
              : isIndexing && indexingProgress.total > 0
                ? `Indexing images... (${indexingProgress.current}/${indexingProgress.total})`
                : importState.status === Status.Importing &&
                    importState?.progress?.total &&
                    importState.progress.total > 0
                  ? `Importing images... (${importState.progress?.current}/${importState.progress?.total})`
                  : 'Processing images...'}
          </Text>
          <Text className="mt-2">This may take a moment.</Text>
        </div>
      ) : searchCriteria.tags.length > 0 || searchCriteria.text ? (
        <div
          className="flex-1 flex flex-col items-center justify-center text-text-secondary text-center"
          onContextMenu={onEmptyAreaContextMenu}
        >
          <Search className="h-12 w-12 text-secondary mb-4" />
          <Text variant={TextVariants.heading} color={TextColors.secondary}>
            No Results Found
          </Text>
          <Text className="mt-2 max-w-sm">
            Could not find an image based on filename or tags.
            {!appSettings?.enableAiTagging && ' For a more comprehensive search, enable automatic tagging in Settings.'}
          </Text>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center" onContextMenu={onEmptyAreaContextMenu}>
          <SlidersHorizontal className="h-12 w-12 mb-4 text-text-secondary" />
          <Text>No images found that match your filter.</Text>
        </div>
      )}
    </div>
  );
}
