import {
  Folder,
  FolderOpen,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Search,
  X,
  Album as AlbumIcon,
  Plus,
  Plane,
  Mountain,
  Sun,
  Camera,
  Map,
  Heart,
  Star,
  Users,
  User,
  Car,
  Briefcase,
} from 'lucide-react';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import Text from '../ui/Text';
import { TEXT_COLOR_KEYS, TextColors, TextVariants, TextWeights } from '../../types/typography';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { AlbumItem, AlbumGroup, Album, Invokes } from '../ui/AppProperties';

export interface FolderTree {
  children: FolderTree[];
  isDir: boolean;
  name: string;
  path: string;
  imageCount?: number;
  hasSubdirs?: boolean;
}

interface FolderTreeProps {
  isResizing: boolean;
  isVisible: boolean;
  onContextMenu(event: any, path: string | null, isPinned?: boolean): void;
  onAlbumContextMenu(event: any, item: AlbumItem | null): void;
  onFolderSelect(folder: string): void;
  onSelectAlbum(albumId: string, albumName: string, images: string[]): void;
  onToggleFolder(folder: string): void;
  onOpenFolder(): void;
  setIsVisible(visible: boolean): void;
  style: any;
  isInstantTransition: boolean;
}

interface TreeNodeProps {
  expandedFolders: Set<string>;
  isExpanded: boolean;
  node: FolderTree;
  onContextMenu(event: any, path: string, isPinned?: boolean): void;
  onFolderSelect(folder: string): void;
  onToggle(path: string): void;
  selectedPath: string | null;
  pinnedFolders: string[];
  showImageCounts: boolean;
  isInstantTransition: boolean;
  folderIcons: Record<string, string>;
}

interface VisibleProps {
  index: number;
  total: number;
}

const ALBUM_ICONS: Record<string, React.ElementType> = {
  plane: Plane,
  mountain: Mountain,
  sun: Sun,
  camera: Camera,
  map: Map,
  heart: Heart,
  star: Star,
  users: Users,
  user: User,
  car: Car,
  briefcase: Briefcase,
};

const filterTree = (node: FolderTree | null, query: string): FolderTree | null => {
  if (!node) {
    return null;
  }

  const lowerCaseQuery = query.toLowerCase();
  const isMatch = node.name.toLowerCase().includes(lowerCaseQuery);

  if (!node.children || node.children.length === 0) {
    return isMatch ? node : null;
  }

  const filteredChildren = node.children
    .map((child: FolderTree) => filterTree(child, query))
    .filter((child: FolderTree | null): child is FolderTree => child !== null);

  if (isMatch || filteredChildren.length > 0) {
    return { ...node, children: filteredChildren };
  }

  return null;
};

const getAutoExpandedPaths = (node: FolderTree, paths: Set<string>) => {
  if (node.children && node.children.length > 0) {
    paths.add(node.path);
    node.children.forEach((child: FolderTree) => getAutoExpandedPaths(child, paths));
  }
};

function SectionHeader({ title, isOpen, onToggle }: { title: string; isOpen: boolean; onToggle: () => void }) {
  const { t } = useTranslation();

  return (
    <Text
      as="div"
      variant={TextVariants.small}
      weight={TextWeights.bold}
      className="flex items-center w-full px-1 py-1.5 cursor-pointer group"
      onClick={onToggle}
      data-tooltip={
        isOpen
          ? t('library.folders.collapseSection', { section: title })
          : t('library.folders.expandSection', { section: title })
      }
    >
      <div className="p-0.5 rounded-md transition-colors">
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </div>
      <span className="ml-1 uppercase tracking-wider select-none">{title}</span>
    </Text>
  );
}

