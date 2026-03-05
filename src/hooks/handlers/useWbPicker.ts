import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';

export function useToggleWbPicker() {
  const { setIsWbPickerActive } = useAppState();

  const toggleWbPicker = useCallback(() => {
    setIsWbPickerActive((prev) => !prev);
  }, []);

  return toggleWbPicker;
}

export function useHandleWbPicked() {
  const handleWbPicked = useCallback(() => {
    //setIsWbPickerActive(false); // lets keep it active
  }, []);

  return handleWbPicked;
}
