import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

export interface SliderKeyframes {
  render(keys: string | Array<string>): ReactNode;
  subscribe(onChange: () => void): () => void;
  valueOf(key: string): number | undefined;
}

export const SliderKeyframeContext = createContext<SliderKeyframes | null>(null);

export const useSliderKeyframe = () => useContext(SliderKeyframeContext);

const SEPARATOR = ',';
const NOT_LIVE: Array<number | undefined> = [];
const noSubscription = () => () => {};

export const useLiveValues = (keys: Array<string> | null, interacting: boolean): Array<number | undefined> => {
  const keyframes = useContext(SliderKeyframeContext);
  const source = keys && keyframes ? { keys, keyframes } : null;
  const live = useSyncExternalStore(source?.keyframes.subscribe ?? noSubscription, () =>
    source ? source.keys.map((key) => source.keyframes.valueOf(key) ?? '').join(SEPARATOR) : '',
  );
  if (!source || interacting) return NOT_LIVE;
  return live.split(SEPARATOR).map((part) => (part ? Number(part) : undefined));
};
