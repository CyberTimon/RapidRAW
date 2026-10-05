import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import {
  Adjustments,
  AiPatch,
  INITIAL_ADJUSTMENTS,
  INITIAL_MASK_ADJUSTMENTS,
  INITIAL_MASK_CONTAINER,
  MaskContainer,
} from '../utils/adjustments';
import { createSubMask } from '../utils/maskUtils';
import { Mask, SubMask, SubMaskMode } from '../components/panel/right/Masks';
import { Invokes, Preset } from '../components/ui/AppProperties';

type BridgeRequest = {
  requestId: string;
  action: string;
  params?: Record<string, unknown>;
};

type NormBox = { x: number; y: number; w: number; h: number };

function setDeepValue(obj: Record<string, unknown>, key: string, value: unknown) {
  if (!key.includes('.')) {
    return { ...obj, [key]: value };
  }
  const parts = key.split('.');
  const root = { ...obj };
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    cursor[p] = { ...(cursor[p] as Record<string, unknown> | undefined) };
    cursor = cursor[p] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  return root;
}

function getDeepValue(obj: Record<string, unknown>, key: string): unknown {
  if (!key.includes('.')) return obj[key];
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
    return undefined;
  }, obj);
}

function getTransformAdjustments(adj: Adjustments) {
  return {
    transformDistortion: adj.transformDistortion,
    transformVertical: adj.transformVertical,
    transformHorizontal: adj.transformHorizontal,
    transformRotate: adj.transformRotate,
    transformAspect: adj.transformAspect,
    transformScale: adj.transformScale,
    transformXOffset: adj.transformXOffset,
    transformYOffset: adj.transformYOffset,
    lensDistortionAmount: adj.lensDistortionAmount,
    lensVignetteAmount: adj.lensVignetteAmount,
    lensTcaAmount: adj.lensTcaAmount,
    lensDistortionParams: adj.lensDistortionParams,
    lensMaker: adj.lensMaker,
    lensModel: adj.lensModel,
    lensDistortionEnabled: adj.lensDistortionEnabled,
    lensTcaEnabled: adj.lensTcaEnabled,
    lensVignetteEnabled: adj.lensVignetteEnabled,
  };
}

function maskTypeFromParam(raw: string): Mask | null {
  switch (String(raw || '').toLowerCase()) {
    case 'sky':
      return Mask.AiSky;
    case 'foreground':
      return Mask.AiForeground;
    case 'subject':
      return Mask.AiSubject;
    case 'depth':
      return Mask.AiDepth;
    default:
      return null;
  }
}

function commitAdjustments(next: Adjustments) {
  const editor = useEditorStore.getState();
  editor.pushHistory(next);
  useEditorStore.setState({ adjustments: next });
}

