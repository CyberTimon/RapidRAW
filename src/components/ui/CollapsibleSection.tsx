import { useRef, useEffect, useState } from 'react';
import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import clsx from 'clsx';
import Text from './Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import { UiMode } from './AppProperties';
import { useSettingsStore } from '../../store/useSettingsStore';

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
  const isCompact = useSettingsStore((state) => state.appSettings?.uiMode === UiMode.Compact);
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
    <div
      className={clsx(
        'rounded-lg overflow-hidden shrink-0',
        isCompact
          ? 'bg-transparent [&_button]:!text-white [&_h1]:!text-white [&_h2]:!text-white [&_h3]:!text-white [&_input]:!text-white [&_label]:!text-white [&_p]:!text-white [&_span]:!text-white [&_textarea]:!text-white'
          : 'bg-surface',
      )}
      onContextMenu={onContextMenu}
    >
      <div
        className={clsx(
          'w-full flex items-center justify-between text-left transition-colors duration-200',
          isCompact ? 'px-0 py-2 text-white' : 'px-4 py-3 hover:bg-card-active',
        )}
        onClick={onToggle}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="flex items-center gap-2">
          <Text
            variant={TextVariants.title}
            weight={TextWeights.normal}
            color={isCompact ? TextColors.white : TextColors.primary}
          >
            {title}
          </Text>
          {canToggleVisibility && (
            <div className="w-6 h-6 flex items-center justify-center">
              <button
                className={clsx(
                  'p-1 rounded-full z-10 transition-opacity duration-300',
                  isCompact ? 'text-white hover:bg-white/10' : 'text-text-secondary hover:bg-bg-primary',
                  isHovering || !isContentVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
                )}
                onClick={handleVisibilityClick}
                data-tooltip={isContentVisible ? 'Disable Section' : 'Enable Section'}
              >
                {isContentVisible ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
            </div>
          )}
        </div>
        <ChevronDown
          className={clsx(isCompact ? 'text-white' : 'text-accent', 'transition-transform duration-300', {
            'rotate-180': isOpen,
          })}
          size={20}
        />
      </div>
      <div ref={wrapperRef} className="overflow-hidden transition-all duration-300 ease-in-out">
        <div
          className={clsx(
            'transition-opacity duration-300',
            isCompact ? 'px-0 pb-3 text-white' : 'px-4 pb-4',
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
