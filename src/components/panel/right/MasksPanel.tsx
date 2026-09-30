import MarigoldDepthControls from './MarigoldDepthControls';
import MarigoldSurfaceControls from './MarigoldSurfaceControls';
import { isSurfaceMask } from '../../../utils/surfaceGeometry';
import DepthMapPreview from './DepthMapPreview';
import { applyLinearFalloffSelection, applyMaskAdjustmentUpdate, insertCreatedSubMask } from './maskInteractions';
import { buildPresetMenu } from './presetMenu';
interface SettingsPanelProps {
  selectionOnly?: boolean;
  effectOnly?: boolean;
  onLimitWithBrush: () => void;
  container: MaskContainer | null;
  activeSubMask: SubMask | null;
  aiModelDownloadStatus: string | null;
  brushSettings: BrushSettings;
  setBrushSettings: React.Dispatch<React.SetStateAction<BrushSettings>>;
  updateContainer: (id: string, data: Partial<MaskContainer>) => void;
  updateSubMask: (id: string, data: Partial<SubMask>) => void;
  histogram: ReturnType<typeof useEditorStore.getState>['histogram'];
  appSettings: AppSettings | null;
  setIsMaskControlHovered: (hovered: boolean) => void;
  collapsibleState: SectionVisibility;
  setCollapsibleState: React.Dispatch<React.SetStateAction<SectionVisibility>>;
  copiedSectionAdjustments: { section: AdjustmentSection; values: Partial<Adjustments> } | null;
  setCopiedSectionAdjustments: (value: { section: AdjustmentSection; values: Partial<Adjustments> } | null) => void;
  onDragStateChange: (dragging: boolean) => void;
  isSettingsSectionOpen: boolean;
  setSettingsSectionOpen: (isOpen: boolean) => void;
  presets: UserPreset[];
  handleGenerateAiDepthMask: ReturnType<typeof useAiMasking>['handleGenerateAiDepthMask'];
  handleGenerateSurfaceMask: ReturnType<typeof useAiMasking>['handleGenerateSurfaceMask'];
}
interface SubMaskRowProps {
  subMask: SubMask;
  index: number;
  totalCount: number;
  containerId: string;
  isActive: boolean;
  parentVisible: boolean;
  onSelect: () => void;
  updateSubMask: (id: string, data: Partial<SubMask>) => void;
  handleDelete: () => void;
  handleDuplicate: () => void;
  handleDuplicateAndInvert: () => void;
  handlePaste: () => void;
  handleCopy: () => void;
  hasCopiedSubMask: boolean;
  activeDragItem: DragData | null;
  analyzingSubMaskId: string | null;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  tempName: string;
  setTempName: (value: string) => void;
  setIsMaskControlHovered: (hovered: boolean) => void;
}
interface ContainerRowProps {
  container: MaskContainer;
  isSelected: boolean;
  hasActiveChild: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  tempName: string;
  setTempName: (value: string) => void;
  updateContainer: (id: string, data: Partial<MaskContainer>) => void;
  handleDelete: (id: string) => void;
  handleDuplicate: (container: MaskContainer) => void;
  handleDuplicateAndInvert: (container: MaskContainer) => void;
  handlePasteMask: (insertAfterContainerId?: string) => void;
  copyMaskToClipboard: (container: MaskContainer) => void;
  copiedMask: MaskContainer | null;
  presets: UserPreset[];
  setAdjustments: AdjustmentSetter;
  activeDragItem: DragData | null;
  activeMaskId: string | null;
  onSelectContainer: (id: string | null) => void;
  onSelectMask: (id: string | null) => void;
  updateSubMask: (id: string, data: Partial<SubMask>) => void;
  handleDeleteSubMask: (containerId: string, subMaskId: string) => void;
  handleDuplicateSubMask: (containerId: string, subMask: SubMask, insertIndex?: number) => void;
  handleDuplicateAndInvertSubMask: (containerId: string, subMask: SubMask) => void;
  handlePasteSubMask: (containerId: string, insertIndex?: number) => void;
  copySubMaskToClipboard: (subMask: SubMask) => void;
  copiedSubMask: SubMask | null;
  analyzingSubMaskId: string | null;
  setIsMaskControlHovered: (hovered: boolean) => void;
  onAddComponent: (event: React.MouseEvent) => void;
}
import type { BrushSettings, Option, AppSettings } from '../../ui/AppProperties';
import type { AdjustmentSetter, AdjustmentSection, SectionVisibility } from '../../../utils/adjustments';
import { INITIAL_ADJUSTMENTS, pickAdjustments } from '../../../utils/adjustments';
import type { SubMaskConfig, MaskParameters } from './Masks';
import type { UserPreset } from '../../../hooks/usePresets';
import { type ChangeEvent, useState, useEffect, useRef, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { v4 as uuidv4 } from 'uuid';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  pointerWithin,
} from '@dnd-kit/core';
import {
  ChartArea,
  Circle,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  FileEdit,
  FolderOpen,
  Folder as FolderIcon,
  Loader2,
  Minus,
  Plus,
  PlusSquare,
  RotateCcw,
  Trash2,
  SwatchBook,
  SquaresIntersect,
} from 'lucide-react';

import CollapsibleSection from '../../ui/CollapsibleSection';
import Switch from '../../ui/Switch';
import Slider from '../../ui/Slider';
import BasicAdjustments from '../../adjustments/Basic';
import CurveGraph from '../../adjustments/Curves';
import ColorPanel from '../../adjustments/Color';
import DetailsPanel from '../../adjustments/Details';
import EffectsPanel from '../../adjustments/Effects';
import Waveform from '../editor/Waveform';
import Resizer from '../../ui/Resizer';
import { DepthRangePicker } from '../../ui/DepthRangePicker';

import {
  Mask,
  MaskType,
  SubMask,
  MASK_BASIC_TYPES,
  MASK_RANGE_TYPES,
  MASK_AI_TYPES,
  ALL_MASK_TYPES,
  MASK_ICON_MAP,
  SubMaskMode,
  ToolType,
  formatMaskTypeName,
  getSubMaskName,
  getMaskTypeName,
  NewMaskDropZone,
} from './Masks';
import {
  Adjustments,
  INITIAL_MASK_ADJUSTMENTS,
  INITIAL_MASK_CONTAINER,
  MaskContainer,
  ADJUSTMENT_SECTIONS,
} from '../../../utils/adjustments';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { OPTION_SEPARATOR, Orientation, Panel } from '../../ui/AppProperties';
import { createSubMask } from '../../../utils/maskUtils';
import { usePresets } from '../../../hooks/usePresets';
import Text from '../../ui/Text';
import { TEXT_COLOR_KEYS, TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { useEditorStore } from '../../../store/useEditorStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useProcessStore } from '../../../store/useProcessStore';
import { useAiMasking } from '../../../hooks/useAiMasking';
import { useEditorActions } from '../../../hooks/useEditorActions';
import { useUIStore } from '../../../store/useUIStore';
import { useWaveformControls } from '../../../hooks/useWaveformControls';

interface DragData {
  type: 'Container' | 'SubMask' | 'Creation';
  item?: MaskContainer | SubMask;
  maskType?: Mask;
  parentId?: string;
}

const SUB_MASK_CONFIG: Partial<Record<Mask, SubMaskConfig>> = {
  [Mask.Radial]: {
    parameters: [{ key: 'feather', min: 0, max: 100, step: 1, multiplier: 100, defaultValue: 50 }],
  },
  [Mask.Brush]: { showBrushTools: true },
  [Mask.Flow]: { showBrushTools: true, showFlowControl: true },
  [Mask.Linear]: { parameters: [] },
  [Mask.Color]: {
    parameters: [
      { key: 'tolerance', min: 1, max: 100, step: 1, defaultValue: 20 },
      { key: 'grow', min: -100, max: 100, step: 1, defaultValue: 0 },
      { key: 'feather', min: 0, max: 100, step: 1, defaultValue: 35 },
    ],
  },
  [Mask.Luminance]: {
    parameters: [
      { key: 'tolerance', min: 1, max: 100, step: 1, defaultValue: 20 },
      { key: 'grow', min: -100, max: 100, step: 1, defaultValue: 0 },
      { key: 'feather', min: 0, max: 100, step: 1, defaultValue: 35 },
    ],
  },
  [Mask.All]: { parameters: [] },
  [Mask.AiDepth]: {
    parameters: [{ key: 'feather', min: 0, max: 100, step: 1, defaultValue: 15 }],
  },
  [Mask.AiSubject]: {
    parameters: [
      { key: 'grow', min: -100, max: 100, step: 1, defaultValue: 0 },
      { key: 'feather', min: 0, max: 100, step: 1, defaultValue: 0 },
    ],
  },
  [Mask.AiForeground]: {
    parameters: [
      { key: 'grow', min: -100, max: 100, step: 1, defaultValue: 0 },
      { key: 'feather', min: 0, max: 100, step: 1, defaultValue: 0 },
    ],
  },
  [Mask.AiSky]: {
    parameters: [
      { key: 'grow', min: -100, max: 100, step: 1, defaultValue: 0 },
      { key: 'feather', min: 0, max: 100, step: 1, defaultValue: 0 },
    ],
  },
  [Mask.QuickEraser]: { parameters: [] },
};

const BrushTools = ({
  settings,
  onSettingsChange,
  onDragStateChange,
}: {
  settings: BrushSettings;
  onSettingsChange: React.Dispatch<React.SetStateAction<BrushSettings>>;
  onDragStateChange?: (isDragging: boolean) => void;
}) => {
  const { t } = useTranslation();

  return (
    <div>
      <Slider
        defaultValue={100}
        label={t('editor.masks.brush.size')}
        max={200}
        min={1}
        onChange={(e) => onSettingsChange((s) => ({ ...s, size: Number(e.target.value) }))}
        step={1}
        value={settings.size}
        fillOrigin="min"
        onDragStateChange={onDragStateChange}
      />
      <Slider
        defaultValue={50}
        label={t('editor.masks.brush.feather')}
        max={100}
        min={0}
        onChange={(e) => onSettingsChange((s) => ({ ...s, feather: Number(e.target.value) }))}
        step={1}
        value={settings.feather}
        fillOrigin="min"
        onDragStateChange={onDragStateChange}
      />
      <div className="grid grid-cols-2 gap-2 pt-2">
        <button
          className={`p-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${settings.tool === ToolType.Brush ? 'text-primary bg-surface' : 'bg-surface text-text-secondary hover:bg-card-active'}`}
          onClick={() => onSettingsChange((s) => ({ ...s, tool: ToolType.Brush }))}
        >
          {t('editor.masks.brush.brush')}
        </button>
        <button
          className={`p-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${settings.tool === ToolType.Eraser ? 'text-primary bg-surface' : 'bg-surface text-text-secondary hover:bg-card-active'}`}
          onClick={() => onSettingsChange((s) => ({ ...s, tool: ToolType.Eraser }))}
        >
          {t('editor.masks.brush.eraser')}
        </button>
      </div>
    </div>
  );
};

const FlowBrushTool = ({
  flow,
  onFlowChange,
  settings,
  onSettingsChange,
  onDragStateChange,
}: {
  flow: number;
  onFlowChange: (flow: number) => void;
  settings: BrushSettings;
  onSettingsChange: React.Dispatch<React.SetStateAction<BrushSettings>>;
  onDragStateChange?: (isDragging: boolean) => void;
}) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-4 border-t border-surface">
      <Slider
        defaultValue={10}
        label={t('editor.masks.brush.flow')}
        max={100}
        min={0}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onFlowChange(Number(e.target.value))}
        step={1}
        value={flow}
        fillOrigin="min"
        onDragStateChange={onDragStateChange}
      />
      <BrushTools settings={settings} onSettingsChange={onSettingsChange} onDragStateChange={onDragStateChange} />
    </div>
  );
};

