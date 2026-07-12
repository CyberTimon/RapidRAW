import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
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
  Circle,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  FileEdit,
  Loader2,
  Minus,
  Plus,
  PlusSquare,
  RotateCcw,
  Trash2,
  Wand2,
  Send,
  FolderOpen,
  SquaresIntersect,
} from 'lucide-react';

import CollapsibleSection from '../../ui/CollapsibleSection';
import Switch from '../../ui/Switch';
import Slider from '../../ui/Slider';
import Input from '../../ui/Input';
import Button from '../../ui/Button';

import { useContextMenu } from '../../../context/ContextMenuContext';
import {
  Mask,
  MaskType,
  SubMask,
  SubMaskMode,
  ToolType,
  MASK_ICON_MAP,
  AI_MANUAL_CLEANUP_TYPES,
  AI_GENERATIVE_CREATION_TYPES,
  AI_SUB_MASK_COMPONENT_TYPES,
  formatMaskTypeName,
  getSubMaskName,
} from './Masks';
import { Adjustments, AiPatch } from '../../../utils/adjustments';
import { OPTION_SEPARATOR } from '../../ui/AppProperties';
import { createSubMask } from '../../../utils/maskUtils';
import Text from '../../ui/Text';
import { TEXT_COLOR_KEYS, TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { useUser, useAuth } from '@clerk/react';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useEditorStore } from '../../../store/useEditorStore';
import { useProcessStore } from '../../../store/useProcessStore';
import { useUIStore } from '../../../store/useUIStore';
import { useEditorActions } from '../../../hooks/useEditorActions';
import { useAiMasking } from '../../../hooks/useAiMasking';

interface DragData {
  type: 'Container' | 'SubMask' | 'Creation';
  item?: AiPatch | SubMask;
  maskType?: Mask;
  parentId?: string;
}

const PLACEHOLDER_PATCH: AiPatch = {
  id: 'placeholder',
  invert: false,
  isLoading: false,
  name: '',
  prompt: '',
  subMasks: [],
  visible: true,
  patchData: null,
};

const SUB_MASK_CONFIG: any = {
  [Mask.Radial]: {
    parameters: [{ key: 'feather', min: 0, max: 100, step: 1, multiplier: 100, defaultValue: 50 }],
  },
  [Mask.Brush]: { showBrushTools: true },
  [Mask.Clone]: { showBrushTools: true },
  [Mask.Heal]: { showBrushTools: true },
  [Mask.Linear]: { parameters: [] },
  [Mask.AiSubject]: {
    parameters: [
      { key: 'grow', min: -100, max: 100, step: 1, defaultValue: 50 },
      { key: 'feather', min: 0, max: 100, step: 1, defaultValue: 25 },
    ],
  },
  [Mask.AiForeground]: {
    parameters: [
      { key: 'grow', min: -100, max: 100, step: 1, defaultValue: 50 },
      { key: 'feather', min: 0, max: 100, step: 1, defaultValue: 25 },
    ],
  },
  [Mask.AiSky]: {
    parameters: [
      { key: 'grow', min: -100, max: 100, step: 1, defaultValue: 0 },
      { key: 'feather', min: 0, max: 100, step: 1, defaultValue: 0 },
    ],
  },
  [Mask.QuickEraser]: {
    parameters: [
      { key: 'grow', min: -100, max: 100, step: 1, defaultValue: 75 },
      { key: 'feather', min: 0, max: 100, step: 1, defaultValue: 75 },
    ],
  },
};

const BrushTools = ({ settings, onSettingsChange }: { settings: any; onSettingsChange: any }) => {
  const { t } = useTranslation();

  return (
    <div>
      <Slider
        defaultValue={100}
        label={t('editor.ai.brush.size')}
        max={200}
        min={1}
        onChange={(e: any) => onSettingsChange((s: any) => ({ ...s, size: Number(e.target.value) }))}
        step={1}
        value={settings.size}
        fillOrigin="min"
      />
      <Slider
        defaultValue={50}
        label={t('editor.ai.brush.feather')}
        max={100}
        min={0}
        onChange={(e: any) => onSettingsChange((s: any) => ({ ...s, feather: Number(e.target.value) }))}
        step={1}
        value={settings.feather}
        fillOrigin="min"
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
          {t('editor.ai.brush.add')}
        </button>
        <button
          className={`p-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
            settings.tool === ToolType.Eraser
              ? 'text-primary bg-surface'
              : 'bg-surface text-text-secondary hover:bg-card-active'
          }`}
          onClick={() => onSettingsChange((s: any) => ({ ...s, tool: ToolType.Eraser }))}
        >
          {t('editor.ai.brush.erase')}
        </button>
      </div>
    </div>
  );
};

interface ConnectionStatusProps {
  aiProvider: string;
  isAIConnectorConnected: boolean;
  isSignedIn: boolean;
  isPro: boolean;
  cloudUsage: { requests: number; limit: number; month: string } | null;
}

const ConnectionStatus = ({
  aiProvider,
  isAIConnectorConnected,
  isSignedIn,
  isPro,
  cloudUsage,
}: ConnectionStatusProps) => {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);

  let statusColor = 'bg-green-500';
  let statusText = t('editor.ai.connection.ready');
  let titleText = t('editor.ai.connection.backendLabel');
  let hoverContent: React.ReactNode = null;

  if (aiProvider === 'cloud') {
    titleText = t('editor.ai.connection.cloudLabel');
    if (isSignedIn && isPro) {
      statusColor = 'bg-green-500';
      statusText = t('editor.ai.connection.ready');

      const reqs = cloudUsage?.requests ?? 0;
      const limit = cloudUsage?.limit ?? 500;
      const percent = Math.min(100, (reqs / limit) * 100);

      hoverContent = (
        <div className="w-full mt-1">
          <div className="flex justify-between items-center mb-1.5">
            <Text variant={TextVariants.small}>{t('editor.ai.connection.monthlyUsage')}</Text>
            <Text variant={TextVariants.small}>
              {t('settings.processing.ai.cloud.signedIn.usageStats', { requests: reqs, limit: limit })}
            </Text>
          </div>
          <div className="w-full bg-bg-tertiary rounded-full h-1.5 border border-border-color">
            <div
              className="bg-accent h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      );
    } else if (isSignedIn && !isPro) {
      statusColor = 'bg-red-500';
      statusText = t('editor.ai.connection.upgradeRequired');
      hoverContent = <Text variant={TextVariants.small}>{t('editor.ai.connection.proRequiredDesc')}</Text>;
    } else {
      statusColor = 'bg-red-500';
      statusText = t('editor.ai.connection.notLoggedIn');
      hoverContent = <Text variant={TextVariants.small}>{t('editor.ai.connection.loginRequiredDesc')}</Text>;
    }
  } else if (aiProvider === 'ai-connector') {
    titleText = t('editor.ai.connection.connectorLabel');
    if (isAIConnectorConnected) {
      statusColor = 'bg-green-500';
      statusText = t('editor.ai.connection.ready');
      hoverContent = <Text variant={TextVariants.small}>{t('editor.ai.connection.connectorConnectedDesc')}</Text>;
    } else {
      statusColor = 'bg-red-500';
      statusText = t('editor.ai.connection.notDetected');
      hoverContent = <Text variant={TextVariants.small}>{t('editor.ai.connection.connectorDisconnectedDesc')}</Text>;
    }
  } else {
    titleText = t('editor.ai.connection.builtinLabel');
    statusColor = 'bg-green-500';
    statusText = t('editor.ai.connection.ready');
    hoverContent = <Text variant={TextVariants.small}>{t('editor.ai.connection.builtinDesc')}</Text>;
  }

  return (
    <div
      className="bg-surface rounded-lg"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className={`flex items-center gap-2 px-4 ${hoverContent ? 'pt-2' : 'py-2'}`}>
        <div className={`w-2.5 h-2.5 rounded-full ${statusColor}`} />
        <Text variant={TextVariants.label}>{titleText}</Text>
        <Text
          variant={TextVariants.label}
          weight={TextWeights.bold}
          className={statusColor === 'bg-green-500' ? 'text-green-500' : 'text-red-500'}
        >
          {statusText}
        </Text>
      </div>
      {hoverContent && (
        <div className="px-4 pb-3">
          <motion.div
            animate={{ height: isHovered ? 'auto' : 0, opacity: isHovered ? 1 : 0, marginTop: isHovered ? '2px' : 0 }}
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0, marginTop: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
          >
            {hoverContent}
          </motion.div>
        </div>
      )}
    </div>
  );
};

