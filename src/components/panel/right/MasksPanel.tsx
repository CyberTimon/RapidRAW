import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import clsx from 'clsx';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useDragControls, useAnimation } from 'framer-motion';
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
  ArrowRight,
  ChartArea,
  Circle,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  FileEdit,
  FolderOpen,
  Folder as FolderIcon,
  GripHorizontal,
  Loader2,
  Minus,
  Plus,
  PlusSquare,
  RotateCcw,
  Trash2,
  Bookmark,
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

import {
  Mask,
  SubMask,
  MASK_PANEL_CREATION_TYPES,
  OTHERS_MASK_TYPES,
  MASK_ICON_MAP,
  SubMaskMode,
  ToolType,
  getSubMaskName,
} from './Masks';
import {
  Adjustments,
  INITIAL_MASK_ADJUSTMENTS,
  INITIAL_MASK_CONTAINER,
  MaskContainer,
  ADJUSTMENT_SECTIONS,
} from '../../../utils/adjustments';
import { useContextMenu } from '../../../context/ContextMenuContext';
import {
  AppSettings,
  BrushSettings,
  OPTION_SEPARATOR,
  SelectedImage,
  WaveformData,
  Orientation,
} from '../../ui/AppProperties';
import { createSubMask } from '../../../utils/maskUtils';
import { usePresets } from '../../../hooks/usePresets';

interface MasksPanelProps {
  activeMaskContainerId: string | null;
  activeMaskId: string | null;
  adjustments: Adjustments;
  aiModelDownloadStatus: string | null;
  appSettings: AppSettings | null;
  brushSettings: BrushSettings | null;
  copiedMask: MaskContainer | null;
  histogram: any;
  isGeneratingAiMask: boolean;
  onGenerateAiForegroundMask(id: string): void;
  onGenerateAiSkyMask(id: string): void;
  onSelectContainer(id: string | null): void;
  onSelectMask(id: string | null): void;
  selectedImage: SelectedImage;
  setAdjustments(updater: any): void;
  setBrushSettings(brushSettings: BrushSettings): void;
  setCopiedMask(mask: MaskContainer): void;
  setCustomEscapeHandler(handler: any): void;
  setIsMaskControlHovered(hovered: boolean): void;
  maskHierarchyOverlayHost?: HTMLDivElement | null;
  onDragStateChange?: (isDragging: boolean) => void;
  isWaveformVisible?: boolean;
  onToggleWaveform?: () => void;
  waveform?: WaveformData | null;
  activeWaveformChannel?: string;
  setActiveWaveformChannel?: (mode: string) => void;
  waveformHeight?: number;
  setWaveformHeight?: (height: number) => void;
}

interface DragData {
  type: 'Container' | 'SubMask';
  item?: MaskContainer | SubMask;
  parentId?: string;
}

type FloatingHierarchyAnchor = 'top-left' | 'top-right' | 'center-left' | 'center-right' | 'bottom-left' | 'bottom-right';

const FLOATING_HIERARCHY_MARGIN = 16;
const FLOATING_HIERARCHY_DEFAULT_WIDTH = 340;
const FLOATING_HIERARCHY_MIN_WIDTH = 260;
const FLOATING_HIERARCHY_MAX_WIDTH = 640;
const MASK_HIERARCHY_LAYOUT_STORAGE_KEY = 'rapidraw-mask-hierarchy-layout';
const MASK_HIERARCHY_ANCHOR_STORAGE_KEY = 'rapidraw-mask-hierarchy-anchor';
const MASK_HIERARCHY_WIDTH_STORAGE_KEY = 'rapidraw-mask-hierarchy-width';
const FLOATING_HIERARCHY_ANCHORS: FloatingHierarchyAnchor[] = [
  'top-left',
  'top-right',
  'center-left',
  'center-right',
  'bottom-left',
  'bottom-right',
];
const HIERARCHY_CREATION_TYPES = [
  ...MASK_PANEL_CREATION_TYPES.filter((maskType) => maskType.id !== 'others'),
  ...OTHERS_MASK_TYPES,
];

const getStoredHierarchyLayout = () => {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem(MASK_HIERARCHY_LAYOUT_STORAGE_KEY) === 'floating';
  } catch {
    return false;
  }
};

const getStoredHierarchyAnchor = (): FloatingHierarchyAnchor => {
  if (typeof window === 'undefined') {
    return 'top-right';
  }

  try {
    const storedAnchor = window.localStorage.getItem(MASK_HIERARCHY_ANCHOR_STORAGE_KEY) as FloatingHierarchyAnchor | null;
    return storedAnchor && FLOATING_HIERARCHY_ANCHORS.includes(storedAnchor) ? storedAnchor : 'top-right';
  } catch {
    return 'top-right';
  }
};

const getStoredHierarchyWidth = () => {
  if (typeof window === 'undefined') {
    return FLOATING_HIERARCHY_DEFAULT_WIDTH;
  }

  try {
    const storedWidth = Number(window.localStorage.getItem(MASK_HIERARCHY_WIDTH_STORAGE_KEY));
    if (!Number.isFinite(storedWidth)) {
      return FLOATING_HIERARCHY_DEFAULT_WIDTH;
    }

    return Math.max(FLOATING_HIERARCHY_MIN_WIDTH, Math.min(FLOATING_HIERARCHY_MAX_WIDTH, storedWidth));
  } catch {
    return FLOATING_HIERARCHY_DEFAULT_WIDTH;
  }
};

const SUB_MASK_CONFIG: Record<Mask, any> = {
  [Mask.Radial]: {
    parameters: [{ key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, multiplier: 100, defaultValue: 50 }],
  },
  [Mask.Brush]: { showBrushTools: true },
  [Mask.Linear]: { parameters: [] },
  [Mask.Color]: {
    parameters: [
      { key: 'tolerance', label: 'Tolerance', min: 1, max: 100, step: 1, defaultValue: 20 },
      { key: 'grow', label: 'Grow', min: -100, max: 100, step: 1, defaultValue: 0 },
      { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, defaultValue: 35 },
    ],
  },
  [Mask.Luminance]: {
    parameters: [
      { key: 'tolerance', label: 'Tolerance', min: 1, max: 100, step: 1, defaultValue: 20 },
      { key: 'grow', label: 'Grow', min: -100, max: 100, step: 1, defaultValue: 0 },
      { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, defaultValue: 35 },
    ],
  },
  [Mask.All]: { parameters: [] },
  [Mask.AiSubject]: {
    parameters: [
      { key: 'grow', label: 'Grow', min: -100, max: 100, step: 1, defaultValue: 0 },
      { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, defaultValue: 0 },
    ],
  },
  [Mask.AiForeground]: {
    parameters: [
      { key: 'grow', label: 'Grow', min: -100, max: 100, step: 1, defaultValue: 0 },
      { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, defaultValue: 0 },
    ],
  },
  [Mask.AiSky]: {
    parameters: [
      { key: 'grow', label: 'Grow', min: -100, max: 100, step: 1, defaultValue: 0 },
      { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, defaultValue: 0 },
    ],
  },
  [Mask.QuickEraser]: { parameters: [] },
};

