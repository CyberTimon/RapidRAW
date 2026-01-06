import { useBloc } from '@blac/react';
import { FolderBloc } from '../../blocs/library/FolderBloc';
import { LibraryBloc } from '../../blocs/library/LibraryBloc';
import { SettingsBloc } from '../../blocs/app/SettingsBloc';
import { openFolderDialog } from '../../services/fileDialogs';
import type { FolderNode } from '../../types/library';

interface FolderNodeItemProps {
  node: FolderNode;
  currentPath: string | null;
  depth: number;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}

function FolderNodeItem({ node, currentPath, depth, onSelect, onToggle }: FolderNodeItemProps) {
  const isSelected = node.path === currentPath;
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <button
        className={`
          w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors
          ${isSelected ? 'bg-accent/20 text-accent' : 'text-text-primary hover:bg-surface'}
        `}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(node.path)}
      >
        {hasChildren && (
          <button
            className="p-0.5 hover:bg-surface/50 rounded"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.path);
            }}
          >
            <svg
              className={`w-3 h-3 text-text-secondary transition-transform ${node.isExpanded ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
        {!hasChildren && <span className="w-4" />}

        <svg
          className={`w-4 h-4 flex-shrink-0 ${isSelected ? 'text-accent' : 'text-text-secondary'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
          />
        </svg>

        <span className="truncate flex-1 text-left">{node.name}</span>

        {node.imageCount !== undefined && node.imageCount > 0 && (
          <span className="text-xs text-text-secondary">{node.imageCount}</span>
        )}
      </button>

      {node.isExpanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <FolderNodeItem
              key={child.path}
              node={child}
              currentPath={currentPath}
              depth={depth + 1}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FolderTree() {
  console.log('Rendering FolderTree');
  const [folder, folderBloc] = useBloc(FolderBloc);
  const [library, libraryBloc] = useBloc(LibraryBloc);
  const [, settingsBloc] = useBloc(SettingsBloc);

  const handleSelectFolder = (path: string) => {
    libraryBloc.openFolder(path);
  };

  const handleToggleExpand = (path: string) => {
    folderBloc.toggleExpand(path);
  };

  const handleOpenFolder = async () => {
    const path = await openFolderDialog();
    if (path) {
      libraryBloc.openFolder(path, true);
      folderBloc.loadTree(path);
      settingsBloc.updateSettings({ lastRootPath: path });
    }
  };

  if (folder.isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-accent border-t-transparent" />
      </div>
    );
  }

  if (folder.error) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-4 text-center">
        <svg className="w-12 h-12 text-red-500 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <p className="text-sm text-text-secondary">{folder.error}</p>
      </div>
    );
  }

  if (!folder.tree) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-4">
        <button
          className="flex flex-col items-center gap-3 p-6 rounded-lg hover:bg-surface transition-colors"
          onClick={handleOpenFolder}
        >
          <svg className="w-12 h-12 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
            />
          </svg>
          <span className="text-sm text-text-secondary">Open Folder</span>
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-bg-secondary">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-color">
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">Folders</span>
        <div className="flex items-center gap-1">
          <button
            className="p-1 rounded hover:bg-surface transition-colors"
            onClick={() => folderBloc.collapseAll()}
            title="Collapse All"
          >
            <svg className="w-4 h-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
          <button
            className="p-1 rounded hover:bg-surface transition-colors"
            onClick={handleOpenFolder}
            title="Open Folder"
          >
            <svg className="w-4 h-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        <FolderNodeItem
          node={folder.tree}
          currentPath={library.currentFolderPath}
          depth={0}
          onSelect={handleSelectFolder}
          onToggle={handleToggleExpand}
        />
      </div>
    </div>
  );
}
