import { type ChangeEvent, useState, useEffect, useRef, useMemo } from 'react';
import debounce from 'lodash.debounce';
import { v4 as uuidv4 } from 'uuid';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
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
  MaskType,
  SubMask,
  MASK_PANEL_CREATION_TYPES,
  OTHERS_MASK_TYPES,
  MASK_ICON_MAP,
  SubMaskMode,
  ToolType,
  formatMaskTypeName,
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
import Text from '../../ui/Text';
import { TEXT_COLOR_KEYS, TextColors, TextVariants, TextWeights } from '../../../types/typography';

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
  onGenerateAiDepthMask(id: string, parameters: any): void;
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
  type: 'Container' | 'SubMask' | 'Creation';
  item?: MaskContainer | SubMask;
  maskType?: Mask;
  parentId?: string;
}

const SUB_MASK_CONFIG: Record<Mask, any> = {
  [Mask.Radial]: {
    parameters: [{ key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, multiplier: 100, defaultValue: 50 }],
  },
  [Mask.Brush]: { showBrushTools: true },
  [Mask.Flow]: { showBrushTools: true, showFlowControl: true },
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
  [Mask.AiDepth]: {
    parameters: [{ key: 'feather', label: 'Global Feather', min: 0, max: 100, step: 1, defaultValue: 15 }],
  },
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
  <div>
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

const FlowBrushTool = ({
  flow,
  onFlowChange,
  settings,
  onSettingsChange,
}: {
  flow: number;
  onFlowChange: (flow: number) => void;
  settings: any;
  onSettingsChange: any;
}) => (
  <div className="space-y-4 border-t border-surface">
    <Slider
      defaultValue={10}
      label="Flow"
      max={100}
      min={0}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onFlowChange(Number(e.target.value))}
      step={1}
      value={flow}
    />
    <BrushTools settings={settings} onSettingsChange={onSettingsChange} />
  </div>
);

