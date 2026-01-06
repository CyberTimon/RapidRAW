import { forwardRef, type ReactNode } from 'react';
import { Input as AriaInput } from 'react-aria-components';
import { tv } from 'tailwind-variants';
import { focusRing } from './aria-utils';

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'> {
  error?: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  className?: string;
}

const inputStyles = tv({
  base: [
    'flex h-10 w-full rounded-md border px-3 py-2 text-sm',
    'bg-bg-primary border-border-color text-text-primary placeholder:text-text-secondary',
    'disabled:cursor-not-allowed disabled:opacity-50',
    'file:border-0 file:bg-transparent file:text-sm file:font-medium',
    focusRing,
  ],
  variants: {
    hasError: {
      true: 'border-red-500 focus-visible:ring-red-500',
    },
    hasLeftIcon: {
      true: 'pl-9',
    },
    hasRightIcon: {
      true: 'pr-9',
    },
  },
});

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', error, type = 'text', leftIcon, rightIcon, ...props }, ref) => {
    const hasIcons = leftIcon || rightIcon;

    const inputElement = (
      <AriaInput
        ref={ref}
        type={type}
        className={inputStyles({
          hasError: !!error,
          hasLeftIcon: !!leftIcon,
          hasRightIcon: !!rightIcon,
          className: hasIcons ? '' : className,
        })}
        {...props}
      />
    );

    if (hasIcons) {
      return (
        <div className={`relative flex items-center ${className}`}>
          {leftIcon && (
            <div className="absolute left-3 text-text-secondary pointer-events-none">
              {leftIcon}
            </div>
          )}
          {inputElement}
          {rightIcon && (
            <div className="absolute right-3 text-text-secondary pointer-events-none">
              {rightIcon}
            </div>
          )}
        </div>
      );
    }

    return inputElement;
  }
);

Input.displayName = 'Input';

export default Input;
