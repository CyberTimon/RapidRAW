import { useCallback } from 'react';
import { Panel } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';

const RIGHT_PANEL_ORDER = [
  Panel.Metadata,
  Panel.Adjustments,
  Panel.Crop,
  Panel.Masks,
  Panel.Ai,
  Panel.Presets,
  Panel.Export,
];

export function useHandleRightPanelSelect() {
  const {
    activeRightPanel,
    setActiveRightPanel,
    setSlideDirection,
    setRenderedRightPanel,
    setActiveMaskId,
    setActiveAiSubMaskId,
  } = useAppState();

  const handleRightPanelSelect = useCallback(
    (panelId: Panel) => {
      if (panelId === activeRightPanel) {
        setActiveRightPanel(null);
      } else {
        const currentIndex = activeRightPanel ? RIGHT_PANEL_ORDER.indexOf(activeRightPanel) : -1;
        const newIndex = RIGHT_PANEL_ORDER.indexOf(panelId);
        setSlideDirection(newIndex > currentIndex ? 1 : -1);
        setActiveRightPanel(panelId);
        setRenderedRightPanel(panelId);
      }
      setActiveMaskId(null);
      setActiveAiSubMaskId(null);
    },
    [activeRightPanel],
  );

  return handleRightPanelSelect;
}
