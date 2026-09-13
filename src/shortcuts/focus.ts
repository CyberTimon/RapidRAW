export function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      'input:not([type=range]), textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"], [role="combobox"]',
    )
  );
}
export function shouldIgnoreShortcut(event: KeyboardEvent) {
  if (
    event.target instanceof HTMLInputElement &&
    event.target.type === 'range' &&
    !event.ctrlKey &&
    !event.metaKey &&
    ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.code)
  )
    return true;
  if (document.querySelector('[role="dialog"][aria-modal="true"], [data-shortcut-modal="true"]')) return true;
  if (event.defaultPrevented || event.isComposing || isEditableTarget(event.target)) return true;
  if (
    event.target instanceof Element &&
    event.target.closest('[data-shortcut-scope="local"], [role="menu"], [role="dialog"]')
  )
    return true;
  return (
    event.target instanceof Element &&
    !!event.target.closest('button, a, [role="button"]') &&
    ['Enter', 'Space', 'Tab'].includes(event.code)
  );
}
export function hasOpenDialog(ui: object) {
  return Object.entries(ui).some(
    ([key, value]) =>
      (key.endsWith('ModalOpen') && value === true) ||
      (key.endsWith('ModalState') && value && typeof value === 'object' && 'isOpen' in value && value.isOpen),
  );
}
