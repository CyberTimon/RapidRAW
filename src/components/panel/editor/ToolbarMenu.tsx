import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { LucideIcon } from 'lucide-react';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';

export const useMenuDismiss = (
  containerRef: React.RefObject<HTMLElement | null>,
  isOpen: boolean,
  setOpen: (open: boolean) => void,
) => {
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [containerRef, isOpen, setOpen]);
};

interface ToolbarMenuProps {
  children: React.ReactNode;
  isOpen: boolean;
  title: string;
}

export function ToolbarMenu({ children, isOpen, title }: ToolbarMenuProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="absolute top-full right-0 mt-3 w-64 origin-top-right z-50"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.1, ease: 'easeOut' }}
        >
          <div className="bg-surface/90 backdrop-blur-md rounded-lg shadow-xl py-3 flex flex-col gap-1" role="menu">
            <Text
              as="div"
              variant={TextVariants.small}
              weight={TextWeights.semibold}
              className="px-4 h-8 flex items-center uppercase"
            >
              {title}
            </Text>
            <div className="max-h-80 overflow-y-auto custom-scrollbar flex flex-col px-1">{children}</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface ToolbarMenuItemProps {
  detail?: React.ReactNode;
  icon?: LucideIcon;
  isDimmed?: boolean;
  isSelected: boolean;
  label: string;
  onClick(): void;
  onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>): void;
}

export function ToolbarMenuItem({
  detail,
  icon: Icon,
  isDimmed,
  isSelected,
  label,
  onClick,
  onKeyDown,
}: ToolbarMenuItemProps) {
  const textColor = isSelected ? TextColors.button : isDimmed ? TextColors.secondary : TextColors.primary;
  const textWeight = isSelected ? TextWeights.medium : TextWeights.normal;

  return (
    <button
      role="menuitemradio"
      aria-checked={isSelected}
      data-active={isSelected}
      className={clsx(
        'mx-1 my-0.5 px-3 py-2 rounded-md flex items-center gap-3 text-left transition-colors',
        isSelected
          ? 'bg-accent'
          : isDimmed
            ? 'opacity-50 hover:bg-bg-primary hover:opacity-100'
            : 'hover:bg-bg-primary',
      )}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {Icon && <Icon size={16} className={clsx('shrink-0', isSelected ? 'text-button-text' : 'text-text-secondary')} />}
      <Text as="span" color={textColor} weight={textWeight} className="flex-1 truncate">
        {label}
      </Text>
      {detail !== undefined && (
        <Text
          as="span"
          variant={TextVariants.small}
          color={textColor}
          weight={textWeight}
          className="opacity-50 shrink-0"
        >
          {detail}
        </Text>
      )}
    </button>
  );
}
