import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Loader2, X, SlidersHorizontal, HelpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useLibraryStore } from '../../../store/useLibraryStore';
import {
  FilterCriteria,
  RawStatus,
  EditedStatus,
  FlagStatus,
  SortCriteria,
  SortDirection,
} from '../../../types/library';
import {
  LibraryViewMode,
  ExifOverlay,
  GroupingMode,
  ThumbnailSize,
  ThumbnailAspectRatio,
} from '../../../types/settings';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import Button from '../../ui/Button';
import Switch from '../../ui/Switch';
import Dropdown from '../../ui/Dropdown';
import SegmentedControl from '../../ui/SegmentedControl';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useUIStore } from '../../../store/useUIStore';
import { ADVANCED_QUERY_REGEX } from '../../../hooks/useSortedLibrary';
import { useShortcut } from '../../../hooks/useShortcuts';
import {
  ColorLabelFilter,
  RatingSegmentedSwitch,
  SIZE_GLYPHS,
  SortOrderButton,
  ViewOptionSection,
} from './ViewOptionControls';

function DropdownMenu({ buttonContent, buttonTitle, children, contentClassName = 'w-56' }: any) {
  const [isOpen, setOpen] = useState(false);
  const dropdownRef = useRef<any>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: any) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        aria-expanded={isOpen}
        aria-haspopup="true"
        className="h-12 w-12 bg-surface text-text-primary shadow-none p-0 flex items-center justify-center"
        onClick={() => setOpen(!isOpen)}
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

