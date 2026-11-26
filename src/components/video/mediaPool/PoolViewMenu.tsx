import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { SlidersHorizontal } from 'lucide-react';
import Dropdown from '../../ui/Dropdown';
import SegmentedControl from '../../ui/SegmentedControl';
import {
  ColorLabelFilter,
  RatingSegmentedSwitch,
  SIZE_GLYPHS,
  SortOrderButton,
  ViewOptionSection,
} from '../../panel/library/ViewOptionControls';
import { usePopover } from '../../../hooks/usePopover';
import { FlagStatus, SortDirection } from '../../../types/library';
import { MediaKind, MediaPoolGroup, MediaPoolSort, MediaPoolTileSize } from '../../../types/video';
import {
  PoolFilters,
  isPoolFiltered,
  resetPoolFilters,
  setPoolFilters,
  updatePoolSettings,
  usePoolSettings,
  usePoolView,
} from './poolView';

const MENU_WIDTH = 380;
const SORTS: Array<MediaPoolSort> = ['imported', 'name', 'date', 'duration', 'type'];
const GROUPS: Array<MediaPoolGroup> = ['none', 'type', 'folder'];
const KINDS: Array<MediaKind> = ['video', 'image', 'audio', 'sequence'];
const SIZES: Array<{ id: MediaPoolTileSize; glyph: number }> = [
  { id: 'small', glyph: 0 },
  { id: 'medium', glyph: 2 },
  { id: 'large', glyph: 4 },
];

function PoolViewMenu() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { anchorRef, popoverRef, placement, room } = usePopover(isOpen, close, MENU_WIDTH);
  const view = usePoolSettings();
  const filters = usePoolView((state) => state.filters);
  const isFiltered = isPoolFiltered(filters);
  const lastClickedColor = useRef<string | null>(null);

  const options = useMemo(
    () => ({
      sorts: SORTS.map((value) => ({ value, label: t(`video.mediaPool.sort.${value}`) })),
      groups: GROUPS.map((id) => ({ id, label: t(`video.mediaPool.group.${id}`) })),
      sizes: SIZES.map(({ id, glyph }) => ({ id, label: t(`video.mediaPool.sizes.${id}`), icon: SIZE_GLYPHS[glyph] })),
      show: [
        { id: 'all' as const, label: t('video.mediaPool.all') },
        { id: 'unused' as const, label: t('video.mediaPool.unused') },
      ],
      kinds: [
        { id: 'all' as const, label: t('video.mediaPool.all') },
        ...KINDS.map((id) => ({ id, label: t(`video.mediaPool.kinds.${id}`) })),
      ],
      flags: [
        { id: FlagStatus.All, label: t('video.mediaPool.all') },
        { id: FlagStatus.Picked, label: t('library.filters.flag.picked') },
        { id: FlagStatus.Rejected, label: t('library.filters.flag.rejected') },
      ],
      ratings: [
        { value: 0, label: t('library.filters.rating.all') },
        { value: -1, label: t('library.filters.rating.unrated') },
      ],
    }),
    [t],
  );

  const filter =
    <K extends keyof PoolFilters>(key: K) =>
    (value: PoolFilters[K]) =>
      setPoolFilters({ [key]: value });

  return (
    <div ref={anchorRef} className="relative shrink-0">
      <button
        type="button"
        className={clsx(
          'relative h-9 w-9 flex items-center justify-center rounded-md bg-surface text-text-primary hover:bg-card-active transition-colors',
          isOpen && 'bg-card-active',
        )}
        onClick={() => setIsOpen(!isOpen)}
        data-tooltip={isOpen ? undefined : t('library.header.viewOptions.title')}
        aria-label={t('library.header.viewOptions.title')}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <SlidersHorizontal size={18} />
        {isFiltered && <div className="absolute -top-0.5 -right-0.5 bg-accent rounded-full w-2.5 h-2.5" />}
      </button>
      {createPortal(
        <AnimatePresence>
          {isOpen && (
            <motion.div
              ref={popoverRef}
              className="fixed z-60 bg-surface/90 backdrop-blur-md rounded-lg shadow-xl"
              style={{ ...placement, width: MENU_WIDTH }}
              role="menu"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.1, ease: 'easeOut' }}
            >
              <div
                className="py-4 px-2 space-y-4 overflow-y-auto custom-scrollbar"
                style={{ maxHeight: room || undefined }}
              >
                <ViewOptionSection
                  title={t('library.header.viewOptions.sortBy')}
                  action={
                    <SortOrderButton
                      order={view.order}
                      onToggle={() =>
                        updatePoolSettings({
                          order:
                            view.order === SortDirection.Ascending ? SortDirection.Descending : SortDirection.Ascending,
                        })
                      }
                    />
                  }
                >
                  <Dropdown
                    options={options.sorts}
                    value={view.sort}
                    onChange={(sort) => updatePoolSettings({ sort })}
                    triggerClassName="bg-bg-primary w-full"
                  />
                </ViewOptionSection>

                <ViewOptionSection title={t('video.mediaPool.groupBy')}>
                  <SegmentedControl
                    tone="subtle"
                    options={options.groups}
                    value={view.group}
                    onChange={(group) => updatePoolSettings({ group })}
                  />
                </ViewOptionSection>

                <ViewOptionSection title={t('library.header.viewOptions.thumbnailSize')}>
                  <SegmentedControl
                    tone="subtle"
                    options={options.sizes}
                    value={view.size}
                    onChange={(size) => updatePoolSettings({ size })}
                    iconOnly
                  />
                </ViewOptionSection>

                <div className="mx-3 border-t border-border-color" />

                <ViewOptionSection
                  title={t('video.mediaPool.show')}
                  action={
                    isFiltered && (
                      <button
                        type="button"
                        className="absolute top-1/2 right-3 -translate-y-1/2 px-1 rounded-sm text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
                        onClick={resetPoolFilters}
                      >
                        {t('video.mediaPool.resetFilters')}
                      </button>
                    )
                  }
                >
                  <SegmentedControl
                    tone="subtle"
                    options={options.show}
                    value={filters.show}
                    onChange={filter('show')}
                  />
                </ViewOptionSection>

                <ViewOptionSection title={t('video.mediaPool.filterByType')}>
                  <SegmentedControl
                    tone="subtle"
                    options={options.kinds}
                    value={filters.kind}
                    onChange={filter('kind')}
                  />
                </ViewOptionSection>

                <ViewOptionSection title={t('library.header.viewOptions.filterByRating')}>
                  <RatingSegmentedSwitch
                    rating={filters.rating}
                    operator={filters.ratingOperator}
                    ratingFilterOptions={options.ratings}
                    onChange={filter('rating')}
                    onOperatorChange={filter('ratingOperator')}
                  />
                </ViewOptionSection>

                <ViewOptionSection title={t('library.header.viewOptions.filterByFlag')}>
                  <SegmentedControl
                    tone="subtle"
                    options={options.flags}
                    value={filters.flag}
                    onChange={filter('flag')}
                  />
                </ViewOptionSection>

                <ViewOptionSection title={t('library.header.viewOptions.filterByColorLabel')} bodyClassName="px-3">
                  <ColorLabelFilter value={filters.colors} lastClicked={lastClickedColor} onChange={filter('colors')} />
                </ViewOptionSection>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

export default memo(PoolViewMenu);
