export class LRUCache<K, V> {
  private cache: Map<K, V>;
  private maxSize: number;
  private onEvict?: (key: K, value: V) => void;

  constructor(maxSize: number, onEvict?: (key: K, value: V) => void) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.onEvict = onEvict;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldestValue = this.cache.get(oldestKey);
        this.cache.delete(oldestKey);
        if (oldestValue !== undefined && this.onEvict) {
          this.onEvict(oldestKey, oldestValue);
        }
      }
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    const value = this.cache.get(key);
    const deleted = this.cache.delete(key);
    if (deleted && value !== undefined && this.onEvict) {
      this.onEvict(key, value);
    }
    return deleted;
  }

  clear(): void {
    if (this.onEvict) {
      for (const [key, value] of this.cache) {
        this.onEvict(key, value);
      }
    }
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  values(): IterableIterator<V> {
    return this.cache.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.cache.entries();
  }

  toRecord(): Record<string, V> {
    const result: Record<string, V> = {};
    for (const [key, value] of this.cache) {
      result[String(key)] = value;
    }
    return result;
  }

  setMaxSize(newMaxSize: number): void {
    this.maxSize = newMaxSize;
    while (this.cache.size > this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.delete(oldestKey);
      }
    }
  }
}

export function revokeBlobUrl(_key: string, url: string): void {
  if (url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}
