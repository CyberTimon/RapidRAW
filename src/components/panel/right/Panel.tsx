import { LucideIcon } from 'lucide-react';
import { createContext, PropsWithChildren, ReactNode, useEffect, useId, useState } from 'react';
import { Direction, Orientation } from '../../ui/AppProperties';
import { useSafeContext } from '../../../context/useSafeContext';
import { AnimatePresence, motion, Variants } from 'framer-motion';
import clsx from 'clsx';
import { useResizer } from '../../../hooks/useResizer';

export interface PanelProps {
  icon: LucideIcon;
  tooltip: string;
}

export type PanelContextProps = PanelProps & {
  group: string;
  id: string;
};

const PanelContext = createContext<PanelContextProps | null>(null);

export function Panel({ icon, tooltip, children }: PropsWithChildren<PanelProps>) {
  const { register, unregister } = useSafeContext(PanelSwitcherContext);
  const { id: group } = useSafeContext(PanelGroupContext);
  const id = useId();

  useEffect(() => {
    register({
      icon,
      tooltip,
      group,
      id,
      render: () => (
        <PanelContext value={{ icon, tooltip, group, id }}>
          <PanelBody>{children}</PanelBody>
        </PanelContext>
      ),
    });

    return () => {
      unregister(id);
    };
  }, [icon, tooltip, children, group]);

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

function PanelDisplay({ isResizing }: { isResizing: boolean }) {
  const { activePanel, panels, panelWidth, slideDirection } = useSafeContext(PanelSwitcherContext);

  const panelVariants: Variants = {
    animate: (direction: number) => ({
      opacity: 1,
      y: 0,
      transition: { duration: direction === 0 ? 0 : 0.2, ease: 'circOut' },
    }),
    exit: (direction: number) => ({
      opacity: direction === 0 ? 1 : 0.2,
      y: direction === 0 ? 0 : direction > 0 ? -20 : 20,
      transition: { duration: direction === 0 ? 0 : 0.1, ease: 'circIn' },
    }),
    initial: (direction: number) => ({
      opacity: direction === 0 ? 1 : 0.2,
      y: direction === 0 ? 0 : direction > 0 ? 20 : -20,
    }),
  };

  return (
    <div
      className={clsx('h-full overflow-hidden', !isResizing && 'transition-all duration-300 ease-in-out')}
      style={{ width: activePanel ? `${panelWidth}px` : '0px' }}
    >
      <AnimatePresence mode="wait" custom={slideDirection}>
        {activePanel && (
          <motion.div
            animate="animate"
            className="h-full w-full"
            exit="exit"
            initial="initial"
            key={activePanel}
            custom={slideDirection}
            variants={panelVariants}
          >
            {panels.find(({ id }) => id === activePanel)?.render()}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

enum SlideDirection {
  Down = 1,
  Up = -1,
}

interface PanelSwitcherContext {
  activePanel: string | null;
  panels: (PanelContextProps & { render: () => ReactNode })[];
  panelWidth: number;
  slideDirection: SlideDirection;
  register: (panel: PanelContextProps & { render: () => ReactNode }) => void;
  unregister: (panelId: string) => void;
}

export const PanelSwitcherContext = createContext<PanelSwitcherContext | null>(null);

export function PanelSwitcher({ children }: PropsWithChildren) {
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const [panels, setPanels] = useState<(PanelContextProps & { render: () => ReactNode })[]>([]);
  const [slideDirection, setSlideDirection] = useState(SlideDirection.Down);

  const {
    size: panelWidth,
    Resizer,
    isResizing,
  } = useResizer({
    defaultSize: 320,
    maxSize: 600,
    minSize: 280,
    orientation: Orientation.Vertical,
    direction: Direction.Left,
  });

  const register = (panel: PanelContextProps & { render: () => ReactNode }) => {
    setPanels((current) => [...current, panel]);
  };

  const unregister = (panelId: string) => {
    setPanels((current) => current.filter((panel) => panel.id !== panelId));
  };

  const checkSlideDirection = (fromId: string, toId: string): SlideDirection => {
    const fromIndex = panels.findIndex((p) => p.id === fromId);
    const toIndex = panels.findIndex((p) => p.id === toId);

    if (fromIndex < toIndex) {
      return SlideDirection.Down;
    }

    return SlideDirection.Up;
  };

  const handleClick = (panelId: string) => {
    setSlideDirection(activePanel !== null ? checkSlideDirection(activePanel, panelId) : SlideDirection.Down);

    if (activePanel === panelId) {
      setActivePanel(null);
    } else {
      setActivePanel(panelId);
    }
  };

  return (
    <PanelSwitcherContext value={{ activePanel, register, unregister, panels, panelWidth, slideDirection }}>
      <Resizer />
      <div className="flex bg-bg-secondary rounded-lg h-full">
        <PanelDisplay isResizing={isResizing} />
        <div
          className={clsx(
            'flex flex-col p-1 gap-1 h-full border-l transition-colors',
            activePanel ? 'border-surface' : 'border-transparent',
          )}
        >
          {panels.map(({ icon: Icon, tooltip, group, id }, index) => (
            <>
              {index > 0 && group !== panels[index - 1].group && <div className="w-6 h-px bg-surface self-center" />}
              <button
                className={`relative p-2 rounded-md transition-colors duration-200 ${
                  activePanel === id
                    ? 'text-text-primary'
                    : 'text-text-secondary hover:bg-surface hover:text-text-primary'
                }`}
                data-tooltip={tooltip}
                onClick={() => handleClick(id)}
              >
                {activePanel === id && (
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
    </PanelSwitcherContext>
  );
}
