import { useBloc } from '@blac/react';
import { Modal } from '../../primitives/Modal';
import { ModalBloc } from '../../blocs/app/ModalBloc';

interface ShortcutItem {
  keys: string;
  description: string;
}

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutItem[];
}

const SHORTCUTS: ShortcutSection[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: '←/→', description: 'Previous/Next image' },
      { keys: '↑/↓', description: 'Zoom in/out (in editor)' },
      { keys: 'Enter/Space', description: 'Open selected image in editor' },
      { keys: 'Escape', description: 'Back to library / Close panel' },
    ],
  },
  {
    title: 'View',
    shortcuts: [
      { keys: 'F', description: 'Toggle fullscreen' },
      { keys: 'B', description: 'Show original image' },
      { keys: 'W', description: 'Toggle waveform' },
      { keys: 'Space', description: 'Toggle zoom fit/100%' },
    ],
  },
  {
    title: 'Panels',
    shortcuts: [
      { keys: 'D', description: 'Adjustments panel' },
      { keys: 'R', description: 'Crop panel' },
      { keys: 'M', description: 'Masks panel' },
      { keys: 'K', description: 'AI panel' },
      { keys: 'P', description: 'Presets panel' },
      { keys: 'I', description: 'Metadata panel' },
      { keys: 'E', description: 'Export panel' },
    ],
  },
  {
    title: 'Rating & Labels',
    shortcuts: [
      { keys: '0-5', description: 'Set rating' },
      { keys: 'Shift+1-5', description: 'Set color label' },
      { keys: 'Shift+0', description: 'Clear color label' },
    ],
  },
  {
    title: 'Editing',
    shortcuts: [
      { keys: 'Cmd/Ctrl+Z', description: 'Undo' },
      { keys: 'Cmd/Ctrl+Y', description: 'Redo' },
      { keys: 'Cmd/Ctrl+C', description: 'Copy adjustments' },
      { keys: 'Cmd/Ctrl+V', description: 'Paste adjustments' },
      { keys: 'Cmd/Ctrl+Shift+C', description: 'Copy files' },
      { keys: 'Cmd/Ctrl+Shift+V', description: 'Paste files' },
    ],
  },
  {
    title: 'Selection',
    shortcuts: [
      { keys: 'Cmd/Ctrl+A', description: 'Select all' },
      { keys: 'Shift+Click', description: 'Range select' },
      { keys: 'Cmd/Ctrl+Click', description: 'Toggle selection' },
      { keys: 'Delete', description: 'Delete selected' },
    ],
  },
  {
    title: 'Zoom',
    shortcuts: [
      { keys: 'Cmd/Ctrl+0', description: 'Fit to window' },
      { keys: 'Cmd/Ctrl+1', description: '100% zoom' },
      { keys: 'Cmd/Ctrl++', description: 'Zoom in' },
      { keys: 'Cmd/Ctrl+-', description: 'Zoom out' },
    ],
  },
];

export function KeyboardShortcutsModal() {
  const [state, modalBloc] = useBloc(ModalBloc);
  const isOpen = state.openModals.includes('keyboard-shortcuts');

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => modalBloc.close('keyboard-shortcuts')}
      title="Keyboard Shortcuts"
      size="lg"
    >
      <div className="space-y-6 max-h-[60vh] overflow-y-auto">
        {SHORTCUTS.map((section) => (
          <div key={section.title}>
            <h3 className="text-sm font-semibold text-text-primary mb-2">{section.title}</h3>
            <div className="space-y-1">
              {section.shortcuts.map((shortcut) => (
                <div
                  key={shortcut.description}
                  className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-surface-hover"
                >
                  <span className="text-sm text-text-secondary">{shortcut.description}</span>
                  <kbd className="px-2 py-1 bg-bg-primary rounded text-xs font-mono text-text-primary border border-border-color">
                    {shortcut.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
