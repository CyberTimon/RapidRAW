import { type PointerEvent as ReactPointerEvent, useState, useCallback } from 'react';
import { useEditorStore } from '../store/useEditorStore';
import { useSettingsStore } from '../store/useSettingsStore';

export function useWaveformControls() {
  const [isResizingWaveform, setIsResizingWaveform] = useState(false);
  const setEditor = useEditorStore((s) => s.setEditor);

  const onToggleWaveform = useCallback(() => {
    const newVal = !useEditorStore.getState().isWaveformVisible;
    setEditor({ isWaveformVisible: newVal });
    const { appSettings, handleSettingsChange } = useSettingsStore.getState();
    if (appSettings) handleSettingsChange({ ...appSettings, isWaveformVisible: newVal });
  }, [setEditor]);

  const setActiveWaveformChannel = useCallback(
    (mode: string) => {
      setEditor({ activeWaveformChannel: mode });
      const { appSettings, handleSettingsChange } = useSettingsStore.getState();
      if (appSettings) handleSettingsChange({ ...appSettings, activeWaveformChannel: mode });
    },
    [setEditor],
  );

  const setWaveformHeight = useCallback(
    (height: number) => {
      setEditor({ waveformHeight: height });
    },
    [setEditor],
  );

  const handleWaveformResize = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const pointerId = e.pointerId;
      const target = e.currentTarget;
      const startY = e.clientY;
      const startHeight = useEditorStore.getState().waveformHeight || 256;
      const previousTouchAction = document.documentElement.style.touchAction;
      const previousUserSelect = document.documentElement.style.userSelect;

      setIsResizingWaveform(true);
      target.setPointerCapture?.(pointerId);
      document.documentElement.style.touchAction = 'none';
      document.documentElement.style.userSelect = 'none';

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        const delta = moveEvent.clientY - startY;
        const newHeight = Math.round(Math.max(150, Math.min(450, startHeight + delta)));
        setEditor({ waveformHeight: newHeight });
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        setIsResizingWaveform(false);
        document.documentElement.style.touchAction = previousTouchAction;
        document.documentElement.style.userSelect = previousUserSelect;
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('pointercancel', handlePointerUp);

        const { appSettings, handleSettingsChange } = useSettingsStore.getState();
        if (appSettings) {
          handleSettingsChange({
            ...appSettings,
            waveformHeight: useEditorStore.getState().waveformHeight,
          });
        }
      };

      document.addEventListener('pointermove', handlePointerMove, { passive: false });
      document.addEventListener('pointerup', handlePointerUp);
      document.addEventListener('pointercancel', handlePointerUp);
    },
    [setEditor],
  );

  return {
    isResizingWaveform,
    onToggleWaveform,
    setActiveWaveformChannel,
    setWaveformHeight,
    handleWaveformResize,
  };
}