async function generateAiMaskAction(params: Record<string, unknown>) {
  const editor = useEditorStore.getState();
  const selected = editor.selectedImage;
  if (!selected?.path) {
    throw Object.assign(new Error('No image open'), { code: 'no_image' });
  }

  const maskType = maskTypeFromParam(String(params.type ?? ''));
  if (!maskType) {
    throw Object.assign(new Error('Unsupported mask type'), { code: 'invalid_type' });
  }

  const steps = editor.adjustments.orientationSteps || 0;
  const isRotated = steps === 1 || steps === 3;
  const imgW = isRotated ? selected.height || 1000 : selected.width || 1000;
  const imgH = isRotated ? selected.width || 1000 : selected.height || 1000;

  const subMask = createSubMask(maskType, { width: imgW, height: imgH }, SubMaskMode.Additive);
  if (maskType === Mask.AiDepth) {
    subMask.parameters = {
      ...(subMask.parameters || {}),
      minDepth: 20,
      maxDepth: 100,
      minFade: 15,
      maxFade: 15,
      feather: 10,
    };
  }

  const containerId = crypto.randomUUID();
  const container: MaskContainer = {
    ...INITIAL_MASK_CONTAINER,
    id: containerId,
    name: `AI ${String(params.type)}`,
    adjustments: { ...INITIAL_MASK_ADJUSTMENTS },
    subMasks: [subMask],
  };

  const withContainer: Adjustments = {
    ...editor.adjustments,
    masks: [...(editor.adjustments.masks || []), container],
  };
  commitAdjustments(withContainer);
  useEditorStore.setState({
    activeMaskContainerId: containerId,
    activeMaskId: subMask.id,
  });

  const transformAdjustments = getTransformAdjustments(withContainer);
  const common = {
    jsAdjustments: transformAdjustments,
    flipHorizontal: withContainer.flipHorizontal,
    flipVertical: withContainer.flipVertical,
    orientationSteps: withContainer.orientationSteps,
    rotation: withContainer.rotation,
    taskId: subMask.id,
  };

  let newParameters: Record<string, unknown>;
  if (maskType === Mask.AiSky) {
    newParameters = await invoke(Invokes.GenerateAiSkyMask, common);
  } else if (maskType === Mask.AiForeground) {
    newParameters = await invoke(Invokes.GenerateAiForegroundMask, common);
  } else if (maskType === Mask.AiDepth) {
    newParameters = await invoke('generate_ai_depth_mask', {
      ...common,
      path: selected.path,
      minDepth: subMask.parameters?.minDepth ?? 20,
      maxDepth: subMask.parameters?.maxDepth ?? 100,
      minFade: subMask.parameters?.minFade ?? 15,
      maxFade: subMask.parameters?.maxFade ?? 15,
      feather: subMask.parameters?.feather ?? 10,
    });
  } else {
    const box = params.box as NormBox | undefined;
    if (!box) {
      throw Object.assign(new Error('subject requires box'), { code: 'box_required' });
    }
    const startPoint: [number, number] = [box.x * imgW, box.y * imgH];
    const endPoint: [number, number] = [(box.x + box.w) * imgW, (box.y + box.h) * imgH];
    newParameters = await invoke(Invokes.GenerateAiSubjectMask, {
      ...common,
      path: selected.path,
      startPoint,
      endPoint,
    });
  }

  const latest = useEditorStore.getState().adjustments;
  const merged: Adjustments = {
    ...latest,
    masks: (latest.masks || []).map((c) =>
      c.id === containerId
        ? {
            ...c,
            subMasks: c.subMasks.map((sm: SubMask) =>
              sm.id === subMask.id
                ? { ...sm, parameters: { ...(sm.parameters || {}), ...newParameters } }
                : sm,
            ),
          }
        : c,
    ),
  };
  commitAdjustments(merged);

  return {
    maskId: containerId,
    subMaskId: subMask.id,
    type: params.type,
    adjustments: merged,
  };
}

async function adjustMaskAction(params: Record<string, unknown>) {
  const editor = useEditorStore.getState();
  const maskId = (params.maskId as string | undefined) || editor.activeMaskContainerId;
  const patch = (params.adjustments || {}) as Record<string, unknown>;
  if (!maskId) {
    throw Object.assign(new Error('No maskId and no active mask'), { code: 'no_mask' });
  }

  const masks = editor.adjustments.masks || [];
  const idx = masks.findIndex((m) => m.id === maskId);
  if (idx < 0) {
    throw Object.assign(new Error(`Mask not found: ${maskId}`), { code: 'not_found' });
  }

  const target = masks[idx];
  const nextMask: MaskContainer = {
    ...target,
    adjustments: {
      ...target.adjustments,
      ...patch,
    },
  };
  const next: Adjustments = {
    ...editor.adjustments,
    masks: masks.map((m, i) => (i === idx ? nextMask : m)),
  };
  commitAdjustments(next);
  useEditorStore.setState({ activeMaskContainerId: maskId });
  return { maskId, adjustments: nextMask.adjustments };
}

