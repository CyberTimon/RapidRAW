import { forwardRef } from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'surface' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'primary', size = 'md', disabled, children, ...props }, ref) => {
    const baseClasses = `
      flex items-center justify-center gap-2
      font-semibold rounded-md
      disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none
    `;

    const variantClasses = {
      primary: 'bg-accent text-button-text shadow-shiny',
      secondary: 'bg-surface text-text-primary border border-border-color hover:bg-bg-tertiary',
      surface: 'bg-surface text-text-primary',
      ghost: 'bg-transparent text-text-primary hover:bg-surface',
      destructive: 'bg-red-600 text-white',
    };

    const sizeClasses = {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-4 py-2 text-sm',
      lg: 'px-6 py-3 text-base',
      icon: 'p-2',
      'icon-sm': 'p-1.5',
    };

    return (
      <button
        ref={ref}
        className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
        disabled={disabled}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