function MasksListRoot({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'mask-list-root' });

  return (
    <motion.div
      key="masks-list-container"
      ref={setNodeRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className={`flex-col transition-colors ${isOver ? 'bg-surface' : ''}`}
      onClick={onClick}
    >
      {children}
    </motion.div>
  );
}

export default function MasksPanel() {
  const { t } = useTranslation();
  const { setAdjustments } = useEditorActions();
  const {
    handleGenerateAiDepthMask,
    handleGenerateAiForegroundMask,
    handleGenerateAiSkyMask,
    handleGenerateSurfaceMask,
  } = useAiMasking();
  const { setCustomEscapeHandler, isAdjustmentsPanelVisible } = useUIStore(
    useShallow((state) => {
      const leftVisible = state.uiVisibility.leftPanel;
      const rightVisible = state.uiVisibility.rightPanel;

      const isVisible =
        (leftVisible && state.activePanels.leftTop === Panel.Adjustments) ||
        (leftVisible && state.activePanels.leftBottom === Panel.Adjustments) ||
        (rightVisible && state.activePanels.rightTop === Panel.Adjustments) ||
        (rightVisible && state.activePanels.rightBottom === Panel.Adjustments);

      return {
        setCustomEscapeHandler: state.setCustomEscapeHandler,
        isAdjustmentsPanelVisible: isVisible,
      };
    }),
  );
  const { appSettings } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
    })),
  );

  const { aiModelDownloadStatus } = useProcessStore(
    useShallow((state) => ({
      aiModelDownloadStatus: state.aiModelDownloadStatus,
    })),
  );

  const {
    activeMaskContainerId,
    activeMaskId,
    adjustments,
    brushSettings,
    copiedMask,
    histogram,
    isGeneratingAiMask,
    selectedImage,
    isWaveformVisible,
    waveform,
    activeWaveformChannel,
    waveformHeight,
    showClipping,
    showPatchMarkers,
    setEditor,
  } = useEditorStore(
    useShallow((state) => ({
      activeMaskContainerId: state.activeMaskContainerId,
      activeMaskId: state.activeMaskId,
      adjustments: state.adjustments,
      brushSettings: state.brushSettings,
      copiedMask: state.copiedMask,
      histogram: state.histogram,
      isGeneratingAiMask: state.isGeneratingAiMask,
      selectedImage: state.selectedImage,
      isWaveformVisible: state.isWaveformVisible,
      waveform: state.waveform,
      activeWaveformChannel: state.activeWaveformChannel,
      waveformHeight: state.waveformHeight,
      showClipping: state.showClipping,
      showPatchMarkers: state.showPatchMarkers ?? true,
      setEditor: state.setEditor,
    })),
  );

  const { isResizingWaveform, onToggleWaveform, setActiveWaveformChannel, handleWaveformResize } =
    useWaveformControls();

  const setBrushSettings = useCallback(
    (updater: React.SetStateAction<BrushSettings>) => {
      setEditor((state) => ({
        brushSettings:
          typeof updater === 'function'
            ? updater(state.brushSettings ?? { size: 50, feather: 50, tool: ToolType.Brush })
            : updater,
      }));
    },
    [setEditor],
  );
  const selectBrushToolForNewMask = useCallback(() => {
    setEditor((state) => ({
      brushSettings: {
        ...(state.brushSettings ?? { size: 50, feather: 50, tool: ToolType.Brush }),
        tool: ToolType.Brush,
      },
    }));
  }, [setEditor]);

  const setCopiedMask = useCallback((mask: MaskContainer) => setEditor({ copiedMask: mask }), [setEditor]);
  const setIsMaskControlHovered = useCallback(
    (hovered: boolean) => setEditor({ isMaskControlHovered: hovered }),
    [setEditor],
  );
  const onDragStateChange = useCallback(
    (isDragging: boolean) => setEditor({ isSliderDragging: isDragging }),
    [setEditor],
  );
  const onSelectContainer = useCallback((id: string | null) => setEditor({ activeMaskContainerId: id }), [setEditor]);
  const onSelectMask = useCallback((id: string | null) => setEditor({ activeMaskId: id }), [setEditor]);

  const [expandedContainers, setExpandedContainers] = useState<Set<string>>(new Set());
  const [activeDragItem, setActiveDragItem] = useState<DragData | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [tempName, setTempName] = useState('');
  const [copiedSubMask, setCopiedSubMask] = useState<SubMask | null>(null);
  const [collapsibleState, setCollapsibleState] = useState<SectionVisibility>({
    basic: true,
    curves: false,
    color: false,
    details: false,
    effects: false,
  });
  const [copiedSectionAdjustments, setCopiedSectionAdjustments] = useState<{
    section: AdjustmentSection;
    values: Partial<Adjustments>;
  } | null>(null);
  const [isSettingsSectionOpen, setSettingsSectionOpen] = useState(true);
  const [isSettingsPanelEverOpened, setIsSettingsPanelEverOpened] = useState(false);
  const hasPerformedInitialSelection = useRef(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [analyzingSubMaskId, setAnalyzingSubMaskId] = useState<string | null>(null);

  const { showContextMenu } = useContextMenu();
  const { presets } = usePresets(adjustments);

  const activeContainer = adjustments.masks?.find((m) => m.id === activeMaskContainerId);
  const activeSubMaskData = activeContainer?.subMasks?.find((sm) => sm.id === activeMaskId);
  const isAiMask =
    activeSubMaskData && [Mask.AiSubject, Mask.AiForeground, Mask.AiSky, Mask.AiDepth].includes(activeSubMaskData.type);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (isGeneratingAiMask && isAiMask) {
      timer = setTimeout(() => {
        setAnalyzingSubMaskId(activeMaskId);
      }, 200);
    } else {
      setAnalyzingSubMaskId(null);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [isGeneratingAiMask, isAiMask, activeMaskId]);

  useEffect(() => {
    if (activeMaskContainerId) {
      const containerExists = adjustments.masks?.some((m) => m.id === activeMaskContainerId);
      if (!containerExists) {
        onSelectContainer(null);
        onSelectMask(null);
      }
    }
  }, [adjustments.masks, activeMaskContainerId, onSelectContainer, onSelectMask]);

  useEffect(() => {
    if (!hasPerformedInitialSelection.current && !activeMaskContainerId && adjustments.masks?.length > 0) {
      const lastMask = adjustments.masks[adjustments.masks.length - 1];
      if (lastMask) {
        onSelectContainer(lastMask.id);
        onSelectMask(null);
      }
    }

    if (activeMaskContainerId) {
      const shouldAutoExpand = !hasPerformedInitialSelection.current || activeMaskId;

      if (shouldAutoExpand) {
        setExpandedContainers((prev) => {
          if (prev.has(activeMaskContainerId)) {
            return prev;
          }
          return new Set(prev).add(activeMaskContainerId);
        });
      }

      hasPerformedInitialSelection.current = true;
    }

    if (activeMaskContainerId || adjustments.masks?.length > 0) {
      setIsSettingsPanelEverOpened(true);
    }
  }, [activeMaskContainerId, activeMaskId, adjustments.masks, onSelectContainer, onSelectMask]);

  useEffect(() => {
    const handler = () => {
      if (renamingId) {
        setRenamingId(null);
        setTempName('');
      } else if (activeMaskId) onSelectMask(null);
      else if (activeMaskContainerId) onSelectContainer(null);
    };
    if (activeMaskContainerId || renamingId) setCustomEscapeHandler(() => handler);
    else setCustomEscapeHandler(null);
    return () => setCustomEscapeHandler(null);
  }, [activeMaskContainerId, activeMaskId, renamingId, onSelectContainer, onSelectMask, setCustomEscapeHandler]);

  const handleDeselect = () => {
    onSelectContainer(null);
    onSelectMask(null);
  };

  const handleToggleExpand = (id: string) => {
    setExpandedContainers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleResetAllMasks = () => {
    handleDeselect();
    setAdjustments((prev) => ({ ...prev, masks: [] }));
  };

  const createMaskLogic = (type: Mask, mode: SubMaskMode = SubMaskMode.Additive) => {
    if (!selectedImage) return createSubMask(type, null, mode);
    const subMask = createSubMask(type, selectedImage, mode);

    const steps = adjustments?.orientationSteps || 0;
    const isRotated = steps === 1 || steps === 3;
    const imgW = isRotated ? selectedImage.height || 1000 : selectedImage.width || 1000;
    const imgH = isRotated ? selectedImage.width || 1000 : selectedImage.height || 1000;

    if (type === Mask.Linear && subMask.parameters) {
      subMask.parameters.range = Math.min(imgW, imgH) * 0.1;
    }

    if (type === Mask.Linear || type === Mask.Radial || type === Mask.Color || type === Mask.Luminance) {
      if (!subMask.parameters) subMask.parameters = {};
      subMask.parameters.isInitialDraw = true;
      if (type === Mask.Linear || type === Mask.Radial) {
        subMask.parameters.startX = -10000;
        subMask.parameters.startY = -10000;
        subMask.parameters.endX = -10000;
        subMask.parameters.endY = -10000;
        subMask.parameters.centerX = -10000;
        subMask.parameters.centerY = -10000;
        subMask.parameters.radiusX = 0;
        subMask.parameters.radiusY = 0;
      } else {
        subMask.parameters.targetX = -10000;
        subMask.parameters.targetY = -10000;
        subMask.parameters.tolerance = 20;
        subMask.parameters.feather = 35;
      }
    }

    if (type === Mask.AiDepth) {
      if (!subMask.parameters) subMask.parameters = {};
      subMask.parameters.depthProvider = 'builtin';
      subMask.parameters.minDepth = 20;
      subMask.parameters.maxDepth = 80;
      subMask.parameters.minFade = 15;
      subMask.parameters.maxFade = 15;
      subMask.parameters.feather = 10;
    }
    if (type === Mask.AiNormals) {
      subMask.parameters.normalAngle = 90;
      subMask.parameters.normalAmount = 0.25;
    }
    return subMask;
  };

  const handleAddMaskContainer = (type: Mask, depthProvider?: 'marigold') => {
    const subMask = createMaskLogic(type);
    if (depthProvider) {
      subMask.parameters.depthProvider = depthProvider;
      subMask.name = t('editor.masks.marigold.newMask', { defaultValue: 'Depth Selection' });
    }
    const count = (adjustments.masks?.length || 0) + 1;
    const newContainer = {
      ...INITIAL_MASK_CONTAINER,
      id: uuidv4(),
      name: t('editor.masks.patches.maskName', { count }),
      subMasks: [subMask],
    };
    setAdjustments((prev: Adjustments) => ({ ...prev, masks: [...(prev.masks || []), newContainer] }));
    onSelectContainer(newContainer.id);
    onSelectMask(subMask.id);
    setExpandedContainers((prev) => new Set(prev).add(newContainer.id));
    if (type === Mask.Brush || type === Mask.Flow) selectBrushToolForNewMask();
    if (type === Mask.AiForeground) handleGenerateAiForegroundMask(subMask.id);
    else if (type === Mask.AiSky) handleGenerateAiSkyMask(subMask.id);
    else if (type === Mask.AiDepth) handleGenerateAiDepthMask(subMask.id, subMask.parameters);
    else if (type === Mask.AiNormals || type === Mask.AiAlbedo)
      void handleGenerateSurfaceMask(subMask.id, type === Mask.AiNormals ? 'normals' : 'albedo');
  };

  const handleAddSubMask = (
    containerId: string,
    type: Mask,
    mode: SubMaskMode = SubMaskMode.Additive,
    insertIndex: number = -1,
    depthProvider?: 'marigold',
  ) => {
    if (
      isSurfaceMask(type) &&
      adjustments.masks.find((m) => m.id === containerId)?.subMasks.some((s) => isSurfaceMask(s.type))
    )
      return;
    const subMask = createMaskLogic(type, mode);
    if (depthProvider) {
      subMask.parameters.depthProvider = depthProvider;
      subMask.name = t('editor.masks.marigold.newMask', { defaultValue: 'Depth Selection' });
    }
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      masks: prev.masks?.map((c: MaskContainer) => {
        if (c.id === containerId) {
          const newSubMasks = [...c.subMasks];
          if (insertIndex >= 0) {
            newSubMasks.splice(insertIndex, 0, subMask);
          } else {
            newSubMasks.push(subMask);
          }
          return { ...c, subMasks: newSubMasks };
        }
        return c;
      }),
    }));
    onSelectContainer(containerId);
    onSelectMask(subMask.id);
    setExpandedContainers((prev) => new Set(prev).add(containerId));
    if (type === Mask.Brush || type === Mask.Flow) selectBrushToolForNewMask();
    if (type === Mask.AiForeground) handleGenerateAiForegroundMask(subMask.id);
    else if (type === Mask.AiSky) handleGenerateAiSkyMask(subMask.id);
    else if (type === Mask.AiDepth) handleGenerateAiDepthMask(subMask.id, subMask.parameters);
    else if (type === Mask.AiNormals || type === Mask.AiAlbedo)
      void handleGenerateSurfaceMask(subMask.id, type === Mask.AiNormals ? 'normals' : 'albedo');
  };

  const handleGridClick = (type: Mask, forceNewMaskContainer: boolean = false) => {
    if (!forceNewMaskContainer && activeMaskContainerId) handleAddSubMask(activeMaskContainerId, type);
    else handleAddMaskContainer(type);
  };

  const handleGridRightClick = (event: React.MouseEvent, type: Mask | null) => {
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    if (!type) return;
    handleGridClick(type, true);
  };

  const buildMarigoldMenu = (targetContainerId?: string | null, mode = SubMaskMode.Additive): Option[] => [
    ...(appSettings?.marigoldDepthEnabled
      ? [
          {
            label: `${t('editor.masks.marigold.newMask', { defaultValue: 'Depth Selection' })} · ${t('editor.masks.marigold.requiresConnector', { defaultValue: 'Requires AI Connector for analysis' })}`,
            icon: MASK_ICON_MAP[Mask.AiDepth],
            disabled: isGeneratingAiMask,
            onClick: () => {
              if (targetContainerId) handleAddSubMask(targetContainerId, Mask.AiDepth, mode, -1, 'marigold');
              else handleAddMaskContainer(Mask.AiDepth, 'marigold');
            },
          },
        ]
      : []),
    ...(appSettings?.marigoldSurfaceEnabled
      ? [Mask.AiNormals, Mask.AiAlbedo].map((type) => ({
          label:
            type === Mask.AiNormals
              ? t('masks.types.normals', { defaultValue: 'Shape Light' })
              : t('masks.types.albedo', { defaultValue: 'Surface Colour' }),
          icon: MASK_ICON_MAP[type],
          disabled:
            isGeneratingAiMask ||
            !!adjustments.masks.find((m) => m.id === targetContainerId)?.subMasks.some((s) => isSurfaceMask(s.type)),
          onClick: () =>
            targetContainerId ? handleAddSubMask(targetContainerId, type, mode) : handleAddMaskContainer(type),
        }))
      : []),
  ];

  const handleAddMaskContextMenu = (event: React.MouseEvent, targetContainerId?: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();

    const buildMenu = (types: MaskType[], mode: SubMaskMode = SubMaskMode.Additive) =>
      types.map((maskType: MaskType) => ({
        label: getMaskTypeName(maskType),
        icon: maskType.icon,
        disabled: maskType.disabled,
        onClick: () => {
          if (targetContainerId) {
            handleAddSubMask(targetContainerId, maskType.type, mode);
          } else {
            handleAddMaskContainer(maskType.type);
          }
        },
      }));

    const container = targetContainerId ? adjustments.masks?.find((m) => m.id === targetContainerId) : null;
    const hasComponents = container && container.subMasks.length > 0;

    // Flattened menu chunks
    const buildFlatMenu = (mode: SubMaskMode) => [
      ...buildMenu(MASK_AI_TYPES, mode),
      ...buildMarigoldMenu(targetContainerId, mode),
      { type: OPTION_SEPARATOR },
      ...buildMenu(MASK_BASIC_TYPES, mode),
      { type: OPTION_SEPARATOR },
      ...buildMenu(MASK_RANGE_TYPES, mode),
    ];

    let options: Option[];

    if (!targetContainerId) {
      // Creating a completely new mask
      options = buildFlatMenu(SubMaskMode.Additive);
    } else {
      // Adding a component to an existing mask
      options = buildFlatMenu(SubMaskMode.Additive);

      if (hasComponents) {
        options.push(
          { type: OPTION_SEPARATOR },
          {
            label: t('editor.masks.actions.subtractFromMask'),
            icon: Minus,
            submenu: buildFlatMenu(SubMaskMode.Subtractive),
          },
          {
            label: t('editor.masks.actions.intersectMaskWith'),
            icon: SquaresIntersect,
            submenu: buildFlatMenu(SubMaskMode.Intersect),
          },
        );
      }
    }

    showContextMenu(rect.left, rect.bottom + 5, options);
  };

  const updateContainer = (id: string, data: Partial<MaskContainer>) =>
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      masks: prev.masks.map((m) => (m.id === id ? { ...m, ...data } : m)),
    }));
  const updateSubMask = (id: string, data: Partial<SubMask>) =>
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      masks: prev.masks.map((m) => ({
        ...m,
        subMasks: m.subMasks.map((sm) => (sm.id === id ? { ...sm, ...data } : sm)),
      })),
    }));

  const handleDeleteContainer = (id: string) => {
    if (activeMaskContainerId === id) handleDeselect();
    setAdjustments((prev: Adjustments) => ({ ...prev, masks: prev.masks.filter((m) => m.id !== id) }));
  };

  const handleDeleteSubMask = (containerId: string, subMaskId: string) => {
    if (activeMaskId === subMaskId) onSelectMask(null);
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      masks: prev.masks.map((m) =>
        m.id === containerId ? { ...m, subMasks: m.subMasks.filter((sm) => sm.id !== subMaskId) } : m,
      ),
    }));
  };

  const cloneMaskContainerData = (
    container: MaskContainer,
    options: { invert?: boolean; rename?: boolean; resetAdjustments?: boolean } = {},
  ): MaskContainer => {
    const clonedContainer = JSON.parse(JSON.stringify(container));

    clonedContainer.id = uuidv4();
    clonedContainer.invert = options.invert ? !clonedContainer.invert : clonedContainer.invert;
    clonedContainer.name =
      options.rename === false ? clonedContainer.name : t('editor.masks.patches.copyName', { name: container.name });
    clonedContainer.subMasks = clonedContainer.subMasks.map((subMask: SubMask) => ({
      ...subMask,
      id: uuidv4(),
    }));

    if (options.resetAdjustments) {
      clonedContainer.adjustments = JSON.parse(JSON.stringify(INITIAL_MASK_ADJUSTMENTS));
    }

    return clonedContainer;
  };

  const cloneSubMaskData = (subMask: SubMask, options: { invert?: boolean; rename?: boolean } = {}): SubMask => {
    const clonedSubMask = JSON.parse(JSON.stringify(subMask));

    clonedSubMask.id = uuidv4();
    clonedSubMask.invert = options.invert ? !clonedSubMask.invert : clonedSubMask.invert;
    clonedSubMask.name =
      options.rename === false
        ? clonedSubMask.name
        : t('editor.masks.patches.copyName', { name: getSubMaskName(subMask) });

    return clonedSubMask;
  };

  const copyMaskToClipboard = (container: MaskContainer) => {
    setCopiedMask(JSON.parse(JSON.stringify(container)));
  };

  const copySubMaskToClipboard = (subMask: SubMask) => {
    setCopiedSubMask(JSON.parse(JSON.stringify(subMask)));
  };

  const insertMaskContainer = (container: MaskContainer, insertIndex?: number) => {
    setAdjustments((prev: Adjustments) => {
      const newMasks = [...(prev.masks || [])];
      const targetIndex = Math.max(0, Math.min(insertIndex ?? newMasks.length, newMasks.length));

      newMasks.splice(targetIndex, 0, container);

      return { ...prev, masks: newMasks };
    });

    onSelectContainer(container.id);
    onSelectMask(null);
    setExpandedContainers((prev) => new Set(prev).add(container.id));
  };

  const insertSubMaskIntoContainer = (containerId: string, subMask: SubMask, insertIndex?: number) => {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      masks: prev.masks.map((container) => {
        if (container.id !== containerId) {
          return container;
        }

        const newSubMasks = [...container.subMasks];
        const targetIndex = Math.max(0, Math.min(insertIndex ?? newSubMasks.length, newSubMasks.length));

        newSubMasks.splice(targetIndex, 0, subMask);

        return { ...container, subMasks: newSubMasks };
      }),
    }));

    onSelectContainer(containerId);
    onSelectMask(subMask.id);
    setExpandedContainers((prev) => new Set(prev).add(containerId));
  };

  const handleDuplicateContainer = (container: MaskContainer) => {
    const containerIndex = adjustments.masks.findIndex((mask) => mask.id === container.id);
    const duplicatedContainer = cloneMaskContainerData(container, { rename: true, resetAdjustments: true });

    insertMaskContainer(duplicatedContainer, containerIndex >= 0 ? containerIndex + 1 : undefined);
  };

  const handleDuplicateAndInvertContainer = (container: MaskContainer) => {
    const containerIndex = adjustments.masks.findIndex((mask) => mask.id === container.id);
    const duplicatedContainer = cloneMaskContainerData(container, {
      invert: true,
      rename: false,
      resetAdjustments: true,
    });
    duplicatedContainer.name = t('editor.masks.patches.invertedName', { name: container.name });

    insertMaskContainer(duplicatedContainer, containerIndex >= 0 ? containerIndex + 1 : undefined);
  };

  const handlePasteMask = (insertAfterContainerId?: string) => {
    if (!copiedMask) {
      return;
    }

    const pastedContainer = cloneMaskContainerData(copiedMask, { rename: false });
    const containerIndex = insertAfterContainerId
      ? adjustments.masks.findIndex((mask) => mask.id === insertAfterContainerId)
      : -1;

    insertMaskContainer(pastedContainer, containerIndex >= 0 ? containerIndex + 1 : undefined);
  };

  const handleDuplicateSubMask = (containerId: string, subMask: SubMask, insertIndex?: number) => {
    const duplicatedSubMask = cloneSubMaskData(subMask, { rename: true });

    insertSubMaskIntoContainer(containerId, duplicatedSubMask, insertIndex);
  };

  const handleDuplicateAndInvertSubMask = (containerId: string, subMask: SubMask) => {
    const parentContainer = adjustments.masks.find((m) => m.id === containerId);
    if (!parentContainer) return;

    const duplicatedSubMask = cloneSubMaskData(subMask, { invert: true, rename: false });
    const newContainer = cloneMaskContainerData(parentContainer, { rename: false, resetAdjustments: true });

    newContainer.name = t('editor.masks.patches.invertedName', { name: getSubMaskName(subMask) });
    newContainer.subMasks = [duplicatedSubMask];
    newContainer.invert = false;

    const parentIndex = adjustments.masks.findIndex((m) => m.id === containerId);
    insertMaskContainer(newContainer, parentIndex >= 0 ? parentIndex + 1 : undefined);
  };

  const handlePasteSubMask = (containerId: string, insertIndex?: number) => {
    if (!copiedSubMask) {
      return;
    }

    const pastedSubMask = cloneSubMaskData(copiedSubMask, { rename: false });

    insertSubMaskIntoContainer(containerId, pastedSubMask, insertIndex);
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragItem(event.active.data.current as DragData);
    if (onDragStateChange) onDragStateChange(true);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const dragData = active.data.current as DragData;
    const overData = over?.data.current as DragData;

    if (dragData.type === 'Creation' && dragData.maskType) {
      const creationFn = () => {
        if (overData?.type === 'Container') {
          handleAddSubMask(overData.item!.id, dragData.maskType!);
        } else if (overData?.type === 'SubMask') {
          const container = adjustments.masks.find((m) => m.id === overData.parentId);
          if (container) {
            insertCreatedSubMask(container, over?.id ?? '', dragData.maskType!, handleAddSubMask);
          }
        } else {
          handleAddMaskContainer(dragData.maskType!);
        }
      };

      if (adjustments.masks && adjustments.masks.length > 0) {
        setPendingAction(() => creationFn);
      } else {
        creationFn();
      }

      setActiveDragItem(null);
      if (onDragStateChange) onDragStateChange(false);
      return;
    }

    setActiveDragItem(null);
    if (onDragStateChange) onDragStateChange(false);

    if (dragData.type === 'Container') {
      const overId = over?.id;
      if (!overId || active.id === overId) return;

      setAdjustments((prev: Adjustments) => {
        const oldIndex = prev.masks.findIndex((m) => m.id === dragData.item!.id);
        let newIndex = -1;

        if (overId === 'mask-list-root') {
          newIndex = prev.masks.length - 1;
        } else if (overData?.type === 'Container') {
          newIndex = prev.masks.findIndex((m) => m.id === overId);
        } else if (overData?.type === 'SubMask') {
          newIndex = prev.masks.findIndex((m) => m.id === overData.parentId);
        }

        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          const newMasks = [...prev.masks];
          const [movedItem] = newMasks.splice(oldIndex, 1);
          newMasks.splice(newIndex, 0, movedItem);
          return { ...prev, masks: newMasks };
        }
        return prev;
      });
      return;
    }

    if (dragData.type === 'SubMask') {
      const sourceContainerId = dragData.parentId;
      if (!sourceContainerId) return;

      if (over?.id === 'mask-list-root' || !over) {
        setAdjustments((prev: Adjustments) => {
          const newMasks = JSON.parse(JSON.stringify(prev.masks));
          const sourceContainer = newMasks.find((m: MaskContainer) => m.id === sourceContainerId);
          if (!sourceContainer) return prev;
          const subMaskIndex = sourceContainer.subMasks.findIndex((sm: SubMask) => sm.id === dragData.item!.id);
          if (subMaskIndex === -1) return prev;
          const [movedSubMask] = sourceContainer.subMasks.splice(subMaskIndex, 1);

          const newContainer = {
            ...INITIAL_MASK_CONTAINER,
            id: uuidv4(),
            name: `Mask ${newMasks.length + 1}`,
            subMasks: [movedSubMask],
          };
          newMasks.push(newContainer);
          setTimeout(() => {
            onSelectContainer(newContainer.id);
            onSelectMask(movedSubMask.id);
            setExpandedContainers((p) => new Set(p).add(newContainer.id));
          }, 0);
          return { ...prev, masks: newMasks };
        });
        return;
      }

      if (!over) return;

      let targetContainerId: string | null = null;
      if (overData?.type === 'Container') targetContainerId = overData.item!.id;
      else if (overData?.type === 'SubMask' && overData.parentId) targetContainerId = overData.parentId;

      if (targetContainerId) {
        setAdjustments((prev: Adjustments) => {
          const newMasks = prev.masks.map((m) => ({ ...m, subMasks: [...m.subMasks] }));
          const sourceContainer = newMasks.find((m) => m.id === sourceContainerId);
          const targetContainer = newMasks.find((m) => m.id === targetContainerId);
          if (!sourceContainer || !targetContainer) return prev;

          const sourceSubMaskIndex = sourceContainer.subMasks.findIndex((sm) => sm.id === dragData.item!.id);
          if (sourceSubMaskIndex === -1) return prev;

          const [movedSubMask] = sourceContainer.subMasks.splice(sourceSubMaskIndex, 1);

          if (sourceContainerId === targetContainerId) {
            if (overData?.type === 'SubMask') {
              const overSubMaskIndex = sourceContainer.subMasks.findIndex((sm) => sm.id === over?.id);
              const insertIndex = overSubMaskIndex >= 0 ? overSubMaskIndex : sourceContainer.subMasks.length;
              sourceContainer.subMasks.splice(insertIndex, 0, movedSubMask);
            } else {
              sourceContainer.subMasks.push(movedSubMask);
            }
          } else {
            if (overData?.type === 'SubMask') {
              const overSubMaskIndex = targetContainer.subMasks.findIndex((sm) => sm.id === over?.id);
              const insertIndex = overSubMaskIndex >= 0 ? overSubMaskIndex : targetContainer.subMasks.length;
              targetContainer.subMasks.splice(insertIndex, 0, movedSubMask);
            } else {
              targetContainer.subMasks.push(movedSubMask);
            }
            setExpandedContainers((p) => new Set(p).add(targetContainerId!));
          }
          return { ...prev, masks: newMasks };
        });
      }
    }
  };

  const handlePanelContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();

    const buildMenu = (types: MaskType[]) =>
      types.map((m) => ({
        label: getMaskTypeName(m),
        icon: m.icon,
        onClick: () => handleAddMaskContainer(m.type),
      }));

    const newMaskSubMenu = [
      ...buildMenu(MASK_AI_TYPES),
      ...buildMarigoldMenu(),
      { type: OPTION_SEPARATOR },
      ...buildMenu(MASK_BASIC_TYPES),
      { type: OPTION_SEPARATOR },
      ...buildMenu(MASK_RANGE_TYPES),
    ];

    showContextMenu(e.clientX, e.clientY, [
      {
        label: t('editor.masks.actions.pasteMask'),
        icon: ClipboardPaste,
        disabled: !copiedMask,
        onClick: () => handlePasteMask(),
      },
      { label: t('editor.masks.addNewMask'), icon: Plus, submenu: newMaskSubMenu },
    ]);
  };

  return (
    <DndContext
      id="masks-panel-dnd"
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      collisionDetection={pointerWithin}
    >
      <div className="flex flex-col h-full select-none overflow-hidden" onContextMenu={handlePanelContextMenu}>
        <div className="p-3 flex justify-between items-center shrink-0 border-b border-surface">
          <Text variant={TextVariants.title}>{t('editor.masks.maskingTitle')}</Text>
          <div className="flex items-center gap-1">
            <button
              className="p-2 rounded-full hover:bg-surface transition-colors"
              onClick={() => setEditor({ showPatchMarkers: !showPatchMarkers })}
              data-tooltip={
                showPatchMarkers ? t('editor.masks.hideMarkersTooltip') : t('editor.masks.showMarkersTooltip')
              }
              aria-label={
                showPatchMarkers ? t('editor.masks.hideMarkersTooltip') : t('editor.masks.showMarkersTooltip')
              }
              aria-pressed={!showPatchMarkers}
            >
              {showPatchMarkers ? <Eye size={18} /> : <EyeOff size={18} />}
            </button>
            <button
              className={clsx(
                'p-2 rounded-full transition-colors',
                isAdjustmentsPanelVisible
                  ? 'opacity-50 cursor-not-allowed text-text-secondary'
                  : isWaveformVisible
                    ? 'bg-surface hover:bg-card-active'
                    : 'hover:bg-surface',
              )}
              onClick={onToggleWaveform}
              disabled={isAdjustmentsPanelVisible}
              data-tooltip={
                isAdjustmentsPanelVisible
                  ? t('editor.masks.toggleAnalyticsInAdjustments')
                  : t('editor.masks.toggleAnalyticsTooltip')
              }
            >
              <ChartArea size={18} />
            </button>
            <button
              className="p-2 rounded-full hover:bg-surface transition-colors"
              onClick={handleResetAllMasks}
              data-tooltip={t('editor.masks.resetMaskingTooltip')}
            >
              <RotateCcw size={18} />
            </button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {isWaveformVisible && !isAdjustmentsPanelVisible && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: waveformHeight || 256, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: isResizingWaveform ? 0 : 0.2, ease: 'easeOut' }}
              className="shrink-0 flex flex-col relative border-b border-surface overflow-hidden"
            >
              <div className="grow w-full h-full p-3 pb-2 min-h-0">
                <Waveform
                  waveformData={waveform || null}
                  histogram={histogram}
                  displayMode={activeWaveformChannel || 'luma'}
                  setDisplayMode={setActiveWaveformChannel}
                  showClipping={showClipping}
                  onToggleClipping={() => setEditor((state) => ({ showClipping: !state.showClipping }))}
                />
              </div>
              <Resizer direction={Orientation.Horizontal} onMouseDown={handleWaveformResize} />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-h-0 p-3">
          {selectedImage ? (
            <>
              <AnimatePresence mode="wait">
                {!adjustments.masks || adjustments.masks.length === 0 ? (
                  <motion.div
                    key="empty-masks-grid"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="z-10 shrink-0"
                    onClick={handleDeselect}
                  >
                    <Text variant={TextVariants.heading} className="mb-2">
                      {t('editor.masks.aiTitle', 'AI Selections')}
                    </Text>
                    <div className="grid grid-cols-3 gap-2 mb-6" onClick={(e) => e.stopPropagation()}>
                      {MASK_AI_TYPES.map((maskType) => (
                        <DraggableGridItem
                          key={maskType.type}
                          maskType={maskType}
                          onClick={() => handleGridClick(maskType.type)}
                          onRightClick={(e: React.MouseEvent) => handleGridRightClick(e, maskType.type)}
                          activeMaskContainerId={activeMaskContainerId}
                        />
                      ))}
                      {appSettings?.marigoldDepthEnabled && (
                        <button
                          className="rounded-md bg-surface p-2 text-sm hover:bg-card-active disabled:opacity-50"
                          disabled={isGeneratingAiMask}
                          onClick={() => handleAddMaskContainer(Mask.AiDepth, 'marigold')}
                        >
                          <span className="block">
                            {t('editor.masks.marigold.newMask', { defaultValue: 'Depth Selection' })}
                          </span>
                          <span className="block text-xs text-text-secondary">
                            {t('editor.masks.marigold.requiresConnector', {
                              defaultValue: 'Requires AI Connector for analysis',
                            })}
                          </span>
                        </button>
                      )}
                      {appSettings?.marigoldSurfaceEnabled &&
                        [Mask.AiNormals, Mask.AiAlbedo].map((type) => (
                          <button
                            key={type}
                            className="rounded-md bg-surface p-2 text-sm hover:bg-card-active disabled:opacity-50"
                            disabled={isGeneratingAiMask}
                            onClick={() => handleAddMaskContainer(type)}
                          >
                            {type === Mask.AiNormals
                              ? t('masks.types.normals', { defaultValue: 'Shape Light' })
                              : t('masks.types.albedo', { defaultValue: 'Surface Colour' })}
                          </button>
                        ))}
                    </div>
                    <Text variant={TextVariants.heading} className="mb-2">
                      {t('editor.masks.basicTitle', 'Basic Tools')}
                    </Text>
                    <div className="grid grid-cols-3 gap-2 mb-6" onClick={(e) => e.stopPropagation()}>
                      {MASK_BASIC_TYPES.map((maskType) => (
                        <DraggableGridItem
                          key={maskType.type}
                          maskType={maskType}
                          onClick={() => handleGridClick(maskType.type)}
                          onRightClick={(e: React.MouseEvent) => handleGridRightClick(e, maskType.type)}
                          activeMaskContainerId={activeMaskContainerId}
                        />
                      ))}
                    </div>
                    <Text variant={TextVariants.heading} className="mb-2">
                      {t('editor.masks.rangeTitle', 'Ranges & Global')}
                    </Text>
                    <div className="grid grid-cols-3 gap-2" onClick={(e) => e.stopPropagation()}>
                      {MASK_RANGE_TYPES.map((maskType) => (
                        <DraggableGridItem
                          key={maskType.type}
                          maskType={maskType}
                          onClick={() => handleGridClick(maskType.type)}
                          onRightClick={(e: React.MouseEvent) => handleGridRightClick(e, maskType.type)}
                          activeMaskContainerId={activeMaskContainerId}
                        />
                      ))}
                    </div>
                  </motion.div>
                ) : (
                  <MasksListRoot onClick={handleDeselect}>
                    <Text variant={TextVariants.heading} className="mb-2">
                      {t('editor.masks.masksTitle')}
                    </Text>

                    <AnimatePresence
                      initial={false}
                      mode="popLayout"
                      onExitComplete={() => {
                        if (pendingAction) {
                          pendingAction();
                          setPendingAction(null);
                        }
                      }}
                    >
                      {adjustments.masks.map((container) => (
                        <ContainerRow
                          key={container.id}
                          container={container}
                          isSelected={activeMaskContainerId === container.id && activeMaskId === null}
                          hasActiveChild={activeMaskContainerId === container.id && activeMaskId !== null}
                          isExpanded={expandedContainers.has(container.id)}
                          onToggle={() => handleToggleExpand(container.id)}
                          onSelect={() => {
                            onSelectContainer(container.id);
                            onSelectMask(null);
                          }}
                          renamingId={renamingId}
                          setRenamingId={setRenamingId}
                          tempName={tempName}
                          setTempName={setTempName}
                          updateContainer={updateContainer}
                          handleDelete={handleDeleteContainer}
                          handleDuplicate={handleDuplicateContainer}
                          handleDuplicateAndInvert={handleDuplicateAndInvertContainer}
                          handlePasteMask={handlePasteMask}
                          copyMaskToClipboard={copyMaskToClipboard}
                          copiedMask={copiedMask}
                          presets={presets}
                          setAdjustments={setAdjustments}
                          activeDragItem={activeDragItem}
                          activeMaskId={activeMaskId}
                          onSelectContainer={onSelectContainer}
                          onSelectMask={onSelectMask}
                          updateSubMask={updateSubMask}
                          handleDeleteSubMask={handleDeleteSubMask}
                          handleDuplicateSubMask={handleDuplicateSubMask}
                          handleDuplicateAndInvertSubMask={handleDuplicateAndInvertSubMask}
                          handlePasteSubMask={handlePasteSubMask}
                          copySubMaskToClipboard={copySubMaskToClipboard}
                          copiedSubMask={copiedSubMask}
                          analyzingSubMaskId={analyzingSubMaskId}
                          setIsMaskControlHovered={setIsMaskControlHovered}
                          onAddComponent={(e: React.MouseEvent) => handleAddMaskContextMenu(e, container.id)}
                        />
                      ))}
                    </AnimatePresence>

                    <AnimatePresence>
                      {activeDragItem?.type === 'Creation' && adjustments.masks.length > 0 && (
                        <NewMaskDropZone isOver={false} textKey="editor.masks.dropzoneText" />
                      )}
                    </AnimatePresence>

                    <Text
                      as="div"
                      weight={TextWeights.medium}
                      className="flex items-center gap-2 p-2 rounded-md transition-colors transition-opacity opacity-70 hover:opacity-100 hover:bg-card-active cursor-pointer hover:text-text-primary"
                      onClick={(e) => handleAddMaskContextMenu(e, null)}
                    >
                      <div className="p-0.5">
                        <Plus size={18} />
                      </div>
                      <span>{t('editor.masks.addNewMask')}</span>
                    </Text>
                  </MasksListRoot>
                )}
              </AnimatePresence>

              <div className="h-4 shrink-0 w-full" onClick={handleDeselect} />

              <AnimatePresence>
                {isSettingsPanelEverOpened && (
                  <motion.div
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="flex-1 min-h-0"
                  >
                    <Text variant={TextVariants.heading} className="mb-2">
                      {t('editor.masks.maskAdjustmentsTitle')}
                    </Text>
                    <MaskSettingsPanel
                      onLimitWithBrush={() => {
                        if (activeMaskContainerId)
                          handleAddSubMask(activeMaskContainerId, Mask.Brush, SubMaskMode.Intersect);
                      }}
                      container={activeContainer ?? null}
                      activeSubMask={activeSubMaskData || null}
                      aiModelDownloadStatus={aiModelDownloadStatus}
                      brushSettings={brushSettings ?? { size: 50, feather: 50, tool: ToolType.Brush }}
                      setBrushSettings={setBrushSettings}
                      updateContainer={updateContainer}
                      updateSubMask={updateSubMask}
                      histogram={histogram}
                      appSettings={appSettings}
                      setIsMaskControlHovered={setIsMaskControlHovered}
                      collapsibleState={collapsibleState}
                      setCollapsibleState={setCollapsibleState}
                      copiedSectionAdjustments={copiedSectionAdjustments}
                      setCopiedSectionAdjustments={setCopiedSectionAdjustments}
                      onDragStateChange={onDragStateChange}
                      isSettingsSectionOpen={isSettingsSectionOpen}
                      setSettingsSectionOpen={setSettingsSectionOpen}
                      presets={presets}
                      handleGenerateAiDepthMask={handleGenerateAiDepthMask}
                      handleGenerateSurfaceMask={handleGenerateSurfaceMask}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          ) : (
            <div className="flex items-center justify-center h-full">
              <Text
                variant={TextVariants.heading}
                color={TextColors.secondary}
                weight={TextWeights.normal}
                className="text-center"
              >
                {t('editor.ai.noImageSelected')}
              </Text>
            </div>
          )}
        </div>
      </div>

      <DragOverlay dropAnimation={{ duration: 150, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
        {activeDragItem ? (
          <div className="w-(--sidebar-width,280px) pointer-events-none">
            {activeDragItem.type === 'Container' && activeDragItem.item && (
              <Text
                as="div"
                color={TextColors.primary}
                weight={TextWeights.medium}
                className="flex items-center gap-2 p-2 rounded-md bg-surface shadow-2xl opacity-90 ring-1 ring-black/10"
              >
                <FolderIcon size={18} className={TEXT_COLOR_KEYS[TextColors.secondary]} />
                <span className="flex-1 truncate">{(activeDragItem.item as MaskContainer).name}</span>
              </Text>
            )}

            {activeDragItem.type === 'SubMask' && activeDragItem.item && (
              <Text
                as="div"
                color={TextColors.primary}
                weight={TextWeights.medium}
                className="flex items-center gap-2 p-2 rounded-md bg-surface shadow-2xl opacity-90 ring-1 ring-black/10 ml-3.75"
              >
                {(() => {
                  const sm = activeDragItem.item as SubMask;
                  const Icon = MASK_ICON_MAP[sm.type] || Circle;
                  return <Icon size={16} className={`shrink-0 ml-1 ${TEXT_COLOR_KEYS[TextColors.secondary]}`} />;
                })()}
                <span className="flex-1 truncate">{getSubMaskName(activeDragItem.item as SubMask)}</span>
              </Text>
            )}

            {activeDragItem.type === 'Creation' && (
              <Text
                as="div"
                variant={TextVariants.small}
                color={TextColors.primary}
                className="bg-surface rounded-lg gap-2 p-2 flex flex-col items-center justify-center aspect-square w-20 shadow-xl opacity-90"
              >
                {(() => {
                  const maskType = ALL_MASK_TYPES.find((m) => m.type === activeDragItem.maskType);
                  const Icon = maskType?.icon || Circle;
                  return (
                    <>
                      <Icon size={24} />
                      <span className="text-center">
                        {activeDragItem.maskType ? formatMaskTypeName(activeDragItem.maskType) : 'Mask'}
                      </span>
                    </>
                  );
                })()}
              </Text>
            )}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function DraggableGridItem({
  maskType,
  onClick,
  onRightClick,
  activeMaskContainerId,
}: {
  maskType: MaskType;
  onClick: () => void;
  onRightClick: (e: React.MouseEvent) => void;
  activeMaskContainerId: string | null;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `create-${maskType.type}`,
    data: { type: 'Creation', maskType: maskType.type },
    disabled: maskType.disabled,
  });

  const tooltip = maskType.disabled
    ? t('editor.masks.comingSoon')
    : activeMaskContainerId
      ? t('editor.masks.tooltips.addToCurrent', { name: getMaskTypeName(maskType) })
      : t('editor.masks.tooltips.createNew', { name: getMaskTypeName(maskType) });

  return (
    <motion.div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onClick}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        if (event.button !== 2) return;
        onRightClick(event);
      }}
      className={`bg-surface text-text-primary rounded-lg p-2 flex flex-col items-center justify-center gap-2 aspect-square transition-colors
        ${maskType.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-card-active active:bg-accent/20'} 
        ${isDragging ? 'opacity-50' : ''}`}
      data-tooltip={tooltip}
      whileTap={{ scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 400, damping: 17 }}
    >
      <maskType.icon size={24} />
      <Text
        as="span"
        variant={TextVariants.small}
        color={TextColors.primary}
        className="text-center w-full leading-tight"
      >
        {getMaskTypeName(maskType)}
      </Text>
    </motion.div>
  );
}

function ContainerRow({
  container,
  isSelected,
  hasActiveChild,
  isExpanded,
  onToggle,
  onSelect,
  renamingId,
  setRenamingId,
  tempName,
  setTempName,
  updateContainer,
  handleDelete,
  handleDuplicate,
  handleDuplicateAndInvert,
  handlePasteMask,
  copyMaskToClipboard,
  copiedMask,
  presets,
  setAdjustments,
  activeDragItem,
  activeMaskId,
  onSelectContainer,
  onSelectMask,
  updateSubMask,
  handleDeleteSubMask,
  handleDuplicateSubMask,
  handleDuplicateAndInvertSubMask,
  handlePasteSubMask,
  copySubMaskToClipboard,
  copiedSubMask,
  analyzingSubMaskId,
  setIsMaskControlHovered,
  onAddComponent,
}: ContainerRowProps) {
  const { t } = useTranslation();
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: container.id,
    data: { type: 'Container', item: container },
  });
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    isDragging,
  } = useDraggable({ id: container.id, data: { type: 'Container', item: container } });
  const { showContextMenu } = useContextMenu();

  const setCombinedRef = (node: HTMLElement | null) => {
    setDroppableRef(node);
    setDraggableRef(node);
  };

  const handleRenameSubmit = () => {
    if (tempName.trim()) {
      const newName = tempName.trim();
      setAdjustments((prev) => {
        const updatedMasks = prev.masks.map((m) => (m.id === container.id ? { ...m, name: newName } : m));
        return { ...prev, masks: updatedMasks };
      });
    }
    setRenamingId(null);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const presetMenu = buildPresetMenu(presets, (preset) => {
      const newAdj = { ...container.adjustments, ...preset.adjustments };
      newAdj.sectionVisibility = { ...container.adjustments.sectionVisibility, ...newAdj.sectionVisibility };
      updateContainer(container.id, { adjustments: newAdj });
    });

    showContextMenu(e.clientX, e.clientY, [
      {
        label: t('editor.masks.actions.rename'),
        icon: FileEdit,
        onClick: () => {
          setRenamingId(container.id);
          setTempName(container.name);
        },
      },
      { label: t('editor.masks.actions.duplicateMask'), icon: PlusSquare, onClick: () => handleDuplicate(container) },
      {
        label: t('editor.masks.actions.duplicateAndInvertMask'),
        icon: RotateCcw,
        onClick: () => handleDuplicateAndInvert(container),
      },
      { label: t('editor.masks.actions.copyMask'), icon: Copy, onClick: () => copyMaskToClipboard(container) },
      {
        label: t('editor.masks.actions.pasteMask'),
        icon: ClipboardPaste,
        disabled: !copiedMask,
        onClick: () => handlePasteMask(container.id),
      },
      {
        label: t('editor.masks.actions.pasteMaskAdjustments'),
        icon: ClipboardPaste,
        disabled: !copiedMask,
        onClick: () => {
          if (copiedMask) {
            updateContainer(container.id, { adjustments: JSON.parse(JSON.stringify(copiedMask.adjustments)) });
          }
        },
      },
      {
        label: t('editor.masks.actions.applyPreset'),
        icon: SwatchBook,
        submenu: presetMenu.length ? presetMenu : [{ label: t('editor.masks.actions.noPresets'), disabled: true }],
      },
      { type: OPTION_SEPARATOR },
      {
        label: t('editor.masks.actions.resetMaskAdjustments'),
        icon: RotateCcw,
        onClick: () =>
          updateContainer(container.id, { adjustments: JSON.parse(JSON.stringify(INITIAL_MASK_ADJUSTMENTS)) }),
      },
      {
        label: t('editor.masks.actions.deleteMask'),
        icon: Trash2,
        isDestructive: true,
        onClick: () => handleDelete(container.id),
      },
    ]);
  };

  const isDraggingContainer = activeDragItem?.type === 'Container';
  let borderClass = '';

  if (isOver) {
    if (isDraggingContainer) {
      borderClass = 'border-t-2 border-accent';
    } else if (
      (activeDragItem?.type === 'SubMask' && activeDragItem?.parentId !== container.id) ||
      activeDragItem?.type === 'Creation'
    ) {
      borderClass = 'bg-card-active border border-accent/50';
    }
  }

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: isDragging ? 0.4 : 1, height: 'auto' }}
      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
      ref={setCombinedRef}
      className="overflow-hidden"
    >
      <div
        {...listeners}
        {...attributes}
        className={`flex items-center gap-2 p-2 rounded-md transition-colors group
             ${isSelected ? 'bg-surface' : 'hover:bg-card-active'}
             ${borderClass}`}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        onContextMenu={onContextMenu}
      >
        <Text
          as="div"
          color={hasActiveChild || isExpanded ? TextColors.primary : TextColors.secondary}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="p-0.5 rounded transition-colors cursor-pointer"
        >
          {isExpanded ? <FolderOpen size={18} /> : <FolderIcon size={18} />}
        </Text>
        <div
          className="flex-1 min-w-0 cursor-pointer"
          onDoubleClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          {renamingId === container.id ? (
            <input
              autoFocus
              className="bg-bg-primary text-sm w-full rounded-sm px-1 outline-hidden border border-accent"
              value={tempName}
              onChange={(e) => setTempName(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={(e) => e.key === 'Enter' && handleRenameSubmit()}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <Text color={TextColors.primary} weight={TextWeights.medium} className="truncate select-none">
              {container.name}
            </Text>
          )}
        </div>
        <div className="flex opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            className="p-1 hover:text-text-primary text-text-secondary"
            onMouseEnter={() => setIsMaskControlHovered(true)}
            onMouseLeave={() => setIsMaskControlHovered(false)}
            data-tooltip={container.visible ? t('editor.masks.actions.hideMask') : t('editor.masks.actions.showMask')}
            onClick={(e) => {
              e.stopPropagation();
              updateContainer(container.id, { visible: !container.visible });
            }}
          >
            {container.visible ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
          <button
            className="p-1 hover:text-red-500 text-text-secondary"
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(container.id);
            }}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden pl-2 border-l-[1.5px] border-border-color/50 ml-3.75"
            layout
          >
            <AnimatePresence mode="popLayout" initial={false}>
              {container.subMasks.map((subMask: SubMask, index: number) => (
                <SubMaskRow
                  key={subMask.id}
                  subMask={subMask}
                  index={index + 1}
                  totalCount={container.subMasks.length}
                  containerId={container.id}
                  isActive={activeMaskId === subMask.id}
                  parentVisible={container.visible}
                  activeDragItem={activeDragItem}
                  onSelect={() => {
                    onSelectContainer(container.id);
                    onSelectMask(subMask.id);
                  }}
                  updateSubMask={updateSubMask}
                  handleDelete={() => handleDeleteSubMask(container.id, subMask.id)}
                  handleDuplicate={() => handleDuplicateSubMask(container.id, subMask, index + 1)}
                  handleDuplicateAndInvert={() => handleDuplicateAndInvertSubMask(container.id, subMask)}
                  handlePaste={() => handlePasteSubMask(container.id, index + 1)}
                  handleCopy={() => copySubMaskToClipboard(subMask)}
                  hasCopiedSubMask={!!copiedSubMask}
                  analyzingSubMaskId={analyzingSubMaskId}
                  renamingId={renamingId}
                  setRenamingId={setRenamingId}
                  tempName={tempName}
                  setTempName={setTempName}
                  setIsMaskControlHovered={setIsMaskControlHovered}
                />
              ))}
            </AnimatePresence>

            <AnimatePresence initial={false}>
              {(isSelected || hasActiveChild || container.subMasks.length === 0) && (
                <motion.div
                  key="add-component-btn"
                  layout="position"
                  initial={{ opacity: 0, height: 0, overflow: 'hidden' }}
                  animate={{ opacity: 1, height: 'auto', overflow: 'hidden' }}
                  exit={{ opacity: 0, height: 0, overflow: 'hidden' }}
                  transition={{ duration: 0.2 }}
                >
                  <Text
                    as="div"
                    weight={TextWeights.medium}
                    className="flex items-center gap-2 p-2 rounded-md transition-colors transition-opacity opacity-70 hover:opacity-100 hover:bg-card-active cursor-pointer hover:text-text-primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddComponent(e);
                    }}
                  >
                    <div className="relative w-4 h-4 ml-1 shrink-0 flex items-center justify-center">
                      <Plus size={16} />
                    </div>
                    <span className="select-none">{t('editor.masks.actions.addNewComponent')}</span>
                  </Text>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function SubMaskRow({
  subMask,
  index,
  totalCount,
  containerId,
  isActive,
  parentVisible,
  onSelect,
  updateSubMask,
  handleDelete,
  handleDuplicate,
  handleDuplicateAndInvert,
  handlePaste,
  handleCopy,
  hasCopiedSubMask,
  activeDragItem,
  analyzingSubMaskId,
  renamingId,
  setRenamingId,
  tempName,
  setTempName,
  setIsMaskControlHovered,
}: SubMaskRowProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: subMask.id,
    data: { type: 'SubMask', item: subMask, parentId: containerId },
  });
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: subMask.id,
    data: { type: 'SubMask', item: subMask, parentId: containerId },
  });
  const setCombinedRef = (node: HTMLElement | null) => {
    setNodeRef(node);
    setDroppableRef(node);
  };
  const MaskIcon = MASK_ICON_MAP[subMask.type] || Circle;
  const { showContextMenu } = useContextMenu();
  const [isHovered, setIsHovered] = useState(false);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isDraggingContainer = activeDragItem?.type === 'Container';
  const isAnalyzing = subMask.id === analyzingSubMaskId;

  const handleMouseEnter = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 1000);
  };

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  const handleRenameSubmit = () => {
    if (tempName.trim()) {
      const newName = tempName.trim();
      updateSubMask(subMask.id, { name: newName });
    }
    setRenamingId(null);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      {
        label: t('editor.masks.actions.rename'),
        icon: FileEdit,
        onClick: () => {
          setRenamingId(subMask.id);
          setTempName(getSubMaskName(subMask));
        },
      },
      { label: t('editor.masks.actions.duplicateComponent'), icon: PlusSquare, onClick: handleDuplicate },
      {
        label: t('editor.masks.actions.duplicateAndInvertComponent'),
        icon: RotateCcw,
        onClick: handleDuplicateAndInvert,
      },
      { label: t('editor.masks.actions.copyComponent'), icon: Copy, onClick: handleCopy },
      {
        label: t('editor.masks.actions.pasteComponent'),
        icon: ClipboardPaste,
        disabled: !hasCopiedSubMask,
        onClick: handlePaste,
      },
      { type: OPTION_SEPARATOR },
      { label: t('editor.masks.actions.deleteComponent'), icon: Trash2, isDestructive: true, onClick: handleDelete },
    ]);
  };

  const showNumber = isHovered && totalCount > 1;

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, x: -15 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: -15, scale: 0.95, transition: { duration: 0.2 } }}
      ref={setCombinedRef}
      {...attributes}
      {...listeners}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`flex items-center gap-2 p-2 rounded-md transition-colors group cursor-pointer
            ${isActive ? 'bg-surface' : 'hover:bg-card-active'}
            ${isOver && !isDraggingContainer ? 'border-t-2 border-accent' : ''}
            ${isDragging ? 'opacity-40 z-50' : ''}
            ${parentVisible === false ? 'opacity-50' : ''}
            ${isDraggingContainer ? 'opacity-30 pointer-events-none' : ''}
            transition-opacity duration-300`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onContextMenu={onContextMenu}
    >
      <Text
        as="div"
        variant={TextVariants.small}
        weight={TextWeights.bold}
        className="relative w-4 h-4 ml-1 shrink-0 flex items-center justify-center"
      >
        <AnimatePresence mode="wait" initial={false}>
          {isAnalyzing ? (
            <motion.div
              key="analyzing"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{ duration: 0.15 }}
              className="absolute"
            >
              <Loader2 size={16} className="animate-spin" />
            </motion.div>
          ) : showNumber ? (
            <motion.span
              key="number"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{ duration: 0.15 }}
              className="absolute"
            >
              {index}
            </motion.span>
          ) : (
            <motion.div
              key="icon"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{ duration: 0.15 }}
              className="absolute"
            >
              <MaskIcon size={16} />
            </motion.div>
          )}
        </AnimatePresence>
      </Text>
      {renamingId === subMask.id ? (
        <input
          autoFocus
          className="bg-bg-primary text-sm w-full rounded px-1 outline-none border border-accent"
          value={tempName}
          onChange={(e) => setTempName(e.target.value)}
          onBlur={handleRenameSubmit}
          onKeyDown={(e) => e.key === 'Enter' && handleRenameSubmit()}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <Text color={TextColors.primary} className="flex-1 truncate select-none">
          {getSubMaskName(subMask)}
        </Text>
      )}
      <div className="flex opacity-0 group-hover:opacity-100 transition-opacity">
        {index > 1 && (
          <button
            className="p-1 hover:text-text-primary text-text-secondary"
            data-tooltip={
              subMask.mode === SubMaskMode.Additive
                ? t('editor.masks.actions.switchToSubtract')
                : subMask.mode === SubMaskMode.Subtractive
                  ? t('editor.masks.actions.switchToIntersect')
                  : t('editor.masks.actions.switchToAdd')
            }
            onClick={(e) => {
              e.stopPropagation();
              updateSubMask(subMask.id, {
                mode:
                  subMask.mode === SubMaskMode.Additive
                    ? SubMaskMode.Subtractive
                    : subMask.mode === SubMaskMode.Subtractive
                      ? SubMaskMode.Intersect
                      : SubMaskMode.Additive,
              });
            }}
          >
            {subMask.mode === SubMaskMode.Additive ? (
              <Plus size={16} />
            ) : subMask.mode === SubMaskMode.Subtractive ? (
              <Minus size={16} />
            ) : (
              <SquaresIntersect size={16} />
            )}
          </button>
        )}
        <button
          className="p-1 hover:text-text-primary text-text-secondary"
          data-tooltip={
            subMask.visible ? t('editor.masks.actions.hideComponent') : t('editor.masks.actions.showComponent')
          }
          onMouseEnter={() => setIsMaskControlHovered(true)}
          onMouseLeave={() => setIsMaskControlHovered(false)}
          onClick={(e) => {
            e.stopPropagation();
            updateSubMask(subMask.id, { visible: !subMask.visible });
          }}
        >
          {subMask.visible ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
        <button
          className="p-1 hover:text-red-500 text-text-secondary"
          data-tooltip={t('editor.ai.actions.deleteComponent')}
          onClick={(e) => {
            e.stopPropagation();
            handleDelete();
          }}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </motion.div>
  );
}

