import { useMemo } from 'react';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { RawStatus, SortDirection, ImageFile } from '../components/ui/AppProperties';

export function computeSortedLibrary(libraryState: any, settingsState: any): ImageFile[] {
  const { imageList, imageRatings, filterCriteria, searchCriteria, sortCriteria } = libraryState;
  const { appSettings, supportedTypes } = settingsState;

  const getParentDir = (filePath: string): string => {
    const separator = filePath.includes('/') ? '/' : '\\';
    const lastSeparatorIndex = filePath.lastIndexOf(separator);
    if (lastSeparatorIndex === -1) {
      return '';
    }
    return filePath.substring(0, lastSeparatorIndex);
  };

  let processedList = imageList;

  if (filterCriteria.rawStatus === RawStatus.RawOverNonRaw && supportedTypes) {
    const rawBaseNames = new Set<string>();

    for (const image of imageList) {
      const pathWithoutVC = image.path.split('?vc=')[0];
      const filename = pathWithoutVC.split(/[\\/]/).pop() || '';
      const lastDotIndex = filename.lastIndexOf('.');
      const extension = lastDotIndex !== -1 ? filename.substring(lastDotIndex + 1).toLowerCase() : '';

      if (extension && supportedTypes.raw.includes(extension)) {
        const baseName = lastDotIndex !== -1 ? filename.substring(0, lastDotIndex) : filename;
        const parentDir = getParentDir(pathWithoutVC);
        const uniqueKey = `${parentDir}/${baseName}`;
        rawBaseNames.add(uniqueKey);
      }
    }

    if (rawBaseNames.size > 0) {
      processedList = imageList.filter((image: ImageFile) => {
        const pathWithoutVC = image.path.split('?vc=')[0];
        const filename = pathWithoutVC.split(/[\\/]/).pop() || '';
        const lastDotIndex = filename.lastIndexOf('.');
        const extension = lastDotIndex !== -1 ? filename.substring(lastDotIndex + 1).toLowerCase() : '';

        const isNonRaw = extension && supportedTypes.nonRaw.includes(extension);

        if (isNonRaw) {
          const baseName = lastDotIndex !== -1 ? filename.substring(0, lastDotIndex) : filename;
          const parentDir = getParentDir(pathWithoutVC);
          const uniqueKey = `${parentDir}/${baseName}`;

          if (rawBaseNames.has(uniqueKey)) {
            return false;
          }
        }

        return true;
      });
    }
  }

  const filteredList = processedList.filter((image: ImageFile) => {
    if (filterCriteria.rating > 0) {
      const rating = imageRatings[image.path] || 0;
      if (filterCriteria.rating === 5) {
        if (rating !== 5) return false;
      } else {
        if (rating < filterCriteria.rating) return false;
      }
    }

    if (
      filterCriteria.rawStatus &&
      filterCriteria.rawStatus !== RawStatus.All &&
      filterCriteria.rawStatus !== RawStatus.RawOverNonRaw &&
      supportedTypes
    ) {
      const extension = image.path.split('.').pop()?.toLowerCase() || '';
      const isRaw = supportedTypes.raw?.includes(extension);

      if (filterCriteria.rawStatus === RawStatus.RawOnly && !isRaw) {
        return false;
      }
      if (filterCriteria.rawStatus === RawStatus.NonRawOnly && isRaw) {
        return false;
      }
    }

    if (filterCriteria.colors && filterCriteria.colors.length > 0) {
      const imageColor = (image.tags || []).find((tag: string) => tag.startsWith('color:'))?.substring(6);

      const hasMatchingColor = imageColor && filterCriteria.colors.includes(imageColor);
      const matchesNone = !imageColor && filterCriteria.colors.includes('none');

      if (!hasMatchingColor && !matchesNone) {
        return false;
      }
    }

    return true;
  });

  const { tags: searchTags, text: searchText, mode: searchMode } = searchCriteria;
  const lowerCaseSearchText = searchText.trim().toLowerCase();

  const filteredBySearch =
    searchTags.length === 0 && lowerCaseSearchText === ''
      ? filteredList
      : filteredList.filter((image: ImageFile) => {
          const lowerCaseImageTags = (image.tags || []).map((t) => t.toLowerCase().replace('user:', ''));
          const filename = image?.path?.split(/[\\/]/)?.pop()?.toLowerCase() || '';

          let tagsMatch = true;
          if (searchTags.length > 0) {
            const lowerCaseSearchTags = searchTags.map((t) => t.toLowerCase());
            if (searchMode === 'OR') {
              tagsMatch = lowerCaseSearchTags.some((searchTag) =>
                lowerCaseImageTags.some((imgTag) => imgTag.includes(searchTag)),
              );
            } else {
              tagsMatch = lowerCaseSearchTags.every((searchTag) =>
                lowerCaseImageTags.some((imgTag) => imgTag.includes(searchTag)),
              );
            }
          }

          let textMatch = true;
          if (lowerCaseSearchText !== '') {
            textMatch =
              filename.includes(lowerCaseSearchText) || lowerCaseImageTags.some((t) => t.includes(lowerCaseSearchText));
          }

          return tagsMatch && textMatch;
        });

  const list = [...filteredBySearch];

  const parseShutter = (val: string | undefined): number | null => {
    if (!val) return null;
    const cleanVal = val.replace(/s/i, '').trim();
    const parts = cleanVal.split('/');
    if (parts.length === 2) {
      const num = parseFloat(parts[0]);
      const den = parseFloat(parts[1]);
      return den !== 0 ? num / den : null;
    }
    const numVal = parseFloat(cleanVal);
    return isNaN(numVal) ? null : numVal;
  };

  const parseAperture = (val: string | undefined): number | null => {
    if (!val) return null;
    const match = val.match(/(\d+(\.\d+)?)/);
    const numVal = match ? parseFloat(match[0]) : null;
    return numVal === null || isNaN(numVal) ? null : numVal;
  };

  const parseFocalLength = (val: string | undefined): number | null => {
    if (!val) return null;
    const match = val.match(/(\d+(\.\d+)?)/);
    if (!match) return null;
    const numVal = parseFloat(match[0]);
    return isNaN(numVal) ? null : numVal;
  };

  list.sort((a, b) => {
    const { key, order } = sortCriteria;
    let comparison = 0;

    const compareNullable = (valA: any, valB: any) => {
      if (valA !== null && valB !== null) {
        if (valA < valB) return -1;
        if (valA > valB) return 1;
        return 0;
      }
      if (valA !== null) return -1;
      if (valB !== null) return 1;
      return 0;
    };

    switch (key) {
      case 'date_taken': {
        const dateA = a.exif?.DateTimeOriginal;
        const dateB = b.exif?.DateTimeOriginal;
        comparison = compareNullable(dateA, dateB);
        if (comparison === 0) comparison = a.modified - b.modified;
        break;
      }
      case 'iso': {
        const getIso = (exif: { [key: string]: string } | null): number | null => {
          if (!exif) return null;
          const isoStr = exif.PhotographicSensitivity || exif.ISOSpeedRatings;
          if (!isoStr) return null;
          const isoNum = parseInt(isoStr, 10);
          return isNaN(isoNum) ? null : isoNum;
        };
        const isoA = getIso(a.exif);
        const isoB = getIso(b.exif);
        comparison = compareNullable(isoA, isoB);
        break;
      }
      case 'shutter_speed': {
        const shutterA = parseShutter(a.exif?.ExposureTime);
        const shutterB = parseShutter(b.exif?.ExposureTime);
        comparison = compareNullable(shutterA, shutterB);
        break;
      }
      case 'aperture': {
        const apertureA = parseAperture(a.exif?.FNumber);
        const apertureB = parseAperture(b.exif?.FNumber);
        comparison = compareNullable(apertureA, apertureB);
        break;
      }
      case 'focal_length': {
        const focalA = parseFocalLength(a.exif?.FocalLength);
        const focalB = parseFocalLength(b.exif?.FocalLength);
        comparison = compareNullable(focalA, focalB);
        break;
      }
      case 'date':
        comparison = a.modified - b.modified;
        break;
      case 'rating':
        comparison = (imageRatings[a.path] || 0) - (imageRatings[b.path] || 0);
        break;
      default:
        comparison = a.path.localeCompare(b.path);
        break;
    }

    if (comparison === 0 && key !== 'name') {
      return a.path.localeCompare(b.path);
    }

    return order === SortDirection.Ascending ? comparison : -comparison;
  });

  return list;
}

export function useSortedLibrary() {
  const imageList = useLibraryStore((state) => state.imageList);
  const imageRatings = useLibraryStore((state) => state.imageRatings);
  const filterCriteria = useLibraryStore((state) => state.filterCriteria);
  const searchCriteria = useLibraryStore((state) => state.searchCriteria);
  const sortCriteria = useLibraryStore((state) => state.sortCriteria);

  const appSettings = useSettingsStore((state) => state.appSettings);
  const supportedTypes = useSettingsStore((state) => state.supportedTypes);

  const sortedImageList = useMemo(() => {
    return computeSortedLibrary(
      { imageList, imageRatings, filterCriteria, searchCriteria, sortCriteria },
      { appSettings, supportedTypes },
    );
  }, [imageList, sortCriteria, imageRatings, filterCriteria, supportedTypes, searchCriteria, appSettings]);

  return sortedImageList;
}
