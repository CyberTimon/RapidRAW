import { useEffect, useState } from 'react';
import { getDpr } from '../utils/zoom';

// Tracks window.devicePixelRatio, e.g. when the window moves to another monitor
// or the OS scale changes.
export const useDevicePixelRatio = (): number => {
  const [dpr, setDpr] = useState(getDpr);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let mediaQuery: MediaQueryList | null = null;

    // The media query only matches the current value, so re-arm it after every change
    const watch = () => {
      mediaQuery?.removeEventListener('change', update);
      mediaQuery = window.matchMedia(`(resolution: ${getDpr()}dppx)`);
      mediaQuery.addEventListener('change', update);
    };
    const update = () => {
      setDpr(getDpr());
      watch();
    };

    watch();
    window.addEventListener('resize', update);

    return () => {
      mediaQuery?.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return dpr;
};
