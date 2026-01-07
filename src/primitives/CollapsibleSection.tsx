import { useRef, useEffect, ReactNode } from 'react';
import {
  Disclosure,
  DisclosurePanel,
  Button,
} from 'react-aria-components';
import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import { tv } from 'tailwind-variants';
import { focusRing } from './aria-utils';

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

const headerStyles = tv({
  base: [
    'w-full px-4 py-3 flex items-center justify-between text-left',
    'hover:bg-card-active cursor-pointer',
    'rounded-t-lg',
    focusRing,
  ],
});

const visibilityButtonStyles = tv({
  base: [
    'p-1 rounded-full text-text-secondary hover:bg-bg-primary z-10',
    'transition-opacity duration-150',
    focusRing,
  ],
  variants: {
    isVisible: {
      true: 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto',
      false: 'opacity-100',
    },
  },
});

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
  const contentRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const isControlled = controlledIsOpen !== undefined;

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const content = contentRef.current;
    if (!wrapper || !content) return;

    const updateMaxHeight = () => {
      const isExpanded = wrapper.closest('[data-expanded="true"]') !== null;
      if (isExpanded) {
        const contentHeight = content.scrollHeight;
        wrapper.style.maxHeight = `${contentHeight}px`;
      } else {
        wrapper.style.maxHeight = '0px';
      }
    };

    updateMaxHeight();

    const resizeObserver = new ResizeObserver(updateMaxHeight);
    resizeObserver.observe(content);

    const mutationObserver = new MutationObserver(updateMaxHeight);
    const disclosure = wrapper.closest('[data-expanded]');
    if (disclosure) {
      mutationObserver.observe(disclosure, { attributes: true, attributeFilter: ['data-expanded'] });
    }

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  const handleVisibilityClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleVisibility?.();
  };

  const handleResetClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onReset?.();
  };

  return (
    <Disclosure
      isExpanded={isControlled ? controlledIsOpen : undefined}
      defaultExpanded={!isControlled ? defaultOpen : undefined}
      onExpandedChange={isControlled ? () => onToggle?.() : undefined}
    >
      {({ isExpanded }) => (
        <div
          className="bg-surface rounded-lg overflow-hidden flex-shrink-0"
          onContextMenu={onContextMenu}
          data-expanded={isExpanded}
        >
          <Button slot="trigger" className={headerStyles()}>
            <div className="group flex items-center gap-2">
              <h3 className="text-lg font-normal text-text-primary text-shadow-shiny">{title}</h3>
              {canToggleVisibility && onToggleVisibility && (
                <div className="w-6 h-6 flex items-center justify-center">
                  <span
                    role="button"
                    tabIndex={0}
                    className={visibilityButtonStyles({ isVisible: isContentVisible })}
                    onClick={handleVisibilityClick}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleVisibilityClick(e as unknown as React.MouseEvent);
                      }
                    }}
                    title={isContentVisible ? 'Preview disabled section' : 'Enable section'}
                  >
                    {isContentVisible ? <Eye size={16} /> : <EyeOff size={16} />}
                  </span>
                </div>
              )}
              {onReset && (
                <span
                  role="button"
                  tabIndex={0}
                  className="text-xs text-text-secondary hover:text-text-primary px-1 cursor-pointer"
                  onClick={handleResetClick}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleResetClick(e as unknown as React.MouseEvent);
                    }
                  }}
                  title={`Reset ${title}`}
                >
                  Reset
                </span>
              )}
            </div>
            <ChevronDown
              className={`text-accent transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
              size={20}
            />
          </Button>
          <DisclosurePanel>
            <div
              ref={wrapperRef}
              className="overflow-hidden transition-[max-height] duration-200 ease-in-out"
            >
              <div
                className={`px-4 pb-4 ${!isContentVisible ? 'opacity-30 pointer-events-none' : ''}`}
                ref={contentRef}
              >
                {children}
              </div>
            </div>
          </DisclosurePanel>
        </div>
      )}
    </Disclosure>
  );
}

export default CollapsibleSection;
