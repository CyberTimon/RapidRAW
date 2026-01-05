import type { ReactNode } from 'react';

interface ClerkConfig {
  publishableKey?: string;
}

interface ClerkProviderProps {
  children: ReactNode;
  config?: ClerkConfig;
}

export function ClerkProvider({ children, config }: ClerkProviderProps) {
  if (!config?.publishableKey) {
    return <>{children}</>;
  }

  return <>{children}</>;
}
