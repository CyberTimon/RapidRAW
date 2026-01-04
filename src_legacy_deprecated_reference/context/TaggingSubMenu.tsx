import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Invokes } from '../components/ui/AppProperties';

interface TaggingSubMenuProps {
  paths: string[];
  initialTags: { tag: string; isUser: boolean }[];
  onTagsChanged: (paths: string[], newTags: { tag: string; isUser: boolean }[]) => void;
  appSettings: any;
  hideContextMenu: () => void;
}

const USER_TAG_PREFIX = 'user:';

const tagVariants = {
  visible: { opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 500, damping: 30 } },
  exit: { opacity: 0, scale: 0.8, transition: { duration: 0.15 } },
};

export default function TaggingSubMenu({
  paths,
  initialTags,
  onTagsChanged,
  appSettings,
  hideContextMenu,
}: TaggingSubMenuProps) {
  const [tags, setTags] = useState<{ tag: string; isUser: boolean }[]>(initialTags);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTags(initialTags);
  }, [initialTags]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleAddTag = async (tagToAdd: string) => {
    const newTagValue = tagToAdd.trim().toLowerCase();
    if (newTagValue && !tags.some((t) => t.tag === newTagValue)) {
      try {
        const prefixedTag = `${USER_TAG_PREFIX}${newTagValue}`;
        await invoke(Invokes.AddTagForPaths, { paths, tag: prefixedTag });
        const newTags = [...tags, { tag: newTagValue, isUser: true }].sort((a, b) => a.tag.localeCompare(b.tag));
        setTags(newTags);
        onTagsChanged(paths, newTags);
        setInputValue('');
      } catch (err) {
        console.error(`Failed to add tag: ${err}`);
      }
    }
  };

  const handleRemoveTag = async (tagToRemove: { tag: string; isUser: boolean }) => {
    try {
      const prefixedTag = tagToRemove.isUser ? `${USER_TAG_PREFIX}${tagToRemove.tag}` : tagToRemove.tag;
      await invoke(Invokes.RemoveTagForPaths, { paths, tag: prefixedTag });
      const newTags = tags.filter((t) => t.tag !== tagToRemove.tag);
      setTags(newTags);
      onTagsChanged(paths, newTags);
    } catch (err) {
      console.error(`Failed to remove tag: ${err}`);
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag(inputValue);
    }
    if (e.key === 'Escape') {
      hideContextMenu();
    }
  };

  const shortcuts = appSettings?.taggingShortcuts || [];

  return (
    <div className="bg-surface/90 p-2 w-64 text-text-primary rounded-lg" onClick={(e) => e.stopPropagation()}>
      <div className="mb-2">
        <div className="flex flex-wrap gap-1 p-1 bg-surface rounded-md min-h-[32px] items-center">
          <AnimatePresence>
            {tags.length > 0 ? (
              tags.map((tagItem) => (
                <motion.div
                  key={tagItem.tag}
                  layout
                  variants={tagVariants}
                  initial={false}
                  animate="visible"
                  exit="exit"
                  onClick={() => handleRemoveTag(tagItem)}
                  title={`Remove tag "${tagItem.tag}"`}
                  className="flex items-center gap-1 bg-bg-primary text-text-primary text-xs font-medium px-2 py-1 rounded group cursor-pointer"
                >
                  <span>{tagItem.tag}</span>
                  <span className="rounded-full group-hover:bg-black/20 p-0.5 transition-colors">
                    <X size={12} />
                  </span>
                </motion.div>
              ))
            ) : (
              <motion.span
                key="no-tags-placeholder"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="text-xs text-text-secondary italic p-1 select-none"
              >
                No tags added
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="relative mb-2">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="Add a tag..."
          className="w-full bg-surface border border-border-color rounded-md pl-2 pr-8 py-1.5 text-sm focus:outline-none"
        />
        <button
          onClick={() => handleAddTag(inputValue)}
          className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-full text-text-secondary hover:text-text-primary hover:bg-surface"
          title="Add tag"
        >
          <Plus size={16} />
        </button>
      </div>

      {shortcuts.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-text-primary px-1 py-1">SHORTCUTS</p>
          <div className="flex flex-wrap gap-1">
            {shortcuts.map((shortcut: string) => (
              <button
                key={shortcut}
                onClick={() => handleAddTag(shortcut)}
                className="bg-surface text-text-secondary hover:bg-card-active hover:text-text-primary text-xs font-medium px-2 py-1 rounded"
              >
                {shortcut}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}