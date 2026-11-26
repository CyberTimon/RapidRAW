import { Star, Copy, ClipboardPaste, Check, Settings, Filter, PanelLeft, PanelRight } from 'lucide-react';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';

import Filmstrip from './Filmstrip';
import ViewerZoom from './ViewerZoom';
import Timeline from '../video/timeline/Timeline';
import { useVideoKind } from '../../store/videoIntegration';
import { ImageFile, ImageFlag } from '../../types/library';
import { SelectedImage } from '../../types/editor';
import { ThumbnailAspectRatio } from '../../types/settings';
import FlagToggles from './library/FlagToggles';
import Text from '../ui/Text';
import { useLibraryActions } from '../../hooks/useLibraryActions';
import { useShortcut, useShortcuts } from '../../hooks/useShortcuts';
import type { ShortcutAction } from '../../utils/keyboardUtils';
import { isFilmstripDocked, toggleBottomPanel, toggleSidePanel, useUIStore } from '../../store/useUIStore';
import { Panel } from '../../types/ui';
import { PanelTabButton } from './PanelSwitcher';
import { QuickFilterControls, useQuickFilterToggle } from './QuickFilter';

interface BottomBarProps {
  filmstripHeight?: number;
  imageList?: Array<ImageFile>;
  imageRatings?: Record<string, number> | null;
  isCopied: boolean;
  isCopyDisabled: boolean;
  isExportDisabled?: boolean;
  isFilmstripVisible?: boolean;
  isLibraryView?: boolean;
  isLoading?: boolean;
  isPasted: boolean;
  isPasteDisabled: boolean;
  isRatingDisabled?: boolean;
  flag?: ImageFlag | null;
  isResetDisabled?: boolean;
  isResizing?: boolean;
  multiSelectedPaths?: Array<string>;
  onClearSelection?(): void;
  onContextMenu?(event: any, path: string): void;
  onEmptyAreaContextMenu?(event: any): void;
  onCopy(): void;
  onExportClick?(): void;
  onImageSelect?(path: string, event: any): void;
  onOpenCopyPasteSettings?(): void;
  onRequestThumbnails?(paths: string[]): void;
  onPaste(): void;
  onRate(rate: number): void;
  onReset?(): void;
  onZoomChange?(zoomValue: number, fitToWindow?: boolean): void;
  rating: number;
  selectedImage?: SelectedImage;
  showFilmstrip?: boolean;
  layoutMode: 'compact' | 'wide' | 'full';
  showZoomControls?: boolean;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  totalImages?: number;
}

const PRIORITY = {
  counter: ['@max-[52rem]:hidden', '@max-[39rem]:hidden'],
  filter: ['@max-[43rem]:hidden', '@max-[30rem]:hidden'],
  gear: ['@max-[40rem]:hidden', '@max-[27rem]:hidden'],
  flags: ['@max-[37rem]:hidden', '@max-[24rem]:hidden'],
  copy: ['@max-[34rem]:hidden', '@max-[21rem]:hidden'],
} as const;

const COLLAPSED_TIMELINE_HEIGHT = 56;

interface StarRatingProps {
  disabled: boolean;
  onRate(rate: number): void;
  rating: number;
}

const StarRating = ({ rating, onRate, disabled }: StarRatingProps) => {
  const { t } = useTranslation();
  const shortcut = useShortcuts();

  return (
    <div className={clsx('flex items-center gap-1', disabled && 'cursor-not-allowed')}>
      {[...Array(5)].map((_, index: number) => {
        const starValue = index + 1;
        return (
          <button
            className="disabled:cursor-not-allowed"
            disabled={disabled}
            key={starValue}
            onClick={() => !disabled && onRate(starValue)}
            data-tooltip={
              disabled
                ? t('ui.bottomBar.tooltips.selectToRate')
                : t('ui.bottomBar.tooltips.rateStars', { count: starValue })
            }
            {...shortcut(disabled ? null : `rate_${starValue}`)}
          >
            <Star
              size={18}
              className={clsx(
                'transition-colors duration-150',
                disabled
                  ? 'text-text-secondary opacity-40'
                  : starValue <= rating
                    ? 'fill-accent text-accent'
                    : 'text-text-secondary hover:text-accent',
              )}
            />
          </button>
        );
      })}
    </div>
  );
};

