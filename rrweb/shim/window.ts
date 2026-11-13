// A window makes no sense in a browser: every method is an async no-op.
// If the last argument is a callback (onResized, listen...), it returns an unlisten fn.
const stub: any = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'label') return 'main';
    if (prop === 'then') return undefined;
    return async (...a: unknown[]) => (typeof a[a.length - 1] === 'function' ? () => {} : undefined);
  },
});
export const getCurrentWindow = () => stub;
