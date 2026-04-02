import { motion } from 'framer-motion';
import { SlidersHorizontal, Info, Scaling, BrushCleaning, Bookmark, Save, Layers } from 'lucide-react';
import { Panel } from '../../ui/AppProperties';

interface PanelOptions {
  icon: any;
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
    { id: Panel.Crop, icon: Scaling, title: 'Crop' },
    { id: Panel.Masks, icon: Layers, title: 'Masks' },
    { id: Panel.Ai, icon: BrushCleaning, title: 'Inpaint' },
  ],
  [
    { id: Panel.Presets, icon: Bookmark, title: 'Presets' },
    { id: Panel.Export, icon: Save, title: 'Export' },
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
    <div className={`p-1 gap-1 ${isHorizontal ? 'flex items-center overflow-x-auto' : 'flex flex-col h-full'}`}>
      {panelGroups.map((group, groupIndex) => (
        <div key={groupIndex} className={`gap-1 ${isHorizontal ? 'flex items-center' : 'flex flex-col'}`}>
          {groupIndex > 0 && (
            <div
              className={isHorizontal ? 'w-px h-6 bg-surface self-stretch my-auto' : 'w-6 h-px bg-surface self-center'}
            />
          )}
          {group.map(({ id, icon: Icon, title }) => (
            <button
              className={`relative rounded-md transition-colors duration-200 ${
                isHorizontal ? 'p-2.5 shrink-0' : 'p-2'
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
