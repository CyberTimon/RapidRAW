import { Eye, EyeOff } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

interface VisibilityToggleProps {
  className?: string;
  isVisible: boolean;
  onToggle(): void;
}

export default function VisibilityToggle({ className, isVisible, onToggle }: VisibilityToggleProps) {
  const { t } = useTranslation();

  return (
    <button
      className={clsx(
        'p-1 rounded-full text-text-secondary hover:bg-bg-primary transition-opacity duration-300',
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
