import { invoke } from '@tauri-apps/api/core';
import { SubMask } from '../../components/panel/right/Masks';
import { Invokes } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';
import { AiPatch } from '../../utils/adjustments';
import { useUpdateSubMask } from './useUpdateSubMask';

export function useHandleGenerateAiSkyMask() {
  const { selectedImage, setIsGeneratingAiMask, adjustments, patchesSentToBackend, setError } = useAppState();
  const updateSubMask = useUpdateSubMask();
  const handleGenerateAiSkyMask = async (subMaskId: string) => {
    if (!selectedImage?.path) {
      console.error('Cannot generate AI mask: No image selected.');
      return;
    }
    setIsGeneratingAiMask(true);
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

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.current.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      console.error('Failed to generate AI sky mask:', error);
      setError(`AI Mask Failed: ${error}`);
    } finally {
      setIsGeneratingAiMask(false);
    }
  };

  return handleGenerateAiSkyMask;
}
