import { forwardRef } from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', error, type = 'text', ...props }, ref) => {
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
