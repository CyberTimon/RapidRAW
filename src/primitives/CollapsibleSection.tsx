import { useRef, useEffect, useState, ReactNode } from 'react';
import { ChevronDown, Eye, EyeOff } from 'lucide-react';

interface CollapsibleSectionProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  isOpen?: boolean;
  isContentVisible?: boolean;
  canToggleVisibility?: boolean;
  onToggle?: () => void;
  onToggleVisibility?: () => void;
  onReset?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function CollapsibleSection({
  title,
  children,
  defaultOpen = true,
  isOpen: controlledIsOpen,
  isContentVisible = true,
  canToggleVisibility = false,
  onToggle,
  onToggleVisibility,
  onReset,
  onContextMenu,
}: CollapsibleSectionProps) {
  const [internalIsOpen, setInternalIsOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isControlled = controlledIsOpen !== undefined;
  const isOpen = isControlled ? controlledIsOpen : internalIsOpen;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) return;

    const updateMaxHeight = () => {
      if (isOpen) {
        const contentHeight = content.scrollHeight;
        wrapper.style.maxHeight = `${contentHeight}px`;
      } else {
        wrapper.style.maxHeight = '0px';
      }
    };

    updateMaxHeight();

    const resizeObserver = new ResizeObserver(updateMaxHeight);
    resizeObserver.observe(content);

    return () => resizeObserver.disconnect();
  }, [isOpen]);

  const handleToggle = () => {
    if (isControlled) {
      onToggle?.();
    } else {
      setInternalIsOpen((prev) => !prev);
    }
  };

  const handleMouseEnter = () => {
    if (!canToggleVisibility) return;
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovering(true);
    }, 250);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setIsHovering(false);
  };

  const handleVisibilityClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleVisibility?.();
  };

  const handleResetClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onReset?.();
  };

  return (
    <div className="bg-surface rounded-lg overflow-hidden flex-shrink-0" onContextMenu={onContextMenu}>
      <div
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-card-active cursor-pointer"
        onClick={handleToggle}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-normal text-text-primary text-shadow-shiny">{title}</h3>
          {canToggleVisibility && onToggleVisibility && (
            <div className="w-6 h-6 flex items-center justify-center">
              <button
                className={`
                  p-1 rounded-full text-text-secondary hover:bg-bg-primary z-10
                  ${isHovering || !isContentVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}
                `}
                onClick={handleVisibilityClick}
                title={isContentVisible ? 'Preview disabled section' : 'Enable section'}
              >
                {isContentVisible ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
            </div>
          )}
          {onReset && (
            <button
              className="text-xs text-text-secondary hover:text-text-primary px-1"
              onClick={handleResetClick}
              title={`Reset ${title}`}
            >
              Reset
            </button>
          )}
        </div>
        <ChevronDown className={`text-accent ${isOpen ? 'rotate-180' : ''}`} size={20} />
      </div>
      <div ref={wrapperRef} className="overflow-hidden">
        <div
          className={`px-4 pb-4 ${!isContentVisible ? 'opacity-30 pointer-events-none' : ''}`}
          ref={contentRef}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export default CollapsibleSection;
