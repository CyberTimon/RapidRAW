import { useEffect } from 'react';
import { useBloc } from '@blac/react';
import { AppBloc } from '../blocs/app/AppBloc';
import { ModalBloc } from '../blocs/app/ModalBloc';
import { KeyboardService, type ShortcutDefinition } from '../blocs/services/KeyboardService';

export function useGlobalShortcuts() {
  const [, appBloc] = useBloc(AppBloc);
  const [, modalBloc] = useBloc(ModalBloc);
  const [, keyboardService] = useBloc(KeyboardService);

  useEffect(() => {
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const cmdKey = isMac ? 'meta' : 'ctrl';

    const shortcuts: ShortcutDefinition[] = [
      {
        key: '1',
        modifiers: [cmdKey],
        description: 'Switch to Library view',
        category: 'navigation',
        action: () => appBloc.navigateToLibrary(),
      },
      {
        key: '2',
        modifiers: [cmdKey],
        description: 'Switch to Editor view',
        category: 'navigation',
        action: () => appBloc.navigateToEditor(),
      },
      {
        key: '3',
        modifiers: [cmdKey],
        description: 'Switch to Community view',
        category: 'navigation',
        action: () => appBloc.navigateToCommunity(),
      },
      {
        key: ',',
        modifiers: [cmdKey],
        description: 'Open Settings',
        category: 'general',
        action: () => modalBloc.open('keyboard-shortcuts'),
      },
      {
        key: '/',
        modifiers: [cmdKey],
        description: 'Show keyboard shortcuts',
        category: 'general',
        action: () => modalBloc.open('keyboard-shortcuts'),
      },
    ];

    const unregister = keyboardService.registerShortcuts(shortcuts);

    return unregister;
  }, [appBloc, modalBloc, keyboardService]);
}
