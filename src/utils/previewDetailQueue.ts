/** One original-detail render at a time; canceled queued requests never start. */
export function createDetailQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(signal: AbortSignal, render: () => Promise<T>): Promise<T | undefined> {
    const result = tail.then(() => (signal.aborted ? undefined : render()));
    tail = result.catch(() => undefined);
    return result;
  };
}

export const enqueuePreviewDetail = createDetailQueue();

export function needsOriginalDetail(zoom: number, fit: number, pixelRatio: number) {
  return zoom > 1.01 && zoom * fit * pixelRatio > 1;
}
