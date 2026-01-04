import { useState, useRef, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Edit, Eye, EyeOff, FileEdit, Loader2, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import AIControls, { SUB_MASK_CONFIG } from './AIControls';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { Mask, AI_PANEL_CREATION_TYPES, MaskType, SubMask } from './Masks';
import { Adjustments, AiPatch, MaskContainer } from '../../../utils/adjustments';
import { BrushSettings, SelectedImage } from '../../ui/AppProperties';
import { createSubMask } from '../../../utils/maskUtils';

interface AiPanelProps {
  adjustments: Adjustments;
  activePatchContainerId: string | null;
  activeSubMaskId: string | null;
  aiModelDownloadStatus: string | null;
  brushSettings: BrushSettings | null;
  isComfyUiConnected: boolean;
  isGeneratingAi: boolean;
  isGeneratingAiMask: boolean;
  onDeletePatch(id: string): void;
  onGenerateAiForegroundMask(id: string): void;
  onGenerativeReplace(patchId: string, prompt: any, useFastInpaint: boolean): void;
  onSelectPatchContainer(id: string | null): void;
  onSelectSubMask(id: string | null): void;
  onTogglePatchVisibility(id: string): void;
  selectedImage: SelectedImage;
  setAdjustments(adjustments: Partial<Adjustments>): void;
  setBrushSettings(brushSettings: BrushSettings | null): void;
  setCustomEscapeHandler(handler: any): void;
}

interface ConnectionStatusProps {
  isConnected: boolean;
}

const itemVariants = {
  hidden: { opacity: 0, x: -15 },
  visible: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: { duration: 0.25, delay: i * 0.05 },
  }),
  exit: { opacity: 0, x: -15, transition: { duration: 0.2 } },
};

