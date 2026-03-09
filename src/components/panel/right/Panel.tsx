import { LucideIcon } from 'lucide-react';
import { createContext, PropsWithChildren, ReactNode, useEffect, useId, useState } from 'react';
import { PanelType } from '../../ui/AppProperties';
import { useSafeContext } from '../../../context/useSafeContext';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';

export interface PanelProps {
  icon: LucideIcon;
  type: PanelType;
  tooltip: string;
}

export type PanelContextProps = PanelProps & {
  group: string;
};

const PanelContext = createContext<PanelContextProps | null>(null);

export function Panel({ icon, type, tooltip, children }: PropsWithChildren<PanelProps>) {
  const { register, unregister } = useSafeContext(PanelSwitcherContext);
  const { id: group } = useSafeContext(PanelGroupContext);

  useEffect(() => {
    register({
      icon,
      tooltip,
      type,
      group,
      render: () => (
        <PanelContext value={{ icon, tooltip, type, group }}>
          <PanelBody>{children}</PanelBody>
        </PanelContext>
      ),
    });

    return () => {
      unregister(type);
    };
  }, [icon, type, tooltip, children]);

  return null;
}

export function PanelHeader({ children, title }: PropsWithChildren<{ title?: string }>) {
  const { tooltip } = useSafeContext(PanelContext);

  return (
    <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
      <h2 className="text-xl font-bold text-primary text-shadow-shiny">{title ?? tooltip}</h2>
      {children}
    </div>
  );
}

export function PanelBody({ children }: PropsWithChildren) {
  const { activePanel } = useSafeContext(PanelSwitcherContext);
  const { type } = useSafeContext(PanelContext);

  if (type !== activePanel) return null;

  return <div className="flex flex-col h-full">{children}</div>;
}

interface PanelGroupContext {
  id: string;
}

const PanelGroupContext = createContext<PanelGroupContext | null>(null);

export function PanelGroup({ children }: PropsWithChildren) {
  const id = useId();

  return <PanelGroupContext value={{ id }}>{children}</PanelGroupContext>;
}

interface PanelSwitcherContext {
  activePanel: PanelType | null;
  panels: (PanelContextProps & { render: () => ReactNode })[];
  register: (panel: PanelContextProps & { render: () => ReactNode }) => void;
  unregister: (panelType: PanelType) => void;
}

export const PanelSwitcherContext = createContext<PanelSwitcherContext | null>(null);

export function PanelSwitcher({
  children,
  isResizing,
  panelWidth,
}: PropsWithChildren<{ isResizing: boolean; panelWidth: number }>) {
  const [activePanel, setActivePanel] = useState<PanelType | null>(null);
  const [panels, setPanels] = useState<(PanelContextProps & { render: () => ReactNode })[]>([]);

  const register = (panel: PanelContextProps & { render: () => ReactNode }) => {
    setPanels((current) => [...current, panel]);
  };

  const unregister = (panelType: PanelType) => {
    setPanels((current) => current.filter((panel) => panel.type !== panelType));
  };

  const handleClick = (type: PanelType) => {
    if (activePanel === type) {
      setActivePanel(null);
    } else {
      setActivePanel(type);
    }
  };

  return (
    <PanelSwitcherContext.Provider value={{ activePanel, register, unregister, panels }}>
      <div className="flex bg-bg-secondary rounded-lg h-full">
        <PanelDisplay isResizing={isResizing} panelWidth={panelWidth} />

        <div className="flex flex-col p-1 gap-1 h-full">
          {panels.map(({ icon: Icon, tooltip: title, type, group }, index) => (
            <>
              {index > 0 && group !== panels[index - 1].group && <div className="w-6 h-px bg-surface self-center" />}
              <button
                className={`relative p-2 rounded-md transition-colors duration-200 ${
                  activePanel === type
                    ? 'text-text-primary'
                    : 'text-text-secondary hover:bg-surface hover:text-text-primary'
                }`}
                data-tooltip={title}
                onClick={() => handleClick(type)}
              >
                {activePanel === type && (
                  <motion.div
                    layoutId="active-panel-indicator"
                    className="absolute inset-0 bg-surface rounded-md"
                    transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
                  />
                )}
                <Icon size={20} className="relative z-10" />
              </button>
            </>
          ))}
        </div>
      </div>
      {children}
    </PanelSwitcherContext.Provider>
  );
}

function PanelDisplay({ isResizing, panelWidth }: { isResizing: boolean; panelWidth: number }) {
  const { activePanel, panels } = useSafeContext(PanelSwitcherContext);

  return (
    <div
      className={clsx('h-full overflow-hidden', !isResizing && 'transition-all duration-300 ease-in-out')}
      style={{ width: activePanel ? `${panelWidth}px` : '0px' }}
    >
      <AnimatePresence mode="wait">
        {activePanel && (
          <motion.div animate="animate" className="h-full w-full" exit="exit" initial="initial" key={activePanel}>
            {panels.find(({ type }) => type === activePanel)?.render()}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