async function aiEraseAction(params: Record<string, unknown>) {
  const editor = useEditorStore.getState();
  const selected = editor.selectedImage;
  if (!selected?.path) {
    throw Object.assign(new Error('No image open'), { code: 'no_image' });
  }

  const mode = String(params.mode || 'quick').toLowerCase();
  const prompt = String(params.prompt || '');
  const useFastInpaint = mode === 'quick';

  if (!useFastInpaint) {
    throw Object.assign(
      new Error(
        'Generative erase requires cloud AI provider / connector auth. Use mode=quick (LaMa) for local erase, or run generative replace from the RapidRAW AI panel.',
      ),
      { code: 'generative_unavailable' },
    );
  }

  let adjustments = editor.adjustments;
  let patchId = params.maskId as string | undefined;
  let patch = (adjustments.aiPatches || []).find((p) => p.id === patchId);

  if (!patch && patchId) {
    const maskContainer = (adjustments.masks || []).find((m) => m.id === patchId);
    if (maskContainer) {
      const converted: AiPatch = {
        id: crypto.randomUUID(),
        invert: maskContainer.invert,
        isLoading: false,
        name: maskContainer.name || 'Quick Erase',
        patchData: null,
        prompt: '',
        subMasks: maskContainer.subMasks,
        visible: true,
      };
      adjustments = {
        ...adjustments,
        aiPatches: [...(adjustments.aiPatches || []), converted],
      };
      commitAdjustments(adjustments);
      patch = converted;
      patchId = converted.id;
    }
  }

  if (!patch) {
    throw Object.assign(
      new Error(
        'maskId required for erase. First call POST /v1/masks/ai (e.g. subject/foreground) then pass returned maskId.',
      ),
      { code: 'mask_required' },
    );
  }

  const patchDefinition = { ...patch, prompt, isLoading: true };
  const loading: Adjustments = {
    ...adjustments,
    aiPatches: (adjustments.aiPatches || []).map((p) =>
      p.id === patchId ? { ...p, isLoading: true, prompt } : p,
    ),
  };
  commitAdjustments(loading);

  try {
    const newPatchDataJson: string = await invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, {
      currentAdjustments: loading,
      patchDefinition,
      path: selected.path,
      useFastInpaint: true,
      token: null,
      taskId: patchId,
    });
    const newPatchData = JSON.parse(newPatchDataJson);
    const after = useEditorStore.getState().adjustments;
    const done: Adjustments = {
      ...after,
      aiPatches: (after.aiPatches || []).map((p) =>
        p.id === patchId
          ? { ...p, patchData: newPatchData, isLoading: false, name: 'Inpaint' }
          : p,
      ),
    };
    commitAdjustments(done);
    useEditorStore.setState({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
    return { patchId, mode: 'quick', adjustments: done };
  } catch (e) {
    const after = useEditorStore.getState().adjustments;
    commitAdjustments({
      ...after,
      aiPatches: (after.aiPatches || []).map((p) =>
        p.id === patchId ? { ...p, isLoading: false } : p,
      ),
    });
    throw e;
  }
}

async function aiDenoiseAction(params: Record<string, unknown>) {
  const editor = useEditorStore.getState();
  const path = (params.path as string | undefined) || editor.selectedImage?.path;
  if (!path) {
    throw Object.assign(new Error('No image path'), { code: 'no_image' });
  }
  const method = String(params.method || 'ai');
  const intensity = Number(params.intensity ?? 50);
  await invoke(Invokes.ApplyDenoising, {
    path,
    intensity,
    method,
  });
  return { path, method, intensity };
}

export function useExternalControlBridge(
  handleImageSelect?: (path: string, openInEditor?: boolean) => void,
) {
  useEffect(() => {
    const interval = setInterval(() => {
      const state = useEditorStore.getState();
      const lib = useLibraryStore.getState();
      void invoke('external_control_push_session', {
        session: {
          currentImagePath: state.selectedImage?.path ?? null,
          adjustments: state.adjustments,
          canUndo: state.historyIndex > 0,
          canRedo: state.historyIndex < state.history.length - 1,
          selectedPaths: lib.multiSelectedPaths ?? [],
          currentFolder: lib.currentFolderPath ?? null,
        },
      });
    }, 500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<BridgeRequest>('external-control-command', async (event) => {
      const { requestId, action, params = {} } = event.payload;
      const fail = async (code: string, message: string) => {
        await invoke('external_control_fulfill_request', {
          response: { requestId, ok: false, data: {}, error: { code, message, details: {} } },
        });
      };
      const ok = async (data: unknown) => {
        await invoke('external_control_fulfill_request', {
          response: { requestId, ok: true, data, error: null },
        });
      };

      try {
        const editor = useEditorStore.getState();
        const library = useLibraryStore.getState();

        switch (action) {
          case 'get_adjustments':
            await ok({ adjustments: editor.adjustments });
            break;
          case 'set_adjustment': {
            const key = String(params.key ?? '');
            const value = params.value;
            const next = setDeepValue(
              editor.adjustments as unknown as Record<string, unknown>,
              key,
              value,
            ) as Adjustments;
            editor.pushHistory(next);
            useEditorStore.setState({ adjustments: next });
            await ok({ adjustments: next });
            break;
          }
          case 'adjust_parameter': {
            const key = String(params.key ?? '');
            const delta = Number(params.delta ?? 0);
            const current = Number(
              getDeepValue(editor.adjustments as unknown as Record<string, unknown>, key) ?? 0,
            );
            const nextVal = current + delta;
            const next = setDeepValue(
              editor.adjustments as unknown as Record<string, unknown>,
              key,
              nextVal,
            ) as Adjustments;
            editor.pushHistory(next);
            useEditorStore.setState({ adjustments: next });
            await ok({ adjustments: next, key, value: nextVal });
            break;
          }
          case 'reset_adjustments':
            editor.resetHistory(INITIAL_ADJUSTMENTS);
            await ok({ adjustments: INITIAL_ADJUSTMENTS });
            break;
          case 'undo':
            editor.undo();
            await ok({ adjustments: useEditorStore.getState().adjustments });
            break;
          case 'redo':
            editor.redo();
            await ok({ adjustments: useEditorStore.getState().adjustments });
            break;
          case 'open_image': {
            const path = String(params.path ?? '');
            if (handleImageSelect) {
              handleImageSelect(path, true);
              await ok({ path });
            } else {
              await fail('unavailable', 'Image navigation handler not ready');
            }
            break;
          }
          case 'next_image':
          case 'previous_image': {
            const imgs = library.imageList;
            const current = editor.selectedImage?.path ?? library.libraryActivePath;
            const idx = imgs.findIndex((i) => i.path === current);
            if (idx < 0) {
              await fail('no_image', 'No current image');
              break;
            }
            const nextIdx = action === 'next_image' ? idx + 1 : idx - 1;
            if (nextIdx < 0 || nextIdx >= imgs.length) {
              await fail('boundary', 'No more images in list');
              break;
            }
            const target = imgs[nextIdx];
            if (handleImageSelect) {
              handleImageSelect(target.path, true);
              await ok({ path: target.path });
            } else {
              await fail('unavailable', 'Image navigation handler not ready');
            }
            break;
          }
          case 'list_presets': {
            const presets: Array<{ preset?: Preset; name?: string }> = await invoke(Invokes.LoadPresets);
            await ok({
              presets: presets.map((p) => p.preset?.name ?? p.name).filter(Boolean),
            });
            break;
          }
          case 'apply_preset': {
            const name = String(params.name ?? '');
            const presets: Array<{ preset?: Preset }> = await invoke(Invokes.LoadPresets);
            const match = presets.find((p) => p.preset?.name === name);
            if (!match?.preset) {
              await fail('not_found', `Preset not found: ${name}`);
              break;
            }
            const merged = {
              ...editor.adjustments,
              ...match.preset.adjustments,
            } as Adjustments;
            editor.pushHistory(merged);
            useEditorStore.setState({ adjustments: merged });
            await ok({ name, adjustments: merged });
            break;
          }
          case 'save_preset': {
            await fail('not_implemented', 'Use RapidRAW UI to save presets with mask/crop options for now');
            break;
          }
          case 'copy_adjustments':
            useEditorStore.setState({ copiedAdjustments: editor.adjustments });
            await ok({});
            break;
          case 'paste_adjustments': {
            const copied = useEditorStore.getState().copiedAdjustments;
            if (!copied) {
              await fail('empty_clipboard', 'No copied adjustments');
              break;
            }
            editor.pushHistory(copied);
            useEditorStore.setState({ adjustments: copied });
            await ok({ adjustments: copied });
            break;
          }
          case 'apply_adjustments_to_images': {
            const paths = (params.paths as string[]) ?? [];
            await invoke(Invokes.ApplyAdjustmentsToPaths, {
              paths,
              adjustments: editor.adjustments,
            });
            await ok({ paths });
            break;
          }
          case 'generate_ai_mask':
            await ok(await generateAiMaskAction(params));
            break;
          case 'adjust_mask':
            await ok(await adjustMaskAction(params));
            break;
          case 'ai_erase':
            await ok(await aiEraseAction(params));
            break;
          case 'ai_denoise':
            await ok(await aiDenoiseAction(params));
            break;
          default:
            await fail('unknown_action', `Unsupported action: ${action}`);
        }
      } catch (e) {
        const code =
          e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : 'handler_error';
        await fail(code, e instanceof Error ? e.message : String(e));
      }
    });
    return () => {
      void unlistenPromise.then((fn) => fn());
    };
  }, [handleImageSelect]);
}
