import { useEffect, useState } from 'react';

export function useDelayedLoading(isLoading: boolean, delayMs = 400) {
  const [isDelayElapsed, setIsDelayElapsed] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setIsDelayElapsed(false);
      return;
    }
    const timer = setTimeout(() => setIsDelayElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [isLoading, delayMs]);

  return isLoading && isDelayElapsed;
}
