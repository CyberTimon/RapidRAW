import { useCallback, useLayoutEffect, useRef } from 'react';
import clsx from 'clsx';
import { FrameRate, Ticks } from '../../../types/video';
import { useVideoStore } from '../../../store/useVideoStore';
import { formatTimecode } from '../../../utils/video/time';

export interface PlayheadState {
  playhead: Ticks;
  isPlaying: boolean;
}

const DIGIT_CLASS = 'inline-block w-[1ch] text-center';

const isDigit = (char: string) => char >= '0' && char <= '9';

export const usePlayheadEffect = (apply: (state: PlayheadState) => void) =>
  useLayoutEffect(() => {
    apply(useVideoStore.getState());
    return useVideoStore.subscribe((state, previous) => {
      if (state.playhead !== previous.playhead || state.isPlaying !== previous.isPlaying) apply(state);
    });
  }, [apply]);

const writeTimecode = (element: HTMLElement, value: string) => {
  if (element.textContent === value) return;
  const chars = [...value];
  const cells = element.children;
  const matches =
    cells.length === chars.length &&
    chars.every((char, index) => isDigit(char) === (cells[index].className === DIGIT_CLASS));
  if (!matches) {
    element.replaceChildren(
      ...chars.map((char) => {
        const cell = document.createElement('span');
        if (isDigit(char)) cell.className = DIGIT_CLASS;
        cell.textContent = char;
        return cell;
      }),
    );
    return;
  }
  chars.forEach((char, index) => {
    if (cells[index].textContent !== char) cells[index].textContent = char;
  });
};

export default function Timecode({ value, className }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (ref.current) writeTimecode(ref.current, value);
  }, [value]);
  return <span ref={ref} className={clsx('inline-flex whitespace-nowrap', className)} />;
}

export function PlayheadTimecode({ fps, className }: { fps: FrameRate; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const show = useCallback(
    ({ playhead }: PlayheadState) => {
      if (ref.current) writeTimecode(ref.current, formatTimecode(playhead, fps));
    },
    [fps],
  );
  usePlayheadEffect(show);
  return <span ref={ref} className={clsx('inline-flex whitespace-nowrap', className)} />;
}
