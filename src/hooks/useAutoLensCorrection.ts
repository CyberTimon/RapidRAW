import { useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import { Adjustments } from '../utils/adjustments';
import { detectLensCorrectionParams, isLensCorrectionDefault } from '../utils/lensCorrection';
import { useEditorStore } from '../store/useEditorStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useUIStore } from '../store/useUIStore';
import { useEditorActions } from './useEditorActions';

export function useAutoLensCorrection() {
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const appSettings = useSettingsStore((s) => s.appSettings);
  const setUI = useUIStore((s) => s.setUI);
  const { setAdjustments } = useEditorActions();
  const attemptRef = useRef<{ path: string | null; attempted: boolean }>({ path: null, attempted: false });

  useEffect(() => {
    const currentPath = selectedImage?.path ?? null;

    if (attemptRef.current.path !== currentPath) {
      attemptRef.current = { path: currentPath, attempted: false };
    }

    if (
      !currentPath ||
      !selectedImage?.isReady ||
      !selectedImage.isRaw ||
      !appSettings?.autoApplyLensCorrection ||
      attemptRef.current.attempted
    ) {
      return;
    }

    attemptRef.current.attempted = true;

    if (!isLensCorrectionDefault(useEditorStore.getState().adjustments)) {
      return;
    }

    let cancelled = false;

    const applyDetectedLensCorrection = async () => {
      try {
        const detectedParams = await detectLensCorrectionParams(selectedImage.exif);

        if (cancelled || useEditorStore.getState().selectedImage?.path !== currentPath) {
          return;
        }

        if (!detectedParams) {
          setUI({ isLensCorrectionModalOpen: true });
          return;
        }

        if (!isLensCorrectionDefault(useEditorStore.getState().adjustments)) {
          return;
        }

        setAdjustments((prev: Adjustments) => ({
          ...prev,
          ...detectedParams,
        }));
      } catch (error) {
        console.error('Automatic lens correction failed:', error);
        if (!cancelled && useEditorStore.getState().selectedImage?.path === currentPath) {
          toast.error(`Automatic lens correction failed: ${error}`);
          setUI({ isLensCorrectionModalOpen: true });
        }
      }
    };

    applyDetectedLensCorrection();

    return () => {
      cancelled = true;
    };
  }, [
    selectedImage?.path,
    selectedImage?.isReady,
    selectedImage?.isRaw,
    selectedImage?.exif,
    appSettings?.autoApplyLensCorrection,
    setAdjustments,
    setUI,
  ]);
}
