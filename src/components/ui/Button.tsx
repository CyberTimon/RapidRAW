import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'size'> {
  children: ReactNode;
  size?: string;
  variant?: string;
}

const Button = ({
  children,
  onClick,
  disabled,
  className = '',
  size: _size,
  variant: _variant,
  ...props
}: ButtonProps) => {
  const baseClasses = `
    flex items-center justify-center gap-2
    font-semibold py-2 px-4 rounded-md
    text-button-text text-md
    disabled:opacity-50 disabled:cursor-not-allowed
  `;

  const hasSurfaceBg = className.includes('bg-surface');

  const combinedClasses = clsx(
    baseClasses,
    {
      'bg-accent': !hasSurfaceBg,
      'bg-surface': hasSurfaceBg,
    },
    className,
  );

  return (
    <button onClick={onClick} disabled={disabled} className={combinedClasses} {...props}>
      {children}
    </button>
  );
};

export default Button;
