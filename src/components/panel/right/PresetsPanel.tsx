import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { PresetListType, usePresets, UserPreset } from '../../../hooks/usePresets';
import { useContextMenu } from '../../../context/ContextMenuContext';
import {
  CopyPlus,
  Edit,
  FileDown,
  FileUp,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Loader2,
  Plus,
  SortAsc,
  Trash2,
  Users,
  Layers,
  Crop,
  Save,
  Wrench,
  Palette,
  Settings2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import ConfigurePresetModal from '../../modals/ConfigurePresetModal';
import CreateFolderModal from '../../modals/CreateFolderModal';
import RenameFolderModal from '../../modals/RenameFolderModal';
import Button from '../../ui/Button';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { Adjustments, INITIAL_ADJUSTMENTS, ADJUSTMENT_GROUPS } from '../../../utils/adjustments';
import { Invokes, OPTION_SEPARATOR, Panel, Preset, SelectedImage } from '../../ui/AppProperties';

interface DroppableFolderItemProps {
  children: any;
  folder: any;
  isExpanded: boolean;
  onContextMenu(event: any, folder: any): void;
  onToggle(id: string): void;
}

interface DraggablePresetItemProps {
  isGeneratingPreviews: boolean;
  onApply(preset: any): void;
  onContextMenu(event: any, preset: any): void;
  preset: any;
  previewUrl: string;
}

interface FolderProps {
  folder: any;
}

interface FolderState {
  isOpen: boolean;
  folder: any;
}

interface ModalState {
  isOpen: boolean;
  preset: Preset | null;
}

interface PresetItemDisplayProps {
  isGeneratingPreviews: boolean;
  preset: Preset;
  previewUrl: string;
}

interface PresetsPanelProps {
  activePanel: Panel | null;
  adjustments: Adjustments;
  selectedImage: SelectedImage;
  setAdjustments(adjustments: Partial<Adjustments>): void;
  onNavigateToCommunity(): void;
}

const itemVariants = {
  hidden: { opacity: 0, x: -15 },
  visible: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: {
      duration: 0.25,
      delay: i * 0.05,
    },
  }),
  exit: { opacity: 0, x: -15, transition: { duration: 0.2 } },
};

function PresetItemDisplay({ preset, previewUrl, isGeneratingPreviews }: PresetItemDisplayProps) {
  const geometryKeys = ADJUSTMENT_GROUPS.geometry.flatMap((g) => g.keys);

  const supportsMasks = preset.includeMasks ?? (preset.adjustments?.masks && preset.adjustments.masks.length > 0);
  const supportsGeometry =
    preset.includeCropTransform ?? geometryKeys.some((key) => preset.adjustments?.[key] !== undefined);
  const isTool = preset.presetType === 'tool';
  const tooltipContent = useMemo(() => {
    const features = [];
    if (supportsMasks) features.push('Masks');
    if (supportsGeometry) features.push('Crop & Transform');

    if (features.length === 0) return undefined;
    return `Supports ${features.join(' + ')}`;
  }, [supportsMasks, supportsGeometry]);

  return (
    <div className="flex items-center gap-3 p-2 rounded-lg bg-surface cursor-grabbing">
      <div
        className="w-20 h-14 bg-bg-tertiary rounded-md flex items-center justify-center shrink-0 relative overflow-hidden"
        data-tooltip={tooltipContent}
      >
        {isGeneratingPreviews && !previewUrl ? (
          <Loader2 size={20} className="animate-spin text-text-secondary" />
        ) : previewUrl ? (
          <img
            src={previewUrl}
            alt={`${preset.name} preview`}
            className="w-full h-full object-cover rounded-md pointer-events-none"
          />
        ) : (
          <Loader2 size={20} className="animate-spin text-text-secondary" />
        )}

        {(supportsMasks || supportsGeometry) && (
          <>
            <div className="absolute top-0 right-0 w-1/2 h-1/2 bg-linear-to-bl from-black/30 via-black/0 to-transparent pointer-events-none z-0" />

            <div className="absolute top-1 right-1 bg-primary rounded-full px-1.5 py-0.5 flex items-center gap-1.5 backdrop-blur-xs shadow-xs z-10 pointer-events-none">
              {supportsMasks && <Layers size={11} className="text-white" />}
              {supportsGeometry && <Crop size={11} className="text-white" />}
            </div>
          </>
        )}
      </div>

      <div className="grow min-w-0 flex flex-col justify-center">
        <Text color={TextColors.primary} weight={TextWeights.medium} className="truncate">
          {preset.name}
        </Text>
        <div className="flex items-center gap-1.5 mt-0.5">
          {isTool ? (
            <Wrench size={12} className="text-text-secondary" />
          ) : (
            <Palette size={12} className="text-text-secondary" />
          )}
          <Text
            variant={TextVariants.small}
            color={TextColors.secondary}
            className="text-[10px] uppercase tracking-wider"
          >
            {isTool ? 'Tool' : 'Style'}
          </Text>
        </div>
      </div>
    </div>
  );
}