const BrushTools = ({ settings, onSettingsChange }: { settings: any; onSettingsChange: any }) => (
  <div className="space-y-4 border-t border-surface">
    <Slider
      defaultValue={100}
      label="Brush Size"
      max={200}
      min={1}
      onChange={(e: any) => onSettingsChange((s: any) => ({ ...s, size: Number(e.target.value) }))}
      step={1}
      value={settings.size}
    />
    <Slider
      defaultValue={50}
      label="Brush Feather"
      max={100}
      min={0}
      onChange={(e: any) => onSettingsChange((s: any) => ({ ...s, feather: Number(e.target.value) }))}
      step={1}
      value={settings.feather}
    />
    <div className="grid grid-cols-2 gap-2 pt-2">
      <button
        className={`p-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${settings.tool === ToolType.Brush ? 'text-primary bg-surface' : 'bg-surface text-text-secondary hover:bg-card-active'}`}
        onClick={() => onSettingsChange((s: any) => ({ ...s, tool: ToolType.Brush }))}
      >
        Brush
      </button>
      <button
        className={`p-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${settings.tool === ToolType.Eraser ? 'text-primary bg-surface' : 'bg-surface text-text-secondary hover:bg-card-active'}`}
        onClick={() => onSettingsChange((s: any) => ({ ...s, tool: ToolType.Eraser }))}
      >
        Eraser
      </button>
    </div>
  </div>
);