function AlbumTreeNode({
  item,
  expandedGroups,
  onToggle,
  onSelectAlbum,
  onContextMenu,
  selectedAlbumId,
}: {
  item: AlbumItem;
  expandedGroups: Set<string>;
  onToggle: (id: string) => void;
  onSelectAlbum: (id: string, name: string, images: string[]) => void;
  onContextMenu: (e: any, item: AlbumItem) => void;
  selectedAlbumId: string | null;
}) {
  const isGroup = item.type === 'group';
  const isExpanded = expandedGroups.has(item.id);
  const isSelected = item.id === selectedAlbumId;

  let ItemIcon = isGroup ? (isExpanded ? FolderOpen : Folder) : AlbumIcon;
  if (item.icon && ALBUM_ICONS[item.icon]) {
    ItemIcon = ALBUM_ICONS[item.icon];
  }
  const iconKey = item.icon || (isGroup ? (isExpanded ? 'group-open' : 'group-closed') : 'album');

  return (
    <Text as="div" color={TextColors.primary} weight={TextWeights.medium}>
      <div
        className={clsx('flex items-center gap-2 p-1.5 rounded-md transition-colors cursor-pointer', {
          'bg-surface': isSelected,
          'hover:bg-card-active': !isSelected,
        })}
        onClick={() => (isGroup ? onToggle(item.id) : onSelectAlbum(item.id, item.name, (item as Album).images))}
        onContextMenu={(e) => onContextMenu(e, item)}
      >
        <div className="relative w-5 h-5 flex items-center justify-center p-0.5 rounded-sm text-text-secondary shrink-0">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={iconKey}
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{ duration: 0.15 }}
              className="absolute"
            >
              <ItemIcon size={16} />
            </motion.div>
          </AnimatePresence>
        </div>
        <span onDoubleClick={() => isGroup && onToggle(item.id)} className="truncate flex-1 select-none">
          {item.name}
        </span>
        {isGroup && (
          <div
            className="text-text-secondary p-0.5 rounded-sm hover:bg-surface/50"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(item.id);
            }}
          >
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        )}
      </div>

      <AnimatePresence>
        {isGroup && isExpanded && (item as AlbumGroup).children.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="pl-1 border-l-[1.5px] border-border-color/50 ml-3.75 overflow-hidden"
          >
            <div className="py-1">
              <AnimatePresence>
                {(item as AlbumGroup).children.map((child) => (
                  <motion.div
                    key={child.id}
                    initial={{ opacity: 0, height: 0, x: -10 }}
                    animate={{ opacity: 1, height: 'auto', x: 0 }}
                    exit={{ opacity: 0, height: 0, x: -10, overflow: 'hidden' }}
                    transition={{ duration: 0.2 }}
                  >
                    <AlbumTreeNode
                      item={child}
                      expandedGroups={expandedGroups}
                      onToggle={onToggle}
                      onSelectAlbum={onSelectAlbum}
                      onContextMenu={onContextMenu}
                      selectedAlbumId={selectedAlbumId}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Text>
  );
}

function TreeNode({
  expandedFolders,
  isExpanded,
  node,
  onContextMenu,
  onFolderSelect,
  onToggle,
  selectedPath,
  pinnedFolders,
  showImageCounts,
  isInstantTransition,
  folderIcons,
}: TreeNodeProps) {
  const hasChildren = node.hasSubdirs || (node.children && node.children.length > 0);
  const isSelected = node.path === selectedPath;
  const isPinned = pinnedFolders.includes(node.path);

  const handleFolderIconClick = (e: any) => {
    e.stopPropagation();
    if (hasChildren) {
      onToggle(node.path);
    }
  };

  const handleNameClick = () => {
    onFolderSelect(node.path);
  };

  const handleNameDoubleClick = () => {
    if (hasChildren) {
      onToggle(node.path);
    }
  };

  const containerVariants: any = {
    closed: { height: 0, opacity: 0, transition: { duration: 0.2, ease: 'easeInOut' } },
    open: { height: 'auto', opacity: 1, transition: { duration: 0.25, ease: 'easeInOut' } },
  };

  const itemVariants = {
    hidden: { opacity: 0, x: -15 },
    visible: ({ index, total }: VisibleProps) => ({
      opacity: 1,
      x: 0,
      transition: {
        duration: 0.25,
        delay: total < 8 ? index * 0.05 : 0,
      },
    }),
    exit: { opacity: 0, x: -15, transition: { duration: 0.2 } },
  };

  const currentFolderIconKey = folderIcons[node.path];
  let ResolvedIcon = isExpanded ? FolderOpen : Folder;
  if (currentFolderIconKey && ALBUM_ICONS[currentFolderIconKey]) {
    ResolvedIcon = ALBUM_ICONS[currentFolderIconKey];
  }
  const iconKey = currentFolderIconKey || (isExpanded ? 'folder-open' : 'folder-closed');

  return (
    <Text as="div" color={TextColors.primary} weight={TextWeights.medium}>
      <div
        className={clsx('flex items-center gap-2 p-1.5 rounded-md transition-colors cursor-pointer', {
          'bg-surface': isSelected,
          'hover:bg-card-active': !isSelected,
        })}
        onClick={handleNameClick}
        onContextMenu={(e: any) => onContextMenu(e, node.path, isPinned)}
      >
        <div
          className={clsx(
            'relative w-5 h-5 flex items-center justify-center p-0.5 rounded-sm transition-colors shrink-0',
            {
              [TEXT_COLOR_KEYS[TextColors.secondary]]: !isExpanded,
              'hover:bg-surface-hover': !isSelected && hasChildren,
            },
          )}
          onClick={handleFolderIconClick}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={iconKey}
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{ duration: 0.15 }}
              className="absolute"
            >
              <ResolvedIcon size={16} />
            </motion.div>
          </AnimatePresence>
        </div>

        <span onDoubleClick={handleNameDoubleClick} className="truncate select-none flex-1">
          <span className="truncate">{node.name}</span>
          {typeof node.imageCount === 'number' && node.imageCount > 0 && (
            <Text
              as="span"
              variant={TextVariants.small}
              color={TextColors.secondary}
              className={clsx(
                'inline-block ml-1 transition-all ease-in-out duration-300',
                showImageCounts ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-2',
              )}
            >
              ({node.imageCount})
            </Text>
          )}
        </span>

        {hasChildren && (
          <Text
            as="div"
            color={TextColors.secondary}
            className="p-0.5 rounded-sm hover:bg-surface/50"
            onClick={handleFolderIconClick}
          >
            {isExpanded ? <ChevronUp size={16} className="shrink-0" /> : <ChevronDown size={16} className="shrink-0" />}
          </Text>
        )}
      </div>

      <AnimatePresence initial={false}>
        {hasChildren && isExpanded && node.children && node.children.length > 0 && (
          <motion.div
            animate="open"
            className="pl-1 border-l-[1.5px] border-border-color/50 ml-3.75 overflow-hidden"
            exit="closed"
            initial={isInstantTransition ? 'open' : 'closed'}
            key="children-container"
            variants={containerVariants}
          >
            <div className="py-1">
              <AnimatePresence>
                {node?.children?.map((childNode: any, index: number) => (
                  <motion.div
                    animate="visible"
                    custom={{ index, total: node.children.length }}
                    exit="exit"
                    initial={isInstantTransition ? 'visible' : 'hidden'}
                    key={childNode.path}
                    layout={isInstantTransition ? false : 'position'}
                    variants={itemVariants}
                  >
                    <TreeNode
                      expandedFolders={expandedFolders}
                      isExpanded={expandedFolders.has(childNode.path)}
                      node={childNode}
                      onContextMenu={onContextMenu}
                      onFolderSelect={onFolderSelect}
                      onToggle={onToggle}
                      selectedPath={selectedPath}
                      pinnedFolders={pinnedFolders}
                      showImageCounts={showImageCounts}
                      isInstantTransition={isInstantTransition}
                      folderIcons={folderIcons}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Text>
  );
}

export default function FolderTree({
  isResizing,
  isVisible,
  onContextMenu,
  onAlbumContextMenu,
  onFolderSelect,
  onSelectAlbum,
  onToggleFolder,
  onOpenFolder,
  setIsVisible,
  style,
  isInstantTransition,
}: FolderTreeProps) {
  const { t } = useTranslation();
  const { appSettings, handleSettingsChange } = useSettingsStore();
  const {
    folderTrees,
    pinnedFolderTrees,
    currentFolderPath: selectedPath,
    expandedFolders,
    isTreeLoading: isLoading,
    albumTree,
    activeAlbumId,
    expandedAlbumGroups,
  } = useLibraryStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [isHovering, setIsHovering] = useState(false);
  const pinnedFolders = appSettings?.pinnedFolders || [];
  const openSections = appSettings?.openTreeSections ?? ['current'];
  const showImageCounts = appSettings?.enableFolderImageCounts ?? false;
  const folderIcons = appSettings?.folderIcons || {};

  useEffect(() => {
    invoke(Invokes.GetAlbums).then((res: any) => useLibraryStore.getState().setLibrary({ albumTree: res }));
  }, []);

  const toggleSection = (section: string) => {
    if (appSettings) {
      const isOpen = openSections.includes(section);
      const newSections = isOpen ? openSections.filter((s) => s !== section) : [...openSections, section];

      handleSettingsChange({ ...appSettings, openTreeSections: newSections });
    }
  };

  const handleEmptyAreaContextMenu = (e: any) => {
    if (e.target === e.currentTarget) {
      onContextMenu(e, null, false);
    }
  };

  const toggleAlbumGroup = (id: string) => {
    useLibraryStore.getState().setLibrary((state) => {
      const next = new Set(state.expandedAlbumGroups);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expandedAlbumGroups: next };
    });
  };

  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 1;

  const filteredTrees = useMemo(() => {
    if (!isSearching) return folderTrees;
    return folderTrees.map((tree: any) => filterTree(tree, trimmedQuery)).filter((t: any) => t !== null);
  }, [folderTrees, trimmedQuery, isSearching]);

  const filteredPinnedTrees = useMemo(() => {
    if (!isSearching) return pinnedFolderTrees;
    return pinnedFolderTrees
      .map((pinnedTree) => filterTree(pinnedTree, trimmedQuery))
      .filter((t): t is FolderTree => t !== null);
  }, [pinnedFolderTrees, trimmedQuery, isSearching]);

  const searchAutoExpandedFolders = useMemo(() => {
    if (!isSearching) return new Set<string>();
    const newExpanded = new Set<string>();
    filteredTrees.forEach((t: any) => getAutoExpandedPaths(t, newExpanded));
    filteredPinnedTrees.forEach((pinned) => getAutoExpandedPaths(pinned, newExpanded));
    return newExpanded;
  }, [isSearching, filteredTrees, filteredPinnedTrees]);

  const effectiveExpandedFolders = useMemo(() => {
    return new Set([...expandedFolders, ...searchAutoExpandedFolders]);
  }, [expandedFolders, searchAutoExpandedFolders]);

  useEffect(() => {
    if (isSearching && appSettings) {
      const hasPinnedResults = filteredPinnedTrees && filteredPinnedTrees.length > 0;
      const hasBaseResults = filteredTrees && filteredTrees.length > 0;

      let newSections = [...openSections];
      let changed = false;

      if (hasPinnedResults && !newSections.includes('pinned')) {
        newSections.push('pinned');
        changed = true;
      }
      if (hasBaseResults && !newSections.includes('current')) {
        newSections.push('current');
        changed = true;
      }

      if (changed) {
        handleSettingsChange({ ...appSettings, openTreeSections: newSections });
      }
    }
  }, [isSearching, filteredTrees, filteredPinnedTrees, openSections, handleSettingsChange, appSettings]);

  const isPinnedOpen = openSections.includes('pinned');
  const isCurrentOpen = openSections.includes('current');
  const isAlbumsOpen = openSections.includes('albums');

  const hasVisiblePinnedTrees = filteredPinnedTrees && filteredPinnedTrees.length > 0;

  return (
    <div
      className={clsx(
        'relative bg-bg-secondary rounded-lg shrink-0',
        !isResizing && 'transition-[width] duration-300 ease-in-out',
      )}
      style={style}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      {!isVisible && (
        <button
          className="absolute top-1/2 -translate-y-1/2 right-1 w-6 h-10 hover:bg-card-active rounded-md flex items-center justify-center z-30"
          onClick={() => setIsVisible(true)}
          data-tooltip={t('library.folders.tooltips.expand')}
        >
          <ChevronRight size={16} />
        </button>
      )}

      {isVisible && (
        <div className="p-2 flex flex-col h-full">
          <div className="pt-1 pb-2">
            <div className="flex items-center">
              <AnimatePresence>
                {isHovering && (
                  <motion.button
                    initial={{ width: 0, padding: 0, marginRight: 0, opacity: 0 }}
                    animate={{ width: 36, padding: 10, marginRight: 6, opacity: 1 }}
                    exit={{ width: 0, padding: 0, marginRight: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'easeInOut' }}
                    className="bg-surface rounded-md hover:bg-card-active flex items-center justify-center shrink-0 overflow-hidden transition-colors"
                    onClick={() => setIsVisible(false)}
                    data-tooltip={t('library.folders.tooltips.collapse')}
                  >
                    <ChevronLeft size={17.5} className="text-text-secondary shrink-0" />
                  </motion.button>
                )}
              </AnimatePresence>
              <div className="relative flex-1 min-w-0">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
                <input
                  type="text"
                  placeholder={t('library.folders.searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-surface border border-transparent rounded-md pl-9 pr-8 py-2 text-sm focus:outline-hidden"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-card-active"
                    data-tooltip={t('library.folders.tooltips.clearSearch')}
                  >
                    <X size={16} className="text-text-secondary" />
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto" onContextMenu={handleEmptyAreaContextMenu}>
            {hasVisiblePinnedTrees && (
              <>
                <div>
                  <SectionHeader
                    title={t('library.folders.sections.pinned')}
                    isOpen={isPinnedOpen}
                    onToggle={() => toggleSection('pinned')}
                  />
                </div>
                <AnimatePresence initial={false}>
                  {isPinnedOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <div className="pt-1 pb-2">
                        <AnimatePresence>
                          {filteredPinnedTrees.map((pinnedTree, index) => (
                            <motion.div
                              key={pinnedTree.path}
                              animate="visible"
                              custom={{ index, total: filteredPinnedTrees.length }}
                              exit="exit"
                              initial={isInstantTransition ? 'visible' : 'hidden'}
                              layout={isInstantTransition ? false : 'position'}
                              variants={{
                                hidden: { opacity: 0, x: -15 },
                                visible: ({ index, total }: VisibleProps) => ({
                                  opacity: 1,
                                  x: 0,
                                  transition: { duration: 0.25, delay: total < 8 ? index * 0.05 : 0 },
                                }),
                                exit: { opacity: 0, x: -15, transition: { duration: 0.2 } },
                              }}
                            >
                              <TreeNode
                                expandedFolders={effectiveExpandedFolders}
                                isExpanded={effectiveExpandedFolders.has(pinnedTree.path)}
                                node={pinnedTree}
                                onContextMenu={onContextMenu}
                                onFolderSelect={onFolderSelect}
                                onToggle={onToggleFolder}
                                selectedPath={selectedPath}
                                pinnedFolders={pinnedFolders}
                                showImageCounts={showImageCounts && isHovering}
                                isInstantTransition={isInstantTransition}
                                folderIcons={folderIcons}
                              />
                            </motion.div>
                          ))}
                        </AnimatePresence>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}

            {!isSearching && (
              <>
                <div>
                  <SectionHeader
                    title={t('library.folders.sections.albums')}
                    isOpen={isAlbumsOpen}
                    onToggle={() => toggleSection('albums')}
                  />
                </div>
                <AnimatePresence>
                  {isAlbumsOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onAlbumContextMenu(e, null);
                      }}
                    >
                      <div className="pt-1 pb-2">
                        <AnimatePresence>
                          {albumTree.map((item: any) => (
                            <motion.div
                              key={item.id}
                              initial={{ opacity: 0, height: 0, x: -15 }}
                              animate={{ opacity: 1, height: 'auto', x: 0 }}
                              exit={{ opacity: 0, height: 0, x: -15, overflow: 'hidden' }}
                              transition={{ duration: 0.2 }}
                              layout="position"
                            >
                              <AlbumTreeNode
                                item={item}
                                expandedGroups={expandedAlbumGroups}
                                onToggle={toggleAlbumGroup}
                                onSelectAlbum={onSelectAlbum}
                                onContextMenu={onAlbumContextMenu}
                                selectedAlbumId={activeAlbumId}
                              />
                            </motion.div>
                          ))}
                        </AnimatePresence>
                        {albumTree.length === 0 && (
                          <motion.div layout="position">
                            <Text variant={TextVariants.small} className="p-2 text-center">
                              {t('library.folders.albumsEmpty')}
                            </Text>
                          </motion.div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}

            {filteredTrees && filteredTrees.length > 0 && (
              <>
                <div>
                  <SectionHeader
                    title={t('library.folders.sections.folders')}
                    isOpen={isCurrentOpen}
                    onToggle={() => toggleSection('current')}
                  />
                </div>
                <AnimatePresence initial={false}>
                  {isCurrentOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <div className="pt-1">
                        <AnimatePresence>
                          {filteredTrees.map((tree: any, index: number) => (
                            <motion.div
                              key={tree.path}
                              animate="visible"
                              custom={{ index, total: filteredTrees.length }}
                              exit="exit"
                              initial={isInstantTransition ? 'visible' : 'hidden'}
                              layout={isInstantTransition ? false : 'position'}
                              variants={{
                                hidden: { opacity: 0, x: -15 },
                                visible: ({ index, total }: VisibleProps) => ({
                                  opacity: 1,
                                  x: 0,
                                  transition: { duration: 0.25, delay: total < 8 ? index * 0.05 : 0 },
                                }),
                                exit: { opacity: 0, x: -15, transition: { duration: 0.2 } },
                              }}
                            >
                              <TreeNode
                                expandedFolders={effectiveExpandedFolders}
                                isExpanded={effectiveExpandedFolders.has(tree.path)}
                                node={tree}
                                onContextMenu={onContextMenu}
                                onFolderSelect={onFolderSelect}
                                onToggle={onToggleFolder}
                                selectedPath={selectedPath}
                                pinnedFolders={pinnedFolders}
                                showImageCounts={showImageCounts && isHovering}
                                isInstantTransition={isInstantTransition}
                                folderIcons={folderIcons}
                              />
                            </motion.div>
                          ))}
                        </AnimatePresence>

                        <AnimatePresence initial={false}>
                          {isHovering && !isSearching && (
                            <motion.div
                              layout="position"
                              initial={{ opacity: 0, height: 0, overflow: 'hidden' }}
                              animate={{ opacity: 1, height: 'auto', overflow: 'hidden' }}
                              exit={{ opacity: 0, height: 0, overflow: 'hidden' }}
                              transition={{ duration: 0.2 }}
                            >
                              <Text
                                as="div"
                                weight={TextWeights.medium}
                                className="flex items-center gap-2 p-2 mt-1 rounded-md transition-colors transition-opacity opacity-70 hover:opacity-100 hover:bg-card-active cursor-pointer hover:text-text-primary"
                                onClick={(e: React.MouseEvent) => {
                                  e.stopPropagation();
                                  onOpenFolder();
                                }}
                              >
                                <div className="relative w-4 h-4 ml-1 shrink-0 flex items-center justify-center">
                                  <Plus size={16} />
                                </div>
                                <span className="select-none">{t('library.folders.addFolder')}</span>
                              </Text>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}

            {!filteredTrees?.length && !hasVisiblePinnedTrees && isSearching && (
              <Text className="p-2 text-center">{t('library.folders.noFoldersFound')}</Text>
            )}

            {folderTrees.length === 0 && pinnedFolderTrees.length === 0 && !isSearching && (
              <div className="pt-1">
                {isLoading ? (
                  <Text className="animate-pulse p-2">{t('library.folders.loading')}</Text>
                ) : (
                  <Text className="p-2">{t('library.folders.openFolderInstruction')}</Text>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