function FolderItemDisplay({ folder }: FolderProps) {
  return (
    <div className="flex items-center gap-2 p-2 rounded-lg bg-surface cursor-grabbing w-full">
      <div className="p-1">
        <FolderIcon size={18} />
      </div>
      <Text color={TextColors.primary} weight={TextWeights.medium} className="grow truncate select-none">
        {folder.name}
      </Text>
      <Text as="span" weight={TextWeights.medium} className="ml-auto pr-1">
        {folder.children?.length || 0}
      </Text>
    </div>
  );
}

function DraggablePresetItem({
  preset,
  onApply,
  onContextMenu,
  previewUrl,
  isGeneratingPreviews,
}: DraggablePresetItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableNodeRef,
    isDragging,
  } = useDraggable({
    id: preset.id,
    data: { type: PresetListType.Preset, preset },
  });

  const { setNodeRef: setDroppableNodeRef, isOver } = useDroppable({
    data: { type: PresetListType.Preset, preset },
    id: preset.id,
  });

  const setCombinedRef = useCallback(
    (node: any) => {
      setDraggableNodeRef(node);
      setDroppableNodeRef(node);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );

  const style = {
    borderRadius: '10px',
    opacity: isDragging ? 0.4 : 1,
    outline: isOver ? '2px solid var(--color-primary)' : '2px solid transparent',
    outlineOffset: '-2px',
    touchAction: 'none',
  };

  return (
    <div
      onClick={() => onApply(preset)}
      onContextMenu={(e: any) => onContextMenu(e, { preset })}
      ref={setCombinedRef}
      style={style}
    >
      <motion.div
        {...listeners}
        {...attributes}
        className="cursor-grab"
        whileTap={{ scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 400, damping: 17 }}
      >
        <PresetItemDisplay preset={preset} previewUrl={previewUrl} isGeneratingPreviews={isGeneratingPreviews} />
      </motion.div>
    </div>
  );
}

