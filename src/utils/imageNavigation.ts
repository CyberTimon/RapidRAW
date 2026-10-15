export type ImageNavigationDirection = 'next' | 'prev';

export function getAdjacentImagePath(
  list: ReadonlyArray<{ path: string }>,
  currentPath: string | null | undefined,
  direction: ImageNavigationDirection,
): string | null {
  if (!currentPath || list.length === 0) return null;
  const currentIndex = list.findIndex((img) => img.path === currentPath);
  if (currentIndex === -1) return null;
  const offset = direction === 'next' ? 1 : -1;
  const nextIndex = (currentIndex + offset + list.length) % list.length;
  return list[nextIndex].path;
}
