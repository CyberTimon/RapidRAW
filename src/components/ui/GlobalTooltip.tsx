import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import Text from './Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

const TOOLTIP_DELAY = 500;
const OFFSET = 8;

interface TooltipData {
  content: string;
  x: number;
  y: number;
  isAbove: boolean;
}

export default function GlobalTooltip() {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const stopWatch = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };

    const hide = () => {
      clearTimer();
      stopWatch();
      targetRef.current = null;
      setTooltip(null);
    };

    const computePosition = (el: HTMLElement): TooltipData | null => {
      const content = el.getAttribute('data-tooltip');
      if (!content) return null;

      const rect = el.getBoundingClientRect();
      let x = rect.left + rect.width / 2;
      let y = rect.bottom + OFFSET;
      let isAbove = false;

      x = Math.max(20, Math.min(x, window.innerWidth - 20));

      if (y + 40 > window.innerHeight) {
        y = rect.top - OFFSET;
        isAbove = true;
      }

      return { content, x, y, isAbove };
    };

    const watchTarget = () => {
      const tick = () => {
        const el = targetRef.current;
        if (!el || !document.contains(el) || !el.getAttribute('data-tooltip')) {
          hide();
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    };

    const handleMouseOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.('[data-tooltip]');
      if (!el || !(el instanceof HTMLElement)) return;
      if (el === targetRef.current) return;

      hide();

      if (!el.getAttribute('data-tooltip')) return;

      targetRef.current = el;

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const current = targetRef.current;
        if (!current || !document.contains(current)) {
          hide();
          return;
        }

        const data = computePosition(current);
        if (!data) {
          hide();
          return;
        }

        setTooltip(data);
        watchTarget();
      }, TOOLTIP_DELAY);
    };

    const handleMouseOut = (e: MouseEvent) => {
      const current = targetRef.current;
      if (!current) return;

      const from = e.target as HTMLElement;
      const to = e.relatedTarget as HTMLElement | null;

      const leaving = from === current || current.contains(from);
      const staying = to !== null && current.contains(to);

      if (leaving && !staying) {
        hide();
      }
    };

    const dismiss = () => hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };

    document.addEventListener('mouseover', handleMouseOver);
    document.addEventListener('mouseout', handleMouseOut);
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('mouseover', handleMouseOver);
      document.removeEventListener('mouseout', handleMouseOut);
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('keydown', onKey);
      clearTimer();
      stopWatch();
    };
  }, []);

  return createPortal(
    <AnimatePresence mode="wait">
      {tooltip && (
        <motion.div
          key={tooltip.content}
          initial={{ opacity: 0, scale: 0.9, y: tooltip.isAbove ? 5 : -5, x: '-50%' }}
          animate={{ opacity: 1, scale: 1, y: tooltip.isAbove ? -10 : 0, x: '-50%' }}
          exit={{ opacity: 0, scale: 0.9, x: '-50%' }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
          style={{ top: tooltip.y, left: tooltip.x }}
          className={clsx(
            'fixed z-100 pointer-events-none',
            'bg-surface/80 backdrop-blur-xs',
            'border border-text-secondary/10 shadow-xl rounded-md',
            'px-2.5 py-1.5 whitespace-nowrap',
            tooltip.isAbove && '-translate-y-full',
          )}
        >
          <Text variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
            {tooltip.content}
          </Text>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
