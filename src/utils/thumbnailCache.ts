const recent = new Map<string, number>();
const visible = new Set<string>();
export const THUMBNAIL_CACHE_LIMIT = 1000;

export function withThumbnailRevision(url: string, revision: string | number = Date.now()) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}rapidrawRevision=${encodeURIComponent(String(revision))}`;
}

export function touchThumbnails(paths: string[]) {
  for (const path of paths) {
    recent.delete(path);
    recent.set(path, Date.now());
  }
  while (recent.size > THUMBNAIL_CACHE_LIMIT * 2) recent.delete(recent.keys().next().value!);
}
export function setVisibleThumbnails(paths: string[]) {
  visible.clear();
  paths.forEach((path) => visible.add(path));
  touchThumbnails(paths);
}
export function mergeThumbnailCache(current: Record<string, string>, incoming: Record<string, string>) {
  const next = { ...current, ...incoming };
  touchThumbnails(Object.keys(incoming));
  const keys = Object.keys(next);
  if (keys.length <= THUMBNAIL_CACHE_LIMIT) return next;
  const candidates = keys
    .filter((path) => !visible.has(path))
    .sort((a, b) => (recent.get(a) ?? 0) - (recent.get(b) ?? 0));
  for (const path of candidates.slice(0, keys.length - THUMBNAIL_CACHE_LIMIT)) delete next[path];
  return next;
}
