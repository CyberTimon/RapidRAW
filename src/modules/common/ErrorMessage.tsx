import { Button } from '../../primitives/Button';

type ErrorVariant = 'error' | 'warning' | 'info';
type ErrorSize = 'sm' | 'md' | 'lg';

interface ErrorMessageProps {
  title?: string;
  message: string;
  variant?: ErrorVariant;
  size?: ErrorSize;
  onRetry?: () => void;
  onDismiss?: () => void;
  retryText?: string;
  dismissText?: string;
  className?: string;
}

const variantConfig: Record<ErrorVariant, { iconColor: string; bgColor: string; borderColor: string }> = {
  error: {
    iconColor: 'text-red-500',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/20',
  },
  warning: {
    iconColor: 'text-yellow-500',
    bgColor: 'bg-yellow-500/10',
    borderColor: 'border-yellow-500/20',
  },
  info: {
    iconColor: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/20',
  },
};

const sizeConfig: Record<ErrorSize, { icon: number; title: string; message: string; padding: string }> = {
  sm: { icon: 20, title: 'text-sm', message: 'text-xs', padding: 'p-3' },
  md: { icon: 32, title: 'text-base', message: 'text-sm', padding: 'p-4' },
  lg: { icon: 48, title: 'text-lg', message: 'text-base', padding: 'p-6' },
};

function ErrorIcon({ size, variant }: { size: number; variant: ErrorVariant }) {
  if (variant === 'warning') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }

  if (variant === 'info') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

export function ErrorMessage({
  title,
  message,
  variant = 'error',
  size = 'md',
  onRetry,
  onDismiss,
  retryText = 'Try Again',
  dismissText = 'Dismiss',
  className = '',
}: ErrorMessageProps) {
  const variantStyles = variantConfig[variant];
  const sizeStyles = sizeConfig[size];

  return (
    <div
      className={`
        ${variantStyles.bgColor} ${variantStyles.borderColor}
        border rounded-lg ${sizeStyles.padding}
        ${className}
      `}
    >
      <div className="flex items-start gap-3">
        <div className={`flex-shrink-0 ${variantStyles.iconColor}`}>
          <ErrorIcon size={sizeStyles.icon} variant={variant} />
        </div>
        <div className="flex-1 min-w-0">
          {title && (
            <h3 className={`${sizeStyles.title} font-semibold text-text-primary mb-1`}>
              {title}
            </h3>
          )}
          <p className={`${sizeStyles.message} text-text-secondary whitespace-pre-wrap`}>
            {message}
          </p>
          {(onRetry || onDismiss) && (
            <div className="flex gap-2 mt-3">
              {onRetry && (
                <Button
                  variant="primary"
                  size={size === 'lg' ? 'md' : 'sm'}
                  onClick={onRetry}
                >
                  {retryText}
                </Button>
              )}
              {onDismiss && (
                <Button
                  variant="ghost"
                  size={size === 'lg' ? 'md' : 'sm'}
                  onClick={onDismiss}
                >
                  {dismissText}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function InlineError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 text-red-500 text-sm">
      <svg
        width={16}
        height={16}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>{message}</span>
    </div>
  );
}

export function FullPageError({
  title = 'Something went wrong',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="h-full w-full flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <div className="text-red-500 mb-4 flex justify-center">
          <svg
            width={64}
            height={64}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-text-primary mb-2">{title}</h2>
        <p className="text-text-secondary mb-4">{message}</p>
        {onRetry && (
          <Button variant="primary" onClick={onRetry}>
            Try Again
          </Button>
        )}
      </div>
    </div>
  );
}
