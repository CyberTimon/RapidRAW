import { motion } from 'framer-motion';
import { SlidersHorizontal, Info, Crop, Layers, Paintbrush, SwatchBook, FileInput, type LucideIcon } from 'lucide-react';
import { Panel } from '../../ui/AppProperties';

interface PanelOptions {
  icon: LucideIcon;
  id: Panel;
  title: string;
}

interface RightPanelSwitcherProps {
  activePanel: Panel | null;
  onPanelSelect(id: Panel): void;
  isInstantTransition: boolean;
  layout?: 'horizontal' | 'vertical';
}

const panelGroups: Array<Array<PanelOptions>> = [
  [{ id: Panel.Metadata, icon: Info, title: 'Info' }],
  [
    { id: Panel.Adjustments, icon: SlidersHorizontal, title: 'Adjust' },
    { id: Panel.Crop, icon: Crop, title: 'Crop' },
    { id: Panel.Masks, icon: Layers, title: 'Masks' },
    { id: Panel.Ai, icon: Paintbrush, title: 'Inpaint' },
  ],
  [
    { id: Panel.Presets, icon: SwatchBook, title: 'Presets' },
    { id: Panel.Export, icon: FileInput, title: 'Export' },
  ],
];

export default function RightPanelSwitcher({
  activePanel,
  onPanelSelect,
  isInstantTransition,
  layout = 'vertical',
}: RightPanelSwitcherProps) {
  const isHorizontal = layout === 'horizontal';

  return (
    <div className={isHorizontal ? 'flex items-center overflow-x-auto p-1 gap-1' : 'flex flex-col p-1 gap-1 h-full'}>
      {panelGroups.map((group, groupIndex) => (
        <div key={groupIndex} className={isHorizontal ? 'flex items-center gap-1' : 'flex flex-col gap-1'}>
          {groupIndex > 0 && (
            <div className={isHorizontal ? 'w-px h-6 bg-surface self-stretch my-auto' : 'w-6 h-px bg-surface self-center'} />
          )}
          {group.map(({ id, icon: Icon, title }) => (
            <button
              className={`relative rounded-md transition-colors duration-200 ${
                isHorizontal ? 'p-2 shrink-0' : 'p-2'
              } ${
                activePanel === id
                  ? 'text-text-primary'
                  : 'text-text-secondary hover:bg-surface hover:text-text-primary'
              }`}
              key={id}
              onClick={() => onPanelSelect(id)}
              data-tooltip={title}
            >
              {activePanel === id && (
                <motion.div
                  layoutId="active-panel-indicator"
                  className="absolute inset-0 bg-surface rounded-md"
                  transition={isInstantTransition ? { duration: 0 } : { type: 'spring', bounce: 0.2, duration: 0.4 }}
                />
              )}
              <Icon size={20} className="relative z-10" />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