const ConnectionStatus = ({ isConnected }: ConnectionStatusProps) => {
  const [isHovered, setIsHovered] = useState(false);
  if (isConnected) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-surface rounded-lg mb-4">
        <div className={'w-2.5 h-2.5 rounded-full bg-green-500'} />
        <span className="text-sm font-medium text-text-secondary">ComfyUI Backend:</span>
        <span className={'text-sm font-bold text-green-400'}>Connected</span>
      </div>
    );
  }

  return (
    <div
      className="bg-surface rounded-lg mb-4"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="flex items-center gap-2 px-4 pt-2">
        <div className={'w-2.5 h-2.5 rounded-full bg-red-500'} />
        <span className="text-sm font-medium text-text-secondary">ComfyUI Backend:</span>
        <span className={'text-sm font-bold text-red-400'}>Not Detected</span>
      </div>
      <div className="px-4 pb-2">
        <motion.div
          animate={{
            height: isHovered ? 'auto' : 0,
            opacity: isHovered ? 1 : 0,
            marginTop: isHovered ? '2px' : 0,
          }}
          className="overflow-hidden"
          initial={{ height: 0, opacity: 0, marginTop: 0 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
        >
          <p className="text-xs text-text-secondary">
            Only simple inpainting is available. Connect to the backend for generative AI features.
          </p>
        </motion.div>
      </div>
    </div>
  );
};

export default function AIPanel({
  adjustments,
  setAdjustments,
  selectedImage,
  isComfyUiConnected,
  isGeneratingAi,
  onGenerativeReplace,
  onDeletePatch,
  onTogglePatchVisibility,
  activePatchContainerId,
  onSelectPatchContainer,
  activeSubMaskId,
  onSelectSubMask,
  brushSettings,
  setBrushSettings,
  isGeneratingAiMask,
  aiModelDownloadStatus,
  onGenerateAiForegroundMask,
  setCustomEscapeHandler,
}: AiPanelProps) {
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
  const [renamingContainerId, setRenamingContainerId] = useState<string | null>(null);
  const [tempName, setTempName] = useState('');
  const { showContextMenu } = useContextMenu();
  const isInitialRender = useRef(true);
  const [styleShiftPrompt, setStyleShiftPrompt] = useState('');

  const handleResetAllAiEdits = () => {
    if (isGeneratingAi) {
      return;
    }
    onSelectPatchContainer(null);
    onSelectSubMask(null);
    setAdjustments((prev: Adjustments) => ({ ...prev, aiPatches: [] }));
  };

  const handleBackToList = useCallback(() => {
    onSelectPatchContainer(null);
    onSelectSubMask(null);
  }, [onSelectPatchContainer, onSelectSubMask]);

  const updatePatch = (patchId: string, updatedData: any) => {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aiPatches: (prev.aiPatches || []).map((p: AiPatch) => (p.id === patchId ? { ...p, ...updatedData } : p)),
    }));
  };

  const updateSubMask = (subMaskId: string, updatedData: any) => {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aiPatches: prev.aiPatches.map((p: AiPatch) => ({
        ...p,
        subMasks: p.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
      })),
    }));
  };

  const handleFinishRename = () => {
    if (renamingContainerId && tempName.trim()) {
      updatePatch(renamingContainerId, { name: tempName.trim() });
    }
    setRenamingContainerId(null);
    setTempName('');
  };

  useEffect(() => {
    const escapeHandler = () => {
      if (renamingContainerId) {
        handleFinishRename();
      } else if (activePatchContainerId) {
        handleBackToList();
      }
    };

    if (activePatchContainerId) {
      setCustomEscapeHandler(() => escapeHandler);
    } else {
      setCustomEscapeHandler(null);
    }

    return () => setCustomEscapeHandler(null);
  }, [activePatchContainerId, renamingContainerId, handleBackToList]);

  useEffect(() => {
    isInitialRender.current = false;
  }, []);

  const handleAddAiPatchContainer = (type: Mask) => {
    const subMask = createSubMask(type, selectedImage);

    const config = SUB_MASK_CONFIG[type];
    if (config && config.parameters) {
      config.parameters.forEach((param: any) => {
        if (param.defaultValue !== undefined) {
          subMask.parameters[param.key] = param.defaultValue / (param.multiplier || 1);
        }
      });
    }

    if (adjustments?.crop && subMask.parameters && (type === Mask.Linear || type === Mask.Radial)) {
      const { x, y, width, height } = adjustments.crop;
      const { width: imgW, height: imgH } = selectedImage;

      if (imgW && imgH && (width !== imgW || height !== imgH)) {
        const ratioX = width / imgW;
        const ratioY = height / imgH;
        const cx = x + width / 2;
        const cy = y + height / 2;
        const ox = imgW / 2;
        const oy = imgH / 2;

        const p = { ...subMask.parameters };

        if (type === Mask.Linear) {
          if (typeof p.startX === 'number') p.startX = cx + (p.startX - ox) * ratioX;
          if (typeof p.endX === 'number') p.endX = cx + (p.endX - ox) * ratioX;
          if (typeof p.startY === 'number') p.startY = cy + (p.startY - oy) * ratioY;
          if (typeof p.endY === 'number') p.endY = cy + (p.endY - oy) * ratioY;
        } else if (type === Mask.Radial) {
          if (typeof p.centerX === 'number') p.centerX = cx + (p.centerX - ox) * ratioX;
          if (typeof p.centerY === 'number') p.centerY = cy + (p.centerY - oy) * ratioY;
          if (typeof p.radiusX === 'number') p.radiusX *= ratioX;
          if (typeof p.radiusY === 'number') p.radiusY *= ratioY;
        }
        subMask.parameters = p;
      }
    }

    let name: string;
    if (type === Mask.QuickEraser) {
      const count =
        (adjustments.aiPatches || []).filter((p: AiPatch) =>
          p.subMasks.some((sm: SubMask) => sm.type === Mask.QuickEraser),
        ).length + 1;
      name = `Quick Erase ${count}`;
    } else {
      name = `AI Edit ${adjustments.aiPatches.length + 1}`;
    }

    const newContainer = {
      id: uuidv4(),
      invert: false,
      isLoading: false,
      name: name,
      patchData: null,
      prompt: '',
      subMasks: [subMask],
      visible: true,
    };
    setAdjustments((prev: Adjustments) => ({ ...prev, aiPatches: [...(prev.aiPatches || []), newContainer] }));
    onSelectPatchContainer(newContainer.id);
    onSelectSubMask(subMask.id);
    if (type === Mask.AiForeground) {
      onGenerateAiForegroundMask(subMask.id);
    }
  };

  const handleDeleteContainer = (id: string) => {
    setDeletingItemId(id);
    setTimeout(() => {
      if (activePatchContainerId === id) {
        onSelectPatchContainer(null);
      }
      const container = adjustments.aiPatches.find((c: AiPatch) => c.id === id);
      if (container && container.subMasks.some((sm: SubMask) => sm.id === activeSubMaskId)) {
        onSelectSubMask(null);
      }
      onDeletePatch(id);
      setDeletingItemId(null);
    }, 200);
  };

  const handleToggleContainerVisibility = (id: string) => {
    onTogglePatchVisibility(id);
  };

  const handleOpenContainerForEditing = (container: AiPatch) => {
    onSelectPatchContainer(container.id);
    const lastSubMaskId = container.subMasks.length > 0 ? container.subMasks[container.subMasks.length - 1].id : null;
    onSelectSubMask(lastSubMaskId);
  };

  const handleDeselect = () => onSelectSubMask(null);

  const handleStartRename = (container: AiPatch | MaskContainer) => {
    setRenamingContainerId(container.id);
    setTempName(container.name);
  };

  const handleRenameKeyDown = (e: any) => {
    if (e.key === 'Enter') {
      handleFinishRename();
    } else if (e.key === 'Escape') {
      setRenamingContainerId(null);
      setTempName('');
    }
  };

  const handleContainerContextMenu = (event: any, container: any) => {
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(event.clientX, event.clientY, [
      { label: 'Edit AI Selection', icon: Edit, onClick: () => handleOpenContainerForEditing(container) },
      { label: 'Rename', icon: FileEdit, onClick: () => handleStartRename(container) },
      { type: 'separator' },
      { label: 'Delete', icon: Trash2, isDestructive: true, onClick: () => handleDeleteContainer(container.id) },
    ]);
  };

  const editingPatch = adjustments.aiPatches?.find((p: AiPatch) => p.id === activePatchContainerId);

  if (editingPatch) {
    const activeSubMask = editingPatch.subMasks?.find((sm: SubMask) => sm.id === activeSubMaskId) ?? null;
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface h-[69px]">
          <button
            className="p-2 rounded-full hover:bg-surface transition-colors flex-shrink-0"
            onClick={handleBackToList}
            title="Back to AI Edit List"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-grow min-w-0 text-center px-2">
            {renamingContainerId === editingPatch.id ? (
              <input
                autoFocus
                className="bg-transparent w-full text-xl font-bold text-primary text-shadow-shiny focus:outline-none focus:ring-1 focus:ring-accent rounded px-1 py-1 text-center"
                onBlur={handleFinishRename}
                onChange={(e: any) => setTempName(e.target.value)}
                onClick={(e: any) => e.stopPropagation()}
                onKeyDown={handleRenameKeyDown}
                type="text"
                value={tempName}
              />
            ) : (
              <h2
                className="text-xl font-bold text-primary text-shadow-shiny truncate cursor-pointer px-4 py-4"
                onClick={() => handleStartRename(editingPatch)}
                title="Click to rename"
              >
                {editingPatch.name}
              </h2>
            )}
          </div>
          <button
            className="p-2 rounded-full hover:bg-surface transition-colors flex-shrink-0"
            onClick={() => updatePatch(editingPatch.id, { subMasks: [] })}
            title="Reset Selection"
          >
            <RotateCcw size={18} />
          </button>
        </div>
        <div className="flex-grow overflow-y-auto">
          <AIControls
            activeSubMask={activeSubMask}
            activeSubMaskId={activeSubMaskId}
            adjustments={adjustments}
            aiModelDownloadStatus={aiModelDownloadStatus}
            brushSettings={brushSettings}
            editingPatch={editingPatch}
            isComfyUiConnected={isComfyUiConnected}
            isGeneratingAi={isGeneratingAi || editingPatch.isLoading}
            isGeneratingAiMask={isGeneratingAiMask}
            onGenerateAiForegroundMask={onGenerateAiForegroundMask}
            onGenerativeReplace={onGenerativeReplace}
            onSelectSubMask={onSelectSubMask}
            selectedImage={selectedImage}
            setAdjustments={setAdjustments}
            setBrushSettings={setBrushSettings}
            updatePatch={updatePatch}
            updateSubMask={updateSubMask}
          />
        </div>
      </div>
    );
  }

  const aiPatches = adjustments?.aiPatches || [];
  const hasAiEdits = aiPatches.length > 0;

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex justify-between items-center flex-shrink-0 border-b border-surface h-[69px]">
        <h2 className="text-xl font-bold text-primary text-shadow-shiny">AI Tools</h2>
        <button
          className="p-2 rounded-full hover:bg-surface transition-colors"
          disabled={!hasAiEdits || isGeneratingAi}
          onClick={handleResetAllAiEdits}
          title="Reset All AI Edits"
        >
          <RotateCcw size={18} />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto p-4 text-text-secondary space-y-6" onClick={handleDeselect}>
        {!selectedImage ? (
          <p className="text-center text-text-tertiary mt-4">No image selected.</p>
        ) : (
          <>
            <ConnectionStatus isConnected={isComfyUiConnected} />

            <div onClick={(e: any) => e.stopPropagation()}>
              <div>
                {aiModelDownloadStatus && (
                  <div className="p-2 text-center text-xs text-text-secondary bg-surface rounded-md mb-4">
                    Downloading AI Model: {aiModelDownloadStatus}
                  </div>
                )}
                <p className="text-sm mb-3 font-semibold text-text-primary">Create New Generative Edit</p>
                <div className="grid grid-cols-3 gap-2">
                  {AI_PANEL_CREATION_TYPES.map((maskType: MaskType) => (
                    <button
                      className={`bg-surface text-text-primary rounded-lg p-2 flex flex-col items-center justify-center gap-1.5 aspect-square transition-colors ${
                        maskType.disabled || isGeneratingAiMask || isGeneratingAi
                          ? 'opacity-50 cursor-not-allowed'
                          : 'hover:bg-card-active'
                      }`}
                      disabled={maskType.disabled || isGeneratingAiMask || isGeneratingAi}
                      key={maskType.type}
                      onClick={() => handleAddAiPatchContainer(maskType.type)}
                      title={maskType.disabled ? `${maskType.name} (Coming Soon)` : `Add ${maskType.name} Edit`}
                    >
                      <maskType.icon size={24} />
                      <span className="text-xs">{maskType.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              {hasAiEdits && (
                <div className="pt-4">
                  <p className="text-sm mb-3 font-semibold text-text-primary">Edits ({aiPatches.length})</p>
                  <div className="flex flex-col gap-2">
                    <AnimatePresence>
                      {aiPatches
                        .filter((p: AiPatch) => p.id !== deletingItemId)
                        .map((patch: AiPatch, index: Number) => (
                          <motion.div
                            animate="visible"
                            className={`group p-2 rounded-lg flex items-center justify-between cursor-pointer transition-all duration-200 ${
                              activePatchContainerId === patch.id ? 'bg-accent/20' : 'bg-surface hover:bg-card-active'
                            } ${!patch.visible ? 'opacity-60' : 'opacity-100'}`}
                            custom={index}
                            exit="exit"
                            initial={isInitialRender.current ? 'hidden' : false}
                            key={patch.id}
                            layout
                            onClick={() => handleOpenContainerForEditing(patch)}
                            onContextMenu={(e: any) => handleContainerContextMenu(e, patch)}
                            variants={itemVariants}
                          >
                            <div className="flex items-center gap-3 flex-grow min-w-0">
                              {patch.isLoading ? (
                                <Loader2 size={16} className="text-accent animate-spin" />
                              ) : (
                                <Wand2 size={16} className="text-text-secondary" />
                              )}
                              {renamingContainerId === patch.id ? (
                                <input
                                  autoFocus
                                  className="bg-transparent w-full text-sm font-medium text-text-primary focus:outline-none focus:ring-1 focus:ring-accent rounded px-1 -mx-1"
                                  onBlur={handleFinishRename}
                                  onChange={(e: any) => setTempName(e.target.value)}
                                  onClick={(e: any) => e.stopPropagation()}
                                  onContextMenu={(e: any) => e.stopPropagation()}
                                  onKeyDown={handleRenameKeyDown}
                                  type="text"
                                  value={tempName}
                                />
                              ) : (
                                <span className="font-medium text-sm text-text-primary truncate">{patch.name}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button
                                className="p-1.5 rounded-full text-text-secondary hover:bg-bg-primary"
                                onClick={(e: any) => {
                                  e.stopPropagation();
                                  handleToggleContainerVisibility(patch.id);
                                }}
                                title={patch.visible ? 'Hide Edit' : 'Show Edit'}
                              >
                                {patch.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                              </button>
                              <button
                                className="p-1.5 rounded-full text-text-secondary hover:text-red-500 hover:bg-red-500/10"
                                onClick={(e: any) => {
                                  e.stopPropagation();
                                  handleDeleteContainer(patch.id);
                                }}
                                title="Delete Edit"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </motion.div>
                        ))}
                    </AnimatePresence>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}