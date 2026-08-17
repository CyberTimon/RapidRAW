import type { ImageFile } from '../components/ui/AppProperties';

export const CULLING_PICK_TAG = 'flag:pick';
export const CULLING_REJECT_TAG = 'flag:reject';

export type CullingFlag = 'pick' | 'reject' | null;

export interface CullingCounts {
  total: number;
  pick: number;
  reject: number;
  unflagged: number;
}

export function isCullingFlagTag(tag: string): boolean {
  return tag === CULLING_PICK_TAG || tag === CULLING_REJECT_TAG;
}

export function getCullingFlag(tags: string[] | null | undefined): CullingFlag {
  if (tags?.includes(CULLING_REJECT_TAG)) return 'reject';
  if (tags?.includes(CULLING_PICK_TAG)) return 'pick';
  return null;
}

export function tagsWithCullingFlag(tags: string[] | null | undefined, flag: CullingFlag): string[] | null {
  const nextTags = (tags || []).filter((tag) => !isCullingFlagTag(tag));
  if (flag === 'pick') nextTags.push(CULLING_PICK_TAG);
  if (flag === 'reject') nextTags.push(CULLING_REJECT_TAG);
  return nextTags.length > 0 ? nextTags.sort() : null;
}

export function buildCullingIndex(imageList: ImageFile[]): {
  flags: Record<string, CullingFlag>;
  counts: CullingCounts;
} {
  const flags: Record<string, CullingFlag> = {};
  const counts: CullingCounts = { total: imageList.length, pick: 0, reject: 0, unflagged: 0 };

  imageList.forEach((image) => {
    const flag = getCullingFlag(image.tags);
    flags[image.path] = flag;
    if (flag) counts[flag] += 1;
    else counts.unflagged += 1;
  });

  return { flags, counts };
}

export function parentDirectory(path: string): string {
  const physicalPath = path.split('?vc=')[0].replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(physicalPath.lastIndexOf('/'), physicalPath.lastIndexOf('\\'));
  return separatorIndex > 0 ? physicalPath.slice(0, separatorIndex) : '';
}

export function joinPath(parent: string, child: string): string {
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${separator}${child}`;
}

export function isArchiveDirectory(path: string | null | undefined): boolean {
  if (!path) return false;
  const normalized = path.replace(/[\\/]+$/, '');
  const name = normalized.slice(Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\')) + 1);
  return name.toLowerCase() === '_archived';
}
