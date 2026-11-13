import { ReactNode } from 'react';
import { SliderResetContext } from '../../context/SliderResetContext';
import { useAdjustmentSliderReset } from '../../utils/developDefaults';

export default function AdjustmentSliderResetProvider({ children }: { children: ReactNode }) {
  return <SliderResetContext.Provider value={useAdjustmentSliderReset()}>{children}</SliderResetContext.Provider>;
}
