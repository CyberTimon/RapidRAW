interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClasses = {
  sm: 'h-4 w-4 border-2',
  md: 'h-6 w-6 border-2',
  lg: 'h-8 w-8 border-3',
};

export function LoadingSpinner({ size = 'md', className = '' }: LoadingSpinnerProps) {
  return (
    <div
      className={`
        animate-spin rounded-full
        border-accent border-t-transparent
        ${sizeClasses[size]}
        ${className}
      `}
    />
  );
}

export function LoadingOverlay({ message }: { message?: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg-primary/80 backdrop-blur-sm z-50">
      <LoadingSpinner size="lg" />
      {message && <p className="mt-4 text-sm text-text-secondary">{message}</p>}
    </div>
  );
}

export function LoadingPlaceholder() {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <LoadingSpinner />
    </div>
  );
}
