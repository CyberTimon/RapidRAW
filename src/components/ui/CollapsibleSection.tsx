import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import Text from './Text';
import VisibilityToggle from './VisibilityToggle';
import { TextVariants, TextWeights } from '../../types/typography';
import { useCollapsibleHeight } from '../../hooks/useCollapsibleHeight';

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
  const { contentRef, wrapperRef } = useCollapsibleHeight(isOpen);
  const [isHovering, setIsHovering] = useState(false);
  const hoverTimeoutRef = useRef<any>(null);

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

  return (
    <div className="bg-surface rounded-lg overflow-hidden shrink-0" onContextMenu={onContextMenu}>
      <div
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-card-active transition-colors duration-200"
        onClick={onToggle}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="flex items-center gap-2">
          <Text variant={TextVariants.title} weight={TextWeights.normal}>
            {title}
          </Text>
          {canToggleVisibility && (
            <div className="w-6 h-6 flex items-center justify-center">
              <VisibilityToggle
                className={clsx(
                  'z-10',
                  isHovering || !isContentVisible ? 'opacity-100' : 'opacity-0 pointer-events-none',
                )}
                isVisible={isContentVisible}
                onToggle={onToggleVisibility}
              />
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
