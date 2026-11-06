import { Eye, EyeOff } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

export const HIDDEN_CONTENT_CLASS = 'opacity-30 pointer-events-none';

interface VisibilityToggleProps {
  className?: string;
  isVisible: boolean;
  onToggle(): void;
  revealOnHover?: boolean;
}

export default function VisibilityToggle({ className, isVisible, onToggle, revealOnHover }: VisibilityToggleProps) {
  const { t } = useTranslation();

  return (
    <button
      className={clsx(
        'p-1 rounded-full text-text-secondary hover:bg-bg-primary transition-opacity duration-300',
        revealOnHover &&
          isVisible &&
          'opacity-0 pointer-events-none group-hover/visibility:opacity-100 group-hover/visibility:pointer-events-auto',
        className,
      )}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      data-tooltip={isVisible ? t('ui.collapsibleSection.disableSection') : t('ui.collapsibleSection.enableSection')}
    >
      {isVisible ? <Eye size={16} /> : <EyeOff size={16} />}
    </button>
  );
}
