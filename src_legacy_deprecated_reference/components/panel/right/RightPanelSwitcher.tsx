import { SlidersHorizontal, Info, Scaling, BrainCircuit, Bookmark, Save, Layers } from 'lucide-react';
import { Panel } from '../../ui/AppProperties';

interface PanelOptions {
  icon: any;
  id: Panel;
  title: string;
}

interface RightPanelSwitcherProps {
  activePanel: Panel | null;
  onPanelSelect(id: Panel): void;
}

const panelOptions: Array<PanelOptions> = [
  { id: Panel.Metadata, icon: Info, title: 'Metadata' },
  { id: Panel.Adjustments, icon: SlidersHorizontal, title: 'Adjustments' },
  { id: Panel.Crop, icon: Scaling, title: 'Crop' },
  { id: Panel.Masks, icon: Layers, title: 'Masks' },
  { id: Panel.Presets, icon: Bookmark, title: 'Presets' },
  { id: Panel.Ai, icon: BrainCircuit, title: 'AI Tools' },
  { id: Panel.Export, icon: Save, title: 'Export' },
];

export default function RightPanelSwitcher({ activePanel, onPanelSelect }: RightPanelSwitcherProps) {
  return (
    <div className="flex flex-col p-1 gap-1 h-full">
      {panelOptions.map(({ id, icon: Icon, title }) => (
        <button
          className={`p-2 rounded-md transition-colors duration-200 ${
            activePanel === id
              ? 'bg-surface text-text-primary'
              : 'text-text-secondary hover:bg-surface hover:text-text-primary'
          }`}
          key={id}
          onClick={() => onPanelSelect(id)}
          title={title}
        >
          <Icon size={20} />
        </button>
      ))}
    </div>
  );
}