export default function AIPanel() {
  const { t } = useTranslation();
  const activePatchContainerId = useEditorStore((s) => s.activeAiPatchContainerId);
  const activeSubMaskId = useEditorStore((s) => s.activeAiSubMaskId);
  const adjustments = useEditorStore((s) => s.adjustments);
  const brushSettings = useEditorStore((s) => s.brushSettings);
  const isAIConnectorConnected = useEditorStore((s) => s.isAIConnectorConnected);
  const isGeneratingAi = useEditorStore((s) => s.isGeneratingAi);
  const isGeneratingAiMask = useEditorStore((s) => s.isGeneratingAiMask);
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const setEditor = useEditorStore((s) => s.setEditor);

  const aiModelDownloadStatus = useProcessStore((s) => s.aiModelDownloadStatus);
  const setCustomEscapeHandler = useUIStore((s) => s.setCustomEscapeHandler);

  const { setAdjustments } = useEditorActions();
  const { handleGenerativeReplace, handleDeleteAiPatch, handleGenerateAiForegroundMask } = useAiMasking();
  const appSettings = useSettingsStore((s) => s.appSettings);
  const aiProvider = appSettings?.aiProvider || 'cpu';

  const { user, isSignedIn } = useUser();
  const { getToken } = useAuth();
  const isPro = user?.publicMetadata?.plan === 'pro';
  const [cloudUsage, setCloudUsage] = useState<{ requests: number; limit: number; month: string } | null>(null);

  const isGenerativeAvailable =
    (aiProvider === 'cloud' && !!isSignedIn && !!isPro) || (aiProvider === 'ai-connector' && isAIConnectorConnected);

  useEffect(() => {
    if (aiProvider !== 'cloud' || !isSignedIn || !isPro) return;

    const fetchUsage = async () => {
      try {
        const token = await getToken();
        if (!token) return;

        const res = await fetch('https://getrapidraw.com/api/usage', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          setCloudUsage(await res.json());
        }
      } catch (e) {
        console.error('Failed to fetch cloud usage', e);
      }
    };

    fetchUsage();
  }, [aiProvider, isSignedIn, isPro, getToken]);

  const setBrushSettings = useCallback(
    (updater: any) =>
      setEditor((state) => ({ brushSettings: typeof updater === 'function' ? updater(state.brushSettings) : updater })),
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

  const onSelectPatchContainer = useCallback(
    (id: string | null) => setEditor({ activeAiPatchContainerId: id }),
    [setEditor],
  );
  const onSelectSubMask = useCallback((id: string | null) => setEditor({ activeAiSubMaskId: id }), [setEditor]);
  const onDragStateChange = useCallback(
    (isDragging: boolean) => setEditor({ isSliderDragging: isDragging }),
    [setEditor],
  );

  const [expandedContainers, setExpandedContainers] = useState<Set<string>>(new Set());
  const [activeDragItem, setActiveDragItem] = useState<DragData | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [tempName, setTempName] = useState('');
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [isSettingsPanelEverOpened, setIsSettingsPanelEverOpened] = useState(false);
  const hasPerformedInitialSelection = useRef(false);
  const [analyzingSubMaskId, setAnalyzingSubMaskId] = useState<string | null>(null);
  const [copiedPatch, setCopiedPatch] = useState<AiPatch | null>(null);
  const [copiedSubMask, setCopiedSubMask] = useState<SubMask | null>(null);

  const [collapsibleState, setCollapsibleState] = useState({
    generative: true,
    properties: true,
  });

  const { showContextMenu } = useContextMenu();
  const { setNodeRef: setRootDroppableRef, isOver: isRootOver } = useDroppable({ id: 'ai-list-root' });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const activeContainer = (adjustments.aiPatches || []).find((p) => p.id === activePatchContainerId);
  const activeSubMaskData = activeContainer?.subMasks.find((sm) => sm.id === activeSubMaskId);
  const isAiMask =
    activeSubMaskData && [Mask.AiSubject, Mask.AiForeground, Mask.AiSky].includes(activeSubMaskData.type);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (isGeneratingAiMask && isAiMask) {
      timer = setTimeout(() => {
        setAnalyzingSubMaskId(activeSubMaskId);
      }, 200);
    } else {
      setAnalyzingSubMaskId(null);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [isGeneratingAiMask, isAiMask, activeSubMaskId]);

  useEffect(() => {
    if (activePatchContainerId) {
      const patchExists = adjustments.aiPatches?.some((p) => p.id === activePatchContainerId);
      if (!patchExists) {
        onSelectPatchContainer(null);
        onSelectSubMask(null);
      } else if (!activeSubMaskId) {
        const container = adjustments.aiPatches?.find((p) => p.id === activePatchContainerId);
        if (
          container &&
          container.subMasks.length === 1 &&
          [Mask.Clone, Mask.Heal].includes(container.subMasks[0].type)
        ) {
          onSelectSubMask(container.subMasks[0].id);
        }
      }
    }
  }, [adjustments.aiPatches, activePatchContainerId, activeSubMaskId, onSelectPatchContainer, onSelectSubMask]);

  useEffect(() => {
    const hasPatches = (adjustments.aiPatches || []).length > 0;

    if (hasPatches) {
      setIsSettingsPanelEverOpened(true);
    }

    if (activePatchContainerId) {
      const shouldAutoExpand = !hasPerformedInitialSelection.current || activeSubMaskId;
      if (shouldAutoExpand) {
        setExpandedContainers((prev) => {
          if (prev.has(activePatchContainerId)) return prev;
          return new Set(prev).add(activePatchContainerId);
        });
      }
      hasPerformedInitialSelection.current = true;
      setIsSettingsPanelEverOpened(true);
    }
  }, [activePatchContainerId, activeSubMaskId, adjustments.aiPatches, onSelectPatchContainer, onSelectSubMask]);

  useEffect(() => {
    const handler = () => {
      if (renamingId) {
        setRenamingId(null);
        setTempName('');
      } else if (activeSubMaskId) onSelectSubMask(null);
      else if (activePatchContainerId) onSelectPatchContainer(null);
    };
    if (activePatchContainerId || renamingId) setCustomEscapeHandler(() => handler);
    else setCustomEscapeHandler(null);
    return () => setCustomEscapeHandler(null);
  }, [
    activePatchContainerId,
    activeSubMaskId,
    renamingId,
    onSelectPatchContainer,
    onSelectSubMask,
    setCustomEscapeHandler,
  ]);

  const handleDeselect = () => {
    onSelectPatchContainer(null);
    onSelectSubMask(null);
  };

  const handleToggleExpand = (id: string) => {
    setExpandedContainers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleResetAllAiEdits = () => {
    if (isGeneratingAi) return;
    handleDeselect();
    setAdjustments((prev: Adjustments) => ({ ...prev, aiPatches: [] }));
  };

  const createMaskLogic = (type: Mask, mode: SubMaskMode = SubMaskMode.Additive) => {
    if (!selectedImage) return createSubMask(type, {} as any, mode);
    const subMask = createSubMask(type, selectedImage, mode);

    const steps = adjustments?.orientationSteps || 0;
    const isRotated = steps === 1 || steps === 3;
    const imgW = isRotated ? selectedImage.height || 1000 : selectedImage.width || 1000;
    const imgH = isRotated ? selectedImage.width || 1000 : selectedImage.height || 1000;

    const config = SUB_MASK_CONFIG[type];
    if (config && config.parameters) {
      config.parameters.forEach((param: any) => {
        if (param.defaultValue !== undefined) {
          subMask.parameters[param.key] = param.defaultValue / (param.multiplier || 1);
        }
      });
    }

    if (type === Mask.Linear && subMask.parameters) {
      subMask.parameters.range = Math.min(imgW, imgH) * 0.1;
    }

    if (type === Mask.Linear || type === Mask.Radial) {
      if (!subMask.parameters) subMask.parameters = {};
      subMask.parameters.isInitialDraw = true;
      subMask.parameters.startX = -10000;
      subMask.parameters.startY = -10000;
      subMask.parameters.endX = -10000;
      subMask.parameters.endY = -10000;
      subMask.parameters.centerX = -10000;
      subMask.parameters.centerY = -10000;
      subMask.parameters.radiusX = 0;
      subMask.parameters.radiusY = 0;
    }
    return subMask;
  };

  const handleAddAiPatchContainer = (type: Mask) => {
    const subMask = createMaskLogic(type);

    let name: string;
    if (type === Mask.QuickEraser) {
      const count =
        (adjustments.aiPatches || []).filter((p: AiPatch) =>
          p.subMasks.some((sm: SubMask) => sm.type === Mask.QuickEraser),
        ).length + 1;
      name = t('editor.ai.patches.quickErase', { count });
    } else if (type === Mask.Clone) {
      const count =
        (adjustments.aiPatches || []).filter((p: AiPatch) => p.subMasks.some((sm: SubMask) => sm.type === Mask.Clone))
          .length + 1;
      name = t('editor.ai.patches.clone', { count });
    } else if (type === Mask.Heal) {
      const count =
        (adjustments.aiPatches || []).filter((p: AiPatch) => p.subMasks.some((sm: SubMask) => sm.type === Mask.Heal))
          .length + 1;
      name = t('editor.ai.patches.heal', { count });
    } else {
      const count = (adjustments.aiPatches || []).length + 1;
      name = t('editor.ai.patches.aiEdit', { count });
    }

    const newContainer: AiPatch = {
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

    const isStandalone = [Mask.Clone, Mask.Heal].includes(type);

    onSelectSubMask(subMask.id);
    if (!isStandalone) {
      setExpandedContainers((prev) => new Set(prev).add(newContainer.id));
    }

    if (type === Mask.Brush || type === Mask.Clone || type === Mask.Heal) {
      selectBrushToolForNewMask();
    }

    if (type === Mask.AiForeground) handleGenerateAiForegroundMask(subMask.id);
  };

  const handleAddSubMask = (
    containerId: string,
    type: Mask,
    mode: SubMaskMode = SubMaskMode.Additive,
    insertIndex: number = -1,
  ) => {
    const subMask = createMaskLogic(type, mode);
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aiPatches: prev.aiPatches?.map((c: AiPatch) => {
        if (c.id === containerId) {
          const newSubMasks = [...c.subMasks];
          if (insertIndex >= 0) newSubMasks.splice(insertIndex, 0, subMask);
          else newSubMasks.push(subMask);
          return { ...c, subMasks: newSubMasks };
        }
        return c;
      }),
    }));
    onSelectPatchContainer(containerId);
    onSelectSubMask(subMask.id);
    setExpandedContainers((prev) => new Set(prev).add(containerId));

    if (type === Mask.Brush || type === Mask.Clone || type === Mask.Heal) {
      selectBrushToolForNewMask();
    }
    if (type === Mask.AiForeground) handleGenerateAiForegroundMask(subMask.id);
  };

  const handleAddAiContextMenu = (event: React.MouseEvent, targetContainerId?: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();

    const container = targetContainerId ? adjustments.aiPatches.find((m) => m.id === targetContainerId) : null;
    const isStandalone =
      container && container.subMasks.length === 1 && [Mask.Clone, Mask.Heal].includes(container.subMasks[0].type);

    if (isStandalone && targetContainerId) {
      return;
    }

    const buildMenu = (types: MaskType[], mode: SubMaskMode = SubMaskMode.Additive) =>
      types
        .filter((mt) => !mt.disabled && (!targetContainerId || ![Mask.Clone, Mask.Heal].includes(mt.type)))
        .map((maskType: MaskType) => ({
          label: formatMaskTypeName(maskType.type),
          icon: maskType.icon,
          onClick: () => {
            if (targetContainerId) {
              handleAddSubMask(targetContainerId, maskType.type, mode);
            } else {
              handleAddAiPatchContainer(maskType.type);
            }
          },
        }));

    const hasComponents = container && container.subMasks.length > 0;

    let options: any[];

    if (!targetContainerId) {
      options = [
        ...buildMenu(AI_MANUAL_CLEANUP_TYPES, SubMaskMode.Additive),
        { type: OPTION_SEPARATOR },
        ...buildMenu(AI_GENERATIVE_CREATION_TYPES, SubMaskMode.Additive),
      ];
    } else {
      options = buildMenu(AI_SUB_MASK_COMPONENT_TYPES, SubMaskMode.Additive);

      if (hasComponents) {
        options.push(
          { type: OPTION_SEPARATOR },
          {
            label: t('editor.ai.actions.subtractFromEdit'),
            icon: Minus,
            submenu: buildMenu(AI_SUB_MASK_COMPONENT_TYPES, SubMaskMode.Subtractive),
          },
          {
            label: t('editor.ai.actions.intersectEditWith'),
            icon: SquaresIntersect,
            submenu: buildMenu(AI_SUB_MASK_COMPONENT_TYPES, SubMaskMode.Intersect),
          },
        );
      }
    }

    showContextMenu(rect.left, rect.bottom + 5, options);
  };

  const updatePatch = (id: string, data: any) =>
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aiPatches: prev.aiPatches.map((p) => (p.id === id ? { ...p, ...data } : p)),
    }));

  const updateSubMask = (id: string, data: any) =>
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aiPatches: prev.aiPatches.map((p) => ({
        ...p,
        subMasks: p.subMasks.map((sm) => (sm.id === id ? { ...sm, ...data } : sm)),
      })),
    }));

  const handleDeleteContainer = (id: string) => {
    if (activePatchContainerId === id) handleDeselect();
    handleDeleteAiPatch(id);
  };

  const handleDeleteSubMask = (containerId: string, subMaskId: string) => {
    if (activeSubMaskId === subMaskId) onSelectSubMask(null);
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aiPatches: prev.aiPatches.map((p) =>
        p.id === containerId ? { ...p, subMasks: p.subMasks.filter((sm) => sm.id !== subMaskId) } : p,
      ),
    }));
  };

  const clonePatchData = (container: AiPatch, options: { invert?: boolean; rename?: boolean } = {}): AiPatch => {
    const clonedContainer = JSON.parse(JSON.stringify(container));

    clonedContainer.id = uuidv4();
    clonedContainer.invert = options.invert ? !clonedContainer.invert : clonedContainer.invert;
    clonedContainer.isLoading = false;
    clonedContainer.name = options.rename === false ? clonedContainer.name : `${container.name} Copy`;
    clonedContainer.patchData = null;
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

  const copyPatchToClipboard = (container: AiPatch) => {
    setCopiedPatch(JSON.parse(JSON.stringify(container)));
  };

  const copySubMaskToClipboard = (subMask: SubMask) => {
    setCopiedSubMask(JSON.parse(JSON.stringify(subMask)));
  };

  const insertPatchContainer = (container: AiPatch, insertIndex?: number) => {
    setAdjustments((prev: Adjustments) => {
      const newPatches = [...(prev.aiPatches || [])];
      const targetIndex = Math.max(0, Math.min(insertIndex ?? newPatches.length, newPatches.length));

      newPatches.splice(targetIndex, 0, container);
      return { ...prev, aiPatches: newPatches };
    });

    onSelectPatchContainer(container.id);
    const isStandalone =
      container.subMasks.length === 1 && [Mask.Clone, Mask.Heal].includes(container.subMasks[0].type);

    if (isStandalone) {
      onSelectSubMask(container.subMasks[0].id);
    } else {
      onSelectSubMask(null);
      setExpandedContainers((prev) => new Set(prev).add(container.id));
    }
  };

  const insertSubMaskIntoContainer = (containerId: string, subMask: SubMask, insertIndex?: number) => {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      aiPatches: (prev.aiPatches || []).map((container) => {
        if (container.id !== containerId) {
          return container;
        }

        const newSubMasks = [...container.subMasks];
        const targetIndex = Math.max(0, Math.min(insertIndex ?? newSubMasks.length, newSubMasks.length));

        newSubMasks.splice(targetIndex, 0, subMask);
        return { ...container, subMasks: newSubMasks };
      }),
    }));

    onSelectPatchContainer(containerId);
    onSelectSubMask(subMask.id);
    setExpandedContainers((prev) => new Set(prev).add(containerId));
  };

  const handleDuplicatePatchContainer = (container: AiPatch) => {
    const patchIndex = (adjustments.aiPatches || []).findIndex((patch) => patch.id === container.id);
    const duplicatedContainer = clonePatchData(container, { rename: true });

    insertPatchContainer(duplicatedContainer, patchIndex >= 0 ? patchIndex + 1 : undefined);
  };

  const handleDuplicateAndInvertPatchContainer = (container: AiPatch) => {
    const patchIndex = (adjustments.aiPatches || []).findIndex((patch) => patch.id === container.id);
    const duplicatedContainer = clonePatchData(container, { invert: true, rename: false });
    duplicatedContainer.name = t('editor.ai.patches.invertedName', { name: container.name });

    insertPatchContainer(duplicatedContainer, patchIndex >= 0 ? patchIndex + 1 : undefined);
  };

  const handlePastePatch = (insertAfterContainerId?: string) => {
    if (!copiedPatch) {
      return;
    }

    const pastedContainer = clonePatchData(copiedPatch, { rename: false });
    const patchIndex = insertAfterContainerId
      ? (adjustments.aiPatches || []).findIndex((patch) => patch.id === insertAfterContainerId)
      : -1;

    insertPatchContainer(pastedContainer, patchIndex >= 0 ? patchIndex + 1 : undefined);
  };

  const handleDuplicateSubMask = (containerId: string, subMask: SubMask, insertIndex?: number) => {
    const duplicatedSubMask = cloneSubMaskData(subMask, { rename: true });
    insertSubMaskIntoContainer(containerId, duplicatedSubMask, insertIndex);
  };

  const handleDuplicateAndInvertSubMask = (containerId: string, subMask: SubMask) => {
    const parentContainer = (adjustments.aiPatches || []).find((p) => p.id === containerId);
    if (!parentContainer) return;

    const duplicatedSubMask = cloneSubMaskData(subMask, { invert: true, rename: false });
    const newContainer = clonePatchData(parentContainer, { rename: false });

    newContainer.name = t('editor.ai.patches.invertedName', { name: getSubMaskName(subMask) });
    newContainer.subMasks = [duplicatedSubMask];
    newContainer.invert = false;

    const parentIndex = (adjustments.aiPatches || []).findIndex((p) => p.id === containerId);
    insertPatchContainer(newContainer, parentIndex >= 0 ? parentIndex + 1 : undefined);
  };

  const handlePasteSubMask = (containerId: string, insertIndex?: number) => {
    if (!copiedSubMask) {
      return;
    }

    const pastedSubMask = cloneSubMaskData(copiedSubMask, { rename: false });
    insertSubMaskIntoContainer(containerId, pastedSubMask, insertIndex);
  };

  const handlePanelContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!selectedImage) {
      return;
    }

    const manualSubMenu = AI_MANUAL_CLEANUP_TYPES.filter((maskType) => !maskType.disabled).map((maskType) => ({
      label: formatMaskTypeName(maskType.type),
      icon: maskType.icon,
      onClick: () => handleAddAiPatchContainer(maskType.type),
    }));

    const genSubMenu = AI_GENERATIVE_CREATION_TYPES.filter((maskType) => !maskType.disabled).map((maskType) => ({
      label: formatMaskTypeName(maskType.type),
      icon: maskType.icon,
      onClick: () => handleAddAiPatchContainer(maskType.type),
    }));

    const newEditSubMenu = [...manualSubMenu, { type: OPTION_SEPARATOR }, ...genSubMenu];

    showContextMenu(e.clientX, e.clientY, [
      {
        label: t('editor.ai.actions.pasteEdit'),
        icon: ClipboardPaste,
        disabled: !copiedPatch,
        onClick: () => handlePastePatch(),
      },
      {
        label: t('editor.ai.addNewEdit'),
        icon: Plus,
        submenu: newEditSubMenu,
      },
    ]);
  };

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

    if (dragData.type === 'Creation' && dragData.maskType) {
      const creationFn = () => {
        const isCreationStandalone = [Mask.Clone, Mask.Heal].includes(dragData.maskType!);

        if (isCreationStandalone) {
          handleAddAiPatchContainer(dragData.maskType!);
        } else if (overData?.type === 'Container') {
          const overContainer = adjustments.aiPatches.find((p) => p.id === overData.item!.id);
          const isOverStandalone =
            overContainer?.subMasks.length === 1 && [Mask.Clone, Mask.Heal].includes(overContainer.subMasks[0].type);

          if (isOverStandalone) {
            handleAddAiPatchContainer(dragData.maskType!);
          } else {
            handleAddSubMask(overData.item!.id, dragData.maskType!);
          }
        } else if (overData?.type === 'SubMask') {
          const container = adjustments.aiPatches.find((p) => p.id === overData.parentId);
          const isTargetStandalone =
            container?.subMasks.length === 1 && [Mask.Clone, Mask.Heal].includes(container.subMasks[0].type);

          if (container && !isTargetStandalone) {
            const targetIndex = container.subMasks.findIndex((sm) => sm.id === over!.id);
            handleAddSubMask(overData.parentId!, dragData.maskType!, SubMaskMode.Additive, targetIndex);
          } else {
            handleAddAiPatchContainer(dragData.maskType!);
          }
        } else {
          handleAddAiPatchContainer(dragData.maskType!);
        }
      };

      if ((adjustments.aiPatches || []).length > 0) setPendingAction(() => creationFn);
      else creationFn();
      return;
    }

    if (dragData.type === 'Container') {
      const overId = over?.id;
      if (!overId || active.id === overId) return;

      setAdjustments((prev: Adjustments) => {
        const oldIndex = prev.aiPatches.findIndex((p) => p.id === dragData.item!.id);
        let newIndex = -1;

        if (overId === 'ai-list-root') newIndex = prev.aiPatches.length - 1;
        else if (overData?.type === 'Container') newIndex = prev.aiPatches.findIndex((p) => p.id === overId);
        else if (overData?.type === 'SubMask') newIndex = prev.aiPatches.findIndex((p) => p.id === overData.parentId);

        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          const newPatches = [...prev.aiPatches];
          const [movedItem] = newPatches.splice(oldIndex, 1);
          newPatches.splice(newIndex, 0, movedItem);
          return { ...prev, aiPatches: newPatches };
        }
        return prev;
      });
      return;
    }

    if (dragData.type === 'SubMask') {
      const sourceContainerId = dragData.parentId;
      if (!sourceContainerId) return;

      let targetContainerId: string | null = null;
      if (overData?.type === 'Container') targetContainerId = overData.item!.id;
      else if (overData?.type === 'SubMask') targetContainerId = overData.parentId || null;

      if (targetContainerId) {
        const targetContainer = adjustments.aiPatches.find((p) => p.id === targetContainerId);
        const isTargetStandalone =
          targetContainer?.subMasks.length === 1 && [Mask.Clone, Mask.Heal].includes(targetContainer.subMasks[0].type);

        const isSourceStandalone = [Mask.Clone, Mask.Heal].includes((dragData.item as SubMask).type);

        if ((isTargetStandalone || isSourceStandalone) && sourceContainerId !== targetContainerId) {
          return;
        }
      }

      if (over?.id === 'ai-list-root' || !over || !targetContainerId) {
        setAdjustments((prev: Adjustments) => {
          const newPatches = JSON.parse(JSON.stringify(prev.aiPatches));
          const sourceContainer = newPatches.find((p: AiPatch) => p.id === sourceContainerId);
          if (!sourceContainer) return prev;
          const subMaskIndex = sourceContainer.subMasks.findIndex((sm: SubMask) => sm.id === dragData.item!.id);
          if (subMaskIndex === -1) return prev;

          const [movedSubMask] = sourceContainer.subMasks.splice(subMaskIndex, 1);

          const newContainer: AiPatch = {
            id: uuidv4(),
            invert: false,
            isLoading: false,
            name: t('editor.ai.patches.aiEdit', { count: newPatches.length + 1 }),
            patchData: null,
            prompt: '',
            subMasks: [movedSubMask],
            visible: true,
          };
          newPatches.push(newContainer);

          setTimeout(() => {
            onSelectPatchContainer(newContainer.id);
            onSelectSubMask(movedSubMask.id);
            setExpandedContainers((p) => new Set(p).add(newContainer.id));
          }, 0);
          return { ...prev, aiPatches: newPatches };
        });
        return;
      }

      if (targetContainerId) {
        setAdjustments((prev: Adjustments) => {
          const newPatches = prev.aiPatches.map((p) => ({ ...p, subMasks: [...p.subMasks] }));
          const sourceContainer = newPatches.find((p) => p.id === sourceContainerId);
          const targetContainer = newPatches.find((p) => p.id === targetContainerId);
          if (!sourceContainer || !targetContainer) return prev;

          const sourceIndex = sourceContainer.subMasks.findIndex((sm) => sm.id === dragData.item!.id);
          if (sourceIndex === -1) return prev;
          const [movedSubMask] = sourceContainer.subMasks.splice(sourceIndex, 1);

          if (sourceContainerId === targetContainerId) {
            if (overData?.type === 'SubMask') {
              const overIndex = sourceContainer.subMasks.findIndex((sm) => sm.id === over.id);
              const insertIndex = overIndex >= 0 ? overIndex : sourceContainer.subMasks.length;
              sourceContainer.subMasks.splice(insertIndex, 0, movedSubMask);
            } else {
              sourceContainer.subMasks.push(movedSubMask);
            }
          } else {
            if (overData?.type === 'SubMask') {
              const overIndex = targetContainer.subMasks.findIndex((sm) => sm.id === over.id);
              const insertIndex = overIndex >= 0 ? overIndex : targetContainer.subMasks.length;
              targetContainer.subMasks.splice(insertIndex, 0, movedSubMask);
            } else {
              targetContainer.subMasks.push(movedSubMask);
            }
            setExpandedContainers((p) => new Set(p).add(targetContainerId!));
          }
          return { ...prev, aiPatches: newPatches };
        });
      }
    }
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      collisionDetection={pointerWithin}
    >
      <div className="flex flex-col h-full select-none overflow-hidden" onContextMenu={handlePanelContextMenu}>
        <div className="p-4 flex justify-between items-center shrink-0 border-b border-surface">
          <Text variant={TextVariants.title}>{t('editor.ai.inpaintingTitle')}</Text>
          <button
            className="p-2 rounded-full hover:bg-surface transition-colors"
            onClick={handleResetAllAiEdits}
            data-tooltip={t('editor.ai.resetInpaintingTooltip')}
          >
            <RotateCcw size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-h-0 p-4">
          <AnimatePresence mode="wait">
            {(adjustments.aiPatches || []).length === 0 ? (
              <motion.div
                key="ai-grid"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="z-10 shrink-0"
                onClick={handleDeselect}
              >
                {!selectedImage ? (
                  <Text
                    variant={TextVariants.heading}
                    color={TextColors.secondary}
                    weight={TextWeights.normal}
                    className="text-center mt-4"
                  >
                    {t('editor.ai.noImageSelected')}
                  </Text>
                ) : (
                  <>
                    <ConnectionStatus
                      aiProvider={aiProvider}
                      isAIConnectorConnected={isAIConnectorConnected}
                      isSignedIn={!!isSignedIn}
                      isPro={!!isPro}
                      cloudUsage={cloudUsage}
                    />

                    <Text variant={TextVariants.heading} className="mb-2 mt-6">
                      {t('editor.ai.manualCleanupTitle')}
                    </Text>
                    <div className="grid grid-cols-3 gap-2 mb-6" onClick={(e) => e.stopPropagation()}>
                      {AI_MANUAL_CLEANUP_TYPES.map((maskType: MaskType) => (
                        <DraggableGridItem
                          key={maskType.type}
                          maskType={maskType}
                          isGenerating={isGeneratingAi}
                          onClick={() => handleAddAiPatchContainer(maskType.type)}
                        />
                      ))}
                    </div>

                    <Text variant={TextVariants.heading} className="mb-2">
                      {t('editor.ai.generativeEditTitle')}
                    </Text>
                    <div className="grid grid-cols-3 gap-2" onClick={(e) => e.stopPropagation()}>
                      {AI_GENERATIVE_CREATION_TYPES.map((maskType: MaskType) => (
                        <DraggableGridItem
                          key={maskType.type}
                          maskType={maskType}
                          isGenerating={isGeneratingAi}
                          onClick={() => handleAddAiPatchContainer(maskType.type)}
                        />
                      ))}
                    </div>
                  </>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="ai-list"
                ref={setRootDroppableRef}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className={`flex flex-col transition-colors ${isRootOver ? 'bg-surface' : ''}`}
                onClick={handleDeselect}
              >
                <Text variant={TextVariants.heading} className="mb-2">
                  {t('editor.ai.editsTitle')}
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
                  {(adjustments.aiPatches || []).map((container) => (
                    <ContainerRow
                      key={container.id}
                      container={container}
                      isSelected={activePatchContainerId === container.id && activeSubMaskId === null}
                      hasActiveChild={activePatchContainerId === container.id && activeSubMaskId !== null}
                      isExpanded={expandedContainers.has(container.id)}
                      onToggle={() => handleToggleExpand(container.id)}
                      onSelect={() => {
                        onSelectPatchContainer(container.id);
                        onSelectSubMask(null);
                      }}
                      renamingId={renamingId}
                      setRenamingId={setRenamingId}
                      tempName={tempName}
                      setTempName={setTempName}
                      updateContainer={updatePatch}
                      handleDelete={handleDeleteContainer}
                      handleDuplicate={handleDuplicatePatchContainer}
                      handleDuplicateAndInvert={handleDuplicateAndInvertPatchContainer}
                      handlePastePatch={handlePastePatch}
                      copyPatchToClipboard={copyPatchToClipboard}
                      copiedPatch={copiedPatch}
                      setAdjustments={setAdjustments}
                      activeDragItem={activeDragItem}
                      activeSubMaskId={activeSubMaskId}
                      activePatchContainerId={activePatchContainerId}
                      onSelectContainer={onSelectPatchContainer}
                      onSelectSubMask={onSelectSubMask}
                      updateSubMask={updateSubMask}
                      handleDeleteSubMask={handleDeleteSubMask}
                      handleDuplicateSubMask={handleDuplicateSubMask}
                      handleDuplicateAndInvertSubMask={handleDuplicateAndInvertSubMask}
                      handlePasteSubMask={handlePasteSubMask}
                      copySubMaskToClipboard={copySubMaskToClipboard}
                      copiedSubMask={copiedSubMask}
                      analyzingSubMaskId={analyzingSubMaskId}
                      onAddComponent={(e: React.MouseEvent) => handleAddAiContextMenu(e, container.id)}
                    />
                  ))}
                </AnimatePresence>

                <AnimatePresence>
                  {activeDragItem?.type === 'Creation' && (adjustments.aiPatches || []).length > 0 && (
                    <NewMaskDropZone isOver={isRootOver} />
                  )}
                </AnimatePresence>

                <Text
                  as="div"
                  weight={TextWeights.medium}
                  className="flex items-center gap-2 p-2 rounded-md transition-colors transition-opacity opacity-70 hover:opacity-100 hover:bg-card-active cursor-pointer hover:text-text-primary"
                  onClick={(e) => handleAddAiContextMenu(e, null)}
                >
                  <div className="p-0.5">
                    <Plus size={18} />
                  </div>
                  <span>{t('editor.ai.addNewEdit')}</span>
                </Text>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="h-4 shrink-0 w-full" onClick={handleDeselect} />

          <AnimatePresence>
            {isSettingsPanelEverOpened && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="flex-1 min-h-0"
              >
                <Text variant={TextVariants.heading} className="mb-2">
                  {t('editor.ai.editSettingsTitle')}
                </Text>
                <SettingsPanel
                  container={activeContainer || null}
                  activeSubMask={activeSubMaskData || null}
                  aiModelDownloadStatus={aiModelDownloadStatus}
                  brushSettings={brushSettings}
                  setBrushSettings={setBrushSettings}
                  updateContainer={updatePatch}
                  updateSubMask={updateSubMask}
                  isGeneratingAi={isGeneratingAi}
                  isGeneratingAiMask={isGeneratingAiMask}
                  onGenerativeReplace={handleGenerativeReplace}
                  collapsibleState={collapsibleState}
                  setCollapsibleState={setCollapsibleState}
                  isGenerativeAvailable={isGenerativeAvailable}
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
                {(() => {
                  const item = activeDragItem.item as AiPatch;
                  const isStandalone =
                    item.subMasks.length === 1 && [Mask.Clone, Mask.Heal].includes(item.subMasks[0].type);
                  const Icon = isStandalone ? MASK_ICON_MAP[item.subMasks[0].type] || Circle : Wand2;
                  return <Icon size={18} className={TEXT_COLOR_KEYS[TextColors.secondary]} />;
                })()}
                <span className="flex-1 truncate">{(activeDragItem.item as AiPatch).name}</span>
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
                  const maskType = AI_SUB_MASK_COMPONENT_TYPES.find((m) => m.type === activeDragItem.maskType);
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
  const { t } = useTranslation();
  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0, marginTop: 0 }}
      animate={{ opacity: 1, height: 'auto', marginTop: '4px' }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={`p-4 rounded-lg text-center ${isOver ? 'border border-accent/80 bg-bg-tertiary/50' : ''}`}
    >
      <Text weight={TextWeights.medium}>{t('editor.ai.dropzoneText')}</Text>
    </motion.div>
  );
}

function DraggableGridItem({ maskType, isGenerating, onClick }: any) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `create-ai-${maskType.type}`,
    data: { type: 'Creation', maskType: maskType.type },
    disabled: isGenerating,
  });
  return (
    <motion.div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onClick}
      className={`bg-surface text-text-primary rounded-lg p-2 flex flex-col items-center justify-center gap-2 aspect-square transition-colors
            ${
              maskType.disabled || isGenerating
                ? 'opacity-50 cursor-not-allowed'
                : 'hover:bg-card-active active:bg-accent/20'
            }
            ${isDragging ? 'opacity-50' : ''}`}
      data-tooltip={
        maskType.disabled
          ? t('editor.ai.comingSoon')
          : t('editor.ai.createNewTooltip', { name: formatMaskTypeName(maskType.type) })
      }
      whileTap={{ scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 400, damping: 17 }}
    >
      <maskType.icon size={24} />{' '}
      <Text as="span" variant={TextVariants.small} color={TextColors.primary}>
        {formatMaskTypeName(maskType.type)}
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
  handlePastePatch,
  copyPatchToClipboard,
  copiedPatch,
  activeDragItem,
  activeSubMaskId,
  activePatchContainerId,
  onSelectContainer,
  onSelectSubMask,
  updateSubMask,
  handleDeleteSubMask,
  handleDuplicateSubMask,
  handleDuplicateAndInvertSubMask,
  handlePasteSubMask,
  copySubMaskToClipboard,
  copiedSubMask,
  analyzingSubMaskId,
  onAddComponent,
}: any) {
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

  const isStandalone = container.subMasks.length === 1 && [Mask.Clone, Mask.Heal].includes(container.subMasks[0].type);
  const firstSubMask = container.subMasks[0];
  const isRowSelected = isStandalone ? container.id === activePatchContainerId : isSelected;

  const setCombinedRef = (node: HTMLElement | null) => {
    setDroppableRef(node);
    setDraggableRef(node);
  };

  const handleRenameSubmit = () => {
    if (tempName.trim()) {
      updateContainer(container.id, { name: tempName.trim() });
    }
    setRenamingId(null);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const menuOptions: any[] = [
      {
        label: t('editor.ai.actions.rename'),
        icon: FileEdit,
        onClick: () => {
          setRenamingId(container.id);
          setTempName(container.name);
        },
      },
      { label: t('editor.ai.actions.duplicateEdit'), icon: PlusSquare, onClick: () => handleDuplicate(container) },
      {
        label: t('editor.ai.actions.duplicateAndInvertEdit'),
        icon: RotateCcw,
        onClick: () => handleDuplicateAndInvert(container),
      },
      { label: t('editor.ai.actions.copyEdit'), icon: Copy, onClick: () => copyPatchToClipboard(container) },
      {
        label: t('editor.ai.actions.pasteEdit'),
        icon: ClipboardPaste,
        disabled: !copiedPatch,
        onClick: () => handlePastePatch(container.id),
      },
      { type: OPTION_SEPARATOR },
    ];

    if (!isStandalone) {
      menuOptions.push({
        label: t('editor.ai.actions.resetSelection'),
        icon: RotateCcw,
        onClick: () => updateContainer(container.id, { subMasks: [] }),
      });
    }

    menuOptions.push({
      label: t('editor.ai.actions.deleteEdit'),
      icon: Trash2,
      isDestructive: true,
      onClick: () => handleDelete(container.id),
    });

    showContextMenu(e.clientX, e.clientY, menuOptions);
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
      if (!isStandalone) {
        borderClass = 'bg-card-active border border-accent/50';
      }
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
                ${isRowSelected ? 'bg-surface' : 'hover:bg-card-active'}
                ${borderClass}`}
        onClick={(e) => {
          e.stopPropagation();
          if (isStandalone) {
            onSelectContainer(container.id);
            onSelectSubMask(firstSubMask.id);
          } else {
            onSelect();
          }
        }}
        onContextMenu={onContextMenu}
      >
        <Text
          as="div"
          color={hasActiveChild || isExpanded || isStandalone ? TextColors.primary : TextColors.secondary}
          onClick={(e) => {
            e.stopPropagation();
            if (isStandalone) {
              onSelectContainer(container.id);
              onSelectSubMask(firstSubMask.id);
            } else {
              onToggle();
            }
          }}
          className="p-0.5 rounded transition-colors cursor-pointer"
        >
          {isStandalone ? (
            (() => {
              const StandaloneIcon = MASK_ICON_MAP[firstSubMask.type] || Circle;
              return <StandaloneIcon size={18} />;
            })()
          ) : isExpanded ? (
            <FolderOpen size={18} />
          ) : (
            <Wand2 size={18} />
          )}
        </Text>
        <div
          className="flex-1 min-w-0 cursor-pointer"
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (!isStandalone) {
              onToggle();
            }
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
            data-tooltip={container.visible ? t('editor.ai.actions.hideEdit') : t('editor.ai.actions.showEdit')}
            onClick={(e) => {
              e.stopPropagation();
              updateContainer(container.id, { visible: !container.visible });
            }}
          >
            {container.visible ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
          <button
            className="p-1 hover:text-red-500 text-text-secondary"
            data-tooltip={t('editor.ai.actions.deleteEdit')}
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
        {!isStandalone && isExpanded && (
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
                  isActive={activeSubMaskId === subMask.id}
                  parentVisible={container.visible}
                  activeDragItem={activeDragItem}
                  onSelect={() => {
                    onSelectContainer(container.id);
                    onSelectSubMask(subMask.id);
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
                  isParentLoading={container.isLoading}
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
                    <span className="select-none">{t('editor.ai.actions.addNewComponent')}</span>
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
  isParentLoading,
}: any) {
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
  const isAnalyzing = subMask.id === analyzingSubMaskId || (isParentLoading && subMask.type === Mask.QuickEraser);

  const handleMouseEnter = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setIsHovered(true);
  };
  const handleMouseLeave = () => {
    hoverTimeoutRef.current = setTimeout(() => setIsHovered(false), 1000);
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
        label: t('editor.ai.actions.rename'),
        icon: FileEdit,
        onClick: () => {
          setRenamingId(subMask.id);
          setTempName(getSubMaskName(subMask));
        },
      },
      { label: t('editor.ai.actions.duplicateComponent'), icon: PlusSquare, onClick: handleDuplicate },
      { label: t('editor.ai.actions.duplicateAndInvertComponent'), icon: RotateCcw, onClick: handleDuplicateAndInvert },
      { label: t('editor.ai.actions.copyComponent'), icon: Copy, onClick: handleCopy },
      {
        label: t('editor.ai.actions.pasteComponent'),
        icon: ClipboardPaste,
        disabled: !hasCopiedSubMask,
        onClick: handlePaste,
      },
      { type: OPTION_SEPARATOR },
      { label: t('editor.ai.actions.deleteComponent'), icon: Trash2, isDestructive: true, onClick: handleDelete },
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
                ? t('editor.ai.actions.switchToSubtract')
                : subMask.mode === SubMaskMode.Subtractive
                  ? t('editor.ai.actions.switchToIntersect')
                  : t('editor.ai.actions.switchToAdd')
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

function SettingsPanel({
  container,
  activeSubMask,
  aiModelDownloadStatus,
  brushSettings,
  setBrushSettings,
  updateContainer,
  updateSubMask,
  isGeneratingAi,
  isGeneratingAiMask: _isGeneratingAiMask,
  onGenerativeReplace,
  collapsibleState,
  setCollapsibleState,
  isGenerativeAvailable,
}: any) {
  const { t } = useTranslation();
  const isActive = !!container;
  const isComponentMode = !!activeSubMask;
  const displayContainer = container || PLACEHOLDER_PATCH;
  const [prompt, setPrompt] = useState(displayContainer.prompt || '');
  const [useFastInpaint, setUseFastInpaint] = useState(!isGenerativeAvailable);
  const prevContainerId = useRef<string | null>(null);

  useEffect(() => {
    if (container) setPrompt(container.prompt || '');
  }, [container?.id]);

  const isQuickErasePatch = displayContainer.subMasks?.some((sm: SubMask) => sm.type === Mask.QuickEraser);
  const isCloneOrHealPatch = displayContainer.subMasks?.some(
    (sm: SubMask) => sm.type === Mask.Clone || sm.type === Mask.Heal,
  );
  const isStandalone =
    displayContainer?.subMasks?.length === 1 && [Mask.Clone, Mask.Heal].includes(displayContainer.subMasks[0].type);

  useEffect(() => {
    if (container) {
      if (!isGenerativeAvailable) {
        setUseFastInpaint(true);
      } else if (container.id !== prevContainerId.current) {
        setUseFastInpaint(isQuickErasePatch);
        prevContainerId.current = container.id;
      }
    } else {
      prevContainerId.current = null;
    }
  }, [isGenerativeAvailable, container, isQuickErasePatch]);

  const subMaskConfig = activeSubMask ? SUB_MASK_CONFIG[activeSubMask.type] || {} : {};
  const isAiMask =
    activeSubMask &&
    (activeSubMask.type === Mask.AiSubject ||
      activeSubMask.type === Mask.AiForeground ||
      activeSubMask.type === Mask.AiSky);

  const handleGenerateClick = () => {
    if (!container) return;
    updateContainer(container.id, { prompt });
    onGenerativeReplace(container.id, prompt, useFastInpaint);
  };

  const handleToggleSection = (section: string) =>
    setCollapsibleState((prev: any) => ({ ...prev, [section]: !prev[section] }));

  return (
    <div
      className={`space-y-2 transition-opacity duration-300 ${!isActive ? 'opacity-50 pointer-events-none' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      {!isCloneOrHealPatch && (
        <CollapsibleSection
          title={t('editor.ai.settings.generativeReplaceTitle')}
          isOpen={collapsibleState.generative}
          onToggle={() => handleToggleSection('generative')}
          canToggleVisibility={false}
          isContentVisible={true}
        >
          <div className="space-y-4 pt-2">
            {aiModelDownloadStatus && aiModelDownloadStatus.includes('Inpainting') && (
              <Text
                as="div"
                variant={TextVariants.small}
                color={TextColors.accent}
                weight={TextWeights.medium}
                className="p-3 bg-card-active rounded-md border border-surface flex items-center gap-3"
              >
                <Loader2 size={16} className="animate-spin shrink-0" />
                <div className="leading-relaxed">
                  <Text variant={TextVariants.small}>{t('editor.ai.settings.downloading')}</Text>
                  <span>{aiModelDownloadStatus}</span>
                </div>
              </Text>
            )}

            <Text variant={TextVariants.small}>
              {isQuickErasePatch
                ? t('editor.ai.settings.quickEraseDesc')
                : useFastInpaint
                  ? t('editor.ai.settings.fastInpaintDesc')
                  : t('editor.ai.settings.generativeDesc')}
            </Text>

            <div>
              <Switch
                checked={useFastInpaint}
                disabled={!isGenerativeAvailable}
                label={t('editor.ai.settings.useBasicInpaint')}
                onChange={setUseFastInpaint}
                tooltip={
                  !isGenerativeAvailable
                    ? t('editor.ai.settings.basicInpaintTooltipDisabled')
                    : t('editor.ai.settings.basicInpaintTooltipEnabled')
                }
              />

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
                        className="grow"
                        disabled={isGeneratingAi || displayContainer.isLoading}
                        onChange={(e: any) => {
                          setPrompt(e.target.value);
                        }}
                        onBlur={() => isActive && updateContainer(container.id, { prompt })}
                        onKeyDown={(e: any) => {
                          if (e.key === 'Enter') handleGenerateClick();
                        }}
                        placeholder={t('editor.ai.settings.placeholder')}
                        type="text"
                        value={prompt}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <Button
              className="w-full"
              disabled={isGeneratingAi || displayContainer.isLoading || displayContainer.subMasks.length === 0}
              onClick={handleGenerateClick}
            >
              {isGeneratingAi || displayContainer.isLoading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Send size={16} />
              )}
              <span className="ml-2">
                {isGeneratingAi || displayContainer.isLoading
                  ? t('editor.ai.settings.generating')
                  : useFastInpaint
                    ? t('editor.ai.settings.inpaintSelectionButton')
                    : t('editor.ai.settings.generateWithAiButton')}
              </span>
            </Button>
          </div>
        </CollapsibleSection>
      )}

      <CollapsibleSection
        title={
          isStandalone
            ? t('editor.ai.settings.selectionPropertiesTitle')
            : isComponentMode
              ? t('editor.ai.settings.componentPropertiesTitle', { name: getSubMaskName(activeSubMask) })
              : t('editor.ai.settings.selectionPropertiesTitle')
        }
        isOpen={collapsibleState.properties}
        onToggle={() => handleToggleSection('properties')}
        canToggleVisibility={false}
        isContentVisible={true}
      >
        <div className="space-y-4 pt-2">
          {!isCloneOrHealPatch && (
            <Switch
              checked={!!(isComponentMode ? activeSubMask.invert : displayContainer.invert)}
              label={
                isComponentMode && !isStandalone
                  ? t('editor.ai.settings.invertComponent')
                  : t('editor.ai.settings.invertSelection')
              }
              onChange={(v) =>
                isComponentMode
                  ? updateSubMask(activeSubMask.id, { invert: v })
                  : updateContainer(container.id, { invert: v })
              }
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
                    <Text variant={TextVariants.small}>{t('editor.ai.settings.aiModelDownloading')}</Text>
                    <span>{aiModelDownloadStatus}</span>
                  </div>
                </Text>
              )}

              {subMaskConfig.parameters?.map((param: any) => (
                <Slider
                  key={param.key}
                  label={t('editor.ai.params.' + param.key)}
                  min={param.min}
                  max={param.max}
                  step={param.step}
                  defaultValue={param.defaultValue}
                  value={(activeSubMask.parameters[param.key] || 0) * (param.multiplier || 1)}
                  onChange={(e: any) =>
                    updateSubMask(activeSubMask.id, {
                      parameters: {
                        ...activeSubMask.parameters,
                        [param.key]: parseFloat(e.target.value) / (param.multiplier || 1),
                      },
                    })
                  }
                  {...(param.key !== 'grow' && { fillOrigin: 'min' })}
                />
              ))}

              {subMaskConfig.showBrushTools && brushSettings && (
                <BrushTools settings={brushSettings} onSettingsChange={setBrushSettings} />
              )}
            </>
          )}
        </div>
      </CollapsibleSection>
    </div>
  );
}
