import { createContext, useContext } from 'react';
import { ActiveTools, isToolActive } from '../utils/adjustments';

interface ToolVisibilityContextValue {
  activeTools: ActiveTools;
  onToggleTool(id: string): void;
  section: string;
}

export const ToolVisibilityContext = createContext<ToolVisibilityContextValue | null>(null);

export const useToolVisibility = (id: string, parentId?: string) => {
  const context = useContext(ToolVisibilityContext);
  if (!context) {
    return null;
  }
  const isVisible = isToolActive(context.activeTools, id);
  return {
    isDimmed: !isVisible && isToolActive(context.activeTools, parentId ?? context.section),
    isVisible,
    toggle: () => context.onToggleTool(id),
  };
};
