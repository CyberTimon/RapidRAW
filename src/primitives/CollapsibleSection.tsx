import { useRef, useEffect, useState, useCallback, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

interface CollapsibleSectionProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  onReset?: () => void;
}

export function CollapsibleSection({
  title,
  children,
  defaultOpen = true,
  onReset,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) return;

    const updateMaxHeight = () => {
      if (isOpen) {
        wrapper.style.maxHeight = `${content.scrollHeight}px`;
      } else {
        wrapper.style.maxHeight = '0px';
      }
    };

    updateMaxHeight();

    const resizeObserver = new ResizeObserver(updateMaxHeight);
    resizeObserver.observe(content);

    return () => resizeObserver.disconnect();
  }, [isOpen]);

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const handleReset = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onReset?.();
    },
    [onReset]
  );

  return (
    <div className="bg-surface rounded-lg overflow-hidden flex-shrink-0">
      <button
        type="button"
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-surface-secondary transition-colors duration-200"
        onClick={handleToggle}
      >
        <div className="flex items-center gap-2">
          <h3 className="text-base font-medium text-text-primary">{title}</h3>
          {onReset && (
            <button
              type="button"
              className="text-xs text-text-secondary hover:text-text-primary transition-colors px-1"
              onClick={handleReset}
            >
              Reset
            </button>
          )}
        </div>
        <ChevronDown
          className={`text-accent transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          size={20}
        />
      </button>
      <div
        ref={wrapperRef}
        className="overflow-hidden transition-all duration-200 ease-in-out"
      >
        <div ref={contentRef} className="px-4 pb-4">
          {children}
        </div>
      </div>
    </div>
  );
}
