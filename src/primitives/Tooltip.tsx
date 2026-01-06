import {
  Tooltip as AriaTooltip,
  TooltipTrigger as AriaTooltipTrigger,
  type TooltipProps as AriaTooltipProps,
  type TooltipTriggerComponentProps,
  composeRenderProps,
  OverlayArrow,
} from 'react-aria-components';
import { tv } from 'tailwind-variants';

export interface TooltipProps extends Omit<AriaTooltipProps, 'children'> {
  children: React.ReactNode;
}

const tooltipStyles = tv({
  base: [
    'bg-surface border border-border-color',
    'text-text-primary text-xs font-medium',
    'rounded-md shadow-lg',
    'px-2 py-1.5',
    'max-w-xs',
    'will-change-transform',
  ],
  variants: {
    isEntering: {
      true: 'animate-in fade-in duration-150 ease-out placement-bottom:slide-in-from-top-1 placement-top:slide-in-from-bottom-1 placement-left:slide-in-from-right-1 placement-right:slide-in-from-left-1',
    },
    isExiting: {
      true: 'animate-out fade-out duration-100 ease-in placement-bottom:slide-out-to-top-1 placement-top:slide-out-to-bottom-1 placement-left:slide-out-to-right-1 placement-right:slide-out-to-left-1',
    },
  },
});

export function Tooltip({ children, ...props }: TooltipProps) {
  return (
    <AriaTooltip
      offset={8}
      {...props}
      className={composeRenderProps(props.className, (className, renderProps) =>
        tooltipStyles({ ...renderProps, className })
      )}
    >
      <OverlayArrow>
        <svg
          width={12}
          height={12}
          viewBox="0 0 12 12"
          className="block fill-surface stroke-border-color group-placement-bottom:rotate-180 group-placement-left:-rotate-90 group-placement-right:rotate-90"
        >
          <path d="M0 0 L6 6 L12 0" />
        </svg>
      </OverlayArrow>
      {children}
    </AriaTooltip>
  );
}

export interface TooltipTriggerProps extends TooltipTriggerComponentProps {
  children: React.ReactNode;
}

export function TooltipTrigger({ children, delay = 200, closeDelay = 0, ...props }: TooltipTriggerProps) {
  return (
    <AriaTooltipTrigger delay={delay} closeDelay={closeDelay} {...props}>
      {children}
    </AriaTooltipTrigger>
  );
}
