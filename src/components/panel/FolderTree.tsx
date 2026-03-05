import { Folder, FolderOpen, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Search, X } from 'lucide-react';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useMemo, useEffect } from 'react';

export interface FolderTree {
  children: FolderTree[];
  is_dir: boolean;
  name: string;
  path: string;
  imageCount?: number;
}

interface FolderTreeProps {
  expandedFolders: Set<string>;
  isLoading: boolean;
  isResizing: boolean;
  isVisible: boolean;
  onContextMenu(event: any, path: string | null, isPinned?: boolean): void;
  onFolderSelect(folder: string): void;
  onToggleFolder(folder: string): void;
  selectedPath: string | null;
  setIsVisible(visible: boolean): void;
  style: any;
  tree: FolderTree | null;
  pinnedFolderTrees: FolderTree[];
  pinnedFolders: string[];
  activeSection: string | null;
  onActiveSectionChange(section: string | null): void;
  showImageCounts: boolean;
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
}

interface VisibleProps {
  index: number;
  total: number;
}

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
  return (
    <div
      className="flex items-center w-full text-left px-1 py-1.5 cursor-pointer group"
      onClick={onToggle}
      data-tooltip={isOpen ? `Collapse ${title}` : `Expand ${title}`}
    >
      <div className="p-0.5 rounded-md transition-colors">
        {isOpen ? (
          <ChevronDown size={14} className="text-text-secondary" />
        ) : (
          <ChevronRight size={14} className="text-text-secondary" />
        )}
      </div>
      <span className="ml-1 text-xs font-bold uppercase text-text-secondary tracking-wider select-none">
        {title}
      </span>
    </div>
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
}: TreeNodeProps) {
  const hasChildren = node.children && node.children.length > 0;
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

  return (
    <div className="text-sm">
      <div
        className={clsx('flex items-center gap-2 p-1.5 rounded-md transition-colors', {
          'bg-surface': isSelected,
          'hover:bg-card-active': !isSelected,
        })}
        onClick={handleNameClick}
        onContextMenu={(e: any) => onContextMenu(e, node.path, isPinned)}
      >
        <div
          className={clsx('cursor-pointer p-0.5 rounded transition-colors', {
            'cursor-default': !hasChildren,
            'text-primary': isSelected && isExpanded, 
            'text-text-secondary': !isSelected || !isExpanded,
            'hover:bg-surface-hover': !isSelected && hasChildren
          })}
          onClick={handleFolderIconClick}
        >
          {isExpanded ? (
            <FolderOpen size={16} className={isSelected ? 'text-primary' : 'text-hover-color'} />
          ) : (
            <Folder size={16} className={isSelected ? 'text-primary' : 'text-text-secondary'} />
          )}
        </div>
        
        <span 
          onDoubleClick={handleNameDoubleClick} 
          className={clsx('truncate select-none cursor-pointer flex-1 font-medium', {
            'text-primary': isSelected,
            'text-text-primary': !isSelected
          })}
        >
          <span className="truncate">{node.name}</span>
           {typeof node.imageCount === "number" && (
             <span 
               className={clsx(
                 "inline-block text-text-secondary text-xs ml-1 transition-all ease-in-out duration-300",
                 showImageCounts 
                   ? "opacity-100 translate-x-0" 
                   : "opacity-0 -translate-x-2"
               )}
             >
                ({node.imageCount})
             </span>
           )}
        </span>

        {hasChildren && (
          <div className="p-0.5 rounded hover:bg-surface/50 cursor-pointer" onClick={handleFolderIconClick}>
            {isExpanded ? (
              <ChevronUp size={16} className="text-text-secondary flex-shrink-0" />
            ) : (
              <ChevronDown size={16} className="text-text-secondary flex-shrink-0" />
            )}
          </div>
        )}
      </div>

      <AnimatePresence initial={false}>
        {hasChildren && isExpanded && (
          <motion.div
            animate="open"
            className="pl-4 border-l border-border-color/20 ml-[15px] overflow-hidden"
            exit="closed"
            initial="closed"
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
                    initial="hidden"
                    key={childNode.path}
                    layout="position"
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
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function FolderTree({
  expandedFolders,
  isLoading,
  isResizing,
  isVisible,
  onContextMenu,
  onFolderSelect,
  onToggleFolder,
  selectedPath,
  setIsVisible,
  style,
  tree,
  pinnedFolderTrees,
  pinnedFolders,
  activeSection,
  onActiveSectionChange,
  showImageCounts,
}: FolderTreeProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isHovering, setIsHovering] = useState(false);

  const handleEmptyAreaContextMenu = (e: any) => {
    if (e.target === e.currentTarget) {
      onContextMenu(e, null, false);
    }
  };

  const trimmedQuery = searchQuery.trim();
  const isSearching = trimmedQuery.length > 1;

  const filteredTree = useMemo(() => {
    if (!isSearching) return tree;
    return filterTree(tree, trimmedQuery);
  }, [tree, trimmedQuery, isSearching]);

  const filteredPinnedTrees = useMemo(() => {
    if (!isSearching) return pinnedFolderTrees;
    return pinnedFolderTrees
      .map((pinnedTree) => filterTree(pinnedTree, trimmedQuery))
      .filter((t): t is FolderTree => t !== null);
  }, [pinnedFolderTrees, trimmedQuery, isSearching]);

  const searchAutoExpandedFolders = useMemo(() => {
    if (!isSearching) {
      return new Set<string>();
    }
    const newExpanded = new Set<string>();
    if (filteredTree) {
      getAutoExpandedPaths(filteredTree, newExpanded);
    }
    filteredPinnedTrees.forEach((pinned) => {
      getAutoExpandedPaths(pinned, newExpanded);
    });
    return newExpanded;
  }, [isSearching, filteredTree, filteredPinnedTrees]);

  const effectiveExpandedFolders = useMemo(() => {
    return new Set([...expandedFolders, ...searchAutoExpandedFolders]);
  }, [expandedFolders, searchAutoExpandedFolders]);

  useEffect(() => {
    if (isSearching) {
      const hasPinnedResults = filteredPinnedTrees && filteredPinnedTrees.length > 0;
      const hasBaseResults = !!filteredTree;

      if (hasPinnedResults && activeSection !== 'pinned') {
        onActiveSectionChange('pinned');
      }
      else if (!hasPinnedResults && hasBaseResults && activeSection !== 'current') {
        onActiveSectionChange('current');
      }
    }
  }, [isSearching, filteredTree, filteredPinnedTrees, activeSection, onActiveSectionChange]);

  const isPinnedOpen = activeSection === 'pinned';
  const isCurrentOpen = activeSection === 'current';

  const hasVisiblePinnedTrees = filteredPinnedTrees && filteredPinnedTrees.length > 0;

  return (
    <div
      className={clsx(
        'relative bg-bg-secondary rounded-lg flex-shrink-0',
        !isResizing && 'transition-[width] duration-300 ease-in-out',
      )}
      style={style}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <button
        className="absolute top-1/2 -translate-y-1/2 right-1 w-6 h-10 hover:bg-card-active rounded-md flex items-center justify-center z-30"
        onClick={() => setIsVisible(!isVisible)}
        data-tooltip={isVisible ? 'Collapse Folder Tree' : 'Expand Folder Tree'}
      >
        {isVisible ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>

      {isVisible && (
        <div className="p-2 flex flex-col h-full">
          <div className="pt-1 pb-2">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
              <input
                type="text"
                placeholder="Search folders..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-surface border border-transparent rounded-md pl-9 pr-8 py-2 text-sm focus:outline-none"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-card-active"
                  data-tooltip="Clear search"
                >
                  <X size={16} className="text-text-secondary" />
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto" onContextMenu={handleEmptyAreaContextMenu}>
            {hasVisiblePinnedTrees && (
              <>
                <div>
                  <SectionHeader
                    title="Pinned"
                    isOpen={isPinnedOpen}
                    onToggle={() => onActiveSectionChange(isPinnedOpen ? null : 'pinned')}
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
                        {filteredPinnedTrees.map((pinnedTree) => (
                          <TreeNode
                            key={pinnedTree.path}
                            expandedFolders={effectiveExpandedFolders}
                            isExpanded={effectiveExpandedFolders.has(pinnedTree.path)}
                            node={pinnedTree}
                            onContextMenu={onContextMenu}
                            onFolderSelect={onFolderSelect}
                            onToggle={onToggleFolder}
                            selectedPath={selectedPath}
                            pinnedFolders={pinnedFolders}
                            showImageCounts={showImageCounts && isHovering}
                          />
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}

            {filteredTree && (
              <>
                <div>
                  <SectionHeader
                    title="Base Folder"
                    isOpen={isCurrentOpen}
                    onToggle={() => onActiveSectionChange(isCurrentOpen ? null : 'current')}
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
                        <TreeNode
                          expandedFolders={effectiveExpandedFolders}
                          isExpanded={effectiveExpandedFolders.has(filteredTree.path)}
                          node={filteredTree}
                          onContextMenu={onContextMenu}
                          onFolderSelect={onFolderSelect}
                          onToggle={onToggleFolder}
                          selectedPath={selectedPath}
                          pinnedFolders={pinnedFolders}
                          showImageCounts={showImageCounts && isHovering}
                        />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}

            {!filteredTree && !hasVisiblePinnedTrees && isSearching && (
              <p className="text-text-secondary text-sm p-2 text-center">No folders found.</p>
            )}

            {!tree && pinnedFolderTrees.length === 0 && !isSearching && (
              <div className="pt-1">
                {isLoading ? (
                  <p className="text-text-secondary text-sm animate-pulse p-2">Loading folder structure...</p>
                ) : (
                  <p className="text-text-secondary text-sm p-2">Open a folder to see its structure.</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
