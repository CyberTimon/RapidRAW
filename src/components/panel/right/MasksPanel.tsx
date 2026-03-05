import { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
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

import {
  Mask,
  MaskType,
  SubMask,
  MASK_PANEL_CREATION_TYPES,
  OTHERS_MASK_TYPES,
  MASK_ICON_MAP,
  SubMaskMode,
  ToolType,
} from './Masks';
import {
  Adjustments,
  INITIAL_MASK_ADJUSTMENTS,
  INITIAL_MASK_CONTAINER,
  MaskContainer,
  ADJUSTMENT_SECTIONS,
} from '../../../utils/adjustments';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { AppSettings, BrushSettings, OPTION_SEPARATOR, SelectedImage } from '../../ui/AppProperties';
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
  onDragStateChange?: (isDragging: boolean) => void;
}

interface DragData {
  type: 'Container' | 'SubMask' | 'Creation';
  item?: MaskContainer | SubMask;
  maskType?: Mask;
  parentId?: string;
}

function formatMaskTypeName(type: string) {
  if (type === Mask.AiSubject) return 'AI Subject';
  if (type === Mask.AiForeground) return 'AI Foreground';
  if (type === Mask.AiSky) return 'AI Sky';
  if (type === Mask.All) return 'Whole Image';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

const SUB_MASK_CONFIG: Record<Mask, any> = {
  [Mask.Radial]: { parameters: [{ key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, multiplier: 100, defaultValue: 50 }] },
  [Mask.Brush]: { showBrushTools: true },
  [Mask.Linear]: { parameters: [] },
  [Mask.Color]: { parameters: [] },
  [Mask.Luminance]: { parameters: [] },
  [Mask.All]: { parameters: [] },
  [Mask.AiSubject]: { parameters: [{ key: 'grow', label: 'Grow', min: -100, max: 100, step: 1, defaultValue: 0 }, { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, defaultValue: 0 }] },
  [Mask.AiForeground]: { parameters: [{ key: 'grow', label: 'Grow', min: -100, max: 100, step: 1, defaultValue: 0 }, { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, defaultValue: 0 }] },
  [Mask.AiSky]: { parameters: [{ key: 'grow', label: 'Grow', min: -100, max: 100, step: 1, defaultValue: 0 }, { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, defaultValue: 0 }] },
  [Mask.QuickEraser]: { parameters: [] },
};

const BrushTools = ({ settings, onSettingsChange }: { settings: any; onSettingsChange: any }) => (
  <div className="space-y-4 border-t border-surface">
    <Slider defaultValue={100} label="Brush Size" max={200} min={1} onChange={(e: any) => onSettingsChange((s: any) => ({ ...s, size: Number(e.target.value) }))} step={1} value={settings.size} />
    <Slider defaultValue={50} label="Brush Feather" max={100} min={0} onChange={(e: any) => onSettingsChange((s: any) => ({ ...s, feather: Number(e.target.value) }))} step={1} value={settings.feather} />
    <div className="grid grid-cols-2 gap-2 pt-2">
      <button className={`p-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${settings.tool === ToolType.Brush ? 'text-primary bg-surface' : 'bg-surface text-text-secondary hover:bg-card-active'}`} onClick={() => onSettingsChange((s: any) => ({ ...s, tool: ToolType.Brush }))}>Brush</button>
      <button className={`p-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${settings.tool === ToolType.Eraser ? 'text-primary bg-surface' : 'bg-surface text-text-secondary hover:bg-card-active'}`} onClick={() => onSettingsChange((s: any) => ({ ...s, tool: ToolType.Eraser }))}>Eraser</button>
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
  onDragStateChange,
}: MasksPanelProps) {
  const [expandedContainers, setExpandedContainers] = useState<Set<string>>(new Set());
  const [activeDragItem, setActiveDragItem] = useState<DragData | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [tempName, setTempName] = useState('');
  const [collapsibleState, setCollapsibleState] = useState<any>({ basic: true, curves: false, color: false, details: false, effects: false });
  const [copiedSectionAdjustments, setCopiedSectionAdjustments] = useState<any | null>(null);
  const [isSettingsSectionOpen, setSettingsSectionOpen] = useState(true);
  const [isSettingsPanelEverOpened, setIsSettingsPanelEverOpened] = useState(false);
  const hasPerformedInitialSelection = useRef(false);
  const [isMaskListEmpty, setIsMaskListEmpty] = useState(adjustments.masks.length === 0);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [analyzingSubMaskId, setAnalyzingSubMaskId] = useState<string | null>(null);

  const { showContextMenu } = useContextMenu();
  const { presets } = usePresets(adjustments);
  
  const { setNodeRef: setRootDroppableRef, isOver: isRootOver } = useDroppable({ id: 'mask-list-root' });
  
  const activeContainer = adjustments.masks.find(m => m.id === activeMaskContainerId);
  const activeSubMaskData = activeContainer?.subMasks.find(sm => sm.id === activeMaskId);
  const isAiMask = activeSubMaskData && [Mask.AiSubject, Mask.AiForeground, Mask.AiSky].includes(activeSubMaskData.type);

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
      const containerExists = adjustments.masks.some(m => m.id === activeMaskContainerId);
      if (!containerExists) {
        onSelectContainer(null);
        onSelectMask(null);
      }
    }
  }, [adjustments.masks, activeMaskContainerId, onSelectContainer, onSelectMask]);

  useEffect(() => {
    if (adjustments.masks.length > 0) {
      setIsMaskListEmpty(false);
    }

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
        setExpandedContainers(prev => {
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
      if (renamingId) { setRenamingId(null); setTempName(''); }
      else if (activeMaskId) onSelectMask(null);
      else if (activeMaskContainerId) onSelectContainer(null);
    };
    if (activeMaskContainerId || renamingId) setCustomEscapeHandler(() => handler);
    else setCustomEscapeHandler(null);
    return () => setCustomEscapeHandler(null);
  }, [activeMaskContainerId, activeMaskId, renamingId, onSelectContainer, onSelectMask, setCustomEscapeHandler]);

  const handleDeselect = () => { onSelectContainer(null); onSelectMask(null); };

  const handleToggleExpand = (id: string) => {
    setExpandedContainers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
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
      const imgW = isRotated ? (selectedImage.height || 1000) : (selectedImage.width || 1000);
      const imgH = isRotated ? (selectedImage.width || 1000) : (selectedImage.height || 1000);

      if (type === Mask.Linear && subMask.parameters) {
          subMask.parameters.range = Math.min(imgW, imgH) * 0.1;
      }

      if (adjustments?.crop && subMask.parameters && (type === Mask.Linear || type === Mask.Radial)) {
        const { x, y, width, height, unit } = adjustments.crop as any;
        const isPercent = unit === '%';
        const cW = isPercent ? (width / 100) * imgW : width;
        const cH = isPercent ? (height / 100) * imgH : height;
        const cX = isPercent ? (x / 100) * imgW : x;
        const cY = isPercent ? (y / 100) * imgH : y;

        if (imgW && imgH) {
           const ratioX = cW / imgW; const ratioY = cH / imgH;
           const cx = cX + cW / 2; const cy = cY + cH / 2;
           const ox = imgW / 2; const oy = imgH / 2;
           const p = { ...subMask.parameters };
           if (type === Mask.Linear) { p.startX = cx + (p.startX - ox) * ratioX; p.endX = cx + (p.endX - ox) * ratioX; p.startY = cy + (p.startY - oy) * ratioY; p.endY = cy + (p.endY - oy) * ratioY; p.range = Math.min(cW, cH) * 0.1; } 
           else if (type === Mask.Radial) { p.centerX = cx + (p.centerX - ox) * ratioX; p.centerY = cy + (p.centerY - oy) * ratioY; p.radiusX *= ratioX; p.radiusY *= ratioY; }
           subMask.parameters = p;
        }
      }
      return subMask;
  };

  const handleAddMaskContainer = (type: Mask) => {
    if (adjustments.masks.length === 0) {
      setIsMaskListEmpty(false);
    }
    const subMask = createMaskLogic(type);
    const newContainer = { ...INITIAL_MASK_CONTAINER, id: uuidv4(), name: `Mask ${adjustments.masks.length + 1}`, subMasks: [subMask] };
    setAdjustments((prev: Adjustments) => ({ ...prev, masks: [...(prev.masks || []), newContainer] }));
    onSelectContainer(newContainer.id);
    onSelectMask(subMask.id);
    setExpandedContainers(prev => new Set(prev).add(newContainer.id));
    if (type === Mask.AiForeground) onGenerateAiForegroundMask(subMask.id);
    else if (type === Mask.AiSky) onGenerateAiSkyMask(subMask.id);
  };

  const handleAddSubMask = (containerId: string, type: Mask, insertIndex: number = -1) => {
    const subMask = createMaskLogic(type);
    setAdjustments((prev: Adjustments) => ({
      ...prev, masks: prev.masks?.map((c: MaskContainer) => {
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
      })
    }));
    onSelectContainer(containerId);
    onSelectMask(subMask.id);
    setExpandedContainers(prev => new Set(prev).add(containerId));
    if (type === Mask.AiForeground) onGenerateAiForegroundMask(subMask.id);
    else if (type === Mask.AiSky) onGenerateAiSkyMask(subMask.id);
  };

  const handleGridClick = (type: Mask) => {
    if (activeMaskContainerId) handleAddSubMask(activeMaskContainerId, type);
    else handleAddMaskContainer(type);
  };

  const handleAddOthersMask = (event: React.MouseEvent) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const options = OTHERS_MASK_TYPES.map((maskType) => ({ label: maskType.name, icon: maskType.icon, onClick: () => handleGridClick(maskType.type) }));
    showContextMenu(rect.left, rect.bottom + 5, options);
  };

  const updateContainer = (id: string, data: any) => setAdjustments((prev: Adjustments) => ({ ...prev, masks: prev.masks.map(m => m.id === id ? { ...m, ...data } : m) }));
  const updateSubMask = (id: string, data: any) => setAdjustments((prev: Adjustments) => ({ ...prev, masks: prev.masks.map(m => ({ ...m, subMasks: m.subMasks.map(sm => sm.id === id ? { ...sm, ...data } : sm) })) }));
  
  const handleDeleteContainer = (id: string) => {
    if (activeMaskContainerId === id) handleDeselect();
    setAdjustments((prev: Adjustments) => ({ ...prev, masks: prev.masks.filter(m => m.id !== id) }));
  };

  const handleDeleteSubMask = (containerId: string, subMaskId: string) => {
    if (activeMaskId === subMaskId) onSelectMask(null);
    setAdjustments((prev: Adjustments) => ({ ...prev, masks: prev.masks.map(m => m.id === containerId ? { ...m, subMasks: m.subMasks.filter(sm => sm.id !== subMaskId) } : m) }));
  };

  const handleDuplicateContainer = (container: MaskContainer) => {
    if (adjustments.masks.length === 0) {
      setIsMaskListEmpty(false);
    }
    const newC = JSON.parse(JSON.stringify(container));
    newC.id = uuidv4();
    newC.name = `${container.name} Copy`;
    newC.subMasks.forEach((sm: any) => sm.id = uuidv4());
    setAdjustments((prev: Adjustments) => ({ ...prev, masks: [...prev.masks, newC] }));
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
                const container = adjustments.masks.find(m => m.id === overData.parentId);
                if (container) {
                    const targetIndex = container.subMasks.findIndex(sm => sm.id === over.id);
                    handleAddSubMask(overData.parentId!, dragData.maskType, targetIndex);
                }
            } else {
                handleAddMaskContainer(dragData.maskType);
            }
        };

        if (!isMaskListEmpty) {
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
        const oldIndex = prev.masks.findIndex(m => m.id === dragData.item!.id);
        let newIndex = -1;

        if (overId === 'mask-list-root') {
             newIndex = prev.masks.length - 1;
        } else if (overData?.type === 'Container') {
             newIndex = prev.masks.findIndex(m => m.id === overId);
        } else if (overData?.type === 'SubMask') {
             newIndex = prev.masks.findIndex(m => m.id === overData.parentId);
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
          if (adjustments.masks.length === 0) {
            setIsMaskListEmpty(false);
          }
          const newContainer = { ...INITIAL_MASK_CONTAINER, id: uuidv4(), name: `Mask ${newMasks.length + 1}`, subMasks: [movedSubMask] };
          newMasks.push(newContainer);
          setTimeout(() => {
            onSelectContainer(newContainer.id);
            onSelectMask(movedSubMask.id);
            setExpandedContainers(p => new Set(p).add(newContainer.id));
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
          const newMasks = prev.masks.map(m => ({ ...m, subMasks: [...m.subMasks] }));
          const sourceContainer = newMasks.find(m => m.id === sourceContainerId);
          const targetContainer = newMasks.find(m => m.id === targetContainerId);
          if (!sourceContainer || !targetContainer) return prev;
          
          const sourceSubMaskIndex = sourceContainer.subMasks.findIndex(sm => sm.id === dragData.item!.id);
          if (sourceSubMaskIndex === -1) return prev;
          
          const [movedSubMask] = sourceContainer.subMasks.splice(sourceSubMaskIndex, 1);
          
          if (sourceContainerId === targetContainerId) {
            if (overData?.type === 'SubMask') {
                const overSubMaskIndex = sourceContainer.subMasks.findIndex(sm => sm.id === over.id);
                const insertIndex = overSubMaskIndex >= 0 ? overSubMaskIndex : sourceContainer.subMasks.length;
                sourceContainer.subMasks.splice(insertIndex, 0, movedSubMask);
            } else {
                sourceContainer.subMasks.push(movedSubMask);
            }
          } else {
            if (overData?.type === 'SubMask') {
               const overSubMaskIndex = targetContainer.subMasks.findIndex(sm => sm.id === over.id);
               const insertIndex = overSubMaskIndex >= 0 ? overSubMaskIndex : targetContainer.subMasks.length;
               targetContainer.subMasks.splice(insertIndex, 0, movedSubMask);
            } else {
               targetContainer.subMasks.push(movedSubMask);
            }
            setExpandedContainers(p => new Set(p).add(targetContainerId!));
          }
          return { ...prev, masks: newMasks };
        });
      }
    }
  };

  const handlePanelContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      const allTypes = [...MASK_PANEL_CREATION_TYPES.filter(m => m.id !== 'others'), ...OTHERS_MASK_TYPES];
      const newMaskSubMenu = allTypes.map(m => ({ label: m.name, icon: m.icon, onClick: () => handleAddMaskContainer(m.type) }));
      const handlePaste = () => {
          if (copiedMask) {
              if (adjustments.masks.length === 0) {
                  setIsMaskListEmpty(false);
              }
              const newC = JSON.parse(JSON.stringify(copiedMask));
              newC.id = uuidv4();
              newC.subMasks.forEach((sm: any) => (sm.id = uuidv4()));
              setAdjustments((prev: Adjustments) => ({ ...prev, masks: [...prev.masks, newC] }));
          }
      };
      showContextMenu(e.clientX, e.clientY, [
          { label: 'Paste Mask', icon: ClipboardPaste, disabled: !copiedMask, onClick: handlePaste },
          { label: 'Add New Mask', icon: Plus, submenu: newMaskSubMenu }
      ]);
  };

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} collisionDetection={pointerWithin}>
      <div className="flex flex-col h-full select-none overflow-hidden" onClick={handleDeselect} onContextMenu={handlePanelContextMenu}>
        
        <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface h-[69px]">
            <h2 className="text-xl font-bold text-primary text-shadow-shiny">Masking</h2>
            <button className="p-2 rounded-full hover:bg-surface transition-colors" onClick={handleResetAllMasks} data-tooltip="Reset Masking">
               <RotateCcw size={18} />
            </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-h-0">
            <div className="p-4 pb-2 z-10 flex-shrink-0">
                <p className="text-sm mb-3 font-semibold text-text-primary">
                  {activeMaskContainerId ? "Add to Mask" : "Create New Mask"}
                </p>
                <div className="grid grid-cols-3 gap-2" onClick={(e) => e.stopPropagation()}>
                    {MASK_PANEL_CREATION_TYPES.map((maskType: MaskType) => (
                    <DraggableGridItem 
                        key={maskType.type || maskType.id} 
                        maskType={maskType} 
                        onClick={(e:any) => maskType.id === 'others' ? handleAddOthersMask(e) : handleGridClick(maskType.type)}
                        isDraggable={maskType.id !== 'others'}
                        activeMaskContainerId={activeMaskContainerId}
                    />
                    ))}
                </div>
            </div>
            
            <AnimatePresence>
                {isSettingsPanelEverOpened && (
                    <motion.div 
                        ref={setRootDroppableRef}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className={`flex-col px-4 pb-2 space-y-1 transition-colors ${isRootOver ? 'bg-surface' : ''}`}
                    >
                        <p className="text-sm my-3 font-semibold text-text-primary">Masks</p>
                        
                        <AnimatePresence 
                          initial={false} 
                          mode='popLayout'
                          onExitComplete={() => {
                              if (adjustments.masks.length === 0) {
                                  setIsMaskListEmpty(true);
                              }
                          }}
                        >
                            {isMaskListEmpty ? (
                                <motion.div
                                    key="empty-masks-placeholder"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="text-center text-text-secondary text-sm py-4 opacity-70"
                                >
                                    No masks created.
                                </motion.div>
                            ) : (
                                adjustments.masks.map((container) => (
                                    <ContainerRow 
                                        key={container.id} 
                                        container={container} 
                                        isSelected={activeMaskContainerId === container.id && activeMaskId === null}
                                        hasActiveChild={activeMaskContainerId === container.id && activeMaskId !== null}
                                        isExpanded={expandedContainers.has(container.id)}
                                        onToggle={() => handleToggleExpand(container.id)} 
                                        onSelect={() => { onSelectContainer(container.id); onSelectMask(null); }}
                                        renamingId={renamingId} setRenamingId={setRenamingId} 
                                        tempName={tempName} setTempName={setTempName}
                                        updateContainer={updateContainer} 
                                        handleDelete={handleDeleteContainer} 
                                        handleDuplicate={handleDuplicateContainer} 
                                        setCopiedMask={setCopiedMask} 
                                        copiedMask={copiedMask} 
                                        presets={presets}
                                        setAdjustments={setAdjustments}
                                        activeDragItem={activeDragItem}
                                        activeMaskId={activeMaskId}
                                        onSelectContainer={onSelectContainer}
                                        onSelectMask={onSelectMask}
                                        updateSubMask={updateSubMask}
                                        handleDeleteSubMask={handleDeleteSubMask}
                                        analyzingSubMaskId={analyzingSubMaskId}
                                    />
                                ))
                            )}
                        </AnimatePresence>

                        <AnimatePresence
                            onExitComplete={() => {
                                if (pendingAction) {
                                    pendingAction();
                                    setPendingAction(null);
                                }
                            }}
                        >
                            {activeDragItem?.type === 'Creation' && !isMaskListEmpty && (
                                <NewMaskDropZone isOver={isRootOver} />
                            )}
                        </AnimatePresence>

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
                        <p className="text-sm my-3 font-semibold text-text-primary px-4">Mask Adjustments</p>
                        <SettingsPanel 
                            container={activeContainer} activeSubMask={activeSubMaskData || null}
                            aiModelDownloadStatus={aiModelDownloadStatus} brushSettings={brushSettings} setBrushSettings={setBrushSettings}
                            updateContainer={updateContainer} updateSubMask={updateSubMask} histogram={histogram}
                            appSettings={appSettings} isGeneratingAiMask={isGeneratingAiMask} setIsMaskControlHovered={setIsMaskControlHovered}
                            collapsibleState={collapsibleState} setCollapsibleState={setCollapsibleState}
                            copiedSectionAdjustments={copiedSectionAdjustments} setCopiedSectionAdjustments={setCopiedSectionAdjustments}
                            onDragStateChange={onDragStateChange} isSettingsSectionOpen={isSettingsSectionOpen} setSettingsSectionOpen={setSettingsSectionOpen}
                            presets={presets}
                        />
                    </motion.div>
                )}
            </AnimatePresence>
        </div>

      </div>

      <DragOverlay dropAnimation={{ duration: 150, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
         {activeDragItem ? (
            <div className="w-[var(--sidebar-width,280px)] pointer-events-none">
              {activeDragItem.type === 'Container' && activeDragItem.item && (
                <div className="flex items-center gap-2 p-2 rounded-md bg-surface shadow-2xl opacity-90 ring-1 ring-black/10">
                    <div className="text-text-secondary"><FolderIcon size={18}/></div>
                    <span className="text-sm font-medium text-text-primary flex-1 truncate">{(activeDragItem.item as MaskContainer).name}</span>
                    <div className="flex gap-1.5 opacity-50">
                       <Eye size={16} className="text-text-secondary"/>
                       <Trash2 size={16} className="text-text-secondary"/>
                    </div>
                </div>
              )}

              {activeDragItem.type === 'SubMask' && activeDragItem.item && (
                 <div className="flex items-center gap-2 p-2 rounded-md bg-surface shadow-2xl opacity-90 ring-1 ring-black/10 ml-[15px]">
                    {(() => {
                      const sm = activeDragItem.item as SubMask;
                      const Icon = MASK_ICON_MAP[sm.type] || Circle;
                      return <Icon size={16} className="text-text-secondary flex-shrink-0 ml-1" />;
                    })()}
                    <span className="text-sm text-text-primary flex-1 truncate">{formatMaskTypeName((activeDragItem.item as SubMask).type)}</span>
                    <div className="flex gap-1.5 opacity-50">
                       <Plus size={14} className="text-text-secondary"/>
                       <Eye size={14} className="text-text-secondary"/>
                       <Trash2 size={14} className="text-text-secondary"/>
                    </div>
                 </div>
              )}

              {activeDragItem.type === 'Creation' && (
                 <div className="bg-surface text-text-primary rounded-lg p-2 flex flex-col items-center justify-center gap-1.5 aspect-square w-20 shadow-xl opacity-90">
                     {(() => {
                        const maskType = MASK_PANEL_CREATION_TYPES.find(m => m.type === activeDragItem.maskType) 
                                      || OTHERS_MASK_TYPES.find(m => m.type === activeDragItem.maskType);
                        const Icon = maskType?.icon || Circle;
                        return (
                          <>
                             <Icon size={24} />
                             <span className="text-xs text-center">{activeDragItem.maskType ? formatMaskTypeName(activeDragItem.maskType) : 'Mask'}</span>
                          </>
                        );
                     })()}
                 </div>
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
      <p className="text-sm font-medium text-text-secondary">
        Drop here to create a new mask
      </p>
    </motion.div>
  );
}

function DraggableGridItem({ maskType, onClick, isDraggable, activeMaskContainerId }: any) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ 
        id: `create-${maskType.id || maskType.type}`, 
        data: { type: 'Creation', maskType: maskType.type },
        disabled: !isDraggable
    });
    return (
        <button
            ref={setNodeRef} {...listeners} {...attributes} disabled={maskType.disabled} onClick={onClick}
            className={`bg-surface text-text-primary rounded-lg p-2 flex flex-col items-center justify-center gap-1.5 aspect-square transition-colors 
                ${maskType.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-card-active active:bg-accent/20'} ${isDragging ? 'opacity-50' : ''}`}
            data-tooltip={maskType.disabled ? 'Coming Soon' : activeMaskContainerId ? `Add ${maskType.name} to Current Mask` : `Create New ${maskType.name} Mask`}
        >
            <maskType.icon size={24} /> <span className="text-xs">{maskType.name}</span>
        </button>
    );
}

function ContainerRow({
  container, isSelected, hasActiveChild, isExpanded, onToggle, onSelect,
  renamingId, setRenamingId, tempName, setTempName, updateContainer, handleDelete,
  handleDuplicate, setCopiedMask, copiedMask, presets, setAdjustments,
  activeDragItem, activeMaskId, onSelectContainer, onSelectMask, updateSubMask, handleDeleteSubMask, analyzingSubMaskId,
}: any) {
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({ id: container.id, data: { type: 'Container', item: container } });
  const { attributes, listeners, setNodeRef: setDraggableRef, isDragging } = useDraggable({ id: container.id, data: { type: 'Container', item: container } });
  const [isSubMaskListEmpty, setIsSubMaskListEmpty] = useState(container.subMasks.length === 0);
  const { showContextMenu } = useContextMenu();

  useEffect(() => {
    if (container.subMasks.length > 0 && isSubMaskListEmpty) {
      setIsSubMaskListEmpty(false);
    }
  }, [container.subMasks.length, isSubMaskListEmpty]);
  
  const setCombinedRef = (node: HTMLElement | null) => {
    setDroppableRef(node);
    setDraggableRef(node);
  };

  const handleRenameSubmit = () => { 
      if (tempName.trim()) {
          const newName = tempName.trim();
          setAdjustments((prev: any) => {
              const updatedMasks = prev.masks.map((m: any) => m.id === container.id ? { ...m, name: newName } : m);
              return { ...prev, masks: updatedMasks };
          });
      }
      setRenamingId(null); 
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const generatePresetSubmenu = (list: any[]): any[] => list.map(item => {
        if (item.folder) return { label: item.folder.name, icon: FolderIcon, submenu: generatePresetSubmenu(item.folder.children) };
        if (item.preset || item.adjustments) return { label: item.name || item.preset.name, onClick: () => { const newAdj = { ...container.adjustments, ...(item.adjustments || item.preset.adjustments) }; newAdj.sectionVisibility = { ...container.adjustments.sectionVisibility, ...newAdj.sectionVisibility }; updateContainer(container.id, { adjustments: newAdj }); } };
        return null;
    }).filter(Boolean);
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Rename', icon: FileEdit, onClick: () => { setRenamingId(container.id); setTempName(container.name); } },
      { label: 'Duplicate', icon: PlusSquare, onClick: () => handleDuplicate(container) },
      { label: 'Copy', icon: Copy, onClick: () => setCopiedMask(container) },
      { label: 'Paste Adjustments', icon: ClipboardPaste, disabled: !copiedMask, onClick: () => { if (copiedMask) updateContainer(container.id, { adjustments: { ...copiedMask.adjustments } }); }},
      { label: 'Apply Preset', icon: Bookmark, submenu: generatePresetSubmenu(presets).length ? generatePresetSubmenu(presets) : [{label: 'No presets', disabled: true}] },
      { type: OPTION_SEPARATOR },
      { label: 'Reset Mask Adjustments', icon: RotateCcw, onClick: () => updateContainer(container.id, { adjustments: JSON.parse(JSON.stringify(INITIAL_MASK_ADJUSTMENTS)) }) },
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
      className="mb-0.5 overflow-hidden"
    >
        <div 
           {...listeners} {...attributes}
           className={`flex items-center gap-2 p-2 rounded-md transition-colors group 
             ${isSelected ? 'bg-surface' : 'hover:bg-card-active'} 
             ${borderClass}`}
           onClick={(e) => { e.stopPropagation(); onSelect(); }}
           onContextMenu={onContextMenu}
        >
            <div onClick={(e) => { e.stopPropagation(); onToggle(); }} className={`p-0.5 rounded transition-colors cursor-pointer ${hasActiveChild ? 'text-text-primary' : isExpanded ? 'text-primary' : 'text-text-secondary'}`}>
               {isExpanded ? <FolderOpen size={18}/> : <FolderIcon size={18}/>}
            </div>
            <div className="flex-1 min-w-0 cursor-pointer" onDoubleClick={(e) => { e.stopPropagation(); onToggle(); }}>
               {renamingId === container.id ? (
                  <input autoFocus className="bg-bg-primary text-sm w-full rounded px-1 outline-none border border-accent" value={tempName} onChange={(e) => setTempName(e.target.value)} onBlur={handleRenameSubmit} onKeyDown={(e) => e.key === 'Enter' && handleRenameSubmit()} onClick={(e) => e.stopPropagation()} />
               ) : (
                  <span className={`text-sm font-medium truncate select-none ${isSelected ? 'text-primary' : 'text-text-primary'} ${hasActiveChild ? 'text-text-primary font-bold' : ''}`}>{container.name}</span>
               )}
            </div>
            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
               <button className="p-1 hover:text-text-primary text-text-secondary" onClick={(e) => { e.stopPropagation(); updateContainer(container.id, { visible: !container.visible }); }}>{container.visible ? <Eye size={16}/> : <EyeOff size={16}/>}</button>
               <button className="p-1 hover:text-red-500 text-text-secondary" onClick={(e) => { e.stopPropagation(); handleDelete(container.id); }}><Trash2 size={16}/></button>
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
              <AnimatePresence
                mode="popLayout"
                initial={false}
                onExitComplete={() => {
                  if (container.subMasks.length === 0) {
                    setIsSubMaskListEmpty(true);
                  }
                }}
              >
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
                    onSelect={() => { onSelectContainer(container.id); onSelectMask(subMask.id); }}
                    updateSubMask={updateSubMask}
                    handleDelete={() => handleDeleteSubMask(container.id, subMask.id)}
                    analyzingSubMaskId={analyzingSubMaskId}
                  />
                ))}
              </AnimatePresence>
              {isSubMaskListEmpty && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="p-3 text-xs text-text-secondary text-center italic"
                >
                  No mask components.
                </motion.div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
    </motion.div>
  );
}