export default function MasksPanel({
  activeMaskContainerId,
  activeMaskId,
  adjustments,
  aiModelDownloadStatus,
  appSettings,
  brushSettings,
  copiedMask,
  histogram,
  isGeneratingAiMask,
  onGenerateAiForegroundMask,
  onGenerateAiSkyMask,
  onSelectContainer,
  onSelectMask,
  selectedImage,
  setAdjustments,
  setBrushSettings,
  setCopiedMask,
  setCustomEscapeHandler,
  setIsMaskControlHovered,
  maskHierarchyOverlayHost,
  onDragStateChange,
  isWaveformVisible,
  onToggleWaveform,
  waveform,
  activeWaveformChannel,
  setActiveWaveformChannel,
  waveformHeight,
  setWaveformHeight,
}: MasksPanelProps) {
  const [expandedContainers, setExpandedContainers] = useState<Set<string>>(new Set());
  const [activeDragItem, setActiveDragItem] = useState<DragData | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [tempName, setTempName] = useState('');
  const [copiedSubMask, setCopiedSubMask] = useState<SubMask | null>(null);
  const [collapsibleState, setCollapsibleState] = useState<any>({
    basic: true,
    curves: false,
    color: false,
    details: false,
    effects: false,
  });
  const [copiedSectionAdjustments, setCopiedSectionAdjustments] = useState<any | null>(null);
  const [isSettingsSectionOpen, setSettingsSectionOpen] = useState(true);
  const [isSettingsPanelEverOpened, setIsSettingsPanelEverOpened] = useState(false);
  const [isHierarchyFloating, setIsHierarchyFloating] = useState(getStoredHierarchyLayout);
  const [floatingHierarchyAnchor, setFloatingHierarchyAnchor] = useState<FloatingHierarchyAnchor>(getStoredHierarchyAnchor);
  const hasPerformedInitialSelection = useRef(false);
  const [analyzingSubMaskId, setAnalyzingSubMaskId] = useState<string | null>(null);
  const [isResizingWaveform, setIsResizingWaveform] = useState<boolean>(false);

  const { showContextMenu } = useContextMenu();
  const { presets } = usePresets(adjustments);

  const { setNodeRef: setRootDroppableRef, isOver: isRootOver } = useDroppable({ id: 'mask-list-root' });

  const activeContainer = adjustments.masks.find((m) => m.id === activeMaskContainerId);
  const activeSubMaskData = activeContainer?.subMasks.find((sm) => sm.id === activeMaskId);
  const isAiMask =
    activeSubMaskData && [Mask.AiSubject, Mask.AiForeground, Mask.AiSky].includes(activeSubMaskData.type);

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
      const containerExists = adjustments.masks.some((m) => m.id === activeMaskContainerId);
      if (!containerExists) {
        onSelectContainer(null);
        onSelectMask(null);
      }
    }
  }, [adjustments.masks, activeMaskContainerId, onSelectContainer, onSelectMask]);

  useEffect(() => {
    if (!hasPerformedInitialSelection.current && !activeMaskContainerId && adjustments.masks.length > 0) {
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

    if (activeMaskContainerId || adjustments.masks.length > 0) {
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

  useEffect(() => {
    try {
      window.localStorage.setItem(
        MASK_HIERARCHY_LAYOUT_STORAGE_KEY,
        isHierarchyFloating ? 'floating' : 'docked',
      );
    } catch {
      // Ignore storage failures and keep the session state in memory.
    }
  }, [isHierarchyFloating]);

  useEffect(() => {
    try {
      window.localStorage.setItem(MASK_HIERARCHY_ANCHOR_STORAGE_KEY, floatingHierarchyAnchor);
    } catch {
      // Ignore storage failures and keep the session state in memory.
    }
  }, [floatingHierarchyAnchor]);

  const handleWaveformResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = waveformHeight || 256;
    setIsResizingWaveform(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientY - startY;
      if (setWaveformHeight) setWaveformHeight(Math.max(150, Math.min(450, startHeight + delta)));
    };

    const handleMouseUp = () => {
      setIsResizingWaveform(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

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
    setAdjustments((prev: any) => ({ ...prev, masks: [] }));
  };

  const createMaskLogic = (type: Mask) => {
    const subMask = createSubMask(type, selectedImage);

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
    return subMask;
  };

  const handleAddMaskContainer = (type: Mask) => {
    const subMask = createMaskLogic(type);
    const newContainer = {
      ...INITIAL_MASK_CONTAINER,
      id: uuidv4(),
      name: `Mask ${adjustments.masks.length + 1}`,
      subMasks: [subMask],
    };
    setAdjustments((prev: Adjustments) => ({ ...prev, masks: [...(prev.masks || []), newContainer] }));
    onSelectContainer(newContainer.id);
    onSelectMask(subMask.id);
    setExpandedContainers((prev) => new Set(prev).add(newContainer.id));
    if (type === Mask.AiForeground) onGenerateAiForegroundMask(subMask.id);
    else if (type === Mask.AiSky) onGenerateAiSkyMask(subMask.id);
  };

  const handleAddSubMask = (containerId: string, type: Mask, insertIndex: number = -1) => {
    const subMask = createMaskLogic(type);
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
    if (type === Mask.AiForeground) onGenerateAiForegroundMask(subMask.id);
    else if (type === Mask.AiSky) onGenerateAiSkyMask(subMask.id);
  };

  const openMaskCreationMenu = (target: HTMLElement, onSelect: (type: Mask) => void) => {
    const rect = target.getBoundingClientRect();
    showContextMenu(
      rect.left,
      rect.bottom + 5,
      HIERARCHY_CREATION_TYPES.map((maskType) => ({
        label: maskType.name,
        icon: maskType.icon,
        disabled: maskType.disabled,
        onClick: () => onSelect(maskType.type),
      })),
    );
  };

  const updateContainer = (id: string, data: any) =>
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      masks: prev.masks.map((m) => (m.id === id ? { ...m, ...data } : m)),
    }));
  const updateSubMask = (id: string, data: any) =>
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
    options: { invert?: boolean; rename?: boolean } = {},
  ): MaskContainer => {
    const clonedContainer = JSON.parse(JSON.stringify(container));

    clonedContainer.id = uuidv4();
    clonedContainer.invert = options.invert ? !clonedContainer.invert : clonedContainer.invert;
    clonedContainer.name = options.rename === false ? clonedContainer.name : `${container.name} Copy`;
    clonedContainer.subMasks = clonedContainer.subMasks.map((subMask: SubMask) => ({
      ...subMask,
      id: uuidv4(),
    }));

    return clonedContainer;
  };

  const cloneSubMaskData = (subMask: SubMask, options: { invert?: boolean; rename?: boolean } = {}): SubMask => {
    const clonedSubMask = JSON.parse(JSON.stringify(subMask));

    clonedSubMask.id = uuidv4();
    clonedSubMask.invert = options.invert ? !clonedSubMask.invert : clonedSubMask.invert;
    clonedSubMask.name = options.rename === false ? clonedSubMask.name : `${getSubMaskName(subMask)} Copy`;

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
    const duplicatedContainer = cloneMaskContainerData(container, { rename: true });

    insertMaskContainer(duplicatedContainer, containerIndex >= 0 ? containerIndex + 1 : undefined);
  };

  const handleDuplicateAndInvertContainer = (container: MaskContainer) => {
    const containerIndex = adjustments.masks.findIndex((mask) => mask.id === container.id);
    const duplicatedContainer = cloneMaskContainerData(container, { invert: true, rename: true });

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

  const handleDuplicateAndInvertSubMask = (containerId: string, subMask: SubMask, insertIndex?: number) => {
    const duplicatedSubMask = cloneSubMaskData(subMask, { invert: true, rename: true });

    insertSubMaskIntoContainer(containerId, duplicatedSubMask, insertIndex);
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

      let targetContainerId = null;
      if (overData?.type === 'Container') targetContainerId = overData.item!.id;
      else if (overData?.type === 'SubMask') targetContainerId = overData.parentId;

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
              const overSubMaskIndex = sourceContainer.subMasks.findIndex((sm) => sm.id === over.id);
              const insertIndex = overSubMaskIndex >= 0 ? overSubMaskIndex : sourceContainer.subMasks.length;
              sourceContainer.subMasks.splice(insertIndex, 0, movedSubMask);
            } else {
              sourceContainer.subMasks.push(movedSubMask);
            }
          } else {
            if (overData?.type === 'SubMask') {
              const overSubMaskIndex = targetContainer.subMasks.findIndex((sm) => sm.id === over.id);
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
    const newMaskSubMenu = HIERARCHY_CREATION_TYPES.map((m) => ({
      label: m.name,
      icon: m.icon,
      disabled: m.disabled,
      onClick: () => handleAddMaskContainer(m.type),
    }));
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Paste Mask', icon: ClipboardPaste, disabled: !copiedMask, onClick: () => handlePasteMask() },
      { label: 'Add New Mask', icon: Plus, submenu: newMaskSubMenu },
    ]);
  };

  const showFloatingHierarchy = isHierarchyFloating && !!maskHierarchyOverlayHost;
  const showInlineHierarchy = !showFloatingHierarchy;

  const toggleHierarchyLayout = useCallback((event?: React.MouseEvent) => {
    event?.stopPropagation();
    setIsHierarchyFloating((prev) => !prev);
  }, []);

  const hierarchyList = (isFloating: boolean) => (
    <div
      ref={setRootDroppableRef}
      className={clsx(
        'flex flex-col transition-colors',
        isFloating && 'h-full min-h-0',
        !isFloating && 'px-4 pb-2',
        isRootOver && (isFloating ? 'bg-bg-tertiary/65' : 'rounded-lg bg-bg-tertiary/40'),
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className={clsx(
          isFloating ? 'flex-1 overflow-y-auto overflow-x-hidden px-3 py-3' : 'flex flex-col',
        )}
      >
        <AnimatePresence initial={false} mode="popLayout">
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
              onOpenCreateSubMaskMenu={(containerId: string, target: HTMLElement) =>
                openMaskCreationMenu(target, (type) => handleAddSubMask(containerId, type))
              }
            />
          ))}
        </AnimatePresence>
        <HierarchyActionRow
          label="Add New Mask"
          onOpenMenu={(target) => openMaskCreationMenu(target, handleAddMaskContainer)}
          className={adjustments.masks.length > 0 ? 'mt-2' : undefined}
        />
      </div>
    </div>
  );

  const hierarchyInlineSection = showInlineHierarchy ? (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="shrink-0"
    >
      <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-4">
        <p className="text-sm font-semibold text-text-primary">Masks</p>
        <button
          className="rounded-full p-2 text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
          data-tooltip="Open Hierarchy in Preview"
          onClick={toggleHierarchyLayout}
        >
          <ExternalLink size={16} />
        </button>
      </div>
      {hierarchyList(false)}
    </motion.div>
  ) : null;

  const hierarchyOverlay = showFloatingHierarchy
    ? createPortal(
        <FloatingMaskHierarchyWindow
          anchor={floatingHierarchyAnchor}
          onAnchorChange={setFloatingHierarchyAnchor}
          onDockToSidebar={() => setIsHierarchyFloating(false)}
          setIsMaskControlHovered={setIsMaskControlHovered}
        >
          {hierarchyList(true)}
        </FloatingMaskHierarchyWindow>,
        maskHierarchyOverlayHost!,
      )
    : null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      collisionDetection={pointerWithin}
    >
      <div
        className="flex flex-col h-full select-none overflow-hidden"
        onClick={handleDeselect}
        onContextMenu={handlePanelContextMenu}
      >
        <div className="p-4 flex justify-between items-center shrink-0 border-b border-surface">
          <h2 className="text-xl font-bold text-primary text-shadow-shiny">Masking</h2>
          <div className="flex items-center gap-1">
            <button
              className={clsx(
                'p-2 rounded-full transition-colors',
                isWaveformVisible ? 'bg-surface hover:bg-card-active' : 'hover:bg-surface',
              )}
              onClick={onToggleWaveform}
              data-tooltip="Toggle Analytics Display"
            >
              <ChartArea size={18} />
            </button>
            <button
              className="p-2 rounded-full hover:bg-surface transition-colors"
              onClick={handleResetAllMasks}
              data-tooltip="Reset Masking"
            >
              <RotateCcw size={18} />
            </button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {isWaveformVisible && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: waveformHeight || 256, opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: isResizingWaveform ? 0 : 0.2, ease: 'easeOut' }}
              className="shrink-0 flex flex-col relative border-b border-surface overflow-hidden"
            >
              <div className="grow w-full h-full p-4 pb-2 min-h-0">
                <Waveform
                  waveformData={waveform || null}
                  histogram={histogram}
                  displayMode={activeWaveformChannel || 'luma'}
                  setDisplayMode={setActiveWaveformChannel || (() => {})}
                  showClipping={adjustments.showClipping || false}
                  onToggleClipping={() => {
                    setAdjustments((prev: Adjustments) => ({
                      ...prev,
                      showClipping: !prev.showClipping,
                    }));
                  }}
                />
              </div>
              <Resizer direction={Orientation.Horizontal} onMouseDown={handleWaveformResize} />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-h-0">
          {hierarchyInlineSection}

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
                <p className="text-sm my-3 font-semibold text-text-primary px-4">Mask Adjustments</p>
                <SettingsPanel
                  container={activeContainer}
                  activeSubMask={activeSubMaskData || null}
                  aiModelDownloadStatus={aiModelDownloadStatus}
                  brushSettings={brushSettings}
                  setBrushSettings={setBrushSettings}
                  updateContainer={updateContainer}
                  updateSubMask={updateSubMask}
                  histogram={histogram}
                  appSettings={appSettings}
                  isGeneratingAiMask={isGeneratingAiMask}
                  setIsMaskControlHovered={setIsMaskControlHovered}
                  collapsibleState={collapsibleState}
                  setCollapsibleState={setCollapsibleState}
                  copiedSectionAdjustments={copiedSectionAdjustments}
                  setCopiedSectionAdjustments={setCopiedSectionAdjustments}
                  onDragStateChange={onDragStateChange}
                  isSettingsSectionOpen={isSettingsSectionOpen}
                  setSettingsSectionOpen={setSettingsSectionOpen}
                  presets={presets}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {hierarchyOverlay}

      <DragOverlay dropAnimation={{ duration: 150, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
        {activeDragItem ? (
          <div className="w-(--sidebar-width,280px) pointer-events-none">
            {activeDragItem.type === 'Container' && activeDragItem.item && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-surface shadow-2xl opacity-90 ring-1 ring-black/10">
                <div className="text-text-secondary">
                  <FolderIcon size={18} />
                </div>
                <span className="text-sm font-medium text-text-primary flex-1 truncate">
                  {(activeDragItem.item as MaskContainer).name}
                </span>
                <div className="flex gap-1.5 opacity-50">
                  <Eye size={16} className="text-text-secondary" />
                  <Trash2 size={16} className="text-text-secondary" />
                </div>
              </div>
            )}

            {activeDragItem.type === 'SubMask' && activeDragItem.item && (
              <div className="flex items-center gap-2 p-2 rounded-md bg-surface shadow-2xl opacity-90 ring-1 ring-black/10 ml-[15px]">
                {(() => {
                  const sm = activeDragItem.item as SubMask;
                  const Icon = MASK_ICON_MAP[sm.type] || Circle;
                  return <Icon size={16} className="text-text-secondary shrink-0 ml-1" />;
                })()}
                <span className="text-sm text-text-primary flex-1 truncate">
                  {getSubMaskName(activeDragItem.item as SubMask)}
                </span>
                <div className="flex gap-1.5 opacity-50">
                  <Plus size={14} className="text-text-secondary" />
                  <Eye size={14} className="text-text-secondary" />
                  <Trash2 size={14} className="text-text-secondary" />
                </div>
              </div>
            )}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function HierarchyActionRow({
  label,
  onOpenMenu,
  className,
}: {
  label: string;
  onOpenMenu(target: HTMLElement): void;
  className?: string;
}) {
  const handleOpenMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenMenu(event.currentTarget);
  };

  return (
    <button
      type="button"
      className={clsx(
        'flex w-full items-center gap-2 rounded-md p-2 text-sm text-text-secondary transition-colors hover:bg-card-active hover:text-text-primary',
        className,
      )}
      onClick={handleOpenMenu}
      onContextMenu={handleOpenMenu}
    >
      <Plus size={16} className="shrink-0" />
      <span>{label}</span>
    </button>
  );
}

function FloatingMaskHierarchyWindow({
  anchor,
  children,
  onAnchorChange,
  onDockToSidebar,
  setIsMaskControlHovered,
}: {
  anchor: FloatingHierarchyAnchor;
  children: any;
  onAnchorChange(anchor: FloatingHierarchyAnchor): void;
  onDockToSidebar(): void;
  setIsMaskControlHovered(hovered: boolean): void;
}) {
  const boundsRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const skipInitialPositionAnimationRef = useRef(true);
  const dragControls = useDragControls();
  const animationControls = useAnimation();
  const [targetPosition, setTargetPosition] = useState({ x: FLOATING_HIERARCHY_MARGIN, y: FLOATING_HIERARCHY_MARGIN });
  const [floatingWidth, setFloatingWidth] = useState(getStoredHierarchyWidth);
  const [isReady, setIsReady] = useState(false);
  const [isWindowDragging, setIsWindowDragging] = useState(false);
  const [isWindowResizing, setIsWindowResizing] = useState(false);
  const isRightAnchored = anchor.endsWith('right');

  useEffect(() => {
    return () => {
      setIsMaskControlHovered(false);
    };
  }, [setIsMaskControlHovered]);

  useEffect(() => {
    try {
      window.localStorage.setItem(MASK_HIERARCHY_WIDTH_STORAGE_KEY, String(floatingWidth));
    } catch {
      // Ignore storage failures and keep the session state in memory.
    }
  }, [floatingWidth]);

  const getAnchorPosition = useCallback((targetAnchor: FloatingHierarchyAnchor) => {
    const bounds = boundsRef.current;
    const panel = panelRef.current;
    if (!bounds || !panel) {
      return null;
    }

    const maxX = Math.max(FLOATING_HIERARCHY_MARGIN, bounds.clientWidth - panel.offsetWidth - FLOATING_HIERARCHY_MARGIN);
    const maxY = Math.max(
      FLOATING_HIERARCHY_MARGIN,
      bounds.clientHeight - panel.offsetHeight - FLOATING_HIERARCHY_MARGIN,
    );
    const centerY = Math.min(maxY, Math.max(FLOATING_HIERARCHY_MARGIN, (bounds.clientHeight - panel.offsetHeight) / 2));

    switch (targetAnchor) {
      case 'top-left':
        return { x: FLOATING_HIERARCHY_MARGIN, y: FLOATING_HIERARCHY_MARGIN };
      case 'top-right':
        return { x: maxX, y: FLOATING_HIERARCHY_MARGIN };
      case 'center-left':
        return { x: FLOATING_HIERARCHY_MARGIN, y: centerY };
      case 'center-right':
        return { x: maxX, y: centerY };
      case 'bottom-left':
        return { x: FLOATING_HIERARCHY_MARGIN, y: maxY };
      case 'bottom-right':
      default:
        return { x: maxX, y: maxY };
    }
  }, []);

  const syncToCorner = useCallback(
    (targetAnchor: FloatingHierarchyAnchor) => {
      if (isWindowDragging) {
        return;
      }

      const nextPosition = getAnchorPosition(targetAnchor);
      if (!nextPosition) {
        return;
      }

      if (!isReady) {
        skipInitialPositionAnimationRef.current = true;
      }

      setTargetPosition((prev) => (prev.x === nextPosition.x && prev.y === nextPosition.y ? prev : nextPosition));
      setIsReady(true);
    },
    [getAnchorPosition, isReady, isWindowDragging],
  );

  useLayoutEffect(() => {
    syncToCorner(anchor);

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => syncToCorner(anchor));

    if (boundsRef.current) {
      observer.observe(boundsRef.current);
    }

    if (panelRef.current) {
      observer.observe(panelRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, [anchor, syncToCorner]);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    let settleFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      settleFrame = window.requestAnimationFrame(() => {
        skipInitialPositionAnimationRef.current = false;
      });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(settleFrame);
    };
  }, [isReady]);

  useLayoutEffect(() => {
    if (!isReady) {
      animationControls.set({ opacity: 0 });
      return;
    }

    const nextAnimation = {
      x: targetPosition.x,
      y: targetPosition.y,
      opacity: 1,
      scale: 1,
    };

    if (skipInitialPositionAnimationRef.current) {
      animationControls.set(nextAnimation);
      return;
    }

    if (isWindowDragging) {
      return;
    }

    void animationControls.start({
      ...nextAnimation,
      transition: isWindowResizing
        ? { duration: 0 }
        : {
            type: 'spring',
            stiffness: 420,
            damping: 34,
            mass: 0.8,
          },
    });
  }, [animationControls, isReady, isWindowDragging, isWindowResizing, targetPosition.x, targetPosition.y]);

  const handleDragEnd = useCallback(() => {
    setIsWindowDragging(false);

    const bounds = boundsRef.current;
    const panel = panelRef.current;
    if (!bounds || !panel) {
      return;
    }

    const boundsRect = bounds.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const currentCenter = {
      x: panelRect.left - boundsRect.left + panelRect.width / 2,
      y: panelRect.top - boundsRect.top + panelRect.height / 2,
    };

    const nearestAnchor = FLOATING_HIERARCHY_ANCHORS.reduce((closest, candidate) => {
      const candidatePosition = getAnchorPosition(candidate);
      if (!candidatePosition) {
        return closest;
      }

      const candidateCenter = {
        x: candidatePosition.x + panelRect.width / 2,
        y: candidatePosition.y + panelRect.height / 2,
      };
      const distance = Math.hypot(candidateCenter.x - currentCenter.x, candidateCenter.y - currentCenter.y);

      if (!closest || distance < closest.distance) {
        return { anchor: candidate, distance };
      }

      return closest;
    }, null as { anchor: FloatingHierarchyAnchor; distance: number } | null);

    if (!nearestAnchor) {
      return;
    }

    onAnchorChange(nearestAnchor.anchor);

    const snappedPosition = getAnchorPosition(nearestAnchor.anchor);
    if (snappedPosition) {
      setTargetPosition((prev) => (prev.x === snappedPosition.x && prev.y === snappedPosition.y ? prev : snappedPosition));
      setIsReady(true);
    }
  }, [getAnchorPosition, onAnchorChange]);

  const handleResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const panel = panelRef.current;
      const bounds = boundsRef.current;
      if (!panel || !bounds) {
        return;
      }

      const startX = event.clientX;
      const startWidth = panel.offsetWidth;
      const maxAllowedWidth = Math.max(
        FLOATING_HIERARCHY_MIN_WIDTH,
        Math.min(FLOATING_HIERARCHY_MAX_WIDTH, bounds.clientWidth - FLOATING_HIERARCHY_MARGIN * 2),
      );
      const resizeDirection = isRightAnchored ? -1 : 1;

      setIsWindowResizing(true);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const nextWidth = Math.max(
          FLOATING_HIERARCHY_MIN_WIDTH,
          Math.min(maxAllowedWidth, startWidth + (moveEvent.clientX - startX) * resizeDirection),
        );
        setFloatingWidth(nextWidth);
      };

      const handleMouseUp = () => {
        setIsWindowResizing(false);
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [isRightAnchored],
  );

  return (
    <div ref={boundsRef} className="absolute inset-0 pointer-events-none">
      <motion.div
        ref={panelRef}
        drag
        initial={{ opacity: 0 }}
        dragControls={dragControls}
        dragListener={false}
        dragMomentum={false}
        dragElastic={0.08}
        dragConstraints={boundsRef}
        onDragStart={() => setIsWindowDragging(true)}
        onDragEnd={handleDragEnd}
        animate={animationControls}
        className="absolute left-0 top-0 pointer-events-auto"
        style={{
          width: floatingWidth,
          minWidth: FLOATING_HIERARCHY_MIN_WIDTH,
          maxWidth: 'calc(100% - 32px)',
          maxHeight: 'min(520px, calc(100% - 32px))',
        }}
        onMouseEnter={() => setIsMaskControlHovered(true)}
        onMouseLeave={() => setIsMaskControlHovered(false)}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <div className="flex max-h-full min-h-0 flex-col overflow-hidden rounded-xl border border-surface bg-bg-secondary shadow-2xl">
          <div
            className={clsx(
              'absolute bottom-0 top-0 z-10 w-2 cursor-col-resize transition-colors hover:bg-surface/80',
              isRightAnchored ? 'left-0' : 'right-0',
            )}
            onMouseDown={handleResizeStart}
          />
          <div
            className="flex cursor-grab items-center justify-between gap-3 border-b border-surface px-3 py-2 active:cursor-grabbing"
            onPointerDown={(event) => {
              event.stopPropagation();
              dragControls.start(event);
            }}
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <GripHorizontal size={14} className="text-text-secondary" />
              <span>Mask Hierarchy</span>
            </div>
            <button
              className="rounded-full p-2 text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
              data-tooltip="Dock Hierarchy in Sidebar"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onDockToSidebar();
              }}
            >
              <ArrowRight size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1">{children}</div>
        </div>
      </motion.div>
    </div>
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
  onOpenCreateSubMaskMenu,
}: any) {
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
      setAdjustments((prev: any) => {
        const updatedMasks = prev.masks.map((m: any) => (m.id === container.id ? { ...m, name: newName } : m));
        return { ...prev, masks: updatedMasks };
      });
    }
    setRenamingId(null);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const generatePresetSubmenu = (list: any[]): any[] =>
      list
        .map((item) => {
          if (item.folder)
            return { label: item.folder.name, icon: FolderIcon, submenu: generatePresetSubmenu(item.folder.children) };
          if (item.preset || item.adjustments)
            return {
              label: item.name || item.preset.name,
              onClick: () => {
                const newAdj = { ...container.adjustments, ...(item.adjustments || item.preset.adjustments) };
                newAdj.sectionVisibility = { ...container.adjustments.sectionVisibility, ...newAdj.sectionVisibility };
                updateContainer(container.id, { adjustments: newAdj });
              },
            };
          return null;
        })
        .filter(Boolean);
    showContextMenu(e.clientX, e.clientY, [
      {
        label: 'Rename',
        icon: FileEdit,
        onClick: () => {
          setRenamingId(container.id);
          setTempName(container.name);
        },
      },
      { label: 'Duplicate Mask', icon: PlusSquare, onClick: () => handleDuplicate(container) },
      { label: 'Duplicate and Invert Mask', icon: RotateCcw, onClick: () => handleDuplicateAndInvert(container) },
      { label: 'Copy Mask', icon: Copy, onClick: () => copyMaskToClipboard(container) },
      {
        label: 'Paste Mask',
        icon: ClipboardPaste,
        disabled: !copiedMask,
        onClick: () => handlePasteMask(container.id),
      },
      {
        label: 'Paste Mask Adjustments',
        icon: ClipboardPaste,
        disabled: !copiedMask,
        onClick: () => {
          if (copiedMask) {
            updateContainer(container.id, { adjustments: JSON.parse(JSON.stringify(copiedMask.adjustments)) });
          }
        },
      },
      {
        label: 'Apply Preset',
        icon: Bookmark,
        submenu: generatePresetSubmenu(presets).length
          ? generatePresetSubmenu(presets)
          : [{ label: 'No presets', disabled: true }],
      },
      { type: OPTION_SEPARATOR },
      {
        label: 'Reset Mask Adjustments',
        icon: RotateCcw,
        onClick: () =>
          updateContainer(container.id, { adjustments: JSON.parse(JSON.stringify(INITIAL_MASK_ADJUSTMENTS)) }),
      },
      { label: 'Delete Mask', icon: Trash2, isDestructive: true, onClick: () => handleDelete(container.id) },
    ]);
  };

  const isDraggingContainer = activeDragItem?.type === 'Container';
  let borderClass = '';

  if (isOver) {
    if (isDraggingContainer) {
      borderClass = 'border-t-2 border-accent';
    } else if (activeDragItem?.type === 'SubMask' && activeDragItem?.parentId !== container.id) {
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
      className="mb-0.5 overflow-hidden"
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
        <div
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className={`p-0.5 rounded-sm transition-colors cursor-pointer ${hasActiveChild ? 'text-text-primary' : isExpanded ? 'text-primary' : 'text-text-secondary'}`}
        >
          {isExpanded ? <FolderOpen size={18} /> : <FolderIcon size={18} />}
        </div>
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
            <span
              className={`text-sm font-medium truncate select-none ${isSelected ? 'text-primary' : 'text-text-primary'} ${hasActiveChild ? 'text-text-primary font-bold' : ''}`}
            >
              {container.name}
            </span>
          )}
        </div>
        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            className="p-1 hover:text-text-primary text-text-secondary"
            onMouseEnter={() => setIsMaskControlHovered(true)}
            onMouseLeave={() => setIsMaskControlHovered(false)}
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
            className="overflow-hidden pl-2 border-l border-border-color/20 ml-[15px]"
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
                  handleDuplicateAndInvert={() => handleDuplicateAndInvertSubMask(container.id, subMask, index + 1)}
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
            <HierarchyActionRow
              label="Add New Component"
              onOpenMenu={(target) => onOpenCreateSubMaskMenu(container.id, target)}
              className="mt-1"
            />
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
}: any) {
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
        label: 'Rename',
        icon: FileEdit,
        onClick: () => {
          setRenamingId(subMask.id);
          setTempName(getSubMaskName(subMask));
        },
      },
      { label: 'Duplicate Component', icon: PlusSquare, onClick: handleDuplicate },
      { label: 'Duplicate and Invert Component', icon: RotateCcw, onClick: handleDuplicateAndInvert },
      { label: 'Copy Component', icon: Copy, onClick: handleCopy },
      { label: 'Paste Component', icon: ClipboardPaste, disabled: !hasCopiedSubMask, onClick: handlePaste },
      { type: OPTION_SEPARATOR },
      { label: 'Delete Component', icon: Trash2, isDestructive: true, onClick: handleDelete },
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
      className={`flex items-center gap-2 p-2 rounded-md transition-colors group mt-0.5 cursor-pointer
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
      <div className="relative w-4 h-4 ml-1 shrink-0 flex items-center justify-center">
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
              <Loader2 size={16} className="text-text-secondary animate-spin" />
            </motion.div>
          ) : showNumber ? (
            <motion.span
              key="number"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{ duration: 0.15 }}
              className="text-xs font-bold text-text-secondary absolute"
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
              <MaskIcon size={16} className="text-text-secondary" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
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
        <span className="text-sm text-text-primary flex-1 truncate select-none">{getSubMaskName(subMask)}</span>
      )}
      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          className="p-1 hover:bg-bg-primary rounded-sm text-text-secondary"
          data-tooltip={subMask.mode === SubMaskMode.Additive ? 'Switch to Subtract' : 'Switch to Add'}
          onClick={(e) => {
            e.stopPropagation();
            updateSubMask(subMask.id, {
              mode: subMask.mode === SubMaskMode.Additive ? SubMaskMode.Subtractive : SubMaskMode.Additive,
            });
          }}
        >
          {subMask.mode === SubMaskMode.Additive ? <Plus size={14} /> : <Minus size={14} />}
        </button>
        <button
          className="p-1 hover:bg-bg-primary rounded-sm text-text-secondary"
          data-tooltip={subMask.visible ? 'Hide Component' : 'Show Component'}
          onMouseEnter={() => setIsMaskControlHovered(true)}
          onMouseLeave={() => setIsMaskControlHovered(false)}
          onClick={(e) => {
            e.stopPropagation();
            updateSubMask(subMask.id, { visible: !subMask.visible });
          }}
        >
          {subMask.visible ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        <button
          className="p-1 hover:text-red-500 text-text-secondary"
          data-tooltip="Delete Component"
          onClick={(e) => {
            e.stopPropagation();
            handleDelete();
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </motion.div>
  );
}

function SettingsPanel({
  container,
  activeSubMask,
  aiModelDownloadStatus,
  brushSettings,
  setBrushSettings,
  updateContainer,
  updateSubMask,
  histogram,
  appSettings,
  isGeneratingAiMask: _isGeneratingAiMask,
  setIsMaskControlHovered,
  collapsibleState,
  setCollapsibleState,
  copiedSectionAdjustments,
  setCopiedSectionAdjustments,
  onDragStateChange,
  isSettingsSectionOpen,
  setSettingsSectionOpen,
  presets,
}: any) {
  const { showContextMenu } = useContextMenu();
  const isActive = !!container;
  const presetButtonRef = useRef<HTMLButtonElement>(null);

  const placeholderContainer = {
    ...INITIAL_MASK_CONTAINER,
    adjustments: INITIAL_MASK_ADJUSTMENTS,
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

  const generatePresetSubmenu = (presetList: any[]): any[] => {
    return presetList
      .map((item: any) => {
        if (item.folder) {
          return {
            label: item.folder.name,
            icon: FolderIcon,
            submenu: generatePresetSubmenu(item.folder.children),
          };
        }
        if (item.preset || item.adjustments) {
          return {
            label: item.name || item.preset.name,
            onClick: () => handleApplyPresetToMask(item.adjustments || item.preset.adjustments),
          };
        }
        return null;
      })
      .filter(Boolean);
  };

  const handlePresetSelectClick = () => {
    if (presetButtonRef.current) {
      const rect = presetButtonRef.current.getBoundingClientRect();
      const presetSubmenu = generatePresetSubmenu(presets);
      const options = presetSubmenu.length > 0 ? presetSubmenu : [{ label: 'No presets found', disabled: true }];
      showContextMenu(rect.left, rect.bottom + 5, options);
    }
  };

  const handleMaskPropertyChange = (key: string, value: any) => {
    if (!isActive) return;
    updateContainer(container.id, { [key]: value });
  };

  const handleSubMaskParameterChange = (key: string, value: number) => {
    if (!isActive || !activeSubMask) return;
    updateSubMask(activeSubMask.id, { parameters: { ...activeSubMask.parameters, [key]: value } });
  };

  const subMaskConfig = activeSubMask ? SUB_MASK_CONFIG[activeSubMask.type] || {} : {};
  const isAiMask = activeSubMask && ['ai-subject', 'ai-foreground', 'ai-sky'].includes(activeSubMask.type);
  const isComponentMode = !!activeSubMask;

  const setMaskContainerAdjustments = (updater: any) => {
    if (!isActive) return;
    const currentAdjustments = container.adjustments;
    const newAdjustments = typeof updater === 'function' ? updater(currentAdjustments) : updater;
    updateContainer(container.id, { adjustments: newAdjustments });
  };

  const handleToggleSection = (section: string) =>
    setCollapsibleState((prev: any) => ({ ...prev, [section]: !prev[section] }));

  const handleToggleVisibility = (sectionName: string) => {
    if (!isActive) return;
    const cur = container.adjustments;
    const vis = cur.sectionVisibility || INITIAL_MASK_ADJUSTMENTS.sectionVisibility;
    updateContainer(container.id, {
      adjustments: { ...cur, sectionVisibility: { ...vis, [sectionName]: !vis[sectionName] } },
    });
  };

  const handleSectionContextMenu = (event: any, sectionName: string) => {
    if (!isActive) return;
    event.preventDefault();
    event.stopPropagation();

    const sectionKeys = ADJUSTMENT_SECTIONS[sectionName];
    if (!sectionKeys) return;

    const handleCopy = () => {
      const adjustmentsToCopy: Record<string, any> = {};
      for (const key of sectionKeys) {
        if (container.adjustments && container.adjustments[key] !== undefined) {
          adjustmentsToCopy[key] = JSON.parse(JSON.stringify(container.adjustments[key]));
        }
      }
      setCopiedSectionAdjustments({ section: sectionName, values: adjustmentsToCopy });
    };

    const handlePaste = () => {
      if (!copiedSectionAdjustments || copiedSectionAdjustments.section !== sectionName) return;

      setMaskContainerAdjustments((prev: any) => ({
        ...prev,
        ...copiedSectionAdjustments.values,
        sectionVisibility: {
          ...(prev.sectionVisibility || INITIAL_MASK_ADJUSTMENTS.sectionVisibility),
          [sectionName]: true,
        },
      }));
    };

    const handleReset = () => {
      const resetValues: any = {};
      for (const key of sectionKeys) {
        if (INITIAL_MASK_ADJUSTMENTS[key] !== undefined) {
          resetValues[key] = JSON.parse(JSON.stringify(INITIAL_MASK_ADJUSTMENTS[key]));
        }
      }
      setMaskContainerAdjustments((prev: any) => ({
        ...prev,
        ...resetValues,
        sectionVisibility: {
          ...(prev.sectionVisibility || INITIAL_MASK_ADJUSTMENTS.sectionVisibility),
          [sectionName]: true,
        },
      }));
    };

    const isPasteAllowed = copiedSectionAdjustments && copiedSectionAdjustments.section === sectionName;
    const sectionTitle = sectionName.charAt(0).toUpperCase() + sectionName.slice(1);

    const pasteLabel = copiedSectionAdjustments
      ? `Paste ${copiedSectionAdjustments.section.charAt(0).toUpperCase() + copiedSectionAdjustments.section.slice(1)} Settings`
      : 'Paste Settings';

    showContextMenu(event.clientX, event.clientY, [
      {
        icon: Copy,
        label: `Copy ${sectionTitle} Settings`,
        onClick: handleCopy,
      },
      { label: pasteLabel, icon: ClipboardPaste, onClick: handlePaste, disabled: !isPasteAllowed },
      { type: OPTION_SEPARATOR },
      {
        icon: RotateCcw,
        label: `Reset ${sectionTitle} Settings`,
        onClick: handleReset,
      },
    ]);
  };

  const sectionVisibility =
    displayContainer.adjustments.sectionVisibility || INITIAL_MASK_ADJUSTMENTS.sectionVisibility;

  return (
    <div
      className={`px-4 pb-4 space-y-2 transition-opacity duration-300 ${!isActive ? 'opacity-50 pointer-events-none' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <CollapsibleSection
        title={isComponentMode ? `${getSubMaskName(activeSubMask)} Properties` : 'Mask Properties'}
        isOpen={isSettingsSectionOpen}
        onToggle={() => setSettingsSectionOpen(!isSettingsSectionOpen)}
        canToggleVisibility={false}
        isContentVisible={true}
      >
        <div className="space-y-4 pt-2">
          <Switch
            checked={!!(isComponentMode ? activeSubMask.invert : displayContainer.invert)}
            label={isComponentMode ? 'Invert Component' : 'Invert Mask'}
            onChange={(v) =>
              isComponentMode ? updateSubMask(activeSubMask.id, { invert: v }) : handleMaskPropertyChange('invert', v)
            }
          />

          {!isComponentMode && (
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium text-text-secondary select-none">Apply Preset</span>
              <button
                ref={presetButtonRef}
                onClick={handlePresetSelectClick}
                className="text-sm text-text-primary text-right select-none cursor-pointer hover:text-accent transition-colors"
                data-tooltip="Select a preset to apply"
              >
                Select
              </button>
            </div>
          )}

          <Slider
            defaultValue={100}
            label="Opacity"
            max={100}
            min={0}
            value={(isComponentMode ? activeSubMask.opacity : displayContainer.opacity) ?? 100}
            onChange={(e: any) =>
              isComponentMode
                ? updateSubMask(activeSubMask.id, { opacity: Number(e.target.value) })
                : handleMaskPropertyChange('opacity', Number(e.target.value))
            }
            step={1}
          />

          {isComponentMode && (
            <>
              {isAiMask && aiModelDownloadStatus && (
                <div className="p-3 mb-4 bg-card-active rounded-md border border-surface flex items-center gap-3">
                  <Loader2 size={16} className="text-accent animate-spin shrink-0" />
                  <div className="text-xs text-text-secondary leading-relaxed">
                    AI Model Downloading: <span className="text-accent font-medium">{aiModelDownloadStatus}</span>
                  </div>
                </div>
              )}
              {subMaskConfig.parameters?.map((param: any) => (
                <Slider
                  key={param.key}
                  label={param.label}
                  min={param.min}
                  max={param.max}
                  step={param.step}
                  defaultValue={param.defaultValue}
                  value={(activeSubMask.parameters[param.key] || 0) * (param.multiplier || 1)}
                  onChange={(e: any) =>
                    handleSubMaskParameterChange(param.key, parseFloat(e.target.value) / (param.multiplier || 1))
                  }
                />
              ))}
              {subMaskConfig.showBrushTools && brushSettings && (
                <BrushTools settings={brushSettings} onSettingsChange={setBrushSettings} />
              )}
            </>
          )}
        </div>
      </CollapsibleSection>

      <div
        onMouseEnter={() => setIsMaskControlHovered(true)}
        onMouseLeave={() => setIsMaskControlHovered(false)}
        className="flex flex-col gap-2"
      >
        {Object.keys(ADJUSTMENT_SECTIONS).map((sectionName) => {
          const SectionComponent: any = {
            basic: BasicAdjustments,
            curves: CurveGraph,
            color: ColorPanel,
            details: DetailsPanel,
            effects: EffectsPanel,
          }[sectionName];
          const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1);
          return (
            <CollapsibleSection
              key={sectionName}
              title={title}
              isOpen={collapsibleState[sectionName]}
              isContentVisible={sectionVisibility[sectionName]}
              onToggle={() => handleToggleSection(sectionName)}
              onToggleVisibility={() => handleToggleVisibility(sectionName)}
              onContextMenu={(e: any) => handleSectionContextMenu(e, sectionName)}
            >
              <SectionComponent
                adjustments={displayContainer.adjustments}
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
    </div>
  );
}
