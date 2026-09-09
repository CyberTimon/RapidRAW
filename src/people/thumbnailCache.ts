/** Bounded request concurrency, in-flight deduplication, and an LRU of successful crops. */
export function createThumbnailCache(load: (id: string) => Promise<string>, capacity = 128, concurrency = 2) {
  const cache = new Map<string, string>();
  const pending = new Map<string, Promise<string>>();
  const queue: Array<() => void> = [];
  let active = 0;
  let generation = 0;
  const pump = () => {
    while (active < concurrency && queue.length) {
      active += 1;
      queue.shift()!();
    }
  };
  return {
    get(id: string): Promise<string> {
      const cached = cache.get(id);
      if (cached !== undefined) {
        cache.delete(id);
        cache.set(id, cached);
        return Promise.resolve(cached);
      }
      const existing = pending.get(id);
      if (existing) return existing;
      const version = generation;
      const result = new Promise<string>((resolve, reject) => {
        queue.push(() => {
          void Promise.resolve()
            .then(() => load(id))
            .then(
              (value) => {
                if (generation === version) {
                  cache.set(id, value);
                  if (cache.size > capacity) cache.delete(cache.keys().next().value!);
                }
                if (pending.get(id) === result) pending.delete(id);
                resolve(value);
              },
              (error) => {
                if (pending.get(id) === result) pending.delete(id);
                reject(error);
              },
            )
            .finally(() => {
              active -= 1;
              pump();
            });
        });
      });
      pending.set(id, result);
      pump();
      return result;
    },
    clear() {
      generation += 1;
      cache.clear();
      pending.clear();
    },
  };
}
