import { useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronRight, History } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { filterToAlbumId, monthFilter } from './immichApi';
import ImmichRow from './ImmichRow';
import { useImmichStore } from './useImmichStore';

export default function ImmichTimeline({
  selectedAlbumId,
  onSelectAlbum,
}: {
  selectedAlbumId: string | null;
  onSelectAlbum(albumId: string, albumName: string, images: string[]): void;
}) {
  const { t, i18n } = useTranslation();
  const { timeline, loadTimeline } = useImmichStore(
    useShallow((state) => ({ timeline: state.timeline, loadTimeline: state.loadTimeline })),
  );
  const [isOpen, setOpen] = useState(false);
  const [openYear, setOpenYear] = useState<string | null>(null);

  const years = useMemo(() => {
    const byYear = new Map<string, { month: string; count: number }[]>();
    for (const bucket of timeline) {
      const year = bucket.timeBucket.slice(0, 4);
      byYear.set(year, [...(byYear.get(year) ?? []), { month: bucket.timeBucket, count: bucket.count }]);
    }
    return [...byYear.entries()];
  }, [timeline]);

  const monthName = (bucket: string) =>
    new Date(`${bucket.slice(0, 7)}-01T00:00:00`).toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' });

  const toggle = () => {
    if (!isOpen) loadTimeline();
    setOpen(!isOpen);
  };

  return (
    <>
      <ImmichRow
        icon={History}
        label={t('immich.section.timeline')}
        isSelected={false}
        onSelect={toggle}
        trailing={isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      />
      {isOpen &&
        years.map(([year, months]) => (
          <div key={year} className="pl-4">
            <ImmichRow
              icon={CalendarDays}
              label={year}
              count={months.reduce((sum, m) => sum + m.count, 0)}
              showCount
              isSelected={false}
              onSelect={() => setOpenYear(openYear === year ? null : year)}
            />
            {openYear === year &&
              months.map(({ month, count }) => {
                const id = filterToAlbumId(monthFilter(month));
                return (
                  <div key={month} className="pl-4">
                    <ImmichRow
                      icon={CalendarDays}
                      label={monthName(month)}
                      count={count}
                      showCount
                      isSelected={selectedAlbumId === id}
                      onSelect={() => onSelectAlbum(id, monthName(month), [])}
                    />
                  </div>
                );
              })}
          </div>
        ))}
    </>
  );
}