export function SearchInput({ indexingProgress, isIndexing }: any) {
  const { t } = useTranslation();
  const searchShortcut = useShortcut('focus_search');
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
        {...searchShortcut}
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
  thumbnailSizeOptions: Array<{ id: ThumbnailSize; size: number }>;
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

  const thumbnailSizeSwitchOptions = useMemo(
    () =>
      thumbnailSizeOptions.map((option, index) => ({
        id: option.id,
        label: `${option.size}px`,
        icon: SIZE_GLYPHS[index],
      })),
    [thumbnailSizeOptions],
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

  const lastClickedColor = useRef<string | null>(null);

  const metadataOptions = useMemo(
    () => [
      { id: ExifOverlay.Off, label: t('library.header.viewOptions.metadataOff') },
      { id: ExifOverlay.Hover, label: t('library.header.viewOptions.metadataHover') },
      { id: ExifOverlay.Always, label: t('library.header.viewOptions.metadataAlways') },
    ],
    [t],
  );

  return (
    <DropdownMenu
      buttonContent={
        <>
          <SlidersHorizontal className="w-8 h-8" />
          {isFilterActive && <div className="absolute -top-1 -right-1 bg-accent rounded-full w-3 h-3" />}
        </>
      }
      buttonTitle={t('library.header.viewOptions.title')}
      contentClassName="library-view-options-menu w-[840px]"
    >
      <div className="library-view-options-content flex">
        <div className="library-view-options-section w-1/2 py-4 px-2 border-r border-border-color space-y-5">
          <ViewOptionSection
            title={t('library.header.viewOptions.sortBy')}
            action={
              <SortOrderButton
                order={sortCriteria.order}
                onToggle={() =>
                  setSortCriteria((prev: SortCriteria) => ({
                    ...prev,
                    order: prev.order === SortDirection.Ascending ? SortDirection.Descending : SortDirection.Ascending,
                  }))
                }
              />
            }
          >
            <Dropdown
              options={sortOptions.map((opt) => ({ value: opt.key, label: opt.label, disabled: opt.disabled }))}
              value={sortCriteria.key}
              onChange={(val) => setSortCriteria((prev: SortCriteria) => ({ ...prev, key: val }))}
              triggerClassName="bg-bg-primary w-full"
            />
          </ViewOptionSection>

          <ViewOptionSection title={t('library.header.viewOptions.thumbnailSize')}>
            <SegmentedControl
              tone="subtle"
              options={thumbnailSizeSwitchOptions}
              value={thumbnailSize}
              onChange={onSelectSize}
              iconOnly
            />
          </ViewOptionSection>

          <ViewOptionSection title={t('library.header.viewOptions.thumbnailFit')}>
            <SegmentedControl
              tone="subtle"
              options={thumbnailAspectRatioOptions}
              value={thumbnailAspectRatio}
              onChange={onSelectAspectRatio}
            />
          </ViewOptionSection>

          <ViewOptionSection title={t('library.header.viewOptions.displayMode')}>
            <SegmentedControl
              tone="subtle"
              options={[
                { id: LibraryViewMode.Flat, label: t('library.header.viewOptions.currentFolder') },
                { id: LibraryViewMode.Recursive, label: t('library.header.viewOptions.recursive') },
              ]}
              value={libraryViewMode}
              onChange={async (val) => {
                setLibraryViewMode(val);
                if (appSettings) {
                  await handleSettingsChange({ ...appSettings, libraryViewMode: val });
                  onLibraryRefresh?.();
                }
              }}
            />
          </ViewOptionSection>

          <ViewOptionSection title={t('library.header.viewOptions.showMetadata')}>
            <SegmentedControl
              tone="subtle"
              options={metadataOptions}
              value={appSettings?.exifOverlay || ExifOverlay.Off}
              onChange={(val) => handleSettingsChange({ ...appSettings!, exifOverlay: val })}
            />
          </ViewOptionSection>
        </div>

        <div className="library-view-options-section w-1/2 py-4 px-2 space-y-5">
          <ViewOptionSection title={t('library.header.viewOptions.filterByRating')}>
            <RatingSegmentedSwitch
              rating={filterCriteria.rating}
              operator={filterCriteria.ratingOperator ?? 'gte'}
              onOperatorChange={(op) => setFilterCriteria((prev: FilterCriteria) => ({ ...prev, ratingOperator: op }))}
              onChange={(val) => setFilterCriteria((prev: FilterCriteria) => ({ ...prev, rating: val }))}
              ratingFilterOptions={ratingFilterOptions}
            />
          </ViewOptionSection>

          <ViewOptionSection title={t('library.header.viewOptions.filterByFileType')}>
            <SegmentedControl
              tone="subtle"
              options={rawStatusOptions.map((o) => ({ id: o.key, label: o.label }))}
              value={filterCriteria.rawStatus || RawStatus.All}
              onChange={(val) => setFilterCriteria((prev: FilterCriteria) => ({ ...prev, rawStatus: val }))}
            />
          </ViewOptionSection>

          <ViewOptionSection title={t('library.header.viewOptions.filterByEdited', 'Filter by Edit Status')}>
            <SegmentedControl
              tone="subtle"
              options={editedStatusOptions.map((o) => ({ id: o.key, label: o.label }))}
              value={filterCriteria.editedStatus || EditedStatus.All}
              onChange={(val) => setFilterCriteria((prev: FilterCriteria) => ({ ...prev, editedStatus: val }))}
            />
          </ViewOptionSection>

          <ViewOptionSection title={t('library.header.viewOptions.filterByFlag')}>
            <SegmentedControl
              tone="subtle"
              options={flagStatusOptions.map((o) => ({ id: o.key, label: o.label }))}
              value={filterCriteria.flagStatus || FlagStatus.All}
              onChange={(val) => setFilterCriteria((prev: FilterCriteria) => ({ ...prev, flagStatus: val }))}
            />
          </ViewOptionSection>

          <ViewOptionSection title={t('library.header.viewOptions.groupRawJpeg')}>
            <SegmentedControl
              tone="subtle"
              options={groupingOptionKeys.map((o) => ({ id: o.key, label: t(o.labelKey) }))}
              value={groupingMode}
              onChange={async (val) => {
                if (appSettings) {
                  await handleSettingsChange({ ...appSettings, grouping: val });
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
          </ViewOptionSection>

          <ViewOptionSection title={t('library.header.viewOptions.filterByColorLabel')} bodyClassName="px-3">
            <ColorLabelFilter
              value={filterCriteria.colors || []}
              lastClicked={lastClickedColor}
              onChange={(colors) => setFilterCriteria((prev: FilterCriteria) => ({ ...prev, colors }))}
            />
          </ViewOptionSection>
        </div>
      </div>
    </DropdownMenu>
  );
}