function SubMaskRow({ subMask, index, totalCount, containerId, isActive, parentVisible, onSelect, updateSubMask, handleDelete, activeDragItem, analyzingSubMaskId }: any) {
   const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: subMask.id, data: { type: 'SubMask', item: subMask, parentId: containerId } });
   const { setNodeRef: setDroppableRef, isOver } = useDroppable({ id: subMask.id, data: { type: 'SubMask', item: subMask, parentId: containerId } });
   const setCombinedRef = (node: HTMLElement | null) => { setNodeRef(node); setDroppableRef(node); };
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

   const onContextMenu = (e: React.MouseEvent) => {
      e.preventDefault(); e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [{ label: 'Delete Component', icon: Trash2, isDestructive: true, onClick: handleDelete }]);
   };

   const showNumber = isHovered && totalCount > 1;

   return (
      <motion.div 
         layout="position" 
         initial={{ opacity: 0, x: -15 }} 
         animate={{ opacity: 1, x: 0, scale: 1 }} 
         exit={{ opacity: 0, x: -15, scale: 0.95, transition: { duration: 0.2 } }}
         ref={setCombinedRef} {...attributes} {...listeners}
         onMouseEnter={handleMouseEnter}
         onMouseLeave={handleMouseLeave}
         className={`flex items-center gap-2 p-2 rounded-md transition-colors group mt-0.5 cursor-pointer 
            ${isActive ? 'bg-surface' : 'hover:bg-card-active'} 
            ${isOver && !isDraggingContainer ? 'border-t-2 border-accent' : ''} 
            ${isDragging ? 'opacity-40 z-50' : ''}
            ${parentVisible === false ? 'opacity-50' : ''}
            ${isDraggingContainer ? 'opacity-30 pointer-events-none' : ''}
            transition-opacity duration-300`}
         onClick={(e) => { e.stopPropagation(); onSelect(); }}
         onContextMenu={onContextMenu}
      >
          <div className="relative w-4 h-4 ml-1 flex-shrink-0 flex items-center justify-center">
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
          <span className="text-sm text-text-primary flex-1 truncate select-none">{formatMaskTypeName(subMask.type)}</span>
          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button className="p-1 hover:bg-bg-primary rounded text-text-secondary" data-tooltip={subMask.mode === SubMaskMode.Additive ? "Switch to Subtract" : "Switch to Add"} onClick={(e) => { e.stopPropagation(); updateSubMask(subMask.id, { mode: subMask.mode === SubMaskMode.Additive ? SubMaskMode.Subtractive : SubMaskMode.Additive }); }}>{subMask.mode === SubMaskMode.Additive ? <Plus size={14}/> : <Minus size={14}/>}</button>
            <button className="p-1 hover:bg-bg-primary rounded text-text-secondary" data-tooltip={subMask.visible ? "Hide Component" : "Show Component"} onClick={(e) => { e.stopPropagation(); updateSubMask(subMask.id, { visible: !subMask.visible }); }}>{subMask.visible ? <Eye size={14}/> : <EyeOff size={14}/>}</button>
            <button className="p-1 hover:text-red-500 text-text-secondary" data-tooltip="Delete Component" onClick={(e) => { e.stopPropagation(); handleDelete(); }}><Trash2 size={14}/></button>
          </div>
      </motion.div>
   );
}

