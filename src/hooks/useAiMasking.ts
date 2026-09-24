import { useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { v4 as uuidv4 } from 'uuid';
import { useEditorStore } from '../store/useEditorStore';
import { useEditorActions } from './useEditorActions';
import { Adjustments, AiPatch, MaskContainer, Coord, INITIAL_MASK_ADJUSTMENTS, INITIAL_MASK_CONTAINER } from '../utils/adjustments';
import { Mask, SubMask, SubMaskMode } from '../components/panel/right/Masks';
import { Invokes } from '../components/ui/AppProperties';
import { useSafeAuth } from '../context/AuthContext';

const getTransformAdjustments = (adj: Adjustments) => ({
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
});

export function useAiMasking() {
  const { setAdjustments } = useEditorActions();
  const setEditor = useEditorStore((state) => state.setEditor);
  const { getToken } = useSafeAuth();

  const updateSubMask = useCallback(
    (subMaskId: string, updatedData: any) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        masks: prev.masks.map((c: MaskContainer) => ({
          ...c,
          subMasks: c.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
        })),
        aiPatches: (prev.aiPatches || []).map((p: AiPatch) => ({
          ...p,
          subMasks: p.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
        })),
      }));
    },
    [setAdjustments],
  );

  const handleManualCleanup = useCallback(
    async (subMaskId: string, sourceX: number, sourceY: number) => {
      const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
      if (!selectedImage?.path) return;

      const patchId = adjustments.aiPatches.find((p: AiPatch) =>
        p.subMasks.some((sm: SubMask) => sm.id === subMaskId),
      )?.id;
      if (!patchId) return;

      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: true } : p)),
      }));

      try {
        const patchDefinitionForBackend = adjustments.aiPatches.find((p: AiPatch) => p.id === patchId);
        const hasRetouch = patchDefinitionForBackend?.subMasks?.some((sm: SubMask) => sm.type === Mask.Retouch);
        const hasLiquify = patchDefinitionForBackend?.subMasks?.some((sm: SubMask) => sm.type === Mask.Liquify);

        let newPatchDataJson: any;
        if (hasRetouch) {
          newPatchDataJson = await invoke('generate_retouch_patch', {
            patchDefinition: patchDefinitionForBackend,
            currentAdjustments: adjustments,
          });
        } else if (hasLiquify) {
          newPatchDataJson = await invoke('generate_liquify_patch', {
            patchDefinition: patchDefinitionForBackend,
            currentAdjustments: adjustments,
            sourcePoint: [sourceX, sourceY],
          });
        } else {
          newPatchDataJson = await invoke('generate_manual_cleanup_patch', {
            currentAdjustments: adjustments,
            patchDefinition: patchDefinitionForBackend,
            sourcePoint: [sourceX, sourceY],
          });
        }

        const newPatchData = JSON.parse(newPatchDataJson);
        patchesSentToBackend.delete(patchId);

        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) =>
            p.id === patchId ? { ...p, patchData: newPatchData, isLoading: false } : p,
          ),
        }));
      } catch (err: any) {
        toast.error(`Cleanup Failed: ${err.message || String(err)}`);
        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
        }));
      }
    },
    [setAdjustments, getToken],
  );

  const handleGenerativeReplace = useCallback(
    async (patchId: string, prompt: string, useFastInpaint: boolean) => {
      const { selectedImage, adjustments, isGeneratingAi, patchesSentToBackend } = useEditorStore.getState();
      if (!selectedImage?.path || isGeneratingAi) return;

      const patch: AiPatch | undefined = adjustments.aiPatches.find((p: AiPatch) => p.id === patchId);
      if (!patch) return;

      const patchDefinition = { ...patch, prompt };
      const token = await getToken();

      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: prev.aiPatches.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: true, prompt } : p)),
      }));

      setEditor({ isGeneratingAi: true });

      try {
        const newPatchDataJson: any = await invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, {
          currentAdjustments: adjustments,
          patchDefinition: patchDefinition,
          path: selectedImage.path,
          useFastInpaint: useFastInpaint,
          token: token || null,
        });

        const newPatchData = JSON.parse(newPatchDataJson);
        patchesSentToBackend.delete(patchId);

        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  patchData: newPatchData,
                  isLoading: false,
                  name: useFastInpaint ? 'Inpaint' : prompt && prompt.trim() ? prompt.trim() : p.name,
                }
              : p,
          ),
        }));
        setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
      } catch (err) {
        toast.error(`AI Replace Failed: ${err}`);
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
        }));
      } finally {
        setEditor({ isGeneratingAi: false });
      }
    },
    [setAdjustments, setEditor],
  );

  const handleQuickErase = useCallback(
    async (subMaskId: string | null, startPoint: Coord, endPoint: Coord) => {
      const { selectedImage, adjustments, isGeneratingAi, patchesSentToBackend } = useEditorStore.getState();
      if (!selectedImage?.path || isGeneratingAi) return;
      const token = await getToken();

      const patchId = adjustments.aiPatches.find((p: AiPatch) =>
        p.subMasks.some((sm: SubMask) => sm.id === subMaskId),
      )?.id;
      if (!patchId) return;

      setEditor({ isGeneratingAi: true });
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: true } : p)),
      }));

      try {
        const transformAdjustments = getTransformAdjustments(adjustments);
        const newMaskParams: any = await invoke(Invokes.GenerateAiSubjectMask, {
          jsAdjustments: transformAdjustments,
          endPoint: [endPoint.x, endPoint.y],
          flipHorizontal: adjustments.flipHorizontal,
          flipVertical: adjustments.flipVertical,
          orientationSteps: adjustments.orientationSteps,
          path: selectedImage.path,
          rotation: adjustments.rotation,
          startPoint: [startPoint.x, startPoint.y],
        });

        const subMaskToUpdate = adjustments.aiPatches
          ?.find((p: AiPatch) => p.id === patchId)
          ?.subMasks.find((sm: SubMask) => sm.id === subMaskId);
        const finalSubMaskParams: any = { ...subMaskToUpdate?.parameters, ...newMaskParams };
        const updatedAdjustmentsForBackend = {
          ...adjustments,
          aiPatches: adjustments.aiPatches.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  subMasks: p.subMasks.map((sm: SubMask) =>
                    sm.id === subMaskId ? { ...sm, parameters: finalSubMaskParams } : sm,
                  ),
                }
              : p,
          ),
        };

        const patchDefinitionForBackend = updatedAdjustmentsForBackend.aiPatches.find((p: AiPatch) => p.id === patchId);
        const newPatchDataJson: any = await invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, {
          currentAdjustments: updatedAdjustmentsForBackend,
          patchDefinition: { ...patchDefinitionForBackend, prompt: '' },
          path: selectedImage.path,
          useFastInpaint: true,
          token: token || null,
        });

        const newPatchData = JSON.parse(newPatchDataJson);
        patchesSentToBackend.delete(patchId);

        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  patchData: newPatchData,
                  isLoading: false,
                  subMasks: p.subMasks.map((sm: SubMask) =>
                    sm.id === subMaskId ? { ...sm, parameters: finalSubMaskParams } : sm,
                  ),
                }
              : p,
          ),
        }));
        setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
      } catch (err: any) {
        toast.error(`Quick Erase Failed: ${err.message || String(err)}`);
        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
        }));
      } finally {
        setEditor({ isGeneratingAi: false });
      }
    },
    [setAdjustments, setEditor],
  );

  const handleDeleteMaskContainer = useCallback(
    (containerId: string) => {
      const { activeMaskContainerId } = useEditorStore.getState();
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        masks: (prev.masks || []).filter((c) => c.id !== containerId),
      }));
      if (activeMaskContainerId === containerId) {
        setEditor({ activeMaskContainerId: null, activeMaskId: null });
      }
    },
    [setAdjustments, setEditor],
  );

  const handleDeleteAiPatch = useCallback(
    (patchId: string) => {
      const { activeAiPatchContainerId } = useEditorStore.getState();
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).filter((p) => p.id !== patchId),
      }));
      if (activeAiPatchContainerId === patchId) {
        setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
      }
    },
    [setAdjustments, setEditor],
  );

  const handleToggleAiPatchVisibility = useCallback(
    (patchId: string) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).map((p: AiPatch) => (p.id === patchId ? { ...p, visible: !p.visible } : p)),
      }));
    },
    [setAdjustments],
  );

  const handleGenerateAiMask = async (subMaskId: string, startPoint: Coord, endPoint: Coord) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke(Invokes.GenerateAiSubjectMask, {
        jsAdjustments: transformAdjustments,
        endPoint: [endPoint.x, endPoint.y],
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        path: selectedImage.path,
        rotation: adjustments.rotation,
        startPoint: [startPoint.x, startPoint.y],
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);
      const mergedParameters = { ...(subMask?.parameters || {}), ...(newParameters as Record<string, any>) };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      toast.error(`AI Mask Failed: ${error}`);
    } finally {
      setEditor({ isGeneratingAiMask: false });
    }
  };

  const handleGenerateAiDepthMask = async (subMaskId: string, parameters: any) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke('generate_ai_depth_mask', {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
        minDepth: parameters.minDepth ?? 20,
        maxDepth: parameters.maxDepth ?? 100,
        minFade: parameters.minFade ?? 15,
        maxFade: parameters.maxFade ?? 15,
        feather: parameters.feather ?? 10,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);
      const mergedParameters = { ...(subMask?.parameters || {}), ...(newParameters as Record<string, any>) };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      toast.error(`AI Depth Mask Failed: ${error}`);
    } finally {
      setEditor({ isGeneratingAiMask: false });
    }
  };

  const handleGenerateAiForegroundMask = async (subMaskId: string) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke(Invokes.GenerateAiForegroundMask, {
        jsAdjustments: transformAdjustments,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);
      const mergedParameters = { ...(subMask?.parameters || {}), ...(newParameters as Record<string, any>) };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      toast.error(`AI Mask Failed: ${error}`);
    } finally {
      setEditor({ isGeneratingAiMask: false });
    }
  };

  const handleGenerateAiSkyMask = async (subMaskId: string) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke(Invokes.GenerateAiSkyMask, {
        jsAdjustments: transformAdjustments,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);
      const mergedParameters = { ...(subMask?.parameters || {}), ...(newParameters as Record<string, any>) };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      toast.error(`AI Mask Failed: ${error}`);
    } finally {
      setEditor({ isGeneratingAiMask: false });
    }
  };

  useEffect(() => {
    const { activeMaskId, activeAiSubMaskId, adjustments, selectedImage } = useEditorStore.getState();
    const activeSubMask =
      adjustments?.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === activeMaskId) ||
      adjustments?.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === activeAiSubMaskId);

    if (activeSubMask?.type === 'ai-subject' && selectedImage?.path) {
      const transformAdjustments = getTransformAdjustments(adjustments);
      invoke('precompute_ai_subject_mask', {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
      }).catch((err) => console.error('Failed to precompute AI subject mask:', err));
    }
  }, [
    useEditorStore.getState().activeMaskId,
    useEditorStore.getState().activeAiSubMaskId,
    useEditorStore.getState().selectedImage?.path,
  ]);

  const handleGeneratePortraitSubmasks = async () => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const portraitResult: any = await invoke('generate_portrait_submasks', {
        jsAdjustments: transformAdjustments,
      });

      if (!portraitResult?.persons || portraitResult.persons.length === 0) {
        toast.info('No portrait subjects detected in frame');
        return;
      }

      const newMasks: MaskContainer[] = [];

      portraitResult.persons.forEach((person: any, idx: number) => {
        const personLabel = `Person ${idx + 1}`;

        if (person.facial_skin_mask_base64) {
          const skinMaskId = uuidv4();
          patchesSentToBackend.delete(skinMaskId);
          newMasks.push({
            ...INITIAL_MASK_CONTAINER,
            id: uuidv4(),
            name: `${personLabel} - Facial Skin`,
            subMasks: [
              {
                id: skinMaskId,
                name: 'Facial Skin',
                type: Mask.Brush,
                mode: SubMaskMode.Additive,
                opacity: 100,
                invert: false,
                visible: true,
                parameters: {
                  mask_data_base64: person.facial_skin_mask_base64,
                  rotation: adjustments.rotation,
                  flip_horizontal: adjustments.flipHorizontal,
                  flip_vertical: adjustments.flipVertical,
                  orientation_steps: adjustments.orientationSteps,
                },
              },
            ],
            adjustments: {
              ...INITIAL_MASK_ADJUSTMENTS,
              texture: -15,
              clarity: -10,
            },
          });
        }

        if (person.eye_sclera_mask_base64) {
          const eyesMaskId = uuidv4();
          patchesSentToBackend.delete(eyesMaskId);
          newMasks.push({
            ...INITIAL_MASK_CONTAINER,
            id: uuidv4(),
            name: `${personLabel} - Eyes & Sclera`,
            subMasks: [
              {
                id: eyesMaskId,
                name: 'Eyes',
                type: Mask.Brush,
                mode: SubMaskMode.Additive,
                opacity: 100,
                invert: false,
                visible: true,
                parameters: {
                  mask_data_base64: person.eye_sclera_mask_base64,
                  rotation: adjustments.rotation,
                  flip_horizontal: adjustments.flipHorizontal,
                  flip_vertical: adjustments.flipVertical,
                  orientation_steps: adjustments.orientationSteps,
                },
              },
            ],
            adjustments: {
              ...INITIAL_MASK_ADJUSTMENTS,
              exposure: 0.25,
              clarity: 15,
            },
          });
        }

        if (person.teeth_mask_base64) {
          const teethMaskId = uuidv4();
          patchesSentToBackend.delete(teethMaskId);
          newMasks.push({
            ...INITIAL_MASK_CONTAINER,
            id: uuidv4(),
            name: `${personLabel} - Teeth`,
            subMasks: [
              {
                id: teethMaskId,
                name: 'Teeth',
                type: Mask.Brush,
                mode: SubMaskMode.Additive,
                opacity: 100,
                invert: false,
                visible: true,
                parameters: {
                  mask_data_base64: person.teeth_mask_base64,
                  rotation: adjustments.rotation,
                  flip_horizontal: adjustments.flipHorizontal,
                  flip_vertical: adjustments.flipVertical,
                  orientation_steps: adjustments.orientationSteps,
                },
              },
            ],
            adjustments: {
              ...INITIAL_MASK_ADJUSTMENTS,
              exposure: 0.2,
              saturation: -20,
            },
          });
        }

        if (person.lips_mask_base64) {
          const lipsMaskId = uuidv4();
          patchesSentToBackend.delete(lipsMaskId);
          newMasks.push({
            ...INITIAL_MASK_CONTAINER,
            id: uuidv4(),
            name: `${personLabel} - Lips`,
            subMasks: [
              {
                id: lipsMaskId,
                name: 'Lips',
                type: Mask.Brush,
                mode: SubMaskMode.Additive,
                opacity: 100,
                invert: false,
                visible: true,
                parameters: {
                  mask_data_base64: person.lips_mask_base64,
                  rotation: adjustments.rotation,
                  flip_horizontal: adjustments.flipHorizontal,
                  flip_vertical: adjustments.flipVertical,
                  orientation_steps: adjustments.orientationSteps,
                },
              },
            ],
            adjustments: {
              ...INITIAL_MASK_ADJUSTMENTS,
              saturation: 10,
              vibrance: 10,
            },
          });
        }

        if (person.hair_mask_base64) {
          const hairMaskId = uuidv4();
          patchesSentToBackend.delete(hairMaskId);
          newMasks.push({
            ...INITIAL_MASK_CONTAINER,
            id: uuidv4(),
            name: `${personLabel} - Hair`,
            subMasks: [
              {
                id: hairMaskId,
                name: 'Hair',
                type: Mask.Brush,
                mode: SubMaskMode.Additive,
                opacity: 100,
                invert: false,
                visible: true,
                parameters: {
                  mask_data_base64: person.hair_mask_base64,
                  rotation: adjustments.rotation,
                  flip_horizontal: adjustments.flipHorizontal,
                  flip_vertical: adjustments.flipVertical,
                  orientation_steps: adjustments.orientationSteps,
                },
              },
            ],
            adjustments: {
              ...INITIAL_MASK_ADJUSTMENTS,
              contrast: 15,
              clarity: 10,
            },
          });
        }
      });

      if (newMasks.length > 0) {
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          masks: [...(prev.masks || []), ...newMasks],
        }));
        setEditor({
          activeMaskContainerId: newMasks[0].id,
          activeMaskId: newMasks[0].subMasks[0]?.id || null,
        });
        toast.success(`Generated ${newMasks.length} portrait sub-masks across detected subjects`);
      }
    } catch (error) {
      toast.error(`Portrait Segmentation Failed: ${error}`);
    } finally {
      setEditor({ isGeneratingAiMask: false });
    }
  };

  return {
    updateSubMask,
    handleGenerativeReplace,
    handleManualCleanup,
    handleQuickErase,
    handleDeleteMaskContainer,
    handleDeleteAiPatch,
    handleToggleAiPatchVisibility,
    handleGenerateAiMask,
    handleGenerateAiDepthMask,
    handleGenerateAiForegroundMask,
    handleGenerateAiSkyMask,
    handleGeneratePortraitSubmasks,
  };
}