interface PanelToggleButtonProps {
  onClick: () => void;
  Icon: React.ElementType;
  tooltip: string;
  disabled?: boolean;
  shortcut: ShortcutAction;
}

const PanelToggleButton = ({ onClick, Icon, tooltip, disabled = false, shortcut }: PanelToggleButtonProps) => {
  const shortcutProps = useShortcut(disabled ? null : shortcut);
  return (
    <button
      className={clsx(
        'p-1.5 rounded-md transition-colors',
        disabled
          ? 'text-text-secondary opacity-40 cursor-not-allowed'
          : 'text-text-secondary hover:bg-surface hover:text-text-primary',
      )}
      onClick={() => !disabled && onClick()}
      disabled={disabled}
      data-tooltip={tooltip}
      {...shortcutProps}
    >
      <Icon size={18} />
    </button>
  );
};

export default function BottomBar({
  filmstripHeight,
  imageList = [],
  imageRatings,
  isCopied,
  isCopyDisabled,
  isFilmstripVisible,
  isLibraryView = false,
  isLoading = false,
  isPasted,
  isPasteDisabled,
  isRatingDisabled = false,
  flag = null,
  isResizing,
  multiSelectedPaths = [],
  onClearSelection,
  onContextMenu,
  onEmptyAreaContextMenu,
  onCopy,
  onImageSelect,
  onOpenCopyPasteSettings,
  onRequestThumbnails,
  onPaste,
  onRate,
  onZoomChange = () => {},
  rating,
  selectedImage,
  showFilmstrip = true,
  layoutMode,
  showZoomControls = true,
  thumbnailAspectRatio,
  totalImages,
}: BottomBarProps) {
  const { t } = useTranslation();
  const shortcut = useShortcuts();
  const { handleToggleFlag } = useLibraryActions();

  const { isInstantTransition, uiVisibility } = useUIStore(
    useShallow((state) => ({
      isInstantTransition: state.isInstantTransition,
      uiVisibility: state.uiVisibility,
    })),
  );

  const isDocked = useUIStore(isFilmstripDocked);
  const isProjectSession = useVideoKind() === 'project';
  const hasVideoTimeline = isProjectSession && showFilmstrip;
  const hasBottomFilmstrip = hasVideoTimeline || (showFilmstrip && !(layoutMode === 'full' && isDocked));
  const isLeftOpen = uiVisibility.leftPanel;
  const isRightOpen = uiVisibility.rightPanel;
  const isBottomOpen = uiVisibility.filmstrip;
  const showLeftPanelToggle = layoutMode === 'full';
  const showRightPanelToggle = layoutMode === 'full' || layoutMode === 'wide';
  const showFilmstripTab = layoutMode !== 'compact' && hasBottomFilmstrip;
  const hasZoom = !isLibraryView && showZoomControls;
  const priority = (item: keyof typeof PRIORITY) => (isProjectSession ? undefined : PRIORITY[item][hasZoom ? 0 : 1]);
  const numSelected = multiSelectedPaths.length;
  const total = totalImages ?? 0;
  const showSelectionCounter = numSelected > 1;

  const { isExpanded: isFilterExpanded, toggle: toggleQuickFilter } = useQuickFilterToggle('quickFilter');
  const currentHeight = filmstripHeight ?? 120;
  const isCollapsed = !isFilmstripVisible;
  const effectiveHeight = isFilmstripVisible ? currentHeight : hasVideoTimeline ? COLLAPSED_TIMELINE_HEIGHT : 0;
  const shouldAnimate = !isInstantTransition && (!isResizing || isCollapsed);

  return (
    <div className="shrink-0 bg-bg-secondary rounded-lg flex flex-col">
      {!isLibraryView && hasBottomFilmstrip && (
        <div
          className={clsx(
            'overflow-hidden shrink-0 relative',
            shouldAnimate && 'transition-all duration-300 ease-in-out',
          )}
          style={{ height: `${effectiveHeight}px` }}
        >
          <div
            className={clsx(
              'w-full p-2 duration-300 ease-in-out',
              shouldAnimate ? 'transition-all' : 'transition-opacity',
              isCollapsed && !hasVideoTimeline ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto',
            )}
            style={{ height: `${currentHeight}px` }}
          >
            {hasVideoTimeline ? (
              <Timeline />
            ) : (
              <Filmstrip
                imageList={imageList}
                imageRatings={imageRatings}
                isLoading={isLoading}
                multiSelectedPaths={multiSelectedPaths}
                onClearSelection={onClearSelection}
                onContextMenu={onContextMenu}
                onEmptyAreaContextMenu={onEmptyAreaContextMenu}
                onImageSelect={onImageSelect}
                onRequestThumbnails={onRequestThumbnails}
                selectedImage={selectedImage}
                thumbnailAspectRatio={thumbnailAspectRatio}
              />
            )}
          </div>
        </div>
      )}

      {!hasVideoTimeline && (
        <div
          className={clsx(
            '@container shrink-0 h-12 flex items-center justify-between px-3',
            !isLibraryView && 'border-t transition-colors duration-300',
            !isLibraryView && hasBottomFilmstrip && isFilmstripVisible ? 'border-surface' : 'border-transparent',
          )}
        >
          <div className="flex flex-wrap items-center gap-3 h-8 min-w-0 overflow-hidden before:h-8 before:-mr-3 before:content-['']">
            <div className={isProjectSession ? 'hidden' : 'contents'}>
              <StarRating rating={rating} onRate={onRate} disabled={isRatingDisabled} />
              <FlagToggles
                flag={flag}
                onToggle={(option) => handleToggleFlag(option)}
                inactiveClassName="text-text-secondary hover:text-accent"
                disabled={isRatingDisabled}
                showShortcuts
                className={priority('flags')}
              />
              <div className={clsx('h-5 w-px bg-surface', priority('copy'))}></div>
            </div>
            <div className={clsx('flex items-center gap-2', priority('copy'))}>
              <button
                className="relative w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                disabled={isCopyDisabled}
                onClick={onCopy}
                data-tooltip={t('ui.bottomBar.tooltips.copySettings')}
                {...shortcut(isCopyDisabled ? null : ['video_copy_adjustments', 'copy_adjustments'])}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {isCopied ? (
                    <motion.div
                      key="copied"
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.5 }}
                      transition={{ duration: 0.15 }}
                      className="absolute"
                    >
                      <Check size={18} className="text-green-500" />
                    </motion.div>
                  ) : (
                    <motion.div
                      key="copy"
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.5 }}
                      transition={{ duration: 0.15 }}
                      className="absolute"
                    >
                      <Copy size={18} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </button>

              <button
                className="relative w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                disabled={isPasteDisabled}
                onClick={onPaste}
                data-tooltip={t('ui.bottomBar.tooltips.pasteSettings')}
                {...shortcut(isPasteDisabled ? null : 'paste_adjustments')}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {isPasted ? (
                    <motion.div
                      key="pasted"
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.5 }}
                      transition={{ duration: 0.15 }}
                      className="absolute"
                    >
                      <Check size={18} className="text-green-500" />
                    </motion.div>
                  ) : (
                    <motion.div
                      key="paste"
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.5 }}
                      transition={{ duration: 0.15 }}
                      className="absolute"
                    >
                      <ClipboardPaste size={18} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </button>

              <button
                className={clsx(
                  'w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors',
                  priority('gear'),
                )}
                onClick={onOpenCopyPasteSettings}
                data-tooltip={t('ui.bottomBar.tooltips.copyPasteSettings')}
              >
                <Settings size={18} />
              </button>
            </div>

            <div className={isProjectSession ? 'hidden' : 'contents'}>
              <div className={clsx('h-5 w-px bg-surface', priority('filter'))}></div>

              <div
                className={clsx(
                  'flex items-center grow basis-0 min-w-8 max-w-max transition-all duration-300',
                  isFilterExpanded ? 'bg-surface rounded-md' : 'bg-transparent',
                  priority('filter'),
                )}
              >
                <button
                  className={clsx(
                    'relative w-8 h-8 flex items-center justify-center rounded-md transition-colors shrink-0',
                    isFilterExpanded
                      ? 'text-text-primary'
                      : 'text-text-secondary hover:bg-surface hover:text-text-primary',
                  )}
                  onClick={toggleQuickFilter}
                  data-tooltip={t('ui.bottomBar.tooltips.quickFilter')}
                >
                  <Filter size={18} />
                </button>

                <div
                  className={clsx(
                    'flex items-center min-w-0 transition-all duration-300 ease-in-out overflow-hidden',
                    isFilterExpanded ? 'max-w-xl opacity-100 pr-2 ml-1' : 'max-w-0 opacity-0 pr-0 ml-0',
                  )}
                >
                  <QuickFilterControls className="flex flex-wrap items-center gap-3 h-8 overflow-hidden whitespace-nowrap before:h-8 before:-mr-3 before:content-['']" />
                </div>
              </div>

              <div
                className={clsx(
                  'flex items-center shrink-0 transition-all duration-300 ease-out overflow-hidden',
                  showSelectionCounter ? 'max-w-xs opacity-100' : 'max-w-0 opacity-0',
                  priority('counter'),
                )}
              >
                <div className="h-5 w-px bg-surface mr-3"></div>
                <Text as="span" className="whitespace-nowrap">
                  {t('ui.bottomBar.imagesSelected', { current: numSelected, total })}
                </Text>
              </div>
            </div>
          </div>

          <div className="flex-1 flex items-center justify-end gap-3">
            {!isLibraryView && showZoomControls && (
              <>
                <ViewerZoom className="flex-1 max-w-56" isLoading={isLoading} onZoomChange={onZoomChange} />

                <div className="h-5 w-px shrink-0 bg-surface"></div>
              </>
            )}

            <div className="flex items-center gap-1 shrink-0">
              {(showLeftPanelToggle || showRightPanelToggle) && (
                <>
                  {showLeftPanelToggle && (
                    <PanelToggleButton
                      onClick={() => toggleSidePanel('left')}
                      Icon={PanelLeft}
                      shortcut="toggle_left_panel"
                      tooltip={
                        isLeftOpen ? t('ui.bottomBar.tooltips.collapseLeft') : t('ui.bottomBar.tooltips.expandLeft')
                      }
                    />
                  )}

                  {showRightPanelToggle && (
                    <PanelToggleButton
                      onClick={() => toggleSidePanel('right')}
                      Icon={PanelRight}
                      shortcut="toggle_right_panel"
                      tooltip={
                        isRightOpen ? t('ui.bottomBar.tooltips.collapseRight') : t('ui.bottomBar.tooltips.expandRight')
                      }
                    />
                  )}
                </>
              )}
            </div>

            {showFilmstripTab && (
              <>
                <div className="h-5 w-px shrink-0 bg-surface"></div>
                <PanelTabButton
                  panel={Panel.Filmstrip}
                  isActive={isBottomOpen && !isLibraryView}
                  indicatorId="active-indicator-filmstrip"
                  onClick={toggleBottomPanel}
                  shortcut="toggle_bottom_panel"
                  isDraggable={layoutMode === 'full'}
                  isDisabled={isLibraryView}
                  isCompact
                  dragId={isLibraryView ? `layout-tab-${Panel.Filmstrip}-library` : undefined}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