function DepthRangePicker({
  minDepth,
  maxDepth,
  minFade,
  maxFade,
  onChange,
}: {
  minDepth: number;
  maxDepth: number;
  minFade: number;
  maxFade: number;
  onChange: (values: { minDepth: number; maxDepth: number; minFade: number; maxFade: number }) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const [dragValues, setDragValues] = useState<{
    minDepth: number;
    maxDepth: number;
    minFade: number;
    maxFade: number;
  } | null>(null);
  const rafRef = useRef<number>(0);
  const [isLabelHovered, setIsLabelHovered] = useState(false);

  const vals = dragValues ?? { minDepth, maxDepth, minFade, maxFade };
  const fadeLeftEdge = Math.max(0, vals.minDepth - vals.minFade);
  const fadeRightEdge = Math.min(100, vals.maxDepth + vals.maxFade);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const getVal = (e: MouseEvent | React.MouseEvent): number => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(100, Math.round(((e.clientX - rect.left) / rect.width) * 100)));
  };

  const compute = (
    handle: string,
    val: number,
    init: { minDepth: number; maxDepth: number; minFade: number; maxFade: number; startVal: number },
  ): { minDepth: number; maxDepth: number; minFade: number; maxFade: number } => {
    switch (handle) {
      case 'minDepth': {
        const v = Math.max(0, Math.min(val, init.maxDepth));
        return { minDepth: v, maxDepth: init.maxDepth, minFade: Math.min(init.minFade, v), maxFade: init.maxFade };
      }
      case 'maxDepth': {
        const v = Math.max(init.minDepth, Math.min(100, val));
        return {
          minDepth: init.minDepth,
          maxDepth: v,
          minFade: init.minFade,
          maxFade: Math.min(init.maxFade, 100 - v),
        };
      }
      case 'fadeLeft': {
        const edge = Math.max(0, Math.min(val, init.minDepth));
        return {
          minDepth: init.minDepth,
          maxDepth: init.maxDepth,
          minFade: init.minDepth - edge,
          maxFade: init.maxFade,
        };
      }
      case 'fadeRight': {
        const edge = Math.max(init.maxDepth, Math.min(100, val));
        return {
          minDepth: init.minDepth,
          maxDepth: init.maxDepth,
          minFade: init.minFade,
          maxFade: edge - init.maxDepth,
        };
      }
      case 'range': {
        const delta = val - init.startVal;
        const width = init.maxDepth - init.minDepth;
        let nMin = Math.round(init.minDepth + delta);
        let nMax = Math.round(init.maxDepth + delta);
        if (nMin < 0) {
          nMin = 0;
          nMax = width;
        }
        if (nMax > 100) {
          nMax = 100;
          nMin = 100 - width;
        }
        return {
          minDepth: nMin,
          maxDepth: nMax,
          minFade: Math.min(init.minFade, nMin),
          maxFade: Math.min(init.maxFade, 100 - nMax),
        };
      }
      default:
        return { minDepth: init.minDepth, maxDepth: init.maxDepth, minFade: init.minFade, maxFade: init.maxFade };
    }
  };

  const beginDrag = (handle: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveHandle(handle);

    const init = { ...vals, startVal: getVal(e) };
    let latest = { ...vals };
    let pending = false;

    const onMove = (me: MouseEvent) => {
      latest = compute(handle, getVal(me), init);
      setDragValues(latest);

      if (!pending) {
        pending = true;
        rafRef.current = requestAnimationFrame(() => {
          onChange(latest);
          pending = false;
        });
      }
    };

    const onUp = () => {
      setActiveHandle(null);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      onChange(latest);

      requestAnimationFrame(() => setDragValues(null));

      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const handleColor = (handle: string, isMain: boolean) =>
    activeHandle === handle
      ? 'var(--color-accent, #818cf8)'
      : isMain
        ? 'rgba(255,255,255,0.85)'
        : 'rgba(255,255,255,0.45)';

  const handleReset = () => {
    onChange({ minDepth: 20, maxDepth: 100, minFade: 15, maxFade: 15 });
  };

  const isDragging = activeHandle !== null;

  return (
    <div className="space-y-2">
      <div
        className="grid w-fit cursor-pointer"
        onClick={handleReset}
        onMouseEnter={() => setIsLabelHovered(true)}
        onMouseLeave={() => setIsLabelHovered(false)}
      >
        <Text
          variant={TextVariants.label}
          aria-hidden={isLabelHovered}
          className={`col-start-1 row-start-1 select-none transition-opacity duration-200 ease-in-out ${
            isLabelHovered ? 'opacity-0' : 'opacity-100'
          }`}
        >
          Depth Range
        </Text>
        <Text
          variant={TextVariants.label}
          aria-hidden={!isLabelHovered}
          className={`col-start-1 row-start-1 select-none transition-opacity duration-200 ease-in-out pointer-events-none ${
            isLabelHovered ? 'opacity-100' : 'opacity-0'
          }`}
        >
          Reset
        </Text>
      </div>
      <div
        ref={trackRef}
        className="relative rounded-md overflow-hidden mt-2 select-none border border-white/10"
        style={{ height: 44 }}
      >
        {isDragging && (
          <div
            className="fixed inset-0 z-[9999]"
            style={{ cursor: activeHandle === 'range' ? 'grabbing' : 'ew-resize' }}
          />
        )}

        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(to right, #ddd 0%, #bbb 20%, #999 35%, #666 55%, #333 80%, #111 100%)',
          }}
        />
        <div
          className="absolute inset-y-0 left-0 bg-black/60 pointer-events-none"
          style={{ width: `${fadeLeftEdge}%` }}
        />
        <div
          className="absolute inset-y-0 right-0 bg-black/60 pointer-events-none"
          style={{ width: `${100 - fadeRightEdge}%` }}
        />

        {vals.minFade > 0.5 && (
          <div
            className="absolute inset-y-0 pointer-events-none"
            style={{
              left: `${fadeLeftEdge}%`,
              width: `${vals.minFade}%`,
              background: 'linear-gradient(to right, rgba(0,0,0,0.6), transparent)',
            }}
          />
        )}
        {vals.maxFade > 0.5 && (
          <div
            className="absolute inset-y-0 pointer-events-none"
            style={{
              left: `${vals.maxDepth}%`,
              width: `${vals.maxFade}%`,
              background: 'linear-gradient(to right, transparent, rgba(0,0,0,0.6))',
            }}
          />
        )}

        {[0, 1].map((i) => (
          <div
            key={i}
            className="absolute h-px pointer-events-none"
            style={{
              left: `${vals.minDepth}%`,
              width: `${Math.max(0, vals.maxDepth - vals.minDepth)}%`,
              background: 'rgba(255,255,255,0.3)',
              ...(i === 0 ? { top: 0 } : { bottom: 0 }),
            }}
          />
        ))}

        {[
          { pos: fadeLeftEdge, key: 'fadeLeft', main: false },
          { pos: vals.minDepth, key: 'minDepth', main: true },
          { pos: vals.maxDepth, key: 'maxDepth', main: true },
          { pos: fadeRightEdge, key: 'fadeRight', main: false },
        ].map(({ pos, key, main }) => (
          <div
            key={`line-${key}`}
            className="absolute inset-y-0 pointer-events-none"
            style={{
              left: `${pos}%`,
              transform: 'translateX(-50%)',
              width: main ? 2 : 1,
              background: handleColor(key, main),
              transition: activeHandle ? 'none' : 'background 0.15s',
            }}
          />
        ))}

        <div
          className="absolute inset-y-0"
          style={{
            left: `${vals.minDepth}%`,
            width: `${Math.max(0, vals.maxDepth - vals.minDepth)}%`,
            cursor: activeHandle === 'range' ? 'grabbing' : 'grab',
            zIndex: 5,
          }}
          onMouseDown={beginDrag('range')}
        />

        {[
          { pos: fadeLeftEdge, key: 'fadeLeft' },
          { pos: fadeRightEdge, key: 'fadeRight' },
        ].map(({ pos, key }) => (
          <div
            key={key}
            className="absolute flex items-start justify-center cursor-ew-resize"
            style={{ left: `${pos}%`, transform: 'translateX(-50%)', top: 0, height: '50%', width: 28, zIndex: 15 }}
            onMouseDown={beginDrag(key)}
          >
            <svg width="8" height="5" viewBox="0 0 8 5" style={{ marginTop: 3 }}>
              <polygon points="4,5 8,0 0,0" fill={handleColor(key, false)} />
            </svg>
          </div>
        ))}

        {[
          { pos: vals.minDepth, key: 'minDepth' },
          { pos: vals.maxDepth, key: 'maxDepth' },
        ].map(({ pos, key }) => (
          <div
            key={key}
            className="absolute flex items-end justify-center cursor-ew-resize"
            style={{ left: `${pos}%`, transform: 'translateX(-50%)', bottom: 0, height: '50%', width: 28, zIndex: 20 }}
            onMouseDown={beginDrag(key)}
          >
            <svg width="10" height="6" viewBox="0 0 10 6" style={{ marginBottom: 3 }}>
              <polygon points="5,0 10,6 0,6" fill={handleColor(key, true)} />
            </svg>
          </div>
        ))}
      </div>
      <Text as="div" variant={TextVariants.small} className="flex justify-between select-none px-1">
        <span>Near</span>
        <span>Far</span>
      </Text>
    </div>
  );
}

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
  onGenerateAiDepthMask,
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
  const hasPerformedInitialSelection = useRef(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [analyzingSubMaskId, setAnalyzingSubMaskId] = useState<string | null>(null);
  const [isResizingWaveform, setIsResizingWaveform] = useState<boolean>(false);

  const { showContextMenu } = useContextMenu();
  const { presets } = usePresets(adjustments);

  const { setNodeRef: setRootDroppableRef, isOver: isRootOver } = useDroppable({ id: 'mask-list-root' });

  const activeContainer = adjustments.masks.find((m) => m.id === activeMaskContainerId);
  const activeSubMaskData = activeContainer?.subMasks.find((sm) => sm.id === activeMaskId);
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

    if (type === Mask.AiDepth) {
      if (!subMask.parameters) subMask.parameters = {};
      subMask.parameters.minDepth = 20;
      subMask.parameters.maxDepth = 100;
      subMask.parameters.minFade = 15;
      subMask.parameters.maxFade = 15;
      subMask.parameters.feather = 10;
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
    else if (type === Mask.AiDepth) onGenerateAiDepthMask(subMask.id, subMask.parameters);
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
    else if (type === Mask.AiDepth) onGenerateAiDepthMask(subMask.id, subMask.parameters);
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

  const handleAddOthersMask = (event: React.MouseEvent) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const options = OTHERS_MASK_TYPES.map((maskType) => ({
      label: maskType.name,
      icon: maskType.icon,
      onClick: () => handleGridClick(maskType.type),
      onRightClick: () => handleGridClick(maskType.type, true),
    }));
    showContextMenu(rect.left, rect.bottom + 5, options);
  };

  const handleAddMaskContextMenu = (event: React.MouseEvent, targetContainerId?: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();

    const buildMenu = (types: MaskType[]) =>
      types.map((maskType: MaskType) => ({
        label: maskType.name,
        icon: maskType.icon,
        disabled: maskType.disabled,
        onClick: () => {
          if (targetContainerId) {
            handleAddSubMask(targetContainerId, maskType.type);
          } else {
            handleAddMaskContainer(maskType.type);
          }
        },
      }));

    const options = MASK_PANEL_CREATION_TYPES.map((maskType: MaskType) => {
      if (maskType.id === 'others') {
        return {
          label: maskType.name,
          icon: maskType.icon,
          submenu: buildMenu(OTHERS_MASK_TYPES),
        };
      }
      return {
        label: maskType.name,
        icon: maskType.icon,
        disabled: maskType.disabled,
        onClick: () => {
          if (targetContainerId) {
            handleAddSubMask(targetContainerId, maskType.type);
          } else {
            handleAddMaskContainer(maskType.type);
          }
        },
      };
    });

    showContextMenu(rect.left, rect.bottom + 5, options);
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

    if (dragData.type === 'Creation' && dragData.maskType) {
      const creationFn = () => {
        if (overData?.type === 'Container') {
          handleAddSubMask(overData.item!.id, dragData.maskType);
        } else if (overData?.type === 'SubMask') {
          const container = adjustments.masks.find((m) => m.id === overData.parentId);
          if (container) {
            const targetIndex = container.subMasks.findIndex((sm) => sm.id === over.id);
            handleAddSubMask(overData.parentId!, dragData.maskType, targetIndex);
          }
        } else {
          handleAddMaskContainer(dragData.maskType);
        }
      };

      if (adjustments.masks.length > 0) {
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
    const allTypes = [...MASK_PANEL_CREATION_TYPES.filter((m) => m.id !== 'others'), ...OTHERS_MASK_TYPES];
    const newMaskSubMenu = allTypes.map((m) => ({
      label: m.name,
      icon: m.icon,
      onClick: () => handleAddMaskContainer(m.type),
    }));
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Paste Mask', icon: ClipboardPaste, disabled: !copiedMask, onClick: () => handlePasteMask() },
      { label: 'Add New Mask', icon: Plus, submenu: newMaskSubMenu },
    ]);
  };

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
          <Text variant={TextVariants.title}>Masking</Text>
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

        <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-h-0 p-4 gap-8">
          <AnimatePresence mode="wait">
            {adjustments.masks.length === 0 ? (
              <motion.div
                key="empty-masks-grid"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="z-10 shrink-0"
              >
                <Text variant={TextVariants.heading} className="mb-2">
                  Create New Mask
                </Text>
                <div className="grid grid-cols-3 gap-2" onClick={(e) => e.stopPropagation()}>
                  {MASK_PANEL_CREATION_TYPES.map((maskType: MaskType) => (
                    <DraggableGridItem
                      key={maskType.type || maskType.id}
                      maskType={maskType}
                      onClick={(e: any) =>
                        maskType.id === 'others' ? handleAddOthersMask(e) : handleGridClick(maskType.type)
                      }
                      onRightClick={(e: React.MouseEvent) => handleGridRightClick(e, maskType.type)}
                      isDraggable={maskType.id !== 'others'}
                      activeMaskContainerId={activeMaskContainerId}
                    />
                  ))}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="masks-list-container"
                ref={setRootDroppableRef}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className={`flex-col transition-colors ${isRootOver ? 'bg-surface' : ''}`}
              >
                <Text variant={TextVariants.heading} className="mb-2">
                  Masks
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
                    <NewMaskDropZone isOver={isRootOver} />
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
                  <span>Add New Mask</span>
                </Text>
              </motion.div>
            )}
          </AnimatePresence>

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
                  Mask Adjustments
                </Text>
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
                  onGenerateAiDepthMask={onGenerateAiDepthMask}
                />
              </motion.div>
            )}
          </AnimatePresence>
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
                  const maskType =
                    MASK_PANEL_CREATION_TYPES.find((m) => m.type === activeDragItem.maskType) ||
                    OTHERS_MASK_TYPES.find((m) => m.type === activeDragItem.maskType);
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

