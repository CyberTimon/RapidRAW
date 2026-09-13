import type { CommandId } from './definitions';
import type { CommandHandlers } from './types';
const panels = new Set<CommandHandlers>();
export function registerPanelCommands(handlers: CommandHandlers) {
  panels.add(handlers);
  return () => {
    panels.delete(handlers);
  };
}
export function panelCommand(action: CommandId) {
  return [...panels].reverse().find((handlers) => handlers[action])?.[action];
}
let dispatch: ((action: CommandId) => boolean) | null = null;
export function installCommandDispatch(handler: (action: CommandId) => boolean) {
  dispatch = handler;
  return () => {
    if (dispatch === handler) dispatch = null;
  };
}
export function executeCommand(action: CommandId) {
  return dispatch?.(action) ?? false;
}
