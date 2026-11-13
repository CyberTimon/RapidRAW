import { createContext, useContext } from 'react';

export type SliderResetResolver = (key: string) => number | undefined;

export const SliderResetContext = createContext<SliderResetResolver | null>(null);

export const useSliderResetResolver = () => useContext(SliderResetContext);
