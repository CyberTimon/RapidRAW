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
  { id: 'crop', label: 'Crop', icon: Crop, implemented: true },
  { id: 'masks', label: 'Masks', icon: Layers, implemented: true },
  { id: 'presets', label: 'Presets', icon: Bookmark, implemented: true },
  { id: 'export', label: 'Export', icon: Download, implemented: true },
  { id: 'metadata', label: 'Metadata', icon: Info, implemented: true },
  { id: 'ai', label: 'AI', icon: Sparkles, implemented: true },
];

const AdjustmentsPanel = lazy(() =>
  import('./AdjustmentsPanel.js').then((m) => ({ default: m.AdjustmentsPanel }))
);

const MetadataPanel = lazy(() =>
  import('./MetadataPanel.js').then((m) => ({ default: m.MetadataPanel }))
);

const ExportPanel = lazy(() =>
  import('./ExportPanel.js').then((m) => ({ default: m.ExportPanel }))
);

const CropPanel = lazy(() =>
  import('./CropPanel.js').then((m) => ({ default: m.CropPanel }))
);

const MasksPanel = lazy(() =>
  import('./MasksPanel.js').then((m) => ({ default: m.MasksPanel }))
);

const PresetsPanel = lazy(() =>
  import('./PresetsPanel.js').then((m) => ({ default: m.PresetsPanel }))
);

const AIPanel = lazy(() =>
  import('./AIPanel.js').then((m) => ({ default: m.AIPanel }))
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
        p-2 rounded-md
        ${isActive ? 'bg-surface text-text-primary' : 'text-text-secondary hover:bg-surface hover:text-text-primary'}
        ${!config.implemented ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
      `}
      title={config.label}
    >
      <Icon size={20} />
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
      case 'crop':
        return <CropPanel />;
      case 'masks':
        return <MasksPanel />;
      case 'presets':
        return <PresetsPanel />;
      case 'metadata':
        return <MetadataPanel />;
      case 'export':
        return <ExportPanel />;
      case 'ai':
        return <AIPanel />;
      default:
        return <PlaceholderPanel panelId={activePanel} />;
    }
  }, [activePanel]);

  return (
    <div className="h-full flex bg-bg-secondary">
      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<LoadingFallback />}>{panelContent}</Suspense>
      </div>
      <div className="flex flex-col p-1 gap-1 border-l border-border-color">
        {PANEL_TABS.map((tab) => (
          <PanelTabButton
            key={tab.id}
            config={tab}
            isActive={activePanel === tab.id}
            onClick={() => bloc.setActivePanel(tab.id)}
          />
        ))}
      </div>
    </div>
  );
}
