import { useCallback, useState, useRef, useEffect, KeyboardEvent } from 'react';

interface TagEditorProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  maxTags?: number;
  readonly?: boolean;
}

export function TagEditor({
  tags,
  onChange,
  suggestions = [],
  placeholder = 'Add tag...',
  maxTags,
  readonly = false,
}: TagEditorProps) {
  const [inputValue, setInputValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filteredSuggestions = suggestions.filter(
    (s) =>
      s.toLowerCase().includes(inputValue.toLowerCase()) &&
      !tags.includes(s) &&
      inputValue.trim().length > 0
  );

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const addTag = useCallback(
    (tag: string) => {
      const trimmedTag = tag.trim().toLowerCase();
      if (
        trimmedTag &&
        !tags.includes(trimmedTag) &&
        (!maxTags || tags.length < maxTags)
      ) {
        onChange([...tags, trimmedTag]);
        setInputValue('');
        setShowSuggestions(false);
        setSelectedSuggestionIndex(-1);
      }
    },
    [tags, onChange, maxTags]
  );

  const removeTag = useCallback(
    (tagToRemove: string) => {
      onChange(tags.filter((tag) => tag !== tagToRemove));
    },
    [tags, onChange]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedSuggestionIndex >= 0 && filteredSuggestions[selectedSuggestionIndex]) {
          addTag(filteredSuggestions[selectedSuggestionIndex]);
        } else if (inputValue.trim()) {
          addTag(inputValue);
        }
      } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
        removeTag(tags[tags.length - 1]);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (filteredSuggestions.length > 0) {
          setShowSuggestions(true);
          setSelectedSuggestionIndex((prev) =>
            prev < filteredSuggestions.length - 1 ? prev + 1 : prev
          );
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedSuggestionIndex((prev) => (prev > 0 ? prev - 1 : -1));
      } else if (e.key === 'Escape') {
        setShowSuggestions(false);
        setSelectedSuggestionIndex(-1);
      } else if (e.key === ',') {
        e.preventDefault();
        if (inputValue.trim()) {
          addTag(inputValue);
        }
      }
    },
    [inputValue, tags, addTag, removeTag, filteredSuggestions, selectedSuggestionIndex]
  );

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setShowSuggestions(true);
    setSelectedSuggestionIndex(-1);
  }, []);

  const handleSuggestionClick = useCallback(
    (suggestion: string) => {
      addTag(suggestion);
      inputRef.current?.focus();
    },
    [addTag]
  );

  const handleContainerClick = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  const canAddMore = !maxTags || tags.length < maxTags;

  return (
    <div ref={containerRef} className="relative">
      <div
        className={`
          flex flex-wrap items-center gap-1.5 p-2 min-h-[42px]
          bg-bg-primary border border-border-color rounded-md
          focus-within:ring-2 focus-within:ring-accent focus-within:border-transparent
          ${readonly ? 'opacity-60 cursor-default' : 'cursor-text'}
        `}
        onClick={handleContainerClick}
      >
        {tags.map((tag) => (
          <Tag key={tag} label={tag} onRemove={readonly ? undefined : () => removeTag(tag)} />
        ))}
        {!readonly && canAddMore && (
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setShowSuggestions(true)}
            placeholder={tags.length === 0 ? placeholder : ''}
            className="flex-1 min-w-[100px] bg-transparent border-none outline-none 
                       text-sm text-text-primary placeholder-text-secondary"
          />
        )}
      </div>

      {showSuggestions && filteredSuggestions.length > 0 && !readonly && (
        <div
          className="absolute z-50 w-full mt-1 bg-surface border border-border-color 
                     rounded-md shadow-lg max-h-[200px] overflow-y-auto"
        >
          {filteredSuggestions.map((suggestion, index) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => handleSuggestionClick(suggestion)}
              className={`
                w-full px-3 py-2 text-left text-sm text-text-primary
                hover:bg-surface-hover
                ${index === selectedSuggestionIndex ? 'bg-surface-hover' : ''}
              `}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {maxTags && (
        <div className="text-xs text-text-secondary mt-1">
          {tags.length}/{maxTags} tags
        </div>
      )}
    </div>
  );
}

interface TagProps {
  label: string;
  onRemove?: () => void;
  variant?: 'default' | 'outline';
}

export function Tag({ label, onRemove, variant = 'default' }: TagProps) {
  const baseStyles =
    'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium';
  const variantStyles = {
    default: 'bg-accent/20 text-accent',
    outline: 'border border-border-color text-text-secondary',
  };

  return (
    <span className={`${baseStyles} ${variantStyles[variant]}`}>
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="hover:text-text-primary focus:outline-none"
          aria-label={`Remove ${label}`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </span>
  );
}

interface TagListProps {
  tags: string[];
  variant?: 'default' | 'outline';
  onTagClick?: (tag: string) => void;
}

export function TagList({ tags, variant = 'default', onTagClick }: TagListProps) {
  if (tags.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className={`
            inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium
            ${variant === 'default' ? 'bg-accent/20 text-accent' : 'border border-border-color text-text-secondary'}
            ${onTagClick ? 'cursor-pointer hover:opacity-80' : ''}
          `}
          onClick={onTagClick ? () => onTagClick(tag) : undefined}
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

interface QuickTagsProps {
  commonTags: string[];
  selectedTags: string[];
  onToggle: (tag: string) => void;
}

export function QuickTags({ commonTags, selectedTags, onToggle }: QuickTagsProps) {
  return (
    <div className="flex flex-wrap gap-1">
      {commonTags.map((tag) => {
        const isSelected = selectedTags.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            onClick={() => onToggle(tag)}
            className={`
              px-2 py-1 rounded-md text-xs font-medium border
              ${
                isSelected
                  ? 'bg-accent text-button-text border-accent'
                  : 'bg-transparent text-text-secondary border-border-color hover:border-accent hover:text-accent'
              }
            `}
          >
            {tag}
          </button>
        );
      })}
    </div>
  );
}
