import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';

export function useHandleToggleWaveform() {
  const { setIsWaveformVisible } = useAppState();

  const handleToggleWaveform = useCallback(() => {
    setIsWaveformVisible((prev: boolean) => !prev);
  }, []);

  return handleToggleWaveform;
}
