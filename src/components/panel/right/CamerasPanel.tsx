import { useMemo, useState } from 'react';
import { Aperture, Camera, ChevronRight, X } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import Text from '../../ui/Text';
import { EquipmentFacetKind } from '../../ui/AppProperties';
import { TextVariants } from '../../../types/typography';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { buildEquipmentFacetGroups, EquipmentFacetGroup } from '../../../utils/libraryFacets';

function EquipmentGroupRow({
  group,
  isExpanded,
  kind,
  onExpand,
}: {
  group: EquipmentFacetGroup;
  isExpanded: boolean;
  kind: EquipmentFacetKind;
  onExpand: () => void;
}) {
  const libraryFacet = useLibraryStore((state) => state.libraryFacet);
  const setLibraryFacet = useLibraryStore((state) => state.setLibraryFacet);
  const isParentSelected =
    libraryFacet?.kind === kind && libraryFacet.primary === group.make && !libraryFacet.secondary;

  const selectMake = () => {
    setLibraryFacet({ kind, primary: group.make });
    if (!isExpanded) onExpand();
  };

  return (
    <li>
      <div
        className={clsx(
          'flex items-center mx-1 rounded-md transition-colors',
          isParentSelected ? 'bg-surface text-text-primary' : 'text-text-secondary hover:bg-card-active',
        )}
      >
        <button
          className="p-1.5 shrink-0"
          onClick={onExpand}
          aria-label={isExpanded ? `Collapse ${group.make}` : `Expand ${group.make}`}
        >
          <ChevronRight size={16} className={clsx('transition-transform', isExpanded && 'rotate-90')} />
        </button>
        <button className="flex flex-1 min-w-0 items-center gap-2 py-2 pr-2 text-left" onClick={selectMake}>
          <span className="text-sm truncate flex-1">{group.make}</span>
          <span className="text-xs tabular-nums opacity-70">{group.count.toLocaleString()}</span>
        </button>
      </div>

      {isExpanded && (
        <ul className="ml-7 mr-1">
          {group.children.map((child) => {
            const isSelected =
              libraryFacet?.kind === kind &&
              libraryFacet.primary === group.make &&
              libraryFacet.secondary === child.name;
            const Icon = kind === 'camera' ? Camera : Aperture;

            return (
              <li key={child.name}>
                <button
                  className={clsx(
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors',
                    isSelected
                      ? 'bg-surface text-text-primary'
                      : 'text-text-secondary hover:bg-card-active hover:text-text-primary',
                  )}
                  onClick={() => setLibraryFacet({ kind, primary: group.make, secondary: child.name })}
                >
                  <Icon size={15} className="shrink-0" />
                  <span className="text-sm truncate flex-1">{child.name}</span>
                  <span className="text-xs tabular-nums opacity-70">{child.count.toLocaleString()}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export default function CamerasPanel() {
  const { t } = useTranslation();
  const imageList = useLibraryStore((state) => state.imageList);
  const libraryFacet = useLibraryStore((state) => state.libraryFacet);
  const kind = useLibraryStore((state) => state.equipmentFacetKind);
  const setEquipmentFacetKind = useLibraryStore((state) => state.setEquipmentFacetKind);
  const setLibraryFacet = useLibraryStore((state) => state.setLibraryFacet);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(libraryFacet && libraryFacet.kind !== 'location' ? [libraryFacet.primary] : []),
  );

  const groups = useMemo(() => buildEquipmentFacetGroups(imageList, kind), [imageList, kind]);
  const hasPendingExif = imageList.some((image) => !image.exif);
  const hasActiveFilter = libraryFacet?.kind === kind;
  const title = kind === 'camera' ? t('library.facets.cameras.title') : t('library.facets.cameras.lensesTitle');
  const toggleTooltip =
    kind === 'camera' ? t('library.facets.cameras.switchToLenses') : t('library.facets.cameras.switchToCameras');

  const toggleKind = () => {
    const nextKind = kind === 'camera' ? 'lens' : 'camera';
    if (libraryFacet?.kind === 'camera' || libraryFacet?.kind === 'lens') setLibraryFacet(null);
    setEquipmentFacetKind(nextKind);
  };

  const toggleExpanded = (make: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(make)) next.delete(make);
      else next.add(make);
      return next;
    });
  };

  return (
    <div className="h-full flex flex-col bg-bg-secondary">
      <div className="p-3 flex items-center gap-2 shrink-0 border-b border-surface">
        <Text variant={TextVariants.title} className="flex-1 min-w-0 truncate">
          {title}
          {groups.length > 0 && ` (${groups.length.toLocaleString()})`}
        </Text>
        {hasActiveFilter && (
          <button
            className="p-1.5 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary"
            onClick={() => setLibraryFacet(null)}
            data-tooltip={t('library.facets.cameras.clearFilter')}
            aria-label={t('library.facets.cameras.clearFilter')}
          >
            <X size={16} />
          </button>
        )}
        <button
          className="p-1.5 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary"
          onClick={toggleKind}
          data-tooltip={toggleTooltip}
          aria-label={toggleTooltip}
        >
          {kind === 'camera' ? <Camera size={18} /> : <Aperture size={18} />}
        </button>
      </div>

      {groups.length > 0 ? (
        <ul className="flex-1 min-h-0 overflow-y-auto py-1 custom-scrollbar">
          {groups.map((group) => (
            <EquipmentGroupRow
              key={group.make}
              group={group}
              isExpanded={expandedGroups.has(group.make)}
              kind={kind}
              onExpand={() => toggleExpanded(group.make)}
            />
          ))}
        </ul>
      ) : (
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <Text className="text-text-secondary">
            {hasPendingExif ? t('library.facets.readingMetadata') : t('library.facets.cameras.empty')}
          </Text>
        </div>
      )}
    </div>
  );
}
