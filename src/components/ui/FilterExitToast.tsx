import { useTranslation } from 'react-i18next';
import Button from './Button';

interface FilterExitToastProps {
  fileName: string;
  count: number;
  onUndo: () => void;
}

const FilterExitToast = ({ fileName, count, onUndo }: FilterExitToastProps) => {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between gap-4 w-full">
      <span className="text-sm min-w-0 break-words">
        {count === 1
          ? t('library.filterExit.hiddenSingle', { name: fileName })
          : t('library.filterExit.hiddenMultiple', { count })}
      </span>
      <Button className="shrink-0 py-1! px-3! text-sm!" onClick={onUndo}>
        {t('library.filterExit.undo')}
      </Button>
    </div>
  );
};

export default FilterExitToast;
