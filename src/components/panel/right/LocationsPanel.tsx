import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronRight, MapPin, X } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

import Text from '../../ui/Text';
import { Invokes } from '../../ui/AppProperties';
import { TextVariants } from '../../../types/typography';
import { useLibraryStore } from '../../../store/useLibraryStore';
import {
  buildLocationFacetGroups,
  GEO_EXIF_KEYS,
  GeoLocationResult,
  getGeoCoordinateRequest,
  LocationFacetGroup,
} from '../../../utils/libraryFacets';

function LocationGroupRow({
  countryName,
  group,
  isExpanded,
  onExpand,
}: {
  countryName: string;
  group: LocationFacetGroup;
  isExpanded: boolean;
  onExpand: () => void;
}) {
  const libraryFacet = useLibraryStore((state) => state.libraryFacet);
  const setLibraryFacet = useLibraryStore((state) => state.setLibraryFacet);
  const isParentSelected =
    libraryFacet?.kind === 'location' &&
    libraryFacet.primary === group.admin1 &&
    libraryFacet.countryCode === group.countryCode &&
    !libraryFacet.secondary;

  const selectRegion = () => {
    setLibraryFacet({ kind: 'location', primary: group.admin1, countryCode: group.countryCode });
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
          aria-label={isExpanded ? `Collapse ${group.admin1}` : `Expand ${group.admin1}`}
        >
          <ChevronRight size={16} className={clsx('transition-transform', isExpanded && 'rotate-90')} />
        </button>
        <button className="flex flex-1 min-w-0 items-center gap-2 py-2 pr-2 text-left" onClick={selectRegion}>
          <span className="text-sm truncate flex-1">
            {group.admin1}
            {countryName ? `, ${countryName}` : ''}
          </span>
          <span className="text-xs tabular-nums opacity-70">{group.count.toLocaleString()}</span>
        </button>
      </div>

      {isExpanded && (
        <ul className="ml-7 mr-1">
          {group.children.map((child) => {
            const isSelected =
              libraryFacet?.kind === 'location' &&
              libraryFacet.primary === group.admin1 &&
              libraryFacet.countryCode === group.countryCode &&
              libraryFacet.secondary === child.name;

            return (
              <li key={child.name}>
                <button
                  className={clsx(
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors',
                    isSelected
                      ? 'bg-surface text-text-primary'
                      : 'text-text-secondary hover:bg-card-active hover:text-text-primary',
                  )}
                  onClick={() =>
                    setLibraryFacet({
                      kind: 'location',
                      primary: group.admin1,
                      secondary: child.name,
                      countryCode: group.countryCode,
                    })
                  }
                >
                  <MapPin size={15} className="shrink-0" />
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

export default function LocationsPanel() {
  const { t, i18n } = useTranslation();
  const imageList = useLibraryStore((state) => state.imageList);
  const libraryFacet = useLibraryStore((state) => state.libraryFacet);
  const setLibrary = useLibraryStore((state) => state.setLibrary);
  const setLibraryFacet = useLibraryStore((state) => state.setLibraryFacet);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () =>
      new Set(
        libraryFacet?.kind === 'location' ? [`${libraryFacet.countryCode ?? ''}\u0000${libraryFacet.primary}`] : [],
      ),
  );
  const [activeGeocodeRequests, setActiveGeocodeRequests] = useState(0);
  const pendingPathsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const coordinateRequests = useMemo(
    () => imageList.map(getGeoCoordinateRequest).filter((request) => request !== null),
    [imageList],
  );

  useEffect(() => {
    const pending = coordinateRequests.filter((request) => !pendingPathsRef.current.has(request.path));
    if (pending.length === 0) return;

    pending.forEach((request) => pendingPathsRef.current.add(request.path));
    setActiveGeocodeRequests((count) => count + 1);

    invoke<GeoLocationResult[]>(Invokes.ReverseGeocodeCoordinates, { coordinates: pending })
      .then((results) => {
        const byPath = new Map(results.map((result) => [result.path, result]));
        setLibrary((state) => ({
          imageList: state.imageList.map((image) => {
            const location = byPath.get(image.path);
            if (!location || !image.exif) return image;
            return {
              ...image,
              exif: {
                ...image.exif,
                [GEO_EXIF_KEYS.admin1]: location.admin1,
                [GEO_EXIF_KEYS.admin2]: location.admin2,
                [GEO_EXIF_KEYS.countryCode]: location.countryCode,
                [GEO_EXIF_KEYS.name]: location.name,
              },
            };
          }),
        }));
      })
      .catch((error) => {
        console.error('Failed to identify photo locations:', error);
      })
      .finally(() => {
        if (mountedRef.current) setActiveGeocodeRequests((count) => Math.max(0, count - 1));
      });
  }, [coordinateRequests, setLibrary]);

  const groups = useMemo(() => buildLocationFacetGroups(imageList), [imageList]);
  const hasPendingExif = imageList.some((image) => !image.exif);
  const isGeocoding =
    activeGeocodeRequests > 0 || coordinateRequests.some((request) => !pendingPathsRef.current.has(request.path));
  const hasActiveFilter = libraryFacet?.kind === 'location';
  const regionNames = useMemo(() => {
    try {
      return new Intl.DisplayNames([i18n.language], { type: 'region' });
    } catch {
      return null;
    }
  }, [i18n.language]);

  const toggleExpanded = (group: LocationFacetGroup) => {
    const key = `${group.countryCode}\u0000${group.admin1}`;
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="h-full flex flex-col bg-bg-secondary">
      <div className="p-3 flex items-center gap-2 shrink-0 border-b border-surface">
        <Text variant={TextVariants.title} className="flex-1 min-w-0 truncate">
          {t('library.facets.locations.title')}
          {groups.length > 0 && ` (${groups.length.toLocaleString()})`}
        </Text>
        {hasActiveFilter && (
          <button
            className="p-1.5 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary"
            onClick={() => setLibraryFacet(null)}
            data-tooltip={t('library.facets.locations.clearFilter')}
            aria-label={t('library.facets.locations.clearFilter')}
          >
            <X size={16} />
          </button>
        )}
      </div>

      {groups.length > 0 ? (
        <ul className="flex-1 min-h-0 overflow-y-auto py-1 custom-scrollbar">
          {groups.map((group) => {
            const key = `${group.countryCode}\u0000${group.admin1}`;
            const countryName = group.countryCode ? regionNames?.of(group.countryCode) || group.countryCode : '';
            return (
              <LocationGroupRow
                key={key}
                countryName={countryName}
                group={group}
                isExpanded={expandedGroups.has(key)}
                onExpand={() => toggleExpanded(group)}
              />
            );
          })}
        </ul>
      ) : (
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <Text className="text-text-secondary">
            {isGeocoding
              ? t('library.facets.locations.geocoding')
              : hasPendingExif
                ? t('library.facets.readingMetadata')
                : t('library.facets.locations.empty')}
          </Text>
        </div>
      )}
    </div>
  );
}
