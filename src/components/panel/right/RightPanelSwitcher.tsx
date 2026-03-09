import { motion } from 'framer-motion';
import { SlidersHorizontal, Info, Scaling, BrushCleaning, Bookmark, Save, Layers, LucideIcon } from 'lucide-react';
import { PanelType } from '../../ui/AppProperties';
import { createContext, PropsWithChildren, useState } from 'react';
import { useSafeContext } from '../../../context/useSafeContext';
import { PanelContextProps } from './Panel';

interface PanelOptions {
  icon: LucideIcon;
  id: PanelType;
  title: string;
}

interface RightPanelSwitcherProps {
  activePanel: PanelType | null;
  onPanelSelect(id: PanelType): void;
}

const panelGroups: Array<Array<PanelOptions>> = [
  [{ id: PanelType.Metadata, icon: Info, title: 'Info' }],
  [
    { id: PanelType.Adjustments, icon: SlidersHorizontal, title: 'Adjust' },
    { id: PanelType.Crop, icon: Scaling, title: 'Crop' },
    { id: PanelType.Masks, icon: Layers, title: 'Masks' },
    { id: PanelType.Ai, icon: BrushCleaning, title: 'Inpaint' },
  ],
  [
    { id: PanelType.Presets, icon: Bookmark, title: 'Presets' },
    { id: PanelType.Export, icon: Save, title: 'Export' },
  ],
];

export default function RightPanelSwitcher({ activePanel, onPanelSelect }: RightPanelSwitcherProps) {
  return (
    <div className="flex flex-col p-1 gap-1 h-full">
      {panelGroups.map((group, groupIndex) => (
        <div key={groupIndex} className="flex flex-col gap-1">
          {groupIndex > 0 && <div className="w-6 h-px bg-surface self-center" />}
          {group.map(({ id, icon: Icon, title }) => (
            <button
              className={`relative p-2 rounded-md transition-colors duration-200 ${
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
                  transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
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
