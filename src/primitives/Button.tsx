import { forwardRef } from 'react';
import {
  Button as AriaButton,
  ButtonProps as AriaButtonProps,
} from 'react-aria-components';
import { tv } from 'tailwind-variants';
import { focusRing } from './aria-utils';

const buttonStyles = tv({
  base: [
    'flex items-center justify-center gap-2',
    'font-semibold rounded-md',
    'transition-colors',
    focusRing,
  ],
  variants: {
    variant: {
      primary:
        'bg-accent text-button-text shadow-shiny data-[pressed]:brightness-90',
      secondary:
        'bg-surface text-text-primary border border-border-color hover:bg-bg-tertiary data-[pressed]:bg-bg-tertiary',
      surface: 'bg-surface text-text-primary data-[pressed]:brightness-95',
      ghost:
        'bg-transparent text-text-primary hover:bg-surface data-[pressed]:bg-surface',
      destructive: 'bg-red-600 text-white data-[pressed]:bg-red-700',
    },
    size: {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-4 py-2 text-sm',
      lg: 'px-6 py-3 text-base',
      icon: 'p-2',
      'icon-sm': 'p-1.5',
    },
    isDisabled: {
      true: 'opacity-50 cursor-not-allowed shadow-none',
    },
  },
  defaultVariants: {
    variant: 'primary',
    size: 'md',
  },
});

type NativeButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

export interface ButtonProps
  extends Omit<AriaButtonProps, 'className' | 'style' | 'onClick'> {
  variant?: 'primary' | 'secondary' | 'surface' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';
  className?: string;
  title?: string;
  /** @deprecated Use isDisabled instead. disabled is supported for backward compatibility. */
  disabled?: boolean;
  /** @deprecated Use onPress instead. onClick is supported for backward compatibility. */
  onClick?: NativeButtonProps['onClick'];
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      className,
      onClick,
      onPress,
      title,
      disabled,
      isDisabled,
      ...props
    },
    ref
  ) => {
    const resolvedDisabled = isDisabled ?? disabled;
    const handlePress = (e: Parameters<NonNullable<AriaButtonProps['onPress']>>[0]) => {
      onPress?.(e);
      if (onClick) {
        onClick(e as unknown as React.MouseEvent<HTMLButtonElement>);
      }
    };

    return (
      <AriaButton
        ref={ref}
        {...props}
        isDisabled={resolvedDisabled}
        onPress={handlePress}
        className={({ isDisabled }) =>
          buttonStyles({
            variant,
            size,
            isDisabled,
            className,
          })
        }
        {...(title ? { title } : {})}
      />
    );
  }
);

Button.displayName = 'Button';