function SettingsPanel({ container, activeSubMask, aiModelDownloadStatus, brushSettings, setBrushSettings, updateContainer, updateSubMask, histogram, appSettings, isGeneratingAiMask: _isGeneratingAiMask, setIsMaskControlHovered, collapsibleState, setCollapsibleState, copiedSectionAdjustments, setCopiedSectionAdjustments, onDragStateChange, isSettingsSectionOpen, setSettingsSectionOpen, presets }: any) {
  const { showContextMenu } = useContextMenu();
  const isActive = !!container;
  const presetButtonRef = useRef<HTMLButtonElement>(null);
  
  const placeholderContainer = {
    ...INITIAL_MASK_CONTAINER,
    adjustments: INITIAL_MASK_ADJUSTMENTS
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
        }
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

  const handleToggleSection = (section: string) => setCollapsibleState((prev: any) => ({ ...prev, [section]: !prev[section] }));
  
  const handleToggleVisibility = (sectionName: string) => {
     if (!isActive) return;
     const cur = container.adjustments;
     const vis = cur.sectionVisibility || INITIAL_MASK_ADJUSTMENTS.sectionVisibility;
     updateContainer(container.id, { adjustments: { ...cur, sectionVisibility: { ...vis, [sectionName]: !vis[sectionName] } }});
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

  const sectionVisibility = displayContainer.adjustments.sectionVisibility || INITIAL_MASK_ADJUSTMENTS.sectionVisibility;

  return (
    <div className={`px-4 pb-4 space-y-2 transition-opacity duration-300 ${!isActive ? 'opacity-50 pointer-events-none' : ''}`} onClick={(e) => e.stopPropagation()}>
         <CollapsibleSection 
            title={isComponentMode ? `${formatMaskTypeName(activeSubMask.type)} Properties` : "Mask Properties"} 
            isOpen={isSettingsSectionOpen} 
            onToggle={() => setSettingsSectionOpen(!isSettingsSectionOpen)} 
            canToggleVisibility={false} 
            isContentVisible={true}
         >
             <div className="space-y-4 pt-2">
                 <Switch 
                     checked={!!(isComponentMode ? activeSubMask.invert : displayContainer.invert)} 
                     label={isComponentMode ? "Invert Component" : "Invert Mask"} 
                     onChange={(v) => isComponentMode ? updateSubMask(activeSubMask.id, { invert: v }) : handleMaskPropertyChange('invert', v)} 
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
                    max={100} min={0} 
                    value={(isComponentMode ? activeSubMask.opacity : displayContainer.opacity) ?? 100} 
                    onChange={(e: any) => isComponentMode ? updateSubMask(activeSubMask.id, { opacity: Number(e.target.value) }) : handleMaskPropertyChange('opacity', Number(e.target.value))} 
                    step={1} 
                 />

                 {isComponentMode && (
                    <>
                        {isAiMask && aiModelDownloadStatus && (
                          <div className="p-3 mb-4 bg-card-active rounded-md border border-surface flex items-center gap-3">
                            <Loader2 size={16} className="text-accent animate-spin flex-shrink-0" />
                            <div className="text-xs text-text-secondary leading-relaxed">
                              AI Model Downloading: <span className="text-accent font-medium">{aiModelDownloadStatus}</span>
                            </div>
                          </div>
                        )}
                        {subMaskConfig.parameters?.map((param: any) => (
                           <Slider key={param.key} label={param.label} min={param.min} max={param.max} step={param.step} defaultValue={param.defaultValue}
                              value={(activeSubMask.parameters[param.key] || 0) * (param.multiplier || 1)}
                              onChange={(e: any) => handleSubMaskParameterChange(param.key, parseFloat(e.target.value) / (param.multiplier || 1))}
                           />
                        ))}
                        {subMaskConfig.showBrushTools && brushSettings && <BrushTools settings={brushSettings} onSettingsChange={setBrushSettings} />}
                    </>
                 )}
             </div>
         </CollapsibleSection>

         <div onMouseEnter={() => setIsMaskControlHovered(true)} onMouseLeave={() => setIsMaskControlHovered(false)} className="flex flex-col gap-2">
            {Object.keys(ADJUSTMENT_SECTIONS).map((sectionName) => {
               const SectionComponent: any = { basic: BasicAdjustments, curves: CurveGraph, color: ColorPanel, details: DetailsPanel, effects: EffectsPanel }[sectionName];
               const title = sectionName.charAt(0).toUpperCase() + sectionName.slice(1);
               return (
                  <CollapsibleSection
                     key={sectionName} title={title} isOpen={collapsibleState[sectionName]} isContentVisible={sectionVisibility[sectionName]}
                     onToggle={() => handleToggleSection(sectionName)} onToggleVisibility={() => handleToggleVisibility(sectionName)}
                     onContextMenu={(e: any) => handleSectionContextMenu(e, sectionName)}
                  >
                     <SectionComponent adjustments={displayContainer.adjustments} setAdjustments={setMaskContainerAdjustments} histogram={histogram} isForMask={true} appSettings={appSettings} onDragStateChange={onDragStateChange} />
                  </CollapsibleSection>
               );
            })}
         </div>
    </div>
  );
}
