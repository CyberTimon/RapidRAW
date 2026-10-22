import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import {
  AlertTriangle,
  CircleDashed,
  ListTodo,
  Pause,
  Play,
  RotateCcw,
  Search,
  Loader2,
  X,
  SlidersHorizontal,
  Check,
  Star as StarIcon,
  ChevronUp,
  ChevronDown,
  HelpCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { invoke } from '@tauri-apps/api/core';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useProcessStore } from '../../../store/useProcessStore';
import {
  Invokes,
  FilterCriteria,
  RawStatus,
  EditedStatus,
  FlagStatus,
  LibraryViewMode,
  SortCriteria,
  SortDirection,
  ExifOverlay,
  RATING_OPERATORS,
  GroupingMode,
  ThumbnailSize,
  ThumbnailAspectRatio,
} from '../../ui/AppProperties';
import { COLOR_LABELS, Color } from '../../../utils/adjustments';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights, TEXT_COLOR_KEYS } from '../../../types/typography';
import Button from '../../ui/Button';
import Switch from '../../ui/Switch';
import Dropdown from '../../ui/Dropdown';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useUIStore } from '../../../store/useUIStore';
import { ADVANCED_QUERY_REGEX } from '../../../hooks/useSortedLibrary';

function DropdownMenu({ buttonContent, buttonTitle, children, contentClassName = 'w-56' }: any) {
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
            className={`absolute right-0 mt-2 ${contentClassName} origin-top-right z-50`}
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

interface SegmentedSwitchProps {
  options: { id: string | number; label: string }[];
  value: string | number;
  onChange: (id: any) => void;
}

const SegmentedSwitch = ({ options, value, onChange }: SegmentedSwitchProps) => {
  const [bubbleStyle, setBubbleStyle] = useState({});
  const isInitialAnimation = useRef(true);

  const selectedIndex = options.findIndex((m) => m.id === value);
  const hasSelection = selectedIndex >= 0;

  useEffect(() => {
    const safeIndex = hasSelection ? selectedIndex : 0;
    const widthPercent = 100 / options.length;
    const targetX = `${safeIndex * 100}%`;
    const targetWidth = `${widthPercent}%`;

    if (isInitialAnimation.current) {
      setBubbleStyle({ x: targetX, width: targetWidth, opacity: hasSelection ? 1 : 0 });
      isInitialAnimation.current = false;
    } else {
      setBubbleStyle({ x: targetX, width: targetWidth, opacity: hasSelection ? 1 : 0 });
    }
  }, [value, options, hasSelection]);

  return (
    <div className="w-full bg-bg-primary p-1 rounded-md">
      <div className="relative flex w-full">
        <motion.div
          className="absolute top-0 bottom-0 left-0 z-0 bg-card-active shadow-xs"
          style={{ borderRadius: 6 }}
          animate={bubbleStyle}
          initial={false}
          transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
        />
        {options.map((option) => (
          <button
            key={option.id}
            onClick={() => onChange(option.id)}
            className={clsx(
              'relative flex-1 flex items-center justify-center px-2 py-1.5 text-xs font-medium rounded-md transition-colors truncate',
              {
                'text-text-secondary hover:text-text-primary': value !== option.id,
                'text-text-primary font-semibold': value === option.id,
              },
            )}
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <span className="relative z-10">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

const RatingSegmentedSwitch = ({ rating, onChange, ratingFilterOptions, operator, onOperatorChange }: any) => {
  const { t } = useTranslation();
  const [bubbleStyle, setBubbleStyle] = useState({});
  const isInitialAnimation = useRef(true);

  const getActiveIndex = () => {
    if (rating === 0) return 0;
    if (rating <= -1) return 1;
    return 2;
  };

  const activeIndex = getActiveIndex();

  useEffect(() => {
    const targetX = `${activeIndex * 100}%`;
    const targetWidth = '33.333333%';

    if (isInitialAnimation.current) {
      setBubbleStyle({ x: targetX, width: targetWidth });
      isInitialAnimation.current = false;
    } else {
      setBubbleStyle({ x: targetX, width: targetWidth });
    }
  }, [activeIndex]);

  const op = RATING_OPERATORS[operator as keyof typeof RATING_OPERATORS] ?? RATING_OPERATORS.gte;

  return (
    <div className="flex w-full items-stretch gap-1">
      <div className="flex-1 min-w-0 bg-bg-primary p-1 rounded-md">
        <div className="relative flex w-full">
          <motion.div
            className="absolute top-0 bottom-0 left-0 z-0 bg-card-active shadow-xs"
            style={{ borderRadius: 6 }}
            animate={bubbleStyle}
            initial={false}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
          />

          <button
            onClick={() => onChange(0)}
            className={clsx(
              'relative flex-1 flex items-center justify-center px-1 py-1.5 text-xs rounded-md transition-colors truncate',
              activeIndex === 0 ? 'text-text-primary font-semibold' : 'text-text-secondary hover:text-text-primary',
            )}
          >
            <span className="relative z-10">{ratingFilterOptions.find((o: any) => o.value === 0)?.label || 'All'}</span>
          </button>

          <button
            onClick={() => onChange(-1)}
            className={clsx(
              'relative flex-1 flex items-center justify-center px-1 py-1.5 text-xs rounded-md transition-colors truncate',
              activeIndex === 1 ? 'text-text-primary font-semibold' : 'text-text-secondary hover:text-text-primary',
            )}
          >
            <span className="relative z-10">
              {ratingFilterOptions.find((o: any) => o.value === -1)?.label || 'Unrated'}
            </span>
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
                        isFilled ? 'text-accent fill-accent' : 'text-text-secondary hover:text-accent'
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

export function SearchInput({ indexingProgress, isIndexing }: any) {
  const { t } = useTranslation();
  const { searchCriteria, setSearchCriteria } = useLibraryStore(
    useShallow((state) => ({ searchCriteria: state.searchCriteria, setSearchCriteria: state.setSearchCriteria })),
  );
  const [isSearchActive, setIsSearchActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { tags, text, mode } = searchCriteria;
  const searchFocusRequest = useUIStore((state) => state.searchFocusRequest);
  const lastSearchFocusRequest = useRef(searchFocusRequest);

  const [contentWidth, setContentWidth] = useState(0);

  useEffect(() => {
    if (isSearchActive) {
      inputRef.current?.focus();
    }
  }, [isSearchActive]);

  useEffect(() => {
    if (searchFocusRequest === lastSearchFocusRequest.current) return;
    lastSearchFocusRequest.current = searchFocusRequest;
    setIsSearchActive(true);
    inputRef.current?.focus();
  }, [searchFocusRequest]);

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
      ? t('library.header.search.indexingProgress', {
          current: indexingProgress.current,
          total: indexingProgress.total,
        })
      : isIndexing
        ? t('library.header.search.indexingImages')
        : tags.length > 0
          ? t('library.header.search.addFilterOrSearch')
          : t('library.header.search.searchOrQuery');

  const INACTIVE_WIDTH = 48;
  const PADDING_AND_ICONS_WIDTH = 100;
  const MAX_WIDTH = 680;

  const calculatedWidth = Math.min(MAX_WIDTH, contentWidth + PADDING_AND_ICONS_WIDTH);

  return (
    <motion.div
      animate={{ width: isActive ? calculatedWidth : INACTIVE_WIDTH }}
      className="relative flex items-center bg-surface rounded-md h-12 overflow-hidden"
      initial={false}
      transition={{ type: 'spring', stiffness: 400, damping: 35 }}
      onClick={() => inputRef.current?.focus()}
    >
      <button
        className="h-12 w-12 flex items-center justify-center text-text-primary z-10 shrink-0 bg-surface outline-hidden"
        onClick={(e) => {
          e.stopPropagation();
          if (!isActive) setIsSearchActive(true);
          inputRef.current?.focus();
        }}
        data-tooltip={t('library.header.search.tooltipSearchFilter')}
      >
        <Search className="w-4 h-4" />
      </button>
      <div
        className="flex-1 min-w-0 h-full overflow-hidden flex items-center pl-1"
        style={{ opacity: isActive ? 1 : 0, pointerEvents: isActive ? 'auto' : 'none', transition: 'opacity 0.2s' }}
      >
        <div ref={contentRef} className="flex items-center gap-2 h-full flex-nowrap min-w-[250px] pr-2">
          {tags.map((tag) => {
            const match = tag.match(ADVANCED_QUERY_REGEX);
            const isQuery = !!match;

            return (
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
                  {isQuery ? (
                    <span className="flex gap-0.5">
                      <span className="uppercase opacity-70">{match[1]}</span>
                      <span>{match[2] || ':'}</span>
                      <span>{match[3]}</span>
                    </span>
                  ) : (
                    tag
                  )}
                </Text>
                <span className="rounded-full group-hover:bg-black/20 p-0.5 transition-colors">
                  <X size={12} />
                </span>
              </motion.div>
            );
          })}
          <input
            className="grow w-full h-full bg-transparent text-text-primary placeholder-text-secondary border-none focus:outline-hidden min-w-[150px]"
            disabled={isIndexing}
            onBlur={() => {
              if (tags.length === 0 && !text) setIsSearchActive(false);
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
        className="shrink-0 flex items-center gap-1 pr-2 bg-surface z-10"
        style={{ opacity: isActive ? 1 : 0, pointerEvents: isActive ? 'auto' : 'none', transition: 'opacity 0.2s' }}
      >
        {tags.length > 0 && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleMode}
            className="p-1.5 rounded-md hover:bg-bg-primary w-10 shrink-0 flex items-center justify-center outline-hidden"
            data-tooltip={mode === 'AND' ? t('library.header.search.matchAll') : t('library.header.search.matchAny')}
          >
            <Text variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.semibold}>
              {mode}
            </Text>
          </button>
        )}
        <div
          className="p-1.5 rounded-md text-text-secondary hover:text-text-primary transition-colors cursor-help shrink-0 outline-hidden"
          data-tooltip={t('library.header.search.tooltipAdvancedQueries')}
        >
          <HelpCircle size={16} />
        </div>
        {(tags.length > 0 || text) && !isIndexing && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={clearSearch}
            className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-primary shrink-0 outline-hidden"
            data-tooltip={t('library.header.search.tooltipClearSearch')}
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

const groupingOptionKeys = [
  { key: 'off' as GroupingMode, labelKey: 'library.header.viewOptions.groupOff' as const },
  { key: 'raw' as GroupingMode, labelKey: 'library.header.viewOptions.groupPreferRaw' as const },
  { key: 'jpeg' as GroupingMode, labelKey: 'library.header.viewOptions.groupPreferJpeg' as const },
];

interface ViewOptionsDropdownProps {
  libraryViewMode: LibraryViewMode;
  onSelectSize: (id: ThumbnailSize) => void;
  onSelectAspectRatio: (id: ThumbnailAspectRatio) => void;
  onLibraryRefresh?: () => void;
  setLibraryViewMode: (mode: LibraryViewMode) => void;
  thumbnailSize: ThumbnailSize;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  thumbnailSizeOptions: Array<{ id: ThumbnailSize; label: string; size: number }>;
  thumbnailAspectRatioOptions: Array<{ id: ThumbnailAspectRatio; label: string }>;
  ratingFilterOptions: Array<{ value: number; label: string }>;
  rawStatusOptions: Array<{ key: RawStatus; label: string }>;
  editedStatusOptions: Array<{ key: EditedStatus; label: string }>;
  flagStatusOptions: Array<{ key: FlagStatus; label: string }>;
  sortOptions: Array<{ key: string; label: string; disabled?: boolean }>;
}

export function ViewOptionsDropdown({
  libraryViewMode,
  onSelectSize,
  onSelectAspectRatio,
  onLibraryRefresh,
  setLibraryViewMode,
  thumbnailSize,
  thumbnailAspectRatio,
  thumbnailSizeOptions,
  thumbnailAspectRatioOptions,
  ratingFilterOptions,
  rawStatusOptions,
  editedStatusOptions,
  flagStatusOptions,
  sortOptions,
}: ViewOptionsDropdownProps) {
  const { t } = useTranslation();
  const { filterCriteria, setFilterCriteria, sortCriteria, setSortCriteria } = useLibraryStore(
    useShallow((state) => ({
      filterCriteria: state.filterCriteria,
      setFilterCriteria: state.setFilterCriteria,
      sortCriteria: state.sortCriteria,
      setSortCriteria: state.setSortCriteria,
    })),
  );

  const { appSettings, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const groupingMode: GroupingMode = appSettings?.grouping ?? 'off';
  const requireMatchingExif = appSettings?.requireMatchingExif ?? false;

  const isFilterActive =
    filterCriteria.rating !== 0 ||
    (filterCriteria.rawStatus && filterCriteria.rawStatus !== RawStatus.All) ||
    (filterCriteria.editedStatus && filterCriteria.editedStatus !== EditedStatus.All) ||
    (filterCriteria.flagStatus && filterCriteria.flagStatus !== FlagStatus.All) ||
    (filterCriteria.colors && filterCriteria.colors.length > 0);

  const [lastClickedColor, setLastClickedColor] = useState<string | null>(null);
  const allColors = useMemo(() => [...COLOR_LABELS, { name: 'none', color: '#9ca3af' }], []);

  const metadataOptions = useMemo(
    () => [
      { id: ExifOverlay.Off, label: t('library.header.viewOptions.metadataOff') },
      { id: ExifOverlay.Hover, label: t('library.header.viewOptions.metadataHover') },
      { id: ExifOverlay.Always, label: t('library.header.viewOptions.metadataAlways') },
    ],
    [t],
  );

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
    <DropdownMenu
      buttonContent={
        <>
          <SlidersHorizontal className="w-8 h-8" />
          {isFilterActive && <div className="absolute -top-1 -right-1 bg-accent rounded-full w-3 h-3" />}
        </>
      }
      buttonTitle={t('library.header.viewOptions.title')}
      contentClassName="library-view-options-menu w-[760px]"
    >
      <div className="library-view-options-content flex">
        <div className="library-view-options-section w-1/2 py-4 px-2 border-r border-border-color space-y-5">
          <div>
            <div className="px-3 py-1 relative flex items-center">
              <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="uppercase">
                {t('library.header.viewOptions.sortBy')}
              </Text>
              <button
                onClick={() =>
                  setSortCriteria((prev: SortCriteria) => ({
                    ...prev,
                    order: prev.order === SortDirection.Ascending ? SortDirection.Descending : SortDirection.Ascending,
                  }))
                }
                data-tooltip={
                  sortCriteria.order === SortDirection.Ascending
                    ? t('library.header.viewOptions.sortDescending')
                    : t('library.header.viewOptions.sortAscending')
                }
                className="absolute top-1/2 right-3 -translate-y-1/2 p-1 bg-transparent border-none text-text-secondary hover:text-text-primary rounded-sm transition-colors"
              >
                {sortCriteria.order === SortDirection.Ascending ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            </div>
            <div className="px-3 mt-1">
              <Dropdown
                options={sortOptions.map((opt) => ({ value: opt.key, label: opt.label, disabled: opt.disabled }))}
                value={sortCriteria.key}
                onChange={(val) => setSortCriteria((prev: SortCriteria) => ({ ...prev, key: val }))}
                triggerClassName="bg-bg-primary w-full"
              />
            </div>
          </div>

          <div>
            <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-1 uppercase">
              {t('library.header.viewOptions.thumbnailSize')}
            </Text>
            <div className="px-3 mt-1">
              <SegmentedSwitch options={thumbnailSizeOptions} value={thumbnailSize} onChange={onSelectSize} />
            </div>
          </div>

          <div>
            <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-1 uppercase">
              {t('library.header.viewOptions.thumbnailFit')}
            </Text>
            <div className="px-3 mt-1">
              <SegmentedSwitch
                options={thumbnailAspectRatioOptions}
                value={thumbnailAspectRatio}
                onChange={onSelectAspectRatio}
              />
            </div>
          </div>

          <div>
            <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-1 uppercase">
              {t('library.header.viewOptions.displayMode')}
            </Text>
            <div className="px-3 mt-1">
              <SegmentedSwitch
                options={[
                  { id: LibraryViewMode.Flat, label: t('library.header.viewOptions.currentFolder') },
                  { id: LibraryViewMode.Recursive, label: t('library.header.viewOptions.recursive') },
                ]}
                value={libraryViewMode}
                onChange={async (val) => {
                  setLibraryViewMode(val as LibraryViewMode);
                  if (appSettings) {
                    await handleSettingsChange({ ...appSettings, libraryViewMode: val as LibraryViewMode });
                    onLibraryRefresh?.();
                  }
                }}
              />
            </div>
          </div>

          <div>
            <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-1 uppercase">
              {t('library.header.viewOptions.showMetadata')}
            </Text>
            <div className="px-3 mt-1">
              <SegmentedSwitch
                options={metadataOptions}
                value={appSettings?.exifOverlay || ExifOverlay.Off}
                onChange={(val) => handleSettingsChange({ ...appSettings!, exifOverlay: val as ExifOverlay })}
              />
            </div>
          </div>
        </div>

        <div className="library-view-options-section w-1/2 py-4 px-2 space-y-5">
          <div>
            <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-1 uppercase">
              {t('library.header.viewOptions.filterByRating')}
            </Text>
            <div className="px-3 mt-1">
              <RatingSegmentedSwitch
                rating={filterCriteria.rating}
                operator={filterCriteria.ratingOperator ?? 'gte'}
                onOperatorChange={(op: 'gte' | 'eq' | 'lte') =>
                  setFilterCriteria((prev: FilterCriteria) => ({ ...prev, ratingOperator: op }))
                }
                onChange={(val: number) => setFilterCriteria((prev: FilterCriteria) => ({ ...prev, rating: val }))}
                ratingFilterOptions={ratingFilterOptions}
              />
            </div>
          </div>

          <div>
            <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-1 uppercase">
              {t('library.header.viewOptions.filterByFileType')}
            </Text>
            <div className="px-3 mt-1">
              <SegmentedSwitch
                options={rawStatusOptions.map((o) => ({ id: o.key, label: o.label }))}
                value={filterCriteria.rawStatus || RawStatus.All}
                onChange={(val) => setFilterCriteria((prev: FilterCriteria) => ({ ...prev, rawStatus: val }))}
              />
            </div>
          </div>

          <div>
            <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-1 uppercase">
              {t('library.header.viewOptions.filterByEdited', 'Filter by Edit Status')}
            </Text>
            <div className="px-3 mt-1">
              <SegmentedSwitch
                options={editedStatusOptions.map((o) => ({ id: o.key, label: o.label }))}
                value={filterCriteria.editedStatus || EditedStatus.All}
                onChange={(val) => setFilterCriteria((prev: FilterCriteria) => ({ ...prev, editedStatus: val }))}
              />
            </div>
          </div>

          <div>
            <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-1 uppercase">
              {t('library.header.viewOptions.filterByFlag')}
            </Text>
            <div className="px-3 mt-1">
              <SegmentedSwitch
                options={flagStatusOptions.map((o) => ({ id: o.key, label: o.label }))}
                value={filterCriteria.flagStatus || FlagStatus.All}
                onChange={(val) => setFilterCriteria((prev: FilterCriteria) => ({ ...prev, flagStatus: val }))}
              />
            </div>
          </div>

          <div>
            <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-1 uppercase">
              {t('library.header.viewOptions.groupRawJpeg')}
            </Text>
            <div className="px-3 mt-1">
              <SegmentedSwitch
                options={groupingOptionKeys.map((o) => ({ id: o.key, label: t(o.labelKey) }))}
                value={groupingMode}
                onChange={async (val) => {
                  if (appSettings) {
                    await handleSettingsChange({ ...appSettings, grouping: val as GroupingMode });
                  }
                }}
              />
              <AnimatePresence initial={false}>
                {groupingMode !== 'off' && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: 'easeInOut' }}
                    className="overflow-hidden"
                  >
                    <div className="pt-2 space-y-2 px-1">
                      <Switch
                        checked={!requireMatchingExif}
                        id="group-ignore-metadata-toggle"
                        label={t('library.header.viewOptions.groupIgnoreMetadata')}
                        onChange={async (checked) => {
                          if (appSettings) {
                            await handleSettingsChange({ ...appSettings, requireMatchingExif: !checked });
                            onLibraryRefresh?.();
                          }
                        }}
                        trackClassName="bg-surface"
                      />
                      <Switch
                        checked={appSettings?.groupEditedFiles ?? true}
                        id="group-edited-files-toggle"
                        label={t('library.header.viewOptions.groupEditedFiles')}
                        onChange={async (checked) => {
                          if (appSettings) {
                            await handleSettingsChange({ ...appSettings, groupEditedFiles: checked });
                            onLibraryRefresh?.();
                          }
                        }}
                        trackClassName="bg-surface"
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div>
            <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-1 uppercase">
              {t('library.header.viewOptions.filterByColorLabel')}
            </Text>
            <div className="flex flex-wrap gap-2.5 px-3 py-1.5">
              {allColors.map((color: Color) => {
                const isSelected = (filterCriteria.colors || []).includes(color.name);
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
                    onClick={(e: any) => handleColorClick(color.name, e)}
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
          </div>
        </div>
      </div>
    </DropdownMenu>
  );
}

const fileName = (path: string) => path.split('?vc=')[0].split(/[\\/]/).pop() ?? path;

const MAX_LISTED_AI_JOBS = 50;
const AI_JOB_ICON_BUTTON_CLASS =
  'shrink-0 p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-primary transition-colors';

const AI_JOB_COLLAPSE_ANIMATION = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: 'auto' },
  exit: { opacity: 0, height: 0 },
  transition: { duration: 0.2, ease: 'easeOut' },
} as const;

function AiJobRow({ path, active, children }: { path: string; active?: boolean; children?: React.ReactNode }) {
  return (
    <motion.div className="overflow-hidden shrink-0" {...AI_JOB_COLLAPSE_ANIMATION}>
      <div className="px-1 py-0.5">
        <div
          className={clsx('px-3 py-2 rounded-md flex items-center gap-3 transition-colors', active && 'bg-bg-primary')}
          data-tooltip={path}
        >
          <Text
            as="span"
            color={active ? TextColors.primary : TextColors.secondary}
            className="flex-1 min-w-0 truncate"
          >
            {fileName(path)}
          </Text>
          <div className="shrink-0 w-20 flex justify-end">{children}</div>
        </div>
      </div>
    </motion.div>
  );
}

export function AiJobsMenu() {
  const { t } = useTranslation();
  const { current, queued, completed, paused, failed } = useProcessStore((state) => state.aiJobs);
  const aiPendingPaths = useProcessStore((state) => state.aiPendingPaths);
  const imageList = useLibraryStore((state) => state.imageList);

  const unprocessedPaths = useMemo(
    () => imageList.filter((image) => image.needs_ai && !aiPendingPaths[image.path]).map((image) => image.path),
    [imageList, aiPendingPaths],
  );
  const queuedPaths = useMemo(() => {
    const paths = Object.keys(aiPendingPaths);
    return current ? [current.path, ...paths.filter((path) => path !== current.path)] : paths;
  }, [aiPendingPaths, current]);

  if (queued === 0 && failed.length === 0 && unprocessedPaths.length === 0) {
    return null;
  }

  const isRunning = queued > 0 && !paused;
  const task = current ? t(`library.aiJobs.kinds.${current.kind}`) : null;
  const statusLabel = paused
    ? current
      ? t('library.aiJobs.pausing')
      : t('library.aiJobs.paused', { remaining: queued })
    : task && current?.maskName
      ? t('library.aiJobs.taskWithMask', { task, mask: current.maskName })
      : (task ?? t('library.aiJobs.waiting'));
  const total = completed + queued;
  const buttonTooltip =
    queued > 0
      ? [
          statusLabel,
          !paused && current ? fileName(current.path) : null,
          t('library.aiJobs.progress', { current: completed, total }),
        ]
          .filter(Boolean)
          .join(' · ')
      : failed.length > 0
        ? t('library.aiJobs.failed', { failedCount: failed.length })
        : t('library.aiJobs.unprocessed', { count: unprocessedPaths.length });
  const hiddenJobs = Math.max(0, queuedPaths.length - MAX_LISTED_AI_JOBS);

  return (
    <div className="flex items-center bg-surface p-1 rounded-lg border border-border-color/20">
      <DropdownMenu
        buttonTitle={buttonTooltip}
        contentClassName="w-80"
        buttonContent={
          <>
            {isRunning ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : paused ? (
              <Pause className="w-5 h-5" />
            ) : (
              <ListTodo className="w-5 h-5" />
            )}
            {(failed.length > 0 || !isRunning) && (
              <div
                className={clsx(
                  'absolute top-1 right-1 rounded-full w-2.5 h-2.5',
                  failed.length > 0 ? 'bg-red-500' : 'bg-accent',
                )}
              />
            )}
          </>
        }
      >
        <div className="py-3 flex flex-col gap-3">
          <div className="px-4 flex items-center gap-1 h-8">
            <Text
              as="div"
              variant={TextVariants.small}
              weight={TextWeights.semibold}
              className="flex-1 truncate uppercase"
            >
              {t('library.aiJobs.title')}
            </Text>
            {queued > 0 && (
              <>
                <button
                  className={AI_JOB_ICON_BUTTON_CLASS}
                  onClick={() => invoke(paused ? Invokes.ResumeAiJobs : Invokes.PauseAiJobs)}
                  data-tooltip={paused ? t('library.aiJobs.resume') : t('library.aiJobs.pause')}
                >
                  {paused ? <Play size={16} /> : <Pause size={16} />}
                </button>
                <button
                  className={AI_JOB_ICON_BUTTON_CLASS}
                  onClick={() => invoke(Invokes.DiscardAiJobs)}
                  data-tooltip={t('library.aiJobs.discard')}
                >
                  <X size={16} />
                </button>
              </>
            )}
          </div>

          <AnimatePresence initial={false}>
            {queued > 0 && (
              <motion.div key="queue" className="overflow-hidden flex flex-col gap-3" {...AI_JOB_COLLAPSE_ANIMATION}>
                <div className="px-4 space-y-2">
                  <Text as="div" color={TextColors.primary} className="truncate">
                    {statusLabel}
                  </Text>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-1 rounded-full bg-bg-primary overflow-hidden">
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                        style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
                      />
                    </div>
                    <Text
                      as="span"
                      variant={TextVariants.small}
                      color={TextColors.secondary}
                      className="shrink-0 w-16 text-right tabular-nums"
                    >
                      {t('library.aiJobs.progress', { current: completed, total })}
                    </Text>
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <Text
                    as="div"
                    variant={TextVariants.small}
                    weight={TextWeights.semibold}
                    className="px-4 py-1 uppercase"
                  >
                    {t('library.aiJobs.queue')}
                  </Text>
                  <div className="max-h-64 overflow-y-auto custom-scrollbar flex flex-col px-1">
                    <AnimatePresence initial={false}>
                      {queuedPaths.slice(0, MAX_LISTED_AI_JOBS).map((path) => {
                        const isCurrent = current?.path === path;
                        return (
                          <AiJobRow key={path} path={path} active={isCurrent}>
                            {isCurrent && !paused ? (
                              <Loader2 size={14} className="animate-spin text-text-secondary" />
                            ) : (
                              <Text
                                as="span"
                                variant={TextVariants.small}
                                color={TextColors.secondary}
                                className="truncate"
                              >
                                {paused ? t('library.aiJobs.pausedItem') : t('library.aiJobs.queuedItem')}
                              </Text>
                            )}
                          </AiJobRow>
                        );
                      })}
                    </AnimatePresence>
                    {hiddenJobs > 0 && (
                      <Text as="div" variant={TextVariants.small} color={TextColors.secondary} className="px-4 py-1">
                        {t('library.aiJobs.more', { moreCount: hiddenJobs })}
                      </Text>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {failed.length > 0 && (
            <div className="flex flex-col gap-1 pt-3 border-t border-border-color/40">
              <div className="px-4 flex items-center gap-3 h-8">
                <Text
                  as="div"
                  variant={TextVariants.small}
                  weight={TextWeights.semibold}
                  color={TextColors.error}
                  className="flex-1 truncate uppercase"
                >
                  {t('library.aiJobs.failed', { failedCount: failed.length })}
                </Text>
                <button
                  className={AI_JOB_ICON_BUTTON_CLASS}
                  onClick={() => invoke(Invokes.RetryFailedAiJobs)}
                  data-tooltip={t('library.aiJobs.retry')}
                >
                  <RotateCcw size={16} />
                </button>
              </div>
              <div className="max-h-40 overflow-y-auto custom-scrollbar flex flex-col px-1">
                <AnimatePresence initial={false}>
                  {failed.slice(0, MAX_LISTED_AI_JOBS).map((job) => (
                    <AiJobRow key={job.path} path={job.path}>
                      <span data-tooltip={job.error} className="text-red-400">
                        <AlertTriangle size={14} />
                      </span>
                    </AiJobRow>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          )}

          {unprocessedPaths.length > 0 && (
            <div className="px-4 pt-3 flex items-center gap-3 border-t border-border-color/40">
              <CircleDashed size={16} className="shrink-0 text-text-secondary" />
              <Text as="div" color={TextColors.secondary} className="flex-1 min-w-0">
                {t('library.aiJobs.unprocessed', { count: unprocessedPaths.length })}
              </Text>
              <button
                className={AI_JOB_ICON_BUTTON_CLASS}
                onClick={() => invoke(Invokes.QueueAiJobs, { paths: unprocessedPaths })}
                data-tooltip={t('library.aiJobs.process')}
              >
                <Play size={16} />
              </button>
            </div>
          )}
        </div>
      </DropdownMenu>
    </div>
  );
}
