import { useMemo } from 'react';
import BasicAdjustments from './Basic';
import CurveGraph from './Curves';
import ColorPanel from './Color';
import DetailsPanel from './Details';
import EffectsPanel from './Effects';
import { ActiveTools } from '../../utils/adjustments';
import { ToolVisibilityContext } from '../../context/ToolVisibilityContext';

const SECTION_COMPONENTS: Record<string, any> = {
  basic: BasicAdjustments,
  curves: CurveGraph,
  color: ColorPanel,
  details: DetailsPanel,
  effects: EffectsPanel,
};

interface AdjustmentSectionProps {
  sectionName: string;
  activeTools: ActiveTools;
  onToggleTool(id: string): void;
  [key: string]: unknown;
}

export default function AdjustmentSection({
  sectionName,
  activeTools,
  onToggleTool,
  ...sectionProps
}: AdjustmentSectionProps) {
  const contextValue = useMemo(
    () => ({ activeTools, onToggleTool, section: sectionName }),
    [activeTools, onToggleTool, sectionName],
  );
  const SectionComponent = SECTION_COMPONENTS[sectionName];

  return (
    <ToolVisibilityContext.Provider value={contextValue}>
      <SectionComponent {...sectionProps} />
    </ToolVisibilityContext.Provider>
  );
}
