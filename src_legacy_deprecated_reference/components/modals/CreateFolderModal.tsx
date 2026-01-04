import { useState, useEffect, useCallback } from 'react';

interface FolderModalProps {
  isOpen: boolean;
  onClose(): void;
  onSave(name: string): void;
}

export default function CreateFolderModal({ isOpen, onClose, onSave }: FolderModalProps) {
  const [name, setName] = useState('');
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setName('');
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleSave = useCallback(() => {
    if (name.trim()) {
      onSave(name.trim());
    }
    onClose();
  }, [name, onSave, onClose]);

  const handleKeyDown = useCallback(
    (e: any) => {
      if (e.key === 'Enter') {
        handleSave();
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [handleSave, onClose],
  );

  if (!isMounted) {
    return null;
  }

  return (
    <div
      aria-modal="true"
      className={`
        fixed inset-0 flex items-center justify-center z-50 
        bg-black/30 backdrop-blur-sm 
        transition-opacity duration-300 ease-in-out
        ${show ? 'opacity-100' : 'opacity-0'}
      `}
      onClick={onClose}
      role="dialog"
    >
      <div
        className={`
          bg-surface rounded-lg shadow-xl p-6 w-full max-w-sm 
          transform transition-all duration-300 ease-out
          ${show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'}
        `}
        onClick={(e: any) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-text-primary mb-4">Create New Folder</h3>
        <input
          autoFocus
          className="w-full bg-bg-primary text-text-primary border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent"
          onChange={(e: any) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter folder name..."
          type="text"
          value={name}
        />
        <div className="flex justify-end gap-3 mt-5">
          <button
            className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-4 py-2 rounded-md bg-accent text-button-text font-semibold hover:bg-accent-hover disabled:bg-gray-500 disabled:text-white disabled:cursor-not-allowed transition-colors"
            disabled={!name.trim()}
            onClick={handleSave}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
