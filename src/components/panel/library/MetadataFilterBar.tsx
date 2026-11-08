import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronRight, Filter, Plus, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import clsx from 'clsx';
import Dropdown from '../../ui/Dropdown';
import Text from '../../ui/Text';
import { TextColors, TextVariants } from '../../../types/typography';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { ImageFile } from '../../ui/AppProperties';
import {
  compareMetadataFilterValues,
  getMetadataFilterValue,
  hasActiveMetadataFilters,
  matchesMetadataFilters,
  MAX_METADATA_FILTER_COLUMNS,
  METADATA_FILTER_FIELDS,
  MetadataFilterField,
  normalizeFilterBarSettings,
  UNKNOWN_VALUE,
  updateMetadataFilterBar,
} from '../../../utils/metadataFilters';

interface ColumnEntry {
  value: string;
  count: number;
}

export default function MetadataFilterBar() {
  const { t } = useTranslation();
  const { imageList, exifByPath, imageRatings, metadataFilters, setLibrary } = useLibraryStore(
    useShallow((state) => ({
      imageList: state.imageList,
      exifByPath: state.exifByPath,
      imageRatings: state.imageRatings,
      metadataFilters: state.metadataFilters,
      setLibrary: state.setLibrary,
    })),
  );
  const rawBarSettings = useSettingsStore((state) => state.appSettings?.metadataFilterBar);
  const bar = useMemo(() => normalizeFilterBarSettings(rawBarSettings), [rawBarSettings]);

  const fieldLabels = useMemo<Record<MetadataFilterField, string>>(
    () => ({
      date: t('library.metadataFilter.fields.date'),
      camera: t('library.metadataFilter.fields.camera'),
      lens: t('library.metadataFilter.fields.lens'),
      iso: t('library.metadataFilter.fields.iso'),
      aperture: t('library.metadataFilter.fields.aperture'),
      shutter: t('library.metadataFilter.fields.shutter'),
      focal: t('library.metadataFilter.fields.focal'),
      edited: t('library.metadataFilter.fields.edited'),
      rating: t('library.metadataFilter.fields.rating'),
      flag: t('library.metadataFilter.fields.flag'),
      color: t('library.metadataFilter.fields.color'),
      fileType: t('library.metadataFilter.fields.fileType'),
    }),
    [t],
  );

  const valueLabels = useMemo<Record<string, string>>(
    () => ({
      [UNKNOWN_VALUE]: t('library.metadataFilter.unknown'),
      'edited:edited': t('library.metadataFilter.values.edited'),
      'edited:unedited': t('library.metadataFilter.values.unedited'),
      'flag:pick': t('library.metadataFilter.values.picked'),
      'flag:reject': t('library.metadataFilter.values.rejected'),
      'flag:none': t('library.metadataFilter.values.unflagged'),
      'rating:0': t('library.metadataFilter.values.unrated'),
      'color:none': t('library.metadataFilter.values.noLabel'),
      'color:red': t('library.metadataFilter.values.red'),
      'color:yellow': t('library.metadataFilter.values.yellow'),
      'color:green': t('library.metadataFilter.values.green'),
      'color:blue': t('library.metadataFilter.values.blue'),
      'color:purple': t('library.metadataFilter.values.purple'),
    }),
    [t],
  );

  const fieldLabel = (field: MetadataFilterField) => fieldLabels[field];

  const valueLabel = (field: MetadataFilterField, value: string) => {
    if (value === UNKNOWN_VALUE) return valueLabels[UNKNOWN_VALUE];
    const translated = valueLabels[`${field}:${value}`];
    if (translated) return translated;
    if (field === 'rating') return '★'.repeat(Number(value));
    return value;
  };

  const columns = useMemo(() => {
    const result = {} as Record<MetadataFilterField, ColumnEntry[]>;
    for (const field of bar.columns) {
      const counts = new Map<string, number>();
      for (const image of imageList as ImageFile[]) {
        const exif = exifByPath[image.path];
        const rating = imageRatings[image.path] || 0;
        const value = getMetadataFilterValue(field, image, exif, rating);
        if (!counts.has(value)) counts.set(value, 0);
        if (matchesMetadataFilters(image, metadataFilters, exif, rating, field)) {
          counts.set(value, counts.get(value)! + 1);
        }
      }
      for (const selected of metadataFilters[field] ?? []) {
        if (!counts.has(selected)) counts.set(selected, 0);
      }
      result[field] = [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => compareMetadataFilterValues(field, a.value, b.value));
    }
    return result;
  }, [bar.columns, imageList, exifByPath, imageRatings, metadataFilters]);

  const setFieldSelection = (field: MetadataFilterField, values: string[]) => {
    setLibrary((state) => ({ metadataFilters: { ...state.metadataFilters, [field]: values } }));
  };

  const toggleValue = (field: MetadataFilterField, value: string) => {
    const current = metadataFilters[field] ?? [];
    setFieldSelection(field, current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);
  };

  const changeColumnField = (index: number, field: MetadataFilterField) => {
    const previous = bar.columns[index];
    if (previous === field) return;
    const next = [...bar.columns];
    next[index] = field;
    updateMetadataFilterBar({ columns: next });
    setFieldSelection(previous, []);
  };

  const removeColumn = (index: number) => {
    const field = bar.columns[index];
    updateMetadataFilterBar({ columns: bar.columns.filter((_, i) => i !== index) });
    setFieldSelection(field, []);
  };

  const addColumn = () => {
    const unused = METADATA_FILTER_FIELDS.find((f) => !bar.columns.includes(f));
    if (unused) updateMetadataFilterBar({ columns: [...bar.columns, unused], expanded: true });
  };

  const isActive = hasActiveMetadataFilters(metadataFilters);
  const activeSummary = (Object.entries(metadataFilters) as Array<[MetadataFilterField, string[]]>)
    .filter(([, values]) => values.length > 0)
    .map(([field, values]) => `${fieldLabel(field)}: ${values.map((v) => valueLabel(field, v)).join(', ')}`)
    .join(' · ');

  return (
    <div className="shrink-0 border-b border-surface">
      <div className="flex items-center gap-2 px-3 h-9">
        <button
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left text-text-secondary hover:text-text-primary transition-colors"
          onClick={() => updateMetadataFilterBar({ expanded: !bar.expanded })}
          data-tooltip={bar.expanded ? t('library.metadataFilter.collapse') : t('library.metadataFilter.expand')}
        >
          {bar.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Filter size={14} className={clsx(isActive && 'text-accent')} />
          <Text variant={TextVariants.small} color={isActive ? TextColors.primary : TextColors.secondary}>
            {t('library.metadataFilter.title')}
          </Text>
          {!bar.expanded && isActive && (
            <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate ml-2">
              {activeSummary}
            </Text>
          )}
        </button>
        {isActive && (
          <button
            className="p-1 rounded-sm text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
            onClick={() => setLibrary({ metadataFilters: {} })}
            data-tooltip={t('library.metadataFilter.clear')}
          >
            <X size={14} />
          </button>
        )}
        {bar.columns.length < MAX_METADATA_FILTER_COLUMNS && (
          <button
            className="p-1 rounded-sm text-text-secondary hover:text-text-primary hover:bg-surface transition-colors"
            onClick={addColumn}
            data-tooltip={t('library.metadataFilter.addColumn')}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {bar.expanded && bar.columns.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div
              className="grid gap-2 px-3 pb-3"
              style={{ gridTemplateColumns: `repeat(${bar.columns.length}, minmax(0, 1fr))` }}
            >
              {bar.columns.map((field, index) => {
                const entries = columns[field] ?? [];
                const selected = metadataFilters[field] ?? [];
                const total = entries.reduce((sum, e) => sum + e.count, 0);
                return (
                  <div key={field} className="flex flex-col min-w-0 bg-surface rounded-md overflow-hidden">
                    <div className="flex items-center gap-1 p-1 border-b border-bg-secondary">
                      <Dropdown
                        className="flex-1 min-w-0"
                        triggerClassName="h-7 text-xs"
                        value={field}
                        onChange={(value) => changeColumnField(index, value)}
                        options={METADATA_FILTER_FIELDS.filter((f) => f === field || !bar.columns.includes(f)).map(
                          (f) => ({ value: f, label: fieldLabel(f) }),
                        )}
                      />
                      <button
                        className="p-1 rounded-sm text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors"
                        onClick={() => removeColumn(index)}
                        data-tooltip={t('library.metadataFilter.removeColumn')}
                      >
                        <X size={12} />
                      </button>
                    </div>
                    <div className="h-36 overflow-y-auto py-1 text-xs">
                      <FilterRow
                        label={t('library.metadataFilter.all')}
                        count={total}
                        selected={selected.length === 0}
                        onClick={() => setFieldSelection(field, [])}
                      />
                      {entries.map((entry) => (
                        <FilterRow
                          key={entry.value}
                          label={valueLabel(field, entry.value)}
                          count={entry.count}
                          selected={selected.includes(entry.value)}
                          onClick={() => toggleValue(field, entry.value)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface FilterRowProps {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}

function FilterRow({ label, count, selected, onClick }: FilterRowProps) {
  return (
    <button
      className={clsx(
        'w-full flex items-center justify-between gap-2 px-2 py-0.5 text-left transition-colors',
        selected ? 'bg-accent/25 text-text-primary' : 'text-text-secondary hover:bg-bg-secondary',
        count === 0 && !selected && 'opacity-50',
      )}
      onClick={onClick}
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 tabular-nums">{count}</span>
    </button>
  );
}
