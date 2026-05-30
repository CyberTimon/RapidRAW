import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
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
import { useLibraryStore } from '../../../store/useLibraryStore';
import {
  FilterCriteria,
  RawStatus,
  LibraryViewMode,
  SortCriteria,
  SortDirection,
  ExifOverlay,
} from '../../ui/AppProperties';
import { COLOR_LABELS, Color } from '../../../utils/adjustments';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights, TEXT_COLOR_KEYS } from '../../../types/typography';
import Button from '../../ui/Button';
import { useSettingsStore } from '../../../store/useSettingsStore';
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

export function ViewOptionsDropdown({
  libraryViewMode,
  onSelectSize,
  onSelectAspectRatio,
  setLibraryViewMode,
  thumbnailSize,
  thumbnailAspectRatio,
  thumbnailSizeOptions,
  thumbnailAspectRatioOptions,
  ratingFilterOptions,
  rawStatusOptions,
  editedStatusOptions,
  sortOptions,
}: any) {
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

  const isFilterActive =
    filterCriteria.rating !== 0 ||
    (filterCriteria.rawStatus && filterCriteria.rawStatus !== RawStatus.All) ||
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
      contentClassName="library-view-options-menu w-[720px]"
    >
      <div className="library-view-options-content flex">
        <div className="library-view-options-section w-1/4 p-2 border-r border-border-color">
          <>
            <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
              {t('library.header.viewOptions.thumbnailSize')}
            </Text>
            {thumbnailSizeOptions.map((option: any) => {
              const isSelected = thumbnailSize === option.id;
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
                  {isSelected && <Check size={16} className={TEXT_COLOR_KEYS[TextColors.primary]} />}
                </button>
              );
            })}
          </>

          <div className="pt-2">
            <>
              <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
                {t('library.header.viewOptions.thumbnailFit')}
              </Text>
              {thumbnailAspectRatioOptions.map((option: any) => {
                const isSelected = thumbnailAspectRatio === option.id;
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
                    {isSelected && <Check size={16} className={TEXT_COLOR_KEYS[TextColors.primary]} />}
                  </button>
                );
              })}
            </>
          </div>

          <div className="pt-2">
            <>
              <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
                {t('library.header.viewOptions.displayMode')}
              </Text>
              <button
                className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
                  libraryViewMode === LibraryViewMode.Flat ? 'bg-card-active' : 'hover:bg-bg-primary'
                }`}
                onClick={() => setLibraryViewMode(LibraryViewMode.Flat)}
                role="menuitem"
              >
                <Text
                  variant={TextVariants.label}
                  color={TextColors.primary}
                  weight={libraryViewMode === LibraryViewMode.Flat ? TextWeights.semibold : TextWeights.normal}
                >
                  {t('library.header.viewOptions.currentFolder')}
                </Text>
                {libraryViewMode === LibraryViewMode.Flat && (
                  <Check size={16} className={TEXT_COLOR_KEYS[TextColors.primary]} />
                )}
              </button>
              <button
                className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
                  libraryViewMode === LibraryViewMode.Recursive ? 'bg-card-active' : 'hover:bg-bg-primary'
                }`}
                onClick={() => setLibraryViewMode(LibraryViewMode.Recursive)}
                role="menuitem"
              >
                <Text
                  variant={TextVariants.label}
                  color={TextColors.primary}
                  weight={libraryViewMode === LibraryViewMode.Recursive ? TextWeights.semibold : TextWeights.normal}
                >
                  {t('library.header.viewOptions.recursive')}
                </Text>
                {libraryViewMode === LibraryViewMode.Recursive && (
                  <Check size={16} className={TEXT_COLOR_KEYS[TextColors.primary]} />
                )}
              </button>
            </>
          </div>

          <div className="pt-2">
            <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
              {t('library.header.viewOptions.showMetadata')}
            </Text>
            {metadataOptions.map((option) => {
              const isSelected = (appSettings?.exifOverlay || ExifOverlay.Off) === option.id;
              return (
                <button
                  key={option.id}
                  className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
                    isSelected ? 'bg-card-active' : 'hover:bg-bg-primary'
                  }`}
                  onClick={() => handleSettingsChange({ ...appSettings!, exifOverlay: option.id })}
                >
                  <Text
                    variant={TextVariants.label}
                    color={TextColors.primary}
                    weight={isSelected ? TextWeights.semibold : TextWeights.normal}
                  >
                    {option.label}
                  </Text>
                  {isSelected && <Check size={16} className={TEXT_COLOR_KEYS[TextColors.primary]} />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="library-view-options-section w-2/4 p-2 border-r border-border-color">
          <div className="space-y-4">
            <div>
              <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
                {t('library.header.viewOptions.filterByRating')}
              </Text>

              {ratingFilterOptions
                .filter((option: any) => option.value <= 0)
                .map((option: any) => {
                  const isSelected = filterCriteria.rating === option.value;
                  return (
                    <button
                      className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
                        isSelected ? 'bg-card-active' : 'hover:bg-bg-primary'
                      }`}
                      key={option.value}
                      onClick={() =>
                        setFilterCriteria((prev: Partial<FilterCriteria>) => ({ ...prev, rating: option.value }))
                      }
                      role="menuitem"
                    >
                      <Text
                        variant={TextVariants.label}
                        color={TextColors.primary}
                        weight={isSelected ? TextWeights.semibold : TextWeights.normal}
                      >
                        {option.label}
                      </Text>
                      {isSelected && <Check size={16} className={TEXT_COLOR_KEYS[TextColors.primary]} />}
                    </button>
                  );
                })}

              <div
                className={`w-full px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
                  filterCriteria.rating > 0 ? 'bg-card-active' : 'hover:bg-bg-primary'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    {[...Array(5)].map((_, index: number) => {
                      const starValue = index + 1;
                      const isFilled = filterCriteria.rating > 0 && starValue <= filterCriteria.rating;
                      const optionLabel = ratingFilterOptions.find((o: any) => o.value === starValue)?.label;

                      return (
                        <button
                          key={starValue}
                          onClick={(e) => {
                            e.stopPropagation();
                            setFilterCriteria((prev: Partial<FilterCriteria>) => ({
                              ...prev,
                              rating: prev.rating === starValue ? 0 : starValue,
                            }));
                          }}
                          className="focus:outline-hidden transition-transform hover:scale-110 flex items-center justify-center p-0.5"
                          data-tooltip={optionLabel}
                        >
                          <StarIcon
                            size={18}
                            className={`transition-colors duration-150 ${
                              isFilled ? 'text-accent fill-accent' : 'text-text-secondary hover:text-accent'
                            }`}
                          />
                        </button>
                      );
                    })}
                  </div>
                  <Text variant={TextVariants.label} color={TextColors.secondary}>
                    {filterCriteria.rating === 5
                      ? t('library.filters.rating.onlySuffix')
                      : t('library.filters.rating.andUpSuffix')}
                  </Text>
                </div>
                {filterCriteria.rating > 0 && <Check size={16} className={TEXT_COLOR_KEYS[TextColors.primary]} />}
              </div>
            </div>

            <div>
              <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
                {t('library.header.viewOptions.filterByFileType')}
              </Text>
              {rawStatusOptions.map((option: any) => {
                const isSelected = (filterCriteria.rawStatus || RawStatus.All) === option.key;
                return (
                  <button
                    className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
                      isSelected ? 'bg-card-active' : 'hover:bg-bg-primary'
                    }`}
                    key={option.key}
                    onClick={() =>
                      setFilterCriteria((prev: Partial<FilterCriteria>) => ({ ...prev, rawStatus: option.key }))
                    }
                    role="menuitem"
                  >
                    <Text
                      variant={TextVariants.label}
                      color={TextColors.primary}
                      weight={isSelected ? TextWeights.semibold : TextWeights.normal}
                    >
                      {option.label}
                    </Text>
                    {isSelected && <Check size={16} className={TEXT_COLOR_KEYS[TextColors.primary]} />}
                  </button>
                );
              })}
            </div>

            <div>
              <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
                {t('library.header.viewOptions.filterByEdited', 'Filter by Edit Status')}
              </Text>
              {editedStatusOptions.map((option: any) => {
                const isSelected = (filterCriteria.editedStatus || EditedStatus.All) === option.key;
                return (
                  <button
                    className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
                      isSelected ? 'bg-card-active' : 'hover:bg-bg-primary'
                    }`}
                    key={option.key}
                    onClick={() =>
                      setFilterCriteria((prev: Partial<FilterCriteria>) => ({ ...prev, editedStatus: option.key }))
                    }
                    role="menuitem"
                  >
                    <Text
                      variant={TextVariants.label}
                      color={TextColors.primary}
                      weight={isSelected ? TextWeights.semibold : TextWeights.normal}
                    >
                      {option.label}
                    </Text>
                    {isSelected && <Check size={16} className={TEXT_COLOR_KEYS[TextColors.primary]} />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="py-2"></div>

          <div>
            <Text as="div" variant={TextVariants.small} weight={TextWeights.semibold} className="px-3 py-2 uppercase">
              {t('library.header.viewOptions.filterByColorLabel')}
            </Text>
            <div className="flex flex-wrap gap-3 px-3 py-2">
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
                    className="w-6 h-6 rounded-full focus:outline-hidden focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-surface transition-transform hover:scale-110"
                    role="menuitem"
                  >
                    <div className="relative w-full h-full">
                      <div className="w-full h-full rounded-full" style={{ backgroundColor: color.color }}></div>
                      {isSelected && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-full">
                          <Check size={14} className={TEXT_COLOR_KEYS[TextColors.white]} />
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="library-view-options-section w-1/4 p-2">
          <>
            <div className="px-3 py-2 relative flex items-center">
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
                className="absolute top-1/2 right-3 -translate-y-1/2 p-1 bg-transparent border-none text-text-secondary hover:text-text-primary rounded-sm"
              >
                {sortCriteria.order === SortDirection.Ascending ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            </div>
            {sortOptions.map((option: any) => {
              const isSelected = sortCriteria.key === option.key;
              return (
                <button
                  className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors duration-150 ${
                    isSelected ? 'bg-card-active' : 'hover:bg-bg-primary'
                  } ${option.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                  key={option.key}
                  onClick={() =>
                    !option.disabled && setSortCriteria((prev: SortCriteria) => ({ ...prev, key: option.key }))
                  }
                  role="menuitem"
                  disabled={option.disabled}
                  data-tooltip={option.disabled ? t('library.header.viewOptions.exifDisabledTooltip') : undefined}
                >
                  <Text
                    variant={TextVariants.label}
                    color={TextColors.primary}
                    weight={isSelected ? TextWeights.semibold : TextWeights.normal}
                  >
                    {option.label}
                  </Text>
                  {isSelected && <Check size={16} className={TEXT_COLOR_KEYS[TextColors.primary]} />}
                </button>
              );
            })}
          </>
        </div>
      </div>
    </DropdownMenu>
  );
}
