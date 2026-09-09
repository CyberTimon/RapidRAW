export function peopleShortcutScope(folder: string | null, albumId: string | null) {
  if (albumId) return `album:${albumId}`;
  if (folder) return `folder:${folder}`;
  return 'global';
}

export function usablePeopleShortcut(event: KeyboardEvent) {
  const target = event.target;
  const editable =
    target &&
    typeof target === 'object' &&
    ('isContentEditable' in target || 'tagName' in target) &&
    (Boolean((target as HTMLElement).isContentEditable) ||
      ['INPUT', 'SELECT', 'TEXTAREA'].includes((target as HTMLElement).tagName));
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || editable) {
    return null;
  }
  const key = event.key.toLocaleLowerCase();
  return /^[a-z0-9]$/.test(key) ? key : null;
}
