import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Circle, Eye, EyeOff, Loader2, Minus, Plus, Send, Trash2 } from 'lucide-react';
import CollapsibleSection from '../../ui/CollapsibleSection';
import Switch from '../../ui/Switch';
import Slider from '../../ui/Slider';
import Input from '../../ui/Input';
import Button from '../../ui/Button';
import { useContextMenu } from '../../../context/ContextMenuContext';
import {
  AI_SUB_MASK_COMPONENT_TYPES,
  Mask,
  MaskType,
  SubMask,
  SubMaskMode,
  ToolType,
  MASK_ICON_MAP,
} from './Masks';
import { Adjustments, AiPatch } from '../../../utils/adjustments';
import { BrushSettings, SelectedImage } from '../../ui/AppProperties';
import { createSubMask } from '../../../utils/maskUtils';

interface AiControlsProps {
  activeSubMaskId: string | null;
  activeSubMask: SubMask | null;
  adjustments: Adjustments;
  aiModelDownloadStatus: string | null;
  brushSettings: BrushSettings | null;
  editingPatch: any;
  isComfyUiConnected: boolean;
  isGeneratingAi: boolean;
  isGeneratingAiMask: boolean;
  onGenerateAiForegroundMask(id: string): void;
  onGenerativeReplace(id: string, prompt: string, useFastInpaint: boolean): void;
  onSelectSubMask(id: string | null): void;
  selectedImage: SelectedImage;
  setAdjustments(adjustments: Partial<Adjustments>): void;
  setBrushSettings(brushSettings: BrushSettings): void;
  updatePatch(id: string, patch: Partial<AiPatch>): void;
  updateSubMask(id: string, parameters: any): void;
}

interface BrushToolsProps {
  onSettingsChange(settings: any): void;
  settings: any;
}

