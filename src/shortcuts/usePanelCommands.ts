import { useEffect } from 'react';
import type { CommandHandlers } from './types';
import { registerPanelCommands } from './runtime';

// Panels own parameterized operations; dispatch and settings still share their stable command IDs.
export function usePanelCommands(handlers: CommandHandlers) {
  useEffect(() => registerPanelCommands(handlers), [handlers]);
}
