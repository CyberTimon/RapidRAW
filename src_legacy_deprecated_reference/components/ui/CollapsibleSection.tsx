import { useRef, useEffect, useState } from 'react';
import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import clsx from 'clsx';

interface CollapsibleSectionProps {
  canToggleVisibility?: boolean;
  children: any;
  isContentVisible: boolean;
  isOpen: boolean;
  onContextMenu?: any;
  onToggle: any;
  onToggleVisibility?: any;
  title: string;
}

export default function CollapsibleSection({
  canToggleVisibility = true,
  children,
  isContentVisible,
  isOpen,
  onContextMenu,
  onToggle,
  onToggleVisibility = () => {},
  title,
}: CollapsibleSectionProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const hoverTimeoutRef = useRef<any>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) {
      return;
    }

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

  const handleMouseEnter = () => {
    if (!canToggleVisibility) {
      return;
    }
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

  const handleVisibilityClick = (e: any) => {
    e.stopPropagation();
    onToggleVisibility();
  };

  return (
    <div className="bg-surface rounded-lg overflow-hidden flex-shrink-0" onContextMenu={onContextMenu}>
      <div
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-card-active transition-colors duration-200"
        onClick={onToggle}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-normal text-primary text-shadow-shiny">{title}</h3>
          {canToggleVisibility && (
            <div className="w-6 h-6 flex items-center justify-center">
              <button
                className={clsx(
                  'p-1 rounded-full text-text-secondary hover:bg-bg-primary z-10 transition-opacity duration-300',
                  isHovering || !isContentVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
                )}
                onClick={handleVisibilityClick}
                title={isContentVisible ? 'Preview disabled section' : 'Enable section'}
              >
                {isContentVisible ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
            </div>
          )}
        </div>
        <ChevronDown
          className={clsx('text-accent transition-transform duration-300', { 'rotate-180': isOpen })}
          size={20}
        />
      </div>
      <div ref={wrapperRef} className="overflow-hidden transition-all duration-300 ease-in-out">
        <div
          className={clsx(
            'px-4 pb-4 transition-opacity duration-300',
            !isContentVisible && 'opacity-30 pointer-events-none',
          )}
          ref={contentRef}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
