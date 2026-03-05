import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';
import { useSetAdjustments } from './useSetAdjustments';
import { invoke } from '@tauri-apps/api/core';
import { SubMask } from '../../components/panel/right/Masks';
import { Invokes } from '../../components/ui/AppProperties';
import { Coord, AiPatch, Adjustments } from '../../utils/adjustments';

export function useHandleQuickErase() {
  const {
    selectedImage,
    isGeneratingAi,
    adjustments,
    setIsGeneratingAi,
    patchesSentToBackend,
    setActiveAiPatchContainerId,
    setActiveAiSubMaskId,
    setError,
  } = useAppState();
  const setAdjustments = useSetAdjustments();

  const handleQuickErase = useCallback(
    async (subMaskId: string | null, startPoint: Coord, endPoint: Coord) => {
      if (!selectedImage?.path || isGeneratingAi) {
        return;
      }

      const patchId = adjustments.aiPatches.find((p: AiPatch) =>
        p.subMasks.some((sm: SubMask) => sm.id === subMaskId),
      )?.id;
      if (!patchId) {
        console.error('Could not find AI patch container for Quick Erase.');
        return;
      }

      setIsGeneratingAi(true);
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: true } : p)),
      }));

      try {
        const transformAdjustments = {
          transformDistortion: adjustments.transformDistortion,
          transformVertical: adjustments.transformVertical,
          transformHorizontal: adjustments.transformHorizontal,
          transformRotate: adjustments.transformRotate,
          transformAspect: adjustments.transformAspect,
          transformScale: adjustments.transformScale,
          transformXOffset: adjustments.transformXOffset,
          transformYOffset: adjustments.transformYOffset,
          lensDistortionAmount: adjustments.lensDistortionAmount,
          lensVignetteAmount: adjustments.lensVignetteAmount,
          lensTcaAmount: adjustments.lensTcaAmount,
          lensDistortionParams: adjustments.lensDistortionParams,
          lensMaker: adjustments.lensMaker,
          lensModel: adjustments.lensModel,
          lensDistortionEnabled: adjustments.lensDistortionEnabled,
          lensTcaEnabled: adjustments.lensTcaEnabled,
          lensVignetteEnabled: adjustments.lensVignetteEnabled,
        };

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
        });

        const newPatchData = JSON.parse(newPatchDataJson);
        if (!newPatchData?.color || !newPatchData?.mask) {
          throw new Error('Inpainting failed to return a valid result.');
        }
        patchesSentToBackend.current.delete(patchId);

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
        setActiveAiPatchContainerId(null);
        setActiveAiSubMaskId(null);
      } catch (err: any) {
        console.error('Quick Erase failed:', err);
        setError(`Quick Erase Failed: ${err.message || String(err)}`);
        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
        }));
      } finally {
        setIsGeneratingAi(false);
      }
    },
    [
      selectedImage?.path,
      isGeneratingAi,
      adjustments,
      setAdjustments,
      setActiveAiPatchContainerId,
      setActiveAiSubMaskId,
    ],
  );

  return handleQuickErase;
}
