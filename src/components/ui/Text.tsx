import React, { forwardRef } from 'react';
import clsx from 'clsx';
import {
  TextWeight,
  TextColor,
  VariantConfig,
  TEXT_WEIGHT_KEYS,
  TEXT_COLOR_KEYS,
  TextVariants,
} from '../../types/typography';

export interface TextProps extends React.HTMLAttributes<HTMLElement> {
  variant?: VariantConfig;
  weight?: TextWeight;
  color?: TextColor;
  as?: React.ElementType;
  children: React.ReactNode;
}

export const Text = forwardRef<HTMLElement, TextProps>(
  ({ variant = TextVariants.body, weight, color, as, className, children, ...props }, ref) => {
    const Component = as || variant.defaultElement;

    return (
      <Component
        ref={ref}
        className={clsx(
          variant.size,
          TEXT_WEIGHT_KEYS[weight ?? variant.defaultWeight],
          TEXT_COLOR_KEYS[color ?? variant.defaultColor],
          variant.extraClasses,
          className,
        )}
        {...props}
      >
        {children}
      </Component>
    );
  },
);

Text.displayName = 'Text';
export default Text;
