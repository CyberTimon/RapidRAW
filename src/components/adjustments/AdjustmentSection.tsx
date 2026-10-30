import { InfluencePreviewContext } from '../../context/InfluencePreviewContext';
import type { InfluenceScope } from '../../utils/influencePreview';
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
  influenceScope?: InfluenceScope;
  [key: string]: unknown;
}

export default function AdjustmentSection({
  sectionName,
  influenceScope,
  activeTools,
  onToggleTool,
  ...sectionProps
}: AdjustmentSectionProps) {
  const contextValue = useMemo(
    () => ({ activeTools, onToggleTool, section: sectionName }),
    [activeTools, onToggleTool, sectionName],
  );
  const influenceContext = useMemo(
    () => ({
      ownerId: influenceScope?.kind === 'mask' ? `mask:${influenceScope.containerId}` : 'global',
      scope: influenceScope ?? { kind: 'global' as const },
    }),
    [influenceScope],
  );
  const SectionComponent = SECTION_COMPONENTS[sectionName];

  return (
    <ToolVisibilityContext.Provider value={contextValue}>
      <InfluencePreviewContext.Provider value={influenceContext}>
        <SectionComponent {...sectionProps} />
      </InfluencePreviewContext.Provider>
    </ToolVisibilityContext.Provider>
  );
}