function DroppableFolderItem({ folder, onContextMenu, children, onToggle, isExpanded }: DroppableFolderItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableNodeRef,
    isDragging,
  } = useDraggable({
    data: { type: PresetListType.Folder, folder },
    id: folder.id,
  });

  const { setNodeRef: setDroppableNodeRef, isOver } = useDroppable({
    data: { type: PresetListType.Folder, folder },
    id: folder.id,
  });

  const style = {
    opacity: isDragging ? 0.4 : 1,
    touchAction: 'none',
  };

  const hasChildren = folder.children && folder.children.length > 0;

  return (
    <div
      className={`rounded-lg transition-colors ${isOver ? 'bg-surface-hover' : ''}`}
      ref={setDroppableNodeRef}
      style={style}
    >
      <div
        className="flex items-center gap-2 p-2 rounded-lg bg-surface cursor-pointer"
        onContextMenu={(e: any) => onContextMenu(e, { folder })}
      >
        <div className="p-1 cursor-grab" ref={setDraggableNodeRef} {...listeners} {...attributes}>
          {isExpanded ? (
            <FolderOpen
              className="text-primary"
              onClick={(e: any) => {
                e.stopPropagation();
                onToggle(folder.id);
              }}
              size={18}
            />
          ) : (
            <FolderIcon
              className="text-text-secondary"
              onClick={(e: any) => {
                e.stopPropagation();
                onToggle(folder.id);
              }}
              size={18}
            />
          )}
        </div>
        <Text
          color={TextColors.primary}
          weight={TextWeights.medium}
          className="grow truncate select-none"
          onClick={() => onToggle(folder.id)}
        >
          {folder.name}
        </Text>
        <Text as="span" variant={TextVariants.small} color={TextColors.secondary} className="ml-auto pr-1">
          {folder.children?.length || 0}
        </Text>
      </div>
      <AnimatePresence>
        {isExpanded && hasChildren && (
          <motion.div
            animate={{ height: 'auto', opacity: 1 }}
            className="pl-6 space-y-2 overflow-hidden pt-2"
            exit={{ height: 0, opacity: 0 }}
            initial={{ height: 0, opacity: 0 }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function PresetsPanel({
  activePanel,
  adjustments,
  selectedImage,
  setAdjustments,
  onNavigateToCommunity,
}: PresetsPanelProps) {
  const {
    addFolder,
    addPreset,
    configurePreset,
    deleteItem,
    duplicatePreset,
    exportPresetsToFile,
    importPresetsFromFile,
    importLegacyPresetsFromFile,
    isLoading,
    movePreset,
    overwritePreset,
    presets,
    renameItem,
    reorderItems,
    sortAllPresetsAlphabetically,
  } = usePresets(adjustments);
  const { showContextMenu } = useContextMenu();
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [isGeneratingPreviews, setIsGeneratingPreviews] = useState(false);
  const [configureModalState, setConfigureModalState] = useState<ModalState>({ isOpen: false, preset: null });
  const [isAddFolderModalOpen, setIsAddFolderModalOpen] = useState(false);
  const [renameFolderState, setRenameFolderState] = useState<FolderState>({ isOpen: false, folder: null });
  const [expandedFolders, setExpandedFolders] = useState(new Set<string>());
  const [activeItem, setActiveItem] = useState<any>(null);
  const [folderPreviewsGenerated, setFolderPreviewsGenerated] = useState<Set<string>>(new Set());
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  const expandedFoldersRef = useRef(expandedFolders);
  expandedFoldersRef.current = expandedFolders;
  const previewQueue = useRef<Array<any>>([]);
  const isProcessingQueue = useRef(false);
  const currentImagePathRef = useRef<string | null>(selectedImage?.path || null);

  useEffect(() => {
    const allPresetIds = new Set();
    presets.forEach((item: UserPreset) => {
      if (item.preset) {
        allPresetIds.add(item.preset.id);
      } else if (item.folder) {
        item.folder.children.forEach((p: Preset) => allPresetIds.add(p.id));
      }
    });

    const currentPreviews = previewsRef.current;
    const previewsToDelete = Object.keys(currentPreviews).filter((id) => !allPresetIds.has(id));

    if (previewsToDelete.length > 0) {
      setPreviews((prev) => {
        const newPreviews = { ...prev };
        previewsToDelete.forEach((id) => {
          const url = newPreviews[id];
          if (url && url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
          }
          delete newPreviews[id];
        });
        return newPreviews;
      });
    }
  }, [presets]);

  useEffect(() => {
    return () => {
      Object.values(previewsRef.current).forEach((url) => {
        if (url && url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      });
      previewQueue.current = [];
      isProcessingQueue.current = false;
    };
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 10,
      },
    }),
  );

  const { setNodeRef: setRootNodeRef, isOver: isRootOver } = useDroppable({ id: 'root' });

  const allItemsMap = useMemo(() => {
    const map = new Map();
    presets.forEach((item: any) => {
      if (item.preset) {
        map.set(item.preset.id, { type: PresetListType.Preset, data: item.preset });
      } else if (item.folder) {
        map.set(item.folder.id, { type: PresetListType.Folder, data: item.folder });
        item.folder.children.forEach((p: any) => map.set(p.id, { type: PresetListType.Preset, data: p }));
      }
    });
    return map;
  }, [presets]);

  const itemParentMap = useMemo(() => {
    const map = new Map();
    presets.forEach((item: UserPreset) => {
      if (item.preset) {
        map.set(item.preset.id, null);
      } else if (item.folder) {
        map.set(item.folder.id, null);
        item.folder.children.forEach((p: UserPreset) => {
          if (!item?.folder) {
            return;
          }
          map.set(p.id, item.folder.id);
        });
      }
    });
    return map;
  }, [presets]);

  const processPreviewQueue = useCallback(async () => {
    if (isProcessingQueue.current || previewQueue.current.length === 0) {
      return;
    }

    isProcessingQueue.current = true;
    setIsGeneratingPreviews(true);

    const pathAtStart = currentImagePathRef.current;

    while (previewQueue.current.length > 0) {
      if (pathAtStart !== currentImagePathRef.current) {
        previewQueue.current = [];
        break;
      }

      const item = previewQueue.current.shift();
      if (!item) break;
      const { preset, folderId } = item;

      if (folderId && !expandedFoldersRef.current.has(folderId)) {
        continue;
      }

      if (previewsRef.current[preset.id]) {
        continue;
      }

      try {
        const fullPresetAdjustments = { ...INITIAL_ADJUSTMENTS, ...preset.adjustments };
        const imageData: Uint8Array = await invoke(Invokes.GeneratePresetPreview, {
          jsAdjustments: fullPresetAdjustments,
        });

        if (pathAtStart !== currentImagePathRef.current) {
          previewQueue.current = [];
          break;
        }

        const blob = new Blob([imageData], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        setPreviews((prev: Record<string, string | null>) => {
          const oldUrl = prev[preset.id];
          if (oldUrl && oldUrl.startsWith('blob:')) {
            URL.revokeObjectURL(oldUrl);
          }
          return { ...prev, [preset.id]: url };
        });
      } catch (error) {
        console.error(`Failed to generate preview for preset ${preset.name}:`, error);
        if (pathAtStart === currentImagePathRef.current) {
          setPreviews((prev: Record<string, string | null>) => ({ ...prev, [preset.id]: null }));
        }
      }
    }

    isProcessingQueue.current = false;
    setIsGeneratingPreviews(false);
  }, []);

  const enqueuePreviews = useCallback(
    (presetsToGenerate: Array<UserPreset>, folderId: string | null = null) => {
      const newItems = presetsToGenerate
        .filter((p: any) => !previewsRef.current[p?.id])
        .map((p: UserPreset) => ({ preset: p, folderId }));
      if (newItems.length > 0) {
        previewQueue.current.push(...newItems);
        processPreviewQueue();
      }
    },
    [processPreviewQueue],
  );

  const toggleFolder = (folderId: string) => {
    setExpandedFolders((prev: Set<string>) => {
      const newSet = new Set(prev);
      if (newSet.has(folderId)) {
        newSet.delete(folderId);
      } else {
        newSet.add(folderId);
        if (!folderPreviewsGenerated.has(folderId)) {
          generateFolderPreviews(folderId);
        }
      }
      return newSet;
    });
  };

  const generateSinglePreview = useCallback(
    async (preset: Preset) => {
      if (!selectedImage?.isReady || !preset) {
        return;
      }

      setIsGeneratingPreviews(true);
      const pathAtStart = currentImagePathRef.current;

      try {
        const fullPresetAdjustments: any = { ...INITIAL_ADJUSTMENTS, ...preset.adjustments };
        const imageData: Uint8Array = await invoke(Invokes.GeneratePresetPreview, {
          jsAdjustments: fullPresetAdjustments,
        });

        if (pathAtStart !== currentImagePathRef.current) return;

        const blob = new Blob([imageData], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);

        setPreviews((prev: Record<string, string | null>) => {
          const oldUrl = prev[preset.id];
          if (oldUrl && oldUrl.startsWith('blob:')) {
            URL.revokeObjectURL(oldUrl);
          }
          return { ...prev, [preset.id]: url };
        });
      } catch (error) {
        console.error(`Failed to generate preview for preset ${preset.name}:`, error);
        if (pathAtStart === currentImagePathRef.current) {
          setPreviews((prev: Record<string, string | null>) => ({ ...prev, [preset.id]: null }));
        }
      } finally {
        if (pathAtStart === currentImagePathRef.current) {
          setIsGeneratingPreviews(false);
        }
      }
    },
    [selectedImage?.isReady],
  );

  const generateFolderPreviews = useCallback(
    async (folderId: string) => {
      if (!selectedImage?.isReady) {
        return;
      }

      const folder = presets.find((item: any) => item.folder && item.folder.id === folderId);
      if (!folder?.folder?.children?.length) {
        return;
      }

      const presetsToGenerate = folder.folder.children.filter((p: any) => !previewsRef.current[p.id]);
      if (presetsToGenerate.length > 0) {
        enqueuePreviews(presetsToGenerate, folderId);
      }
      setFolderPreviewsGenerated((prev: Set<string>) => new Set(prev).add(folderId));
    },
    [selectedImage?.isReady, presets, enqueuePreviews],
  );

  const generateRootPreviews = useCallback(async () => {
    if (!selectedImage?.isReady) {
      return;
    }

    const rootPresets = presets.filter((item: UserPreset) => item.preset).map((item) => item.preset);
    const presetsToGenerate: any = rootPresets.filter((p: any) => !previewsRef.current[p.id]);

    if (presetsToGenerate.length > 0) {
      enqueuePreviews(presetsToGenerate);
    }
  }, [selectedImage?.isReady, presets, enqueuePreviews]);

  useEffect(() => {
    const isPathChanged = selectedImage?.path !== currentImagePathRef.current;

    if (isPathChanged || !selectedImage?.isReady) {
      Object.values(previewsRef.current).forEach((url) => {
        if (url && url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      });

      previewsRef.current = {};
      previewQueue.current = [];

      setPreviews({});
      setFolderPreviewsGenerated(new Set<string>());

      if (isPathChanged && selectedImage?.path) {
        currentImagePathRef.current = selectedImage.path;
      }
    }

    if (activePanel === Panel.Presets && selectedImage?.isReady && presets.length > 0) {
      generateRootPreviews();
      expandedFolders.forEach((folderId: string) => {
        generateFolderPreviews(folderId);
      });
    }
  }, [
    activePanel,
    selectedImage?.isReady,
    selectedImage?.path,
    presets.length,
    generateRootPreviews,
    generateFolderPreviews,
    expandedFolders,
  ]);

  const handleApplyPreset = (preset: Preset) => {
    setAdjustments((prevAdjustments: Adjustments) => ({
      ...prevAdjustments,
      ...preset.adjustments,
    }));
  };

  const handleSaveConfiguredPreset = async (
    name: string,
    includeMasks: boolean,
    includeCropTransform: boolean,
    presetType: 'tool' | 'style',
  ) => {
    if (configureModalState.preset) {
      const updated = configurePreset(
        configureModalState.preset.id,
        name,
        includeMasks,
        includeCropTransform,
        presetType,
      );
      if (updated) {
        await generateSinglePreview(updated);
      }
    } else {
      const newPreset = addPreset(name, null, includeMasks, includeCropTransform, presetType);
      if (newPreset) {
        await generateSinglePreview(newPreset);
      }
    }
    setConfigureModalState({ isOpen: false, preset: null });
  };

  const handleAddFolder = (name: string) => {
    addFolder(name);
    setIsAddFolderModalOpen(false);
  };

  const handleRenameFolderSave = (newName: string) => {
    if (renameFolderState.folder) {
      renameItem(renameFolderState.folder.id, newName);
    }
    setRenameFolderState({ isOpen: false, folder: null });
  };

  const handleDeleteItem = (id: string | null, isFolder = false) => {
    setDeletingItemId(id);
    if (!id) {
      return;
    }

    setTimeout(() => {
      deleteItem(id);
      if (isFolder) {
        setExpandedFolders((prev: Set<string>) => {
          const newSet = new Set(prev);
          newSet.delete(id);
          return newSet;
        });
        setFolderPreviewsGenerated((prev: Set<string>) => {
          const newSet = new Set(prev);
          newSet.delete(id);
          return newSet;
        });
      }
    }, 300);
  };

  const handleDragStart = (event: any) => {
    setActiveItem(allItemsMap.get(event.active.id) ?? null);
  };

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    setActiveItem(null);

    const activeId = active.id;
    const activeParentId = itemParentMap.get(activeId);
    const activeType = active.data.current?.type;

    if (!over) {
      if (activeParentId !== null) {
        movePreset(activeId, null, null);
      }
      return;
    }

    if (active.id === over.id) {
      return;
    }

    const overId = over.id;
    const overParentId = itemParentMap.get(overId);
    const overType = over.data.current?.type;

    const targetFolderId = overType === PresetListType.Folder ? overId : overParentId;

    if (activeType === PresetListType.Preset && targetFolderId) {
      if (activeParentId !== targetFolderId) {
        movePreset(activeId, targetFolderId);
        setExpandedFolders((prev: Set<string>) => new Set(prev).add(targetFolderId));
        if (!folderPreviewsGenerated.has(targetFolderId)) {
          generateFolderPreviews(targetFolderId);
        }
      } else {
        reorderItems(activeId, overId);
      }
      return;
    }

    if (activeParentId !== null && !targetFolderId) {
      movePreset(activeId, null, overId);
      return;
    }

    if (activeParentId === null && !targetFolderId) {
      reorderItems(activeId, overId);
      return;
    }
  };

  const handleImportPresets = async () => {
    try {
      const selectedPath = await openDialog({
        filters: [
          { name: 'All Preset Files', extensions: ['rrpreset', 'xmp', 'lrtemplate'] },
          { name: 'RapidRAW Preset', extensions: ['rrpreset'] },
          { name: 'Legacy Preset', extensions: ['xmp', 'lrtemplate'] },
        ],
        multiple: false,
        title: 'Import Presets',
      });

      if (typeof selectedPath === 'string') {
        const isLegacy =
          selectedPath.toLowerCase().endsWith('.xmp') || selectedPath.toLowerCase().endsWith('.lrtemplate');

        if (isLegacy) {
          await importLegacyPresetsFromFile(selectedPath);
        } else {
          await importPresetsFromFile(selectedPath);
        }

        setFolderPreviewsGenerated(new Set<string>());
        setPreviews({});
      }
    } catch (error) {
      console.error('Failed to import presets:', error);
    }
  };

  const handleExport = async (item: UserPreset) => {
    const isFolder = !!item.folder;
    const name = isFolder ? item.folder?.name : item.preset?.name;
    const itemsToExport = [item];

    try {
      const filePath = await saveDialog({
        defaultPath: `${name}.rrpreset`.replace(/[<>:"/\\|?*]/g, '_'),
        filters: [{ name: 'Preset File', extensions: ['rrpreset'] }],
        title: `Export ${isFolder ? 'Folder' : 'Preset'}`,
      });

      if (filePath) {
        await exportPresetsToFile(itemsToExport, filePath);
      }
    } catch (error) {
      console.error(`Failed to export ${isFolder ? PresetListType.Folder : PresetListType.Preset}:`, error);
    }
  };

  const handleExportAllPresets = async () => {
    if (presets.length === 0) {
      return;
    }
    try {
      const filePath = await saveDialog({
        defaultPath: 'all_presets.rrpreset',
        filters: [{ name: 'Preset File', extensions: ['rrpreset'] }],
        title: 'Export All Presets',
      });

      if (filePath) {
        await exportPresetsToFile(presets, filePath);
      }
    } catch (error) {
      console.error('Failed to export all presets:', error);
    }
  };

  const handleContextMenu = (event: any, item: UserPreset) => {
    event.preventDefault();
    event.stopPropagation();

    const isFolder = !!item.folder;
    const data = isFolder ? item.folder : item.preset;

    let options = [];
    if (isFolder) {
      options = [
        {
          icon: Edit,
          label: 'Rename Folder',
          onClick: () => setRenameFolderState({ isOpen: true, folder: data }),
        },
        {
          icon: FileDown,
          label: 'Export Folder',
          onClick: () => handleExport(item),
        },
        { type: OPTION_SEPARATOR },
        {
          icon: Trash2,
          isDestructive: true,
          label: 'Delete Folder',
          onClick: () => handleDeleteItem(data?.id ?? null, true),
        },
      ];
    } else {
      options = [
        {
          icon: Save,
          label: 'Overwrite',
          onClick: async () => {
            const updated = overwritePreset(data?.id ?? null);
            if (updated) {
              await generateSinglePreview(updated);
            }
          },
        },
        {
          icon: Settings2,
          label: 'Configure Preset',
          onClick: () => setConfigureModalState({ isOpen: true, preset: data as Preset }),
        },
        { type: OPTION_SEPARATOR },
        {
          icon: CopyPlus,
          label: 'Duplicate Preset',
          onClick: async () => {
            const duplicated = duplicatePreset(data?.id ?? null);
            if (duplicated) {
              await generateSinglePreview(duplicated);
            }
          },
        },
        {
          icon: FileDown,
          label: 'Export Preset',
          onClick: () => handleExport(item),
        },
        { type: OPTION_SEPARATOR },
        {
          icon: Trash2,
          isDestructive: true,
          label: 'Delete Preset',
          onClick: () => handleDeleteItem(data?.id ?? null, false),
        },
      ];
    }

    showContextMenu(event.clientX, event.clientY, options);
  };

  const handleBackgroundContextMenu = (event: any) => {
    if (!event.currentTarget.contains(event.target)) {
      return;
    }
    event.preventDefault();
    const options = [
      {
        icon: Plus,
        label: 'New Preset',
        onClick: () => setConfigureModalState({ isOpen: true, preset: null }),
      },
      {
        icon: FolderPlus,
        label: 'New Folder',
        onClick: () => setIsAddFolderModalOpen(true),
      },
      { type: OPTION_SEPARATOR },
      {
        disabled: presets.length === 0,
        icon: SortAsc,
        label: 'Sort All Alphabetically',
        onClick: sortAllPresetsAlphabetically,
      },
    ];
    showContextMenu(event.clientX, event.clientY, options);
  };

  const folders = useMemo(() => presets.filter((item: UserPreset) => item.folder), [presets]);
  const rootPresets = useMemo(() => presets.filter((item: UserPreset) => item.preset), [presets]);

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex flex-col h-full">
        <div className="p-4 flex justify-between items-center shrink-0 border-b border-surface">
          <Text variant={TextVariants.title}>Presets</Text>
          <div className="flex items-center gap-1">
            <button
              className="p-2 rounded-full hover:bg-surface transition-colors"
              onClick={onNavigateToCommunity}
              data-tooltip="Explore Community Presets"
            >
              <Users size={18} />
            </button>
            <button
              className="p-2 rounded-full hover:bg-surface transition-colors"
              disabled={isLoading}
              onClick={handleImportPresets}
              data-tooltip="Import presets from .rrpreset file"
            >
              <FileUp size={18} />
            </button>
            <button
              className="p-2 rounded-full hover:bg-surface transition-colors"
              disabled={presets.length === 0 || isLoading}
              onClick={handleExportAllPresets}
              data-tooltip="Export all presets to .rrpreset file"
            >
              <FileDown size={18} />
            </button>
            <button
              className="p-2 rounded-full hover:bg-surface transition-colors"
              disabled={isLoading}
              onClick={() => setConfigureModalState({ isOpen: true, preset: null })}
              data-tooltip="Save as new preset"
            >
              <Plus size={18} />
            </button>
          </div>
        </div>

        <div
          className={`grow overflow-y-auto p-4 space-y-2 rounded-lg transition-colors ${
            isRootOver ? 'bg-surface-hover' : ''
          }`}
          onContextMenu={handleBackgroundContextMenu}
          ref={setRootNodeRef}
        >
          {isLoading && presets.length === 0 && (
            <Text
              as="div"
              variant={TextVariants.heading}
              color={TextColors.secondary}
              weight={TextWeights.normal}
              className="text-center mt-4"
            >
              <Loader2 size={14} className="animate-spin inline-block mr-2" /> Loading Presets...
            </Text>
          )}
          {!isLoading && presets.length === 0 ? (
            <div className="text-center text-text-secondary flex flex-col items-center gap-4 pt-4">
              <Text className="max-w-xs">
                No presets saved yet. Create your own, import from a file, or explore community presets.
              </Text>
              <Button variant="secondary" onClick={onNavigateToCommunity}>
                <Users size={16} className="mr-2" />
                Get Community Presets
              </Button>
            </div>
          ) : (
            <>
              <AnimatePresence>
                {folders
                  .filter((item: UserPreset) => item.folder?.id !== deletingItemId)
                  .map((item: UserPreset, index: number) => (
                    <motion.div
                      animate="visible"
                      custom={index}
                      exit="exit"
                      initial="hidden"
                      key={item.folder?.id}
                      layout="position"
                      variants={itemVariants}
                    >
                      <DroppableFolderItem
                        folder={item.folder}
                        isExpanded={item.folder?.id ? expandedFolders.has(item.folder?.id) : false}
                        onContextMenu={(e: any) => handleContextMenu(e, item)}
                        onToggle={toggleFolder}
                      >
                        <AnimatePresence>
                          {item.folder?.children
                            .filter((preset: Preset) => preset.id !== deletingItemId)
                            .map((preset: Preset) => (
                              <motion.div
                                exit={{ opacity: 0, x: -15, transition: { duration: 0.2 } }}
                                key={preset.id}
                                layout="position"
                              >
                                <DraggablePresetItem
                                  isGeneratingPreviews={isGeneratingPreviews}
                                  onApply={handleApplyPreset}
                                  onContextMenu={(e: any) => handleContextMenu(e, { preset })}
                                  preset={preset}
                                  previewUrl={previews[preset.id] || ''}
                                />
                              </motion.div>
                            ))}
                        </AnimatePresence>
                      </DroppableFolderItem>
                    </motion.div>
                  ))}
              </AnimatePresence>
              <AnimatePresence>
                {rootPresets
                  .filter((item: UserPreset) => item.preset?.id !== deletingItemId)
                  .map((item: UserPreset, index: number) => (
                    <motion.div
                      animate="visible"
                      custom={folders.length + index}
                      exit="exit"
                      initial="hidden"
                      key={item.preset?.id}
                      layout="position"
                      variants={itemVariants}
                    >
                      <DraggablePresetItem
                        isGeneratingPreviews={isGeneratingPreviews}
                        onApply={handleApplyPreset}
                        onContextMenu={(e: any) => handleContextMenu(e, item)}
                        preset={item.preset}
                        previewUrl={(item.preset?.id ? previews[item.preset.id] : '') || ''}
                      />
                    </motion.div>
                  ))}
              </AnimatePresence>
            </>
          )}
        </div>

        <ConfigurePresetModal
          isOpen={configureModalState.isOpen}
          initialPreset={configureModalState.preset}
          onClose={() => setConfigureModalState({ isOpen: false, preset: null })}
          onSave={handleSaveConfiguredPreset}
        />
        <CreateFolderModal
          isOpen={isAddFolderModalOpen}
          onClose={() => setIsAddFolderModalOpen(false)}
          onSave={handleAddFolder}
        />
        <RenameFolderModal
          currentName={renameFolderState.folder?.name}
          isOpen={renameFolderState.isOpen}
          onClose={() => setRenameFolderState({ isOpen: false, folder: null })}
          onSave={handleRenameFolderSave}
        />
      </div>
      <DragOverlay>
        {activeItem ? (
          activeItem.type === 'preset' ? (
            <PresetItemDisplay
              isGeneratingPreviews={false}
              preset={activeItem.data}
              previewUrl={previews[activeItem.data.id] || ''}
            />
          ) : (
            <FolderItemDisplay folder={activeItem.data} />
          )
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
