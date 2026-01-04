import { Suspense, lazy, useMemo } from 'react';
import { useBloc } from '@blac/react';
import { PanelBloc, type PanelId } from '../../blocs/editor/PanelBloc.js';
import {
  Sliders,
  Crop,
  Layers,
  Bookmark,
  Download,
  Info,
  Sparkles,
} from 'lucide-react';

interface PanelTabConfig {
  id: PanelId;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  implemented: boolean;
}

const PANEL_TABS: PanelTabConfig[] = [
  { id: 'adjustments', label: 'Adjustments', icon: Sliders, implemented: true },
  { id: 'crop', label: 'Crop', icon: Crop, implemented: false },
  { id: 'masks', label: 'Masks', icon: Layers, implemented: false },
  { id: 'presets', label: 'Presets', icon: Bookmark, implemented: false },
  { id: 'export', label: 'Export', icon: Download, implemented: false },
  { id: 'metadata', label: 'Metadata', icon: Info, implemented: false },
  { id: 'ai', label: 'AI', icon: Sparkles, implemented: false },
];

const AdjustmentsPanel = lazy(() =>
  import('./AdjustmentsPanel.js').then((m) => ({ default: m.AdjustmentsPanel }))
);

function LoadingFallback() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function PlaceholderPanel({ panelId }: { panelId: PanelId }) {
  const config = PANEL_TABS.find((t) => t.id === panelId);
  return (
    <div className="h-full flex flex-col items-center justify-center text-text-secondary p-4">
      {config && <config.icon size={48} className="mb-4 opacity-50" />}
      <p className="text-sm">{config?.label || panelId} panel</p>
      <p className="text-xs mt-1 opacity-70">Coming soon</p>
    </div>
  );
}

interface PanelTabButtonProps {
  config: PanelTabConfig;
  isActive: boolean;
  onClick: () => void;
}

function PanelTabButton({ config, isActive, onClick }: PanelTabButtonProps) {
  const Icon = config.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!config.implemented}
      className={`
        flex-1 flex flex-col items-center justify-center py-2 px-1
        transition-colors duration-150
        ${isActive ? 'text-accent bg-surface' : 'text-text-secondary hover:text-text-primary'}
        ${!config.implemented ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
      `}
      title={config.label}
    >
      <Icon size={18} />
      <span className="text-[10px] mt-1 truncate w-full text-center">{config.label}</span>
    </button>
  );
}

export function PanelSwitcher() {
  const [state, bloc] = useBloc(PanelBloc);
  const { activePanel } = state;

  const panelContent = useMemo(() => {
    switch (activePanel) {
      case 'adjustments':
        return <AdjustmentsPanel />;
      default:
        return <PlaceholderPanel panelId={activePanel} />;
    }
  }, [activePanel]);

  return (
    <div className="h-full flex flex-col bg-bg-secondary">
      <div className="flex border-b border-border shrink-0">
        {PANEL_TABS.map((tab) => (
          <PanelTabButton
            key={tab.id}
            config={tab}
            isActive={activePanel === tab.id}
            onClick={() => bloc.setActivePanel(tab.id)}
          />
        ))}
      </div>

      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<LoadingFallback />}>{panelContent}</Suspense>
      </div>
    </div>
  );
}