function NewMaskDropZone({ isOver }: { isOver: boolean }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0, marginTop: 0 }}
      animate={{ opacity: 1, height: 'auto', marginTop: '4px' }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={`p-4 rounded-lg text-center ${isOver ? 'border border-accent/80 bg-bg-tertiary/50' : ''}`}
    >
      <Text weight={TextWeights.medium}>Drop here to create a new mask</Text>
    </motion.div>
  );
}

function DraggableGridItem({ maskType, onClick, onRightClick, isDraggable, activeMaskContainerId }: any) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `create-${maskType.id || maskType.type}`,
    data: { type: 'Creation', maskType: maskType.type },
    disabled: !isDraggable,
  });

  const tooltip = maskType.disabled
    ? 'Coming Soon'
    : maskType.id === 'others'
      ? 'Show More Mask Types'
      : activeMaskContainerId
        ? `Add ${maskType.name} to Current Mask or Create New (Right-click)`
        : `Create New ${maskType.name} Mask`;

  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      disabled={maskType.disabled}
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
                ${maskType.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-card-active active:bg-accent/20'} ${isDragging ? 'opacity-50' : ''}`}
      data-tooltip={tooltip}
    >
      <maskType.icon size={24} />{' '}
      <Text as="span" variant={TextVariants.small} color={TextColors.primary}>
        {maskType.name}
      </Text>
    </button>
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
            className="overflow-hidden pl-2 border-l border-border-color/20 ml-3.75"
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
                    <span className="select-none">Add New Component</span>
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
        <button
          className="p-1 hover:text-text-primary text-text-secondary"
          data-tooltip={subMask.mode === SubMaskMode.Additive ? 'Switch to Subtract' : 'Switch to Add'}
          onClick={(e) => {
            e.stopPropagation();
            updateSubMask(subMask.id, {
              mode: subMask.mode === SubMaskMode.Additive ? SubMaskMode.Subtractive : SubMaskMode.Additive,
            });
          }}
        >
          {subMask.mode === SubMaskMode.Additive ? <Plus size={16} /> : <Minus size={16} />}
        </button>
        <button
          className="p-1 hover:text-text-primary text-text-secondary"
          data-tooltip={subMask.visible ? 'Hide Component' : 'Show Component'}
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
          data-tooltip="Delete Component"
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
  onGenerateAiDepthMask,
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

  const handleSubMaskParametersChange = (changes: Record<string, number>) => {
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
  const isAiMask = activeSubMask && ['ai-subject', 'ai-foreground', 'ai-sky', 'ai-depth'].includes(activeSubMask.type);
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
      className={`space-y-2 transition-opacity duration-300 ${!isActive ? 'opacity-50 pointer-events-none' : ''}`}
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
              <Text variant={TextVariants.label} className="select-none">
                Apply Preset
              </Text>
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
                <Text
                  as="div"
                  variant={TextVariants.small}
                  color={TextColors.accent}
                  weight={TextWeights.medium}
                  className="p-3 bg-card-active rounded-md border border-surface flex items-center gap-3"
                >
                  <Loader2 size={16} className="animate-spin shrink-0" />
                  <div className="leading-relaxed">
                    <Text variant={TextVariants.small}>AI Model Downloading: </Text>
                    <span>{aiModelDownloadStatus}</span>
                  </div>
                </Text>
              )}

              {activeSubMask.type === Mask.AiDepth && (
                <DepthRangePicker
                  minDepth={100 - (activeSubMask.parameters?.maxDepth ?? 100)}
                  maxDepth={100 - (activeSubMask.parameters?.minDepth ?? 0)}
                  minFade={activeSubMask.parameters?.maxFade ?? 15}
                  maxFade={activeSubMask.parameters?.minFade ?? 15}
                  onChange={handleDepthRangeChange}
                />
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
                    handleSubMaskParametersChange({ [param.key]: parseFloat(e.target.value) / (param.multiplier || 1) })
                  }
                />
              ))}

              {subMaskConfig.showBrushTools && brushSettings && (
                activeSubMask.type === Mask.Flow ? (
                  <FlowBrushTool
                    flow={activeSubMask.parameters?.flow ?? 10}
                    onFlowChange={(flow: number) => handleSubMaskParametersChange({ flow })}
                    settings={brushSettings}
                    onSettingsChange={setBrushSettings}
                  />
                ) : (
                  <BrushTools settings={brushSettings} onSettingsChange={setBrushSettings} />
                )
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