function formatMaskTypeName(type: Mask) {
  if (type === Mask.AiSubject) {
    return 'AI Subject';
  }
  if (type === Mask.AiForeground) {
    return 'AI Foreground';
  }
  if (type === Mask.AiSky) {
    return 'AI Sky';
  }
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export const SUB_MASK_CONFIG: any = {
  [Mask.Radial]: {
    parameters: [{ key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, multiplier: 100, defaultValue: 50 }],
  },
  [Mask.Brush]: { showBrushTools: true },
  [Mask.Linear]: { parameters: [] },
  [Mask.AiSubject]: {
    parameters: [
      { key: 'grow', label: 'Grow', min: -100, max: 100, step: 1, defaultValue: 50 },
      { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, defaultValue: 25 },
    ],
  },
  [Mask.AiForeground]: {
    parameters: [
      { key: 'grow', label: 'Grow', min: -100, max: 100, step: 1, defaultValue: 50 },
      { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, defaultValue: 25 },
    ],
  },
  [Mask.AiSky]: {
    parameters: [
      { key: 'grow', label: 'Grow', min: -100, max: 100, step: 1, defaultValue: 0 },
      { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, defaultValue: 0 },
    ],
  },
  [Mask.QuickEraser]: {
    parameters: [
      { key: 'grow', label: 'Grow', min: -100, max: 100, step: 1, defaultValue: 50 },
      { key: 'feather', label: 'Feather', min: 0, max: 100, step: 1, defaultValue: 50 },
    ],
  },
};

const BrushTools = ({ settings, onSettingsChange }: BrushToolsProps) => (
  <div className="space-y-4 pt-4 border-t border-surface mt-4">
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
        className={`p-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
          settings.tool === ToolType.Brush
            ? 'text-primary bg-surface'
            : 'bg-surface text-text-secondary hover:bg-card-active'
        }`}
        onClick={() => onSettingsChange((s: any) => ({ ...s, tool: ToolType.Brush }))}
      >
        Add
      </button>
      <button
        className={`p-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
          settings.tool === ToolType.Eraser
            ? 'text-primary bg-surface'
            : 'bg-surface text-text-secondary hover:bg-card-active'
        }`}
        onClick={() => onSettingsChange((s: any) => ({ ...s, tool: ToolType.Eraser }))}
      >
        Erase
      </button>
    </div>
  </div>
);

export default function AIControls({
  activeSubMask,
  activeSubMaskId,
  adjustments,
  aiModelDownloadStatus,
  brushSettings,
  editingPatch,
  isComfyUiConnected,
  isGeneratingAi,
  isGeneratingAiMask,
  onGenerateAiForegroundMask,
  onGenerativeReplace,
  onSelectSubMask,
  selectedImage,
  setAdjustments,
  setBrushSettings,
  updatePatch,
  updateSubMask,
}: AiControlsProps) {
  const { showContextMenu } = useContextMenu();
  const [isSettingsSectionOpen, setSettingsSectionOpen] = useState(true);
  const [showAnalyzingMessage, setShowAnalyzingMessage] = useState(false);
  const analyzingTimeoutRef = useRef<number>(null);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string>(editingPatch?.prompt || '');
  const isQuickErasePatch = editingPatch?.subMasks?.some((sm: SubMask) => sm.type === Mask.QuickEraser);
  const [useFastInpaint, setUseFastInpaint] = useState(isQuickErasePatch || !isComfyUiConnected);

  useEffect(() => {
    setPrompt(editingPatch?.prompt || '');
  }, [editingPatch?.id, editingPatch?.prompt]);

  useEffect(() => {
    const isQuickErase = editingPatch?.subMasks?.some((sm: SubMask) => sm.type === Mask.QuickEraser);
    setUseFastInpaint(isQuickErase || !isComfyUiConnected);
  }, [isComfyUiConnected, editingPatch]);

  useEffect(() => {
    if (isGeneratingAiMask) {
      analyzingTimeoutRef.current = setTimeout(() => setShowAnalyzingMessage(true), 1000);
    } else {
      if (analyzingTimeoutRef.current) clearTimeout(analyzingTimeoutRef.current);
      setShowAnalyzingMessage(false);
    }
    return () => {
      if (analyzingTimeoutRef.current) {
        clearTimeout(analyzingTimeoutRef.current);
      }
    };
  }, [isGeneratingAiMask]);

  const handleAddSubMask = (containerId: string, type: Mask) => {
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

    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      aiPatches: prev.aiPatches?.map((p: AiPatch) =>
        p.id === containerId ? { ...p, subMasks: [...p.subMasks, subMask] } : p,
      ),
    }));
    onSelectSubMask(subMask.id);
    if (type === Mask.AiForeground) {
      onGenerateAiForegroundMask(subMask.id);
    }
  };

  const handleDeleteSubMask = (containerId: string, subMaskId: string) => {
    setDeletingItemId(subMaskId);
    setTimeout(() => {
      if (activeSubMaskId === subMaskId) {
        onSelectSubMask(null);
      }
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aiPatches: prev.aiPatches?.map((p: AiPatch) =>
          p.id === containerId ? { ...p, subMasks: p.subMasks.filter((sm: SubMask) => sm.id !== subMaskId) } : p,
        ),
      }));
      setDeletingItemId(null);
    }, 200);
  };

  const handleDeselectSubMask = () => onSelectSubMask(null);

  const handleSubMaskContextMenu = (event: any, subMask: SubMask) => {
    event.preventDefault();
    event.stopPropagation();
    const options = [
      {
        icon: Trash2,
        isDestructive: true,
        label: 'Delete Component',
        onClick: () => handleDeleteSubMask(editingPatch.id, subMask.id),
      },
    ];
    showContextMenu(event.clientX, event.clientY, options);
  };

  const handleGenerateClick = () => {
    onGenerativeReplace(editingPatch.id, prompt, useFastInpaint);
  };

  if (!editingPatch) {
    return null;
  }

  const subMaskConfig = activeSubMask ? SUB_MASK_CONFIG[activeSubMask.type] || {} : {};

  const handleSubMaskParameterChange = (key: string, value: any) => {
    if (!activeSubMask) {
      return;
    }
    updateSubMask(activeSubMask.id, { parameters: { ...activeSubMask.parameters, [key]: value } });
  };

  const handlePatchPropertyChange = (key: string, value: any) => updatePatch(editingPatch.id, { [key]: value });

  const isAiMask =
    activeSubMask &&
    (activeSubMask.type === Mask.AiSubject ||
      activeSubMask.type === Mask.AiForeground ||
      activeSubMask.type === Mask.AiSky);

  return (
    <>
      <div className="p-4 border-b border-surface">
        <p className="text-sm mb-3 font-semibold text-text-primary">Add to Selection</p>
        <div className="grid grid-cols-3 gap-2">
          {AI_SUB_MASK_COMPONENT_TYPES.map((maskType: MaskType) => (
            <button
              className={`bg-surface text-text-primary rounded-lg p-2 flex flex-col items-center justify-center gap-1.5 aspect-square transition-colors ${
                maskType.disabled || isGeneratingAiMask || isGeneratingAi
                  ? 'opacity-50 cursor-not-allowed'
                  : 'hover:bg-card-active'
              }`}
              disabled={maskType.disabled || isGeneratingAiMask || isGeneratingAi}
              key={maskType.type}
              onClick={() => handleAddSubMask(editingPatch.id, maskType.type)}
              title={`Add ${maskType.name} component`}
            >
              <maskType.icon size={24} />
              <span className="text-xs">{maskType.name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 space-y-2" onClick={handleDeselectSubMask}>
        <p className="text-sm mb-3 font-semibold text-text-primary">Selection Components</p>
        {editingPatch.subMasks.length === 0 ? (
          <div className="text-center text-sm text-text-secondary py-6 px-4 bg-surface rounded-lg">
            <p className="font-medium">This AI edit has no selection.</p>
            <p className="mt-1">Select a component type above to define the area to edit.</p>
          </div>
        ) : (
          <AnimatePresence>
            {editingPatch.subMasks
              .filter((sm: SubMask) => sm.id !== deletingItemId)
              .map((subMask: SubMask) => {
                const MaskIcon = MASK_ICON_MAP[subMask.type] || Circle;
                return (
                  <motion.div
                    className={`group p-2 rounded-lg flex items-center justify-between cursor-pointer transition-all duration-200 ${
                      activeSubMaskId === subMask.id ? 'bg-accent/20' : 'bg-surface hover:bg-card-active'
                    } ${!subMask.visible ? 'opacity-60' : 'opacity-100'}`}
                    exit={{ opacity: 0, x: -15, transition: { duration: 0.2 } }}
                    key={subMask.id}
                    layout
                    onClick={(e: any) => {
                      e.stopPropagation();
                      onSelectSubMask(subMask.id);
                    }}
                    onContextMenu={(e: any) => handleSubMaskContextMenu(e, subMask)}
                  >
                    <div className="flex items-center gap-3">
                      <MaskIcon size={16} className="text-text-secondary" />
                      <span className="font-medium text-sm text-text-primary capitalize">
                        {formatMaskTypeName(subMask.type)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        className="p-1.5 rounded-full text-text-secondary hover:bg-bg-primary"
                        onClick={(e: any) => {
                          e.stopPropagation();
                          updateSubMask(subMask.id, {
                            mode:
                              subMask.mode === SubMaskMode.Additive ? SubMaskMode.Subtractive : SubMaskMode.Additive,
                          });
                        }}
                        title={subMask.mode === SubMaskMode.Additive ? 'Set to Subtract' : 'Set to Add'}
                      >
                        {subMask.mode === SubMaskMode.Additive ? <Plus size={14} /> : <Minus size={14} />}
                      </button>
                      <button
                        className="p-1.5 rounded-full text-text-secondary hover:bg-bg-primary"
                        onClick={(e: any) => {
                          e.stopPropagation();
                          updateSubMask(subMask.id, { visible: !subMask.visible });
                        }}
                        title={subMask.visible ? 'Hide' : 'Show'}
                      >
                        {subMask.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                      </button>
                      <button
                        className="p-1.5 rounded-full text-text-secondary hover:text-red-500 hover:bg-red-500/10"
                        onClick={(e: any) => {
                          e.stopPropagation();
                          handleDeleteSubMask(editingPatch.id, subMask.id);
                        }}
                        title="Delete"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </motion.div>
                );
              })}
          </AnimatePresence>
        )}
      </div>

      <div className="p-4 flex flex-col gap-4 border-t border-surface mt-auto">
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">Generative Replace</h3>
          <p className="text-xs text-text-secondary -mt-2">
            {isQuickErasePatch
              ? 'Fill selection to remove the object.'
              : useFastInpaint
              ? 'Fill selection based on surrounding pixels.'
              : 'Describe what you want to generate in the selected area.'}
          </p>
          <div className="pt-1">
            <Switch
              checked={useFastInpaint}
              disabled={isQuickErasePatch || !isComfyUiConnected}
              label="Use fast inpainting"
              onChange={setUseFastInpaint}
              tooltip={
                isQuickErasePatch
                  ? 'Quick Erase always uses fast inpainting.'
                  : !isComfyUiConnected
                  ? 'ComfyUI not connected, fast inpainting is required.'
                  : 'Fast inpainting is quicker but not generative. Uncheck to use ComfyUI with a text prompt.'
              }
            />
          </div>
          <AnimatePresence>
            {!useFastInpaint && (
              <motion.div
                animate={{ opacity: 1, height: 'auto', marginTop: '0.75rem' }}
                className="overflow-hidden"
                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                initial={{ opacity: 0, height: 0, marginTop: 0 }}
                transition={{ duration: 0.2 }}
              >
                <div className="flex items-center gap-2">
                  <Input
                    className="flex-grow"
                    disabled={isGeneratingAi}
                    onChange={(e: any) => setPrompt(e.target.value)}
                    onKeyDown={(e: any) => {
                      if (e.key === 'Enter') handleGenerateClick();
                    }}
                    placeholder="e.g., a field of flowers"
                    type="text"
                    value={prompt}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="pt-2">
            <Button
              className="w-full"
              disabled={isGeneratingAi || editingPatch.subMasks.length === 0}
              onClick={handleGenerateClick}
            >
              {isGeneratingAi ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              <span className="ml-2">
                {isGeneratingAi ? 'Generating...' : useFastInpaint ? 'Inpaint Selection' : 'Generate with AI'}
              </span>
            </Button>
          </div>
        </div>

        <CollapsibleSection
          canToggleVisibility={false}
          isContentVisible={true}
          isOpen={isSettingsSectionOpen}
          onToggle={() => setSettingsSectionOpen((prev: any) => !prev)}
          title="Selection Properties"
        >
          <div className="space-y-4">
            <Switch
              checked={!!editingPatch.invert}
              label="Invert Selection"
              onChange={(checked) => handlePatchPropertyChange('invert', checked)}
            />
            {activeSubMask && (
              <>
                {isAiMask && (
                  <>
                    {aiModelDownloadStatus && (
                      <div className="text-sm text-text-secondary p-2 bg-surface rounded-md text-center">
                        Downloading AI Model ({aiModelDownloadStatus})...
                      </div>
                    )}
                    {showAnalyzingMessage && !aiModelDownloadStatus && (
                      <div className="text-sm text-text-secondary p-2 bg-surface rounded-md text-center animate-pulse">
                        Analyzing Image...
                      </div>
                    )}
                  </>
                )}
                {subMaskConfig.parameters?.map((param: any) => {
                  const storedValue = activeSubMask.parameters[param.key];
                  const multiplier = param.multiplier || 1;
                  const sliderValue = storedValue === undefined ? param.defaultValue : storedValue * multiplier;

                  return (
                    <Slider
                      defaultValue={param.defaultValue}
                      key={param.key}
                      label={param.label}
                      max={param.max}
                      min={param.min}
                      onChange={(e: any) =>
                        handleSubMaskParameterChange(param.key, parseFloat(e.target.value) / multiplier)
                      }
                      step={param.step}
                      value={sliderValue}
                    />
                  );
                })}
                {subMaskConfig.showBrushTools && brushSettings && setBrushSettings && (
                  <BrushTools settings={brushSettings} onSettingsChange={setBrushSettings} />
                )}
              </>
            )}
          </div>
        </CollapsibleSection>
      </div>
    </>
  );
}