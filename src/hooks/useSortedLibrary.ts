import { useMemo } from 'react';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import {
  RawStatus,
  EditedStatus,
  FlagStatus,
  ImageFlag,
  SortDirection,
  ImageFile,
  GroupingMode,
} from '../components/ui/AppProperties';
import { buildImageGroups, GroupBadgeInfo, GroupId } from '../utils/imageGrouping';

export const ADVANCED_QUERY_REGEX =
  /^(iso|aperture|f|shutter|s|focal|mm|rating|color|camera|make|model|lens)(?=\s*[:<>=])\s*(?::)?\s*(>=|<=|>|<|=)?\s*(.+)$/i;

const parseShutter = (val: string | undefined): number => {
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

const parseAperture = (val: string | undefined): number => {
  if (!val) return 0;
  const match = val.match(/(\d+(\.\d+)?)/);
  const numVal = match ? parseFloat(match[0]) : 0;
  return isNaN(numVal) ? 0 : numVal;
};

const parseFocalLength = (val: string | undefined): number => {
  if (!val) return 0;
  const match = val.match(/(\d+(\.\d+)?)/);
  if (!match) return 0;
  const numVal = parseFloat(match[0]);
  return isNaN(numVal) ? 0 : numVal;
};

const nameCollator = new Intl.Collator();

const EXIF_SORT_KEYS = new Set(['date_taken', 'iso', 'shutter_speed', 'aperture', 'focal_length']);
const EXIF_QUERY_FIELDS = new Set([
  'iso',
  'aperture',
  'f',
  'shutter',
  's',
  'focal',
  'mm',
  'camera',
  'make',
  'model',
  'lens',
]);
const NO_EXIF: Record<string, Record<string, string>> = {};

function usesExif(sortCriteria: { key: string }, searchCriteria: { tags: string[] }): boolean {
  if (EXIF_SORT_KEYS.has(sortCriteria.key)) return true;
  return searchCriteria.tags.some((tag) => {
    const match = tag.match(ADVANCED_QUERY_REGEX);
    return !!match && EXIF_QUERY_FIELDS.has(match[1].toLowerCase());
  });
}

export interface GroupedLibrary {
  displayList: ImageFile[];
  badges: Map<GroupId, GroupBadgeInfo> | null;
}

function computeGroupedLibrary(
  libraryState: any,
  settingsState: any,
  options: { includeBadges: boolean } = { includeBadges: true },
): GroupedLibrary {
  const { imageList, imageRatings, filterCriteria, searchCriteria, sortCriteria } = libraryState;
  const exifByPath: Record<string, Record<string, string>> = libraryState.exifByPath ?? NO_EXIF;
  const { appSettings } = settingsState;

  const groupingMode: GroupingMode = appSettings?.grouping ?? 'off';
  const isGroupingActive = groupingMode !== 'off';

  const matchesFilter = (image: ImageFile): boolean => {
    if (filterCriteria.rating !== 0) {
      const rating = imageRatings[image.path] || 0;
      if (filterCriteria.rating === -1 && rating !== 0) return false;
      if (filterCriteria.rating > 0) {
        const op = filterCriteria.ratingOperator ?? 'gte';
        if (op === 'eq' && rating !== filterCriteria.rating) return false;
        if (op === 'gte' && rating < filterCriteria.rating) return false;
        if (op === 'lte' && rating > filterCriteria.rating) return false;
      }
    }

    if (filterCriteria.rawStatus && filterCriteria.rawStatus !== RawStatus.All) {
      if (filterCriteria.rawStatus === RawStatus.RawOnly && !image.is_raw) return false;
      if (filterCriteria.rawStatus === RawStatus.NonRawOnly && image.is_raw) return false;
    }

    if (filterCriteria.editedStatus && filterCriteria.editedStatus !== EditedStatus.All) {
      if (filterCriteria.editedStatus === EditedStatus.EditedOnly && !image.is_edited) return false;
      if (filterCriteria.editedStatus === EditedStatus.UneditedOnly && image.is_edited) return false;
    }

    if (filterCriteria.flagStatus && filterCriteria.flagStatus !== FlagStatus.All) {
      if (filterCriteria.flagStatus === FlagStatus.Picked && image.flag !== ImageFlag.Pick) return false;
      if (filterCriteria.flagStatus === FlagStatus.ExcludeRejected && image.flag === ImageFlag.Reject) return false;
      if (filterCriteria.flagStatus === FlagStatus.Rejected && image.flag !== ImageFlag.Reject) return false;
    }

    if (filterCriteria.colors && filterCriteria.colors.length > 0) {
      const imageColor = (image.tags || []).find((tag: string) => tag.startsWith('color:'))?.substring(6);
      const hasMatchingColor = imageColor && filterCriteria.colors.includes(imageColor);
      const matchesNone = !imageColor && filterCriteria.colors.includes('none');

      if (!hasMatchingColor && !matchesNone) return false;
    }

    return true;
  };

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
    const exif = exifByPath[image.path];

    if (['iso', 'aperture', 'f', 'shutter', 's', 'focal', 'mm', 'rating'].includes(field)) {
      let imgVal = 0;
      let qVal = parseFloat(value);

      if (field === 'iso') imgVal = parseInt(exif?.PhotographicSensitivity || exif?.ISOSpeedRatings || '0', 10) || 0;
      else if (field === 'aperture' || field === 'f') imgVal = parseAperture(exif?.FNumber);
      else if (field === 'focal' || field === 'mm') imgVal = parseFocalLength(exif?.FocalLength);
      else if (field === 'rating') imgVal = imageRatings[image.path] || 0;
      else if (field === 'shutter' || field === 's') {
        imgVal = parseShutter(exif?.ExposureTime);
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
        imgStr = `${exif?.Make || ''} ${exif?.Model || ''}`.toLowerCase();
      } else if (field === 'lens') {
        imgStr = String(`${exif?.LensModel || ''} ${exif?.Lens || ''} ${exif?.LensMake || ''}`).toLowerCase();
      } else if (field === 'color') {
        imgStr = (image.tags || []).find((t: string) => t.startsWith('color:'))?.substring(6) || '';
      }

      return operator === '=' || operator === ':' ? imgStr.includes(value) : false;
    }
  };

  const isSearchActive = parsedTags.length > 0 || lowerCaseSearchText !== '';

  const matchesSearch = (image: ImageFile): boolean => {
    if (!isSearchActive) return true;

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
        tagsMatch = parsedTags.some((pt: any) => evaluateTag(pt));
      } else {
        tagsMatch = parsedTags.every((pt: any) => evaluateTag(pt));
      }
    }

    let textMatch = true;
    if (lowerCaseSearchText !== '') {
      textMatch =
        filename.includes(lowerCaseSearchText) || lowerCaseImageTags.some((t) => t.includes(lowerCaseSearchText));
    }

    return tagsMatch && textMatch;
  };

  let processedList = imageList.filter((image: ImageFile) => matchesFilter(image));
  let searchMatchingGroupIds: Set<string> | null = null;

  if (isGroupingActive) {
    const groupEditedFiles = appSettings?.groupEditedFiles ?? true;
    const groupingResult = buildImageGroups(processedList, groupingMode, groupEditedFiles);
    processedList = groupingResult.displayList;

    if (isSearchActive) {
      searchMatchingGroupIds = new Set<string>();
      for (const image of imageList) {
        if (!image.group_id) continue;
        if (matchesSearch(image)) {
          searchMatchingGroupIds.add(image.group_id);
        }
      }
    }
  }

  const filteredBySearch = !isSearchActive
    ? processedList
    : processedList.filter((image: ImageFile) => {
        if (searchMatchingGroupIds && image.group_id && searchMatchingGroupIds.has(image.group_id)) return true;
        return matchesSearch(image);
      });

  const list = [...filteredBySearch];

  const getRatingSortValue = (image: ImageFile) =>
    image.flag === ImageFlag.Reject ? -1 : imageRatings[image.path] || 0;

  const { key, order } = sortCriteria;

  const getNumericSortValue = (image: ImageFile): number => {
    const exif = exifByPath[image.path];
    switch (key) {
      case 'iso':
        return parseInt(exif?.PhotographicSensitivity || exif?.ISOSpeedRatings || '0', 10) || 0;
      case 'shutter_speed':
        return parseShutter(exif?.ExposureTime);
      case 'aperture':
        return parseAperture(exif?.FNumber);
      case 'focal_length':
        return parseFocalLength(exif?.FocalLength);
      case 'rating':
        return getRatingSortValue(image);
      default:
        return 0;
    }
  };

  const names = new Map<ImageFile, string>();
  const values = new Map<ImageFile, number>();
  for (const image of list) {
    names.set(image, image.path.split(/[\\/]/).pop() || image.path);
    values.set(image, getNumericSortValue(image));
  }
  const compareNames = (a: ImageFile, b: ImageFile) => nameCollator.compare(names.get(a)!, names.get(b)!);

  list.sort((a, b) => {
    let comparison = 0;

    switch (key) {
      case 'date_taken': {
        const dateA = exifByPath[a.path]?.DateTimeOriginal || '';
        const dateB = exifByPath[b.path]?.DateTimeOriginal || '';
        if (dateA !== dateB) comparison = dateA < dateB ? -1 : 1;
        else comparison = a.modified - b.modified;
        break;
      }
      case 'iso':
      case 'shutter_speed':
      case 'aperture':
      case 'focal_length':
      case 'rating':
        comparison = values.get(a)! - values.get(b)!;
        break;
      case 'date':
        comparison = a.modified - b.modified;
        break;
      case 'edited':
        comparison = a.is_edited === b.is_edited ? 0 : a.is_edited ? 1 : -1;
        break;
      default: {
        comparison = compareNames(a, b);
        break;
      }
    }

    if (comparison === 0 && key !== 'name') {
      return compareNames(a, b);
    }

    return order === SortDirection.Ascending ? comparison : -comparison;
  });

  const badges =
    isGroupingActive && options.includeBadges
      ? buildImageGroups(imageList, groupingMode, appSettings?.groupEditedFiles ?? true).badges
      : null;

  return { displayList: list, badges };
}

export function computeSortedLibrary(libraryState: any, settingsState: any): ImageFile[] {
  return computeGroupedLibrary(libraryState, settingsState, { includeBadges: false }).displayList;
}

export function useSortedLibrary() {
  const imageList = useLibraryStore((state) => state.imageList);
  const imageRatings = useLibraryStore((state) => state.imageRatings);
  const filterCriteria = useLibraryStore((state) => state.filterCriteria);
  const searchCriteria = useLibraryStore((state) => state.searchCriteria);
  const sortCriteria = useLibraryStore((state) => state.sortCriteria);
  const needsExif = useLibraryStore((state) => usesExif(state.sortCriteria, state.searchCriteria));
  const exifByPath = useLibraryStore((state) => (needsExif ? state.exifByPath : NO_EXIF));

  const appSettings = useSettingsStore((state) => state.appSettings);

  const groupingMode: GroupingMode = appSettings?.grouping ?? 'off';
  const groupEditedFiles = appSettings?.groupEditedFiles ?? true;

  const displayList = useMemo(() => {
    return computeGroupedLibrary(
      { imageList, imageRatings, filterCriteria, searchCriteria, sortCriteria, exifByPath },
      { appSettings },
      { includeBadges: false },
    ).displayList;
  }, [imageList, sortCriteria, imageRatings, filterCriteria, searchCriteria, appSettings, exifByPath]);

  const badges = useMemo(
    () => (groupingMode !== 'off' ? buildImageGroups(imageList, groupingMode, groupEditedFiles).badges : null),
    [imageList, groupingMode, groupEditedFiles],
  );

  return useMemo(() => ({ displayList, badges }), [displayList, badges]);
}
