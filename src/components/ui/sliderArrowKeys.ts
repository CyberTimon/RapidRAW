import { useCallback, useEffect, useRef } from 'react';

interface HoverArrowKeyOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  disabled: boolean;
  max: number;
  min: number;
  onChange(value: number): void;
  onInteractionEnd(): void;
  onInteractionStart(): void;
  step: number;
  value: number;
}

export const stepSliderValue = (value: number, direction: 1 | -1, min: number, max: number, step: number) => {
  const decimalPlaces = String(step).split('.')[1]?.length ?? 0;
  const nextValue = value + direction * step;
  return Number(Math.max(min, Math.min(max, nextValue)).toFixed(decimalPlaces));
};

const isTextEntry = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(
    target.closest(
      'input:not([type="range"]), textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"], [role="combobox"]',
    ),
  );

export const useSliderHoverArrowKeys = ({
  containerRef,
  disabled,
  max,
  min,
  onChange,
  onInteractionEnd,
  onInteractionStart,
  step,
  value,
}: HoverArrowKeyOptions) => {
  const isHoveredRef = useRef(false);
  const isAdjustingRef = useRef(false);
  const currentValueRef = useRef(value);
  const finishTimeoutRef = useRef<number | undefined>(undefined);
  const callbacksRef = useRef({ onChange, onInteractionEnd, onInteractionStart });
  callbacksRef.current = { onChange, onInteractionEnd, onInteractionStart };

  if (!isAdjustingRef.current) currentValueRef.current = value;

  const finishInteraction = useCallback(() => {
    if (finishTimeoutRef.current !== undefined) window.clearTimeout(finishTimeoutRef.current);
    finishTimeoutRef.current = undefined;
    if (!isAdjustingRef.current) return;
    isAdjustingRef.current = false;
    callbacksRef.current.onInteractionEnd();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        disabled ||
        !isHoveredRef.current ||
        (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing ||
        isTextEntry(event.target)
      ) {
        return;
      }

      const container = containerRef.current;
      if (!container) return;

      event.preventDefault();
      event.stopPropagation();

      const nextValue = stepSliderValue(
        currentValueRef.current,
        event.key === 'ArrowUp' ? 1 : -1,
        min,
        max,
        step,
      );
      if (nextValue === currentValueRef.current) return;

      if (!isAdjustingRef.current) {
        isAdjustingRef.current = true;
        callbacksRef.current.onInteractionStart();
      }
      currentValueRef.current = nextValue;
      callbacksRef.current.onChange(nextValue);

      if (finishTimeoutRef.current !== undefined) window.clearTimeout(finishTimeoutRef.current);
      finishTimeoutRef.current = window.setTimeout(finishInteraction, 180);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      finishInteraction();
    };
  }, [containerRef, disabled, finishInteraction, max, min, step]);

  return {
    onMouseEnter: () => {
      isHoveredRef.current = true;
    },
    onMouseLeave: () => {
      isHoveredRef.current = false;
      finishInteraction();
    },
  };
};
