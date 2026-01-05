import { useState, type FC } from 'react';
import { Tag, Plus, X } from 'lucide-react';

interface TaggingSubMenuProps {
  hideContextMenu: () => void;
  existingTags: string[];
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  currentTags: string[];
}

export const TaggingSubMenu: FC<TaggingSubMenuProps> = ({
  hideContextMenu,
  existingTags,
  onAddTag,
  onRemoveTag,
  currentTags,
}) => {
  const [newTag, setNewTag] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  const handleAddTag = () => {
    const trimmed = newTag.trim();
    if (trimmed && !currentTags.includes(trimmed)) {
      onAddTag(trimmed);
      setNewTag('');
      setIsAdding(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    } else if (e.key === 'Escape') {
      setIsAdding(false);
      setNewTag('');
    }
  };

  const availableTags = existingTags.filter((tag) => !currentTags.includes(tag));

  return (
    <div className="bg-surface/95 rounded-lg shadow-xl p-2 w-64">
      <div className="px-2 py-1 text-xs text-text-secondary font-medium uppercase tracking-wider mb-1">
        Current Tags
      </div>

      {currentTags.length === 0 ? (
        <div className="px-2 py-2 text-sm text-text-tertiary">No tags assigned</div>
      ) : (
        <div className="flex flex-wrap gap-1 px-2 py-1 mb-2">
          {currentTags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-accent/20 text-accent text-xs rounded-full"
            >
              {tag}
              <button
                onClick={() => onRemoveTag(tag)}
                className="hover:text-red-400"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="h-px bg-surface my-2" />

      {availableTags.length > 0 && (
        <>
          <div className="px-2 py-1 text-xs text-text-secondary font-medium uppercase tracking-wider mb-1">
            Add Tag
          </div>
          <div className="max-h-32 overflow-y-auto">
            {availableTags.slice(0, 10).map((tag) => (
              <button
                key={tag}
                onClick={() => {
                  onAddTag(tag);
                }}
                className="w-full text-left px-3 py-1.5 text-sm rounded-md text-text-primary hover:bg-bg-primary flex items-center gap-2"
              >
                <Tag size={14} />
                {tag}
              </button>
            ))}
          </div>
          <div className="h-px bg-surface my-2" />
        </>
      )}

      {isAdding ? (
        <div className="px-2 py-1">
          <input
            type="text"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter tag name..."
            autoFocus
            className="w-full px-2 py-1.5 text-sm bg-bg-primary border border-surface rounded-md text-text-primary placeholder-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleAddTag}
              disabled={!newTag.trim()}
              className="flex-1 px-2 py-1 text-xs bg-accent text-button-text rounded-md disabled:opacity-50"
            >
              Add
            </button>
            <button
              onClick={() => {
                setIsAdding(false);
                setNewTag('');
              }}
              className="flex-1 px-2 py-1 text-xs bg-surface text-text-primary rounded-md"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setIsAdding(true)}
          className="w-full text-left px-3 py-1.5 text-sm rounded-md text-text-secondary hover:bg-bg-primary hover:text-text-primary flex items-center gap-2"
        >
          <Plus size={14} />
          Create new tag...
        </button>
      )}
    </div>
  );
};