export function MaskSettingsPanel({
  selectionOnly = false,
  effectOnly = false,
  onLimitWithBrush,
  container,
  activeSubMask,
  aiModelDownloadStatus,
  brushSettings,
  setBrushSettings,
  updateContainer,
  updateSubMask,
  histogram,
  appSettings,
  setIsMaskControlHovered,
  collapsibleState,
  setCollapsibleState,
  copiedSectionAdjustments,
  setCopiedSectionAdjustments,
  onDragStateChange,
  isSettingsSectionOpen,
  setSettingsSectionOpen,
  presets,
  handleGenerateAiDepthMask,
  handleGenerateSurfaceMask,
}: SettingsPanelProps) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const isActive = !!container;
  const presetButtonRef = useRef<HTMLButtonElement>(null);

  const placeholderContainer = {
    ...INITIAL_MASK_CONTAINER,
    adjustments: INITIAL_MASK_ADJUSTMENTS,
    id: 'placeholder',
  };
  const displayContainer = container || placeholderContainer;

  const handleApplyPresetToMask = (presetAdjustments: Partial<Adjustments>) => {
    if (!container) return;
    const currentAdjustments = container.adjustments;
    const newMaskAdjustments = {
      ...currentAdjustments,
      ...presetAdjustments,
      sectionVisibility: {
        ...(currentAdjustments.sectionVisibility || INITIAL_MASK_ADJUSTMENTS.sectionVisibility),
        ...(presetAdjustments.sectionVisibility || {}),
      },
    };
    updateContainer(container.id, { adjustments: newMaskAdjustments });
  };

  const handlePresetSelectClick = () => {
    if (presetButtonRef.current) {
      const rect = presetButtonRef.current.getBoundingClientRect();
      const presetSubmenu = buildPresetMenu(presets, (preset) => handleApplyPresetToMask(preset.adjustments));
      const options =
        presetSubmenu.length > 0
          ? presetSubmenu
          : [{ label: t('editor.masks.settings.noPresetsFound'), disabled: true }];
      showContextMenu(rect.left, rect.bottom + 5, options);
    }
  };

  const handleMaskPropertyChange = <K extends keyof MaskContainer>(key: K, value: MaskContainer[K]) => {
    if (!isActive) return;
    updateContainer(container.id, { [key]: value });
  };

  const handleSubMaskParametersChange = (changes: Partial<MaskParameters>) => {
    if (!isActive || !activeSubMask) return;
    const newParams = { ...activeSubMask.parameters, ...changes };
    updateSubMask(activeSubMask.id, { parameters: newParams });
  };

  const handleDepthRangeChange = (values: { minDepth: number; maxDepth: number; minFade: number; maxFade: number }) => {
    if (!isActive || !activeSubMask) return;

    const newParams = {
      ...activeSubMask.parameters,
      minDepth: 100 - values.maxDepth,
      maxDepth: 100 - values.minDepth,
      minFade: values.maxFade,
      maxFade: values.minFade,
    };
    updateSubMask(activeSubMask.id, { parameters: newParams });
  };

  const subMaskConfig = activeSubMask ? SUB_MASK_CONFIG[activeSubMask.type] || {} : {};
  const isAiMask =
    activeSubMask && [Mask.AiSubject, Mask.AiForeground, Mask.AiSky, Mask.AiDepth].includes(activeSubMask.type);
  const isComponentMode = !!activeSubMask;

  const setMaskContainerAdjustments: AdjustmentSetter = (updater) => {
    if (!isActive) return;
    const currentAdjustments = container.adjustments;
    const newAdjustments = applyMaskAdjustmentUpdate(currentAdjustments, updater);
    updateContainer(container.id, { adjustments: newAdjustments });
  };

  const handleToggleSection = (section: AdjustmentSection) => {
    setCollapsibleState((prev) => {
      const isOpening = !prev[section];
      if (appSettings?.enableFocusMode && isOpening) {
        setSettingsSectionOpen(false);
        const newState = { ...prev };
        Object.keys(newState).forEach((key) => {
          newState[key] = false;
        });
        newState[section] = true;
        return newState;
      }
      return { ...prev, [section]: !prev[section] };
    });
  };

  const handleToggleVisibility = (sectionName: AdjustmentSection) => {
    if (!isActive) return;
    const cur = container.adjustments;
    const vis = cur.sectionVisibility || INITIAL_MASK_ADJUSTMENTS.sectionVisibility;
    updateContainer(container.id, {
      adjustments: { ...cur, sectionVisibility: { ...vis, [sectionName]: !vis[sectionName] } },
    });
  };

  const handleSectionContextMenu = (event: React.MouseEvent, sectionName: AdjustmentSection) => {
    if (!isActive) return;
    event.preventDefault();
    event.stopPropagation();

    const sectionKeys = ADJUSTMENT_SECTIONS[sectionName];
    if (!sectionKeys) return;

    const handleCopy = () => {
      const adjustmentsToCopy = structuredClone(pickAdjustments(container.adjustments, sectionKeys));
      setCopiedSectionAdjustments({ section: sectionName, values: adjustmentsToCopy });
    };

    const handlePaste = () => {
      if (!copiedSectionAdjustments || copiedSectionAdjustments.section !== sectionName) return;

      setMaskContainerAdjustments((prev) => ({
        ...prev,
        ...copiedSectionAdjustments.values,
        sectionVisibility: {
          ...(prev.sectionVisibility || INITIAL_MASK_ADJUSTMENTS.sectionVisibility),
          [sectionName]: true,
        },
      }));
    };

    const handleReset = () => {
      const resetValues = structuredClone(pickAdjustments(INITIAL_MASK_ADJUSTMENTS, sectionKeys));
      setMaskContainerAdjustments((prev) => ({
        ...prev,
        ...resetValues,
        sectionVisibility: {
          ...(prev.sectionVisibility || INITIAL_MASK_ADJUSTMENTS.sectionVisibility),
          [sectionName]: true,
        },
      }));
    };

    const isPasteAllowed = copiedSectionAdjustments && copiedSectionAdjustments.section === sectionName;
    const sectionTitle = t(`editor.adjustments.sections.${sectionName}`);

    const pasteLabel = copiedSectionAdjustments
      ? t('editor.masks.settings.pasteSectionSettings', { section: sectionTitle })
      : t('editor.masks.settings.pasteSettings');

    showContextMenu(event.clientX, event.clientY, [
      {
        icon: Copy,
        label: t('editor.masks.settings.copySectionSettings', { section: sectionTitle }),
        onClick: handleCopy,
      },
      { label: pasteLabel, icon: ClipboardPaste, onClick: handlePaste, disabled: !isPasteAllowed },
      { type: OPTION_SEPARATOR },
      {
        icon: RotateCcw,
        label: t('editor.masks.settings.resetSectionSettings', { section: sectionTitle }),
        onClick: handleReset,
      },
    ]);
  };

  const sectionVisibility =
    displayContainer.adjustments.sectionVisibility || INITIAL_MASK_ADJUSTMENTS.sectionVisibility;

  return (
    <div
      className={`space-y-2 transition-opacity duration-300 ${!isActive ? 'opacity-50 pointer-events-none' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      {!effectOnly && (
        <CollapsibleSection
          title={
            isComponentMode
              ? t('editor.masks.settings.componentPropertiesTitle', { name: getSubMaskName(activeSubMask) })
              : t('editor.masks.settings.maskPropertiesTitle')
          }
          isOpen={isSettingsSectionOpen}
          onToggle={() => {
            const isOpening = !isSettingsSectionOpen;
            setSettingsSectionOpen(isOpening);
            if (appSettings?.enableFocusMode && isOpening) {
              setCollapsibleState((prev) => {
                const newState = { ...prev };
                Object.keys(newState).forEach((key) => {
                  newState[key] = false;
                });
                return newState;
              });
            }
          }}
          canToggleVisibility={false}
          isContentVisible={true}
        >
          <div className="space-y-4 pt-2">
            <Switch
              checked={!!(isComponentMode ? activeSubMask.invert : displayContainer.invert)}
              label={
                isComponentMode ? t('editor.masks.settings.invertComponent') : t('editor.masks.settings.invertMask')
              }
              onChange={(v) =>
                isComponentMode ? updateSubMask(activeSubMask.id, { invert: v }) : handleMaskPropertyChange('invert', v)
              }
            />

            {!selectionOnly && !isComponentMode && (
              <div className="flex justify-between items-center">
                <Text variant={TextVariants.label} className="select-none">
                  {t('editor.masks.settings.applyPreset')}
                </Text>
                <button
                  ref={presetButtonRef}
                  onClick={handlePresetSelectClick}
                  className="text-sm text-text-primary text-right select-none cursor-pointer hover:text-accent transition-colors"
                  data-tooltip={t('editor.masks.settings.selectPresetTooltip')}
                >
                  {t('editor.masks.settings.select')}
                </button>
              </div>
            )}

            {(isComponentMode || !selectionOnly) && (
              <Slider
                defaultValue={100}
                label={t('editor.masks.settings.opacity')}
                max={100}
                min={0}
                value={(isComponentMode ? activeSubMask.opacity : displayContainer.opacity) ?? 100}
                onChange={(e) =>
                  isComponentMode
                    ? updateSubMask(activeSubMask.id, { opacity: Number(e.target.value) })
                    : handleMaskPropertyChange('opacity', Number(e.target.value))
                }
                step={1}
                fillOrigin="min"
                onDragStateChange={onDragStateChange}
              />
            )}

            {isComponentMode && (
              <>
                {isAiMask && aiModelDownloadStatus && (
                  <Text
                    as="div"
                    variant={TextVariants.small}
                    color={TextColors.accent}
                    weight={TextWeights.medium}
                    className="p-3 bg-card-active rounded-md border border-surface flex items-center gap-3"
                  >
                    <Loader2 size={16} className="animate-spin shrink-0" />
                    <div className="leading-relaxed">
                      <Text variant={TextVariants.small}>{t('editor.masks.settings.aiModelDownloading')}</Text>
                      <span>{aiModelDownloadStatus}</span>
                    </div>
                  </Text>
                )}

                {(activeSubMask.type === Mask.AiNormals || activeSubMask.type === Mask.AiAlbedo) && (
                  <MarigoldSurfaceControls
                    key={activeSubMask.id}
                    subMask={activeSubMask}
                    enabled={appSettings?.marigoldSurfaceEnabled ?? false}
                    generate={handleGenerateSurfaceMask}
                    updateSubMask={updateSubMask}
                    onDragStateChange={onDragStateChange}
                    onLimitWithBrush={onLimitWithBrush}
                  />
                )}
                {activeSubMask.type === Mask.AiDepth && activeSubMask.parameters.depthProvider === 'marigold' && (
                  <MarigoldDepthControls
                    key={activeSubMask.id}
                    subMask={activeSubMask}
                    enabled={appSettings?.marigoldDepthEnabled ?? false}
                    generate={handleGenerateAiDepthMask}
                    updateSubMask={updateSubMask}
                  />
                )}
                {activeSubMask.type === Mask.AiDepth && (
                  <DepthMapPreview key={`depth-preview-${activeSubMask.id}`} subMask={activeSubMask} />
                )}
                {activeSubMask.type === Mask.AiDepth && (
                  <DepthRangePicker
                    minDepth={100 - (activeSubMask.parameters?.maxDepth ?? 100)}
                    maxDepth={100 - (activeSubMask.parameters?.minDepth ?? 0)}
                    minFade={activeSubMask.parameters?.maxFade ?? 15}
                    maxFade={activeSubMask.parameters?.minFade ?? 15}
                    defaultMinDepth={20}
                    defaultMaxDepth={80}
                    defaultMinFade={15}
                    defaultMaxFade={15}
                    onChange={handleDepthRangeChange}
                    onDragStateChange={onDragStateChange}
                  />
                )}

                {activeSubMask.type === Mask.Linear && (
                  <div className="space-y-3">
                    <label className="flex items-center justify-between gap-2 text-sm">
                      {t('editor.masks.params.falloff', { defaultValue: 'Fade curve' })}
                      <select
                        className="bg-surface rounded px-2 py-1"
                        value={activeSubMask.parameters.falloff ?? 'linear'}
                        onChange={(e) => applyLinearFalloffSelection(e.target.value, handleSubMaskParametersChange)}
                      >
                        <option value="linear">
                          {t('editor.masks.params.linearFalloff', { defaultValue: 'Linear' })}
                        </option>
                        <option value="smoothstep">
                          {t('editor.masks.params.smoothFalloff', { defaultValue: 'Smooth' })}
                        </option>
                        <option value="smootherstep">
                          {t('editor.masks.params.smootherFalloff', { defaultValue: 'Extra smooth' })}
                        </option>
                      </select>
                    </label>
                    {(['fadeBefore', 'fadeAfter'] as const).map((key) => (
                      <Slider
                        key={key}
                        label={
                          key === 'fadeBefore'
                            ? t('editor.masks.params.fadeBefore', { defaultValue: 'Zero edge distance' })
                            : t('editor.masks.params.fadeAfter', { defaultValue: 'Full edge distance' })
                        }
                        min={0}
                        max={Math.max(10000, activeSubMask.parameters[key] ?? 0)}
                        step={1}
                        defaultValue={activeSubMask.parameters.range ?? 50}
                        value={activeSubMask.parameters[key] ?? activeSubMask.parameters.range ?? 50}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          handleSubMaskParametersChange({ [key]: Number(e.target.value) })
                        }
                        fillOrigin="min"
                        onDragStateChange={onDragStateChange}
                      />
                    ))}
                  </div>
                )}

                {subMaskConfig.parameters?.map((param) => (
                  <Slider
                    key={param.key}
                    label={
                      param.key === 'feather' && activeSubMask.type === Mask.AiDepth
                        ? t('editor.masks.params.globalFeather')
                        : t(`editor.masks.params.${param.key}`, { defaultValue: param.key })
                    }
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    defaultValue={param.defaultValue}
                    value={(activeSubMask.parameters[param.key] || 0) * (param.multiplier || 1)}
                    onChange={(e) =>
                      handleSubMaskParametersChange({ [param.key]: Number(e.target.value) / (param.multiplier || 1) })
                    }
                    {...(param.key !== 'grow' && { fillOrigin: 'min' })}
                    onDragStateChange={onDragStateChange}
                  />
                ))}

                {subMaskConfig.showBrushTools &&
                  brushSettings &&
                  (activeSubMask.type === Mask.Flow ? (
                    <FlowBrushTool
                      flow={activeSubMask.parameters?.flow ?? 10}
                      onFlowChange={(flow: number) => handleSubMaskParametersChange({ flow })}
                      settings={brushSettings}
                      onSettingsChange={setBrushSettings}
                      onDragStateChange={onDragStateChange}
                    />
                  ) : (
                    <BrushTools
                      settings={brushSettings}
                      onSettingsChange={setBrushSettings}
                      onDragStateChange={onDragStateChange}
                    />
                  ))}
              </>
            )}
          </div>
        </CollapsibleSection>
      )}

      {!selectionOnly && (
        <div
          onMouseEnter={() => setIsMaskControlHovered(true)}
          onMouseLeave={() => setIsMaskControlHovered(false)}
          className="flex flex-col gap-2"
        >
          {(['basic', 'curves', 'color', 'details', 'effects'] as const).map((sectionName) => {
            const SectionComponent = {
              basic: BasicAdjustments,
              curves: CurveGraph,
              color: ColorPanel,
              details: DetailsPanel,
              effects: EffectsPanel,
            }[sectionName];
            const title = t(`editor.adjustments.sections.${sectionName}`);
            return (
              <CollapsibleSection
                key={sectionName}
                title={title}
                isOpen={collapsibleState[sectionName]}
                isContentVisible={sectionVisibility[sectionName]}
                onToggle={() => handleToggleSection(sectionName)}
                onToggleVisibility={() => handleToggleVisibility(sectionName)}
                onContextMenu={(e) => handleSectionContextMenu(e, sectionName)}
              >
                <SectionComponent
                  adjustments={{ ...INITIAL_ADJUSTMENTS, ...displayContainer.adjustments }}
                  setAdjustments={setMaskContainerAdjustments}
                  histogram={histogram}
                  isForMask={true}
                  appSettings={appSettings}
                  onDragStateChange={onDragStateChange}
                />
              </CollapsibleSection>
            );
          })}
        </div>
      )}
    </div>
  );
}
