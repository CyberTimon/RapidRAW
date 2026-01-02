import { motion, AnimatePresence } from 'framer-motion';
import { useBloc } from '@blac/react';
import clsx from 'clsx';
import { EditorCubit, UICubit, MasksCubit } from '../../cubits';
import { Panel } from '../ui/AppProperties';
import Controls from '../panel/right/ControlsPanel';
import MetadataPanel from '../panel/right/MetadataPanel';
import CropPanel from '../panel/right/CropPanel';
import PresetsPanel from '../panel/right/PresetsPanel';
import AIPanel from '../panel/right/AIPanel';
import ExportPanel from '../panel/right/ExportPanel';
import MasksPanel from '../panel/right/MasksPanel';
import RightPanelSwitcher from '../panel/right/RightPanelSwitcher';

interface RightPanelContainerProps {
  onGenerateAiForegroundMask: (subMaskId: string) => void;
  onGenerateAiSkyMask: (subMaskId: string) => void;
  onDeletePatch: (patchId: string) => void;
  onGenerativeReplace: (patchId: string, prompt: string, useFastInpaint: boolean) => Promise<void>;
  onTogglePatchVisibility: (patchId: string) => void;
  setCustomEscapeHandler: (handler: any) => void;
}

const panelVariants: any = {
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'circOut' } },
  exit: { opacity: 0.4, y: -20, transition: { duration: 0.1, ease: 'circIn' } },
  initial: { opacity: 0.4, y: 20 },
};

export default function RightPanelContainer({
  onGenerateAiForegroundMask,
  onGenerateAiSkyMask,
  onDeletePatch,
  onGenerativeReplace,
  onTogglePatchVisibility,
  setCustomEscapeHandler,
}: RightPanelContainerProps) {
  const [editorState, editorCubit] = useBloc(EditorCubit);
  const [uiState] = useBloc(UICubit);
  const [, masksCubit] = useBloc(MasksCubit);

  const { activeRightPanel, renderedRightPanel } = editorState;
  const { rightPanelWidth, isResizing } = uiState;

  const handleRightPanelSelect = (panelId: Panel) => {
    if (panelId === activeRightPanel) {
      editorCubit.setActiveRightPanel(null);
    } else {
      editorCubit.setActiveRightPanel(panelId);
      editorCubit.setRenderedRightPanel(panelId);
    }
    masksCubit.setActiveMask(null);
    masksCubit.setActiveAiSubMask(null);
  };

  return (
    <div className="flex bg-bg-secondary rounded-lg h-full">
      <div
        className={clsx('h-full overflow-hidden', !isResizing && 'transition-all duration-300 ease-in-out')}
        style={{ width: activeRightPanel ? `${rightPanelWidth}px` : '0px' }}
      >
        <div style={{ width: `${rightPanelWidth}px` }} className="h-full">
          <AnimatePresence mode="wait">
            {activeRightPanel && (
              <motion.div
                animate="animate"
                className="h-full w-full"
                exit="exit"
                initial="initial"
                key={renderedRightPanel}
                variants={panelVariants}
              >
                {renderedRightPanel === Panel.Adjustments && <Controls />}
                {renderedRightPanel === Panel.Metadata && <MetadataPanel />}
                {renderedRightPanel === Panel.Crop && <CropPanel />}
                {renderedRightPanel === Panel.Masks && (
                  <MasksPanel
                    onGenerateAiForegroundMask={onGenerateAiForegroundMask}
                    onGenerateAiSkyMask={onGenerateAiSkyMask}
                    setCustomEscapeHandler={setCustomEscapeHandler}
                  />
                )}
                {renderedRightPanel === Panel.Presets && <PresetsPanel />}
                {renderedRightPanel === Panel.Export && <ExportPanel />}
                {renderedRightPanel === Panel.Ai && (
                  <AIPanel
                    onDeletePatch={onDeletePatch}
                    onGenerateAiForegroundMask={onGenerateAiForegroundMask}
                    onGenerativeReplace={onGenerativeReplace}
                    onTogglePatchVisibility={onTogglePatchVisibility}
                    setCustomEscapeHandler={setCustomEscapeHandler}
                  />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      <div
        className={clsx(
          'h-full border-l transition-colors',
          activeRightPanel ? 'border-surface' : 'border-transparent',
        )}
      >
        <RightPanelSwitcher activePanel={activeRightPanel} onPanelSelect={handleRightPanelSelect} />
      </div>
    </div>
  );
}
