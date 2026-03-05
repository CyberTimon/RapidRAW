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
  RefreshCw,
  SortAsc,
  Trash2,
  Users,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import AddPresetModal from '../../modals/AddPresetModal';
import RenamePresetModal from '../../modals/RenamePresetModal';
import CreateFolderModal from '../../modals/CreateFolderModal';
import RenameFolderModal from '../../modals/RenameFolderModal';
import Button from '../../ui/Button';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../../../utils/adjustments';
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
  preset: UserPreset | null;
}

interface PresetItemDisplayProps {
  isGeneratingPreviews: boolean;
  preset: any;
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
  return (
    <div className="flex items-center gap-2 p-2 rounded-lg bg-surface cursor-grabbing">
      <div className="w-20 h-14 bg-bg-tertiary rounded-md flex items-center justify-center flex-shrink-0">
        {isGeneratingPreviews && !previewUrl ? (
          <Loader2 size={20} className="animate-spin text-text-secondary" />
        ) : previewUrl ? (
          <img src={previewUrl} alt={`${preset.name} preview`} className="w-full h-full object-cover rounded-md" />
        ) : (
          <Loader2 size={20} className="animate-spin text-text-secondary" />
        )}
      </div>
      <div className="flex-grow min-w-0">
        <p className="font-medium truncate">{preset.name}</p>
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
      <p className="font-normal flex-grow truncate select-none">{folder.name}</p>
      <span className="text-text-secondary text-sm ml-auto pr-1">{folder.children?.length || 0}</span>
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
      <div {...listeners} {...attributes} className="cursor-grab">
        <PresetItemDisplay preset={preset} previewUrl={previewUrl} isGeneratingPreviews={isGeneratingPreviews} />
      </div>
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
        <p className="font-normal flex-grow truncate select-none" onClick={() => onToggle(folder.id)}>
          {folder.name}
        </p>
        <span className="text-text-secondary text-sm ml-auto pr-1">{folder.children?.length || 0}</span>
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
    deleteItem,
    duplicatePreset,
    exportPresetsToFile,
    importPresetsFromFile,
    importLegacyPresetsFromFile,
    isLoading,
    movePreset,
    presets,
    renameItem,
    reorderItems,
    sortAllPresetsAlphabetically,
    updatePreset,
  } = usePresets(adjustments);
  const { showContextMenu } = useContextMenu();
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [isGeneratingPreviews, setIsGeneratingPreviews] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isAddFolderModalOpen, setIsAddFolderModalOpen] = useState(false);
  const [renamePresetState, setRenamePresetState] = useState<ModalState>({ isOpen: false, preset: null });
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

    while (previewQueue.current.length > 0) {
      const { preset, folderId } = previewQueue.current.shift();
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
        setPreviews((prev: Record<string, string | null>) => ({ ...prev, [preset.id]: null }));
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
      try {
        const fullPresetAdjustments: any = { ...INITIAL_ADJUSTMENTS, ...preset.adjustments };
        const imageData: Uint8Array = await invoke(Invokes.GeneratePresetPreview, {
          jsAdjustments: fullPresetAdjustments,
        });
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
        setPreviews((prev: Record<string, string | null>) => ({ ...prev, [preset.id]: null }));
      } finally {
        setIsGeneratingPreviews(false);
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
    console.log(presetsToGenerate);

    if (presetsToGenerate.length > 0) {
      enqueuePreviews(presetsToGenerate);
    }
  }, [selectedImage?.isReady, presets, enqueuePreviews]);

  useEffect(() => {
    if (activePanel === Panel.Presets && selectedImage?.isReady && presets.length > 0) {
      generateRootPreviews();
      expandedFolders.forEach((folderId: string) => {
        generateFolderPreviews(folderId);
      });
    } else if (!selectedImage?.isReady) {
      setPreviews({});
      setFolderPreviewsGenerated(new Set<string>());
      previewQueue.current = [];
    }
  }, [
    activePanel,
    selectedImage?.isReady,
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

  const handleSaveCurrentSettingsAsPreset = async (name: string) => {
    const newPreset = addPreset(name);
    setIsAddModalOpen(false);
    if (newPreset) {
      await generateSinglePreview(newPreset);
    }
  };

  const handleAddFolder = (name: string) => {
    addFolder(name);
    setIsAddFolderModalOpen(false);
  };

  const handleRenamePresetSave = (newName: string) => {
    if (renamePresetState.preset) {
      renameItem(renamePresetState.preset.id ?? null, newName);
    }
    setRenamePresetState({ isOpen: false, preset: null });
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
    console.log('Activetype: ', activeType);

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
        const isLegacy = selectedPath.toLowerCase().endsWith('.xmp') || selectedPath.toLowerCase().endsWith('.lrtemplate');

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
          icon: RefreshCw,
          label: 'Overwrite Preset',

          onClick: async () => {
            const updated = updatePreset(data?.id ?? null);
            if (updated) {
              await generateSinglePreview(updated);
            }
          },
        },
        { type: OPTION_SEPARATOR },
        {
          icon: Edit,
          label: 'Rename Preset',
          onClick: () => setRenamePresetState({ isOpen: true, preset: data ?? null }),
        },
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
        onClick: () => setIsAddModalOpen(true),
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
        <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface">
          <h2 className="text-xl font-bold text-primary text-shadow-shiny">Presets</h2>
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
              onClick={() => setIsAddModalOpen(true)}
              data-tooltip="Save as new preset"
            >
              <Plus size={18} />
            </button>
          </div>
        </div>

        <div
          className={`flex-grow overflow-y-auto p-4 space-y-2 rounded-lg transition-colors ${
            isRootOver ? 'bg-surface-hover' : ''
          }`}
          onContextMenu={handleBackgroundContextMenu}
          ref={setRootNodeRef}
        >
          {isLoading && presets.length === 0 && (
            <div className="text-center text-text-secondary py-2">
              <Loader2 size={16} className="animate-spin inline-block mr-2" /> Loading Presets...
            </div>
          )}
          {!isLoading && presets.length === 0 ? (
            <div className="text-center text-text-secondary py-8 flex flex-col items-center gap-4">
              <p className="max-w-xs">
                No presets saved yet. Create your own, import from a file, or explore community presets.
              </p>
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

        <AddPresetModal
          isOpen={isAddModalOpen}
          onClose={() => setIsAddModalOpen(false)}
          onSave={handleSaveCurrentSettingsAsPreset}
        />
        <CreateFolderModal
          isOpen={isAddFolderModalOpen}
          onClose={() => setIsAddFolderModalOpen(false)}
          onSave={handleAddFolder}
        />
        <RenamePresetModal
          currentName={renamePresetState.preset?.name}
          isOpen={renamePresetState.isOpen}
          onClose={() => setRenamePresetState({ isOpen: false, preset: null })}
          onSave={handleRenamePresetSave}
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
