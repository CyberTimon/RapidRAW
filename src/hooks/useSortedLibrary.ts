import { useMemo } from 'react';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { RawStatus, EditedStatus, SortDirection, ImageFile } from '../components/ui/AppProperties';

export const ADVANCED_QUERY_REGEX =
  /^(iso|aperture|f|shutter|s|focal|mm|rating|color|camera|make|model|lens)\s*(?::)?\s*(>=|<=|>|<|=)?\s*(.+)$/i;

export const parseShutter = (val: string | undefined): number => {
  if (!val) return 0;
  const cleanVal = val.replace(/s/i, '').trim();
  const parts = cleanVal.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    return den !== 0 ? num / den : 0;
  }
  const numVal = parseFloat(cleanVal);
  return isNaN(numVal) ? 0 : numVal;
};

export const parseAperture = (val: string | undefined): number => {
  if (!val) return 0;
  const match = val.match(/(\d+(\.\d+)?)/);
  const numVal = match ? parseFloat(match[0]) : 0;
  return isNaN(numVal) ? 0 : numVal;
};

export const parseFocalLength = (val: string | undefined): number => {
  if (!val) return 0;
  const match = val.match(/(\d+(\.\d+)?)/);
  if (!match) return 0;
  const numVal = parseFloat(match[0]);
  return isNaN(numVal) ? 0 : numVal;
};

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
    if (filterCriteria.rating !== 0) {
      const rating = imageRatings[image.path] || 0;
      if (filterCriteria.rating === -1 && rating !== 0) return false;
      if (filterCriteria.rating === 5 && rating !== 5) return false;
      if (filterCriteria.rating > 0 && filterCriteria.rating < 5 && rating < filterCriteria.rating) return false;
    }

    if (
      filterCriteria.rawStatus &&
      filterCriteria.rawStatus !== RawStatus.All &&
      filterCriteria.rawStatus !== RawStatus.RawOverNonRaw &&
      supportedTypes
    ) {
      const pathWithoutVC = image.path.split('?vc=')[0];
      const extension = pathWithoutVC.split('.').pop()?.toLowerCase() || '';
      const isRaw = supportedTypes.raw?.includes(extension);

      if (filterCriteria.rawStatus === RawStatus.RawOnly && !isRaw) return false;
      if (filterCriteria.rawStatus === RawStatus.NonRawOnly && isRaw) return false;
    }

    if (filterCriteria.editedStatus && filterCriteria.editedStatus !== EditedStatus.All) {
      if (filterCriteria.editedStatus === EditedStatus.EditedOnly && !image.is_edited) return false;
      if (filterCriteria.editedStatus === EditedStatus.UneditedOnly && image.is_edited) return false;
    }

    if (filterCriteria.colors && filterCriteria.colors.length > 0) {
      const imageColor = (image.tags || []).find((tag: string) => tag.startsWith('color:'))?.substring(6);
      const hasMatchingColor = imageColor && filterCriteria.colors.includes(imageColor);
      const matchesNone = !imageColor && filterCriteria.colors.includes('none');

      if (!hasMatchingColor && !matchesNone) return false;
    }

    return true;
  });

  const { tags: searchTags, text: searchText, mode: searchMode } = searchCriteria;
  const lowerCaseSearchText = searchText.trim().toLowerCase();

  const parsedTags = searchTags.map((tag: string) => {
    const match = tag.match(ADVANCED_QUERY_REGEX);
    if (match) {
      const operator = match[2] || '=';
      return { type: 'query', field: match[1].toLowerCase(), operator, value: match[3].toLowerCase(), raw: tag };
    }
    return { type: 'normal', value: tag.toLowerCase(), raw: tag };
  });

  const evaluateQuery = (q: any, image: ImageFile) => {
    const { field, operator, value } = q;

    if (['iso', 'aperture', 'f', 'shutter', 's', 'focal', 'mm', 'rating'].includes(field)) {
      let imgVal = 0;
      let qVal = parseFloat(value);

      if (field === 'iso')
        imgVal = parseInt(image.exif?.PhotographicSensitivity || image.exif?.ISOSpeedRatings || '0', 10) || 0;
      else if (field === 'aperture' || field === 'f') imgVal = parseAperture(image.exif?.FNumber);
      else if (field === 'focal' || field === 'mm') imgVal = parseFocalLength(image.exif?.FocalLength);
      else if (field === 'rating') imgVal = imageRatings[image.path] || 0;
      else if (field === 'shutter' || field === 's') {
        imgVal = parseShutter(image.exif?.ExposureTime);
        qVal = parseShutter(value);
      }

      switch (operator) {
        case '>':
          return imgVal > qVal;
        case '<':
          return imgVal < qVal;
        case '>=':
          return imgVal >= qVal;
        case '<=':
          return imgVal <= qVal;
        case '=':
        case ':':
          return imgVal === qVal;
        default:
          return false;
      }
    } else {
      let imgStr = '';
      if (field === 'camera' || field === 'make' || field === 'model') {
        imgStr = `${image.exif?.Make || ''} ${image.exif?.Model || ''}`.toLowerCase();
      } else if (field === 'lens') {
        imgStr = String(
          `${image.exif?.LensModel || ''} ${image.exif?.Lens || ''} ${image.exif?.LensMake || ''}`,
        ).toLowerCase();
      } else if (field === 'color') {
        imgStr = (image.tags || []).find((t: string) => t.startsWith('color:'))?.substring(6) || '';
      }

      return operator === '=' || operator === ':' ? imgStr.includes(value) : false;
    }
  };

  const filteredBySearch =
    parsedTags.length === 0 && lowerCaseSearchText === ''
      ? filteredList
      : filteredList.filter((image: ImageFile) => {
          const lowerCaseImageTags = (image.tags || []).map((t) => t.toLowerCase().replace('user:', ''));
          const filename = image?.path?.split(/[\\/]/)?.pop()?.toLowerCase() || '';

          let tagsMatch = true;
          if (parsedTags.length > 0) {
            const evaluateTag = (parsedTag: any) => {
              if (parsedTag.type === 'normal') {
                return lowerCaseImageTags.some((imgTag) => imgTag.includes(parsedTag.value));
              }
              return evaluateQuery(parsedTag, image);
            };

            if (searchMode === 'OR') {
              tagsMatch = parsedTags.some((pt) => evaluateTag(pt));
            } else {
              tagsMatch = parsedTags.every((pt) => evaluateTag(pt));
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

  list.sort((a, b) => {
    const { key, order } = sortCriteria;
    let comparison = 0;

    switch (key) {
      case 'date_taken': {
        const dateA = a.exif?.DateTimeOriginal || '';
        const dateB = b.exif?.DateTimeOriginal || '';
        if (dateA !== dateB) comparison = dateA < dateB ? -1 : 1;
        else comparison = a.modified - b.modified;
        break;
      }
      case 'iso': {
        const isoA = parseInt(a.exif?.PhotographicSensitivity || a.exif?.ISOSpeedRatings || '0', 10) || 0;
        const isoB = parseInt(b.exif?.PhotographicSensitivity || b.exif?.ISOSpeedRatings || '0', 10) || 0;
        comparison = isoA - isoB;
        break;
      }
      case 'shutter_speed': {
        comparison = parseShutter(a.exif?.ExposureTime) - parseShutter(b.exif?.ExposureTime);
        break;
      }
      case 'aperture': {
        comparison = parseAperture(a.exif?.FNumber) - parseAperture(b.exif?.FNumber);
        break;
      }
      case 'focal_length': {
        comparison = parseFocalLength(a.exif?.FocalLength) - parseFocalLength(b.exif?.FocalLength);
        break;
      }
      case 'date':
        comparison = a.modified - b.modified;
        break;
      case 'rating':
        comparison = (imageRatings[a.path] || 0) - (imageRatings[b.path] || 0);
        break;
      case 'edited':
        comparison = a.is_edited === b.is_edited ? 0 : a.is_edited ? 1 : -1;
        break;
      default: {
        const nameA = a.path.split(/[\\/]/).pop() || a.path;
        const nameB = b.path.split(/[\\/]/).pop() || b.path;
        comparison = nameA.localeCompare(nameB);
        break;
      }
    }

    if (comparison === 0 && key !== 'name') {
      const nameA = a.path.split(/[\\/]/).pop() || a.path;
      const nameB = b.path.split(/[\\/]/).pop() || b.path;
      return nameA.localeCompare(nameB);
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
