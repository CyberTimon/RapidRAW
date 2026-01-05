import { forwardRef, type ReactNode } from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', error, type = 'text', leftIcon, rightIcon, ...props }, ref) => {
    if (leftIcon || rightIcon) {
      return (
        <div className={`relative flex items-center ${className}`}>
          {leftIcon && (
            <div className="absolute left-3 text-text-secondary pointer-events-none">
              {leftIcon}
            </div>
          )}
          <input
            ref={ref}
            type={type}
            className={`
              flex h-10 w-full rounded-md border px-3 py-2 text-sm
              bg-bg-primary border-border-color text-text-primary placeholder:text-text-secondary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent
              disabled:cursor-not-allowed disabled:opacity-50
              ${leftIcon ? 'pl-9' : ''}
              ${rightIcon ? 'pr-9' : ''}
              ${error ? 'border-red-500 focus-visible:ring-red-500' : ''}
            `}
            {...props}
          />
          {rightIcon && (
            <div className="absolute right-3 text-text-secondary pointer-events-none">
              {rightIcon}
            </div>
          )}
        </div>
      );
    }

    return (
      <input
        ref={ref}
        type={type}
        className={`
          flex h-10 w-full rounded-md border px-3 py-2 text-sm
          bg-bg-primary border-border-color text-text-primary placeholder:text-text-secondary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent
          disabled:cursor-not-allowed disabled:opacity-50
          file:border-0 file:bg-transparent file:text-sm file:font-medium
          ${error ? 'border-red-500 focus-visible:ring-red-500' : ''}
          ${className}
        `}
        {...props}
      />
    );
  }
);

Input.displayName = 'Input';

export default Input;
