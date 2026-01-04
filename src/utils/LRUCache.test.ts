import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LRUCache, revokeBlobUrl } from './LRUCache';

describe('LRUCache', () => {
  describe('basic operations', () => {
    it('should store and retrieve values', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBe(2);
    });

    it('should return undefined for missing keys', () => {
      const cache = new LRUCache<string, number>(3);
      expect(cache.get('missing')).toBeUndefined();
    });

    it('should report size correctly', () => {
      const cache = new LRUCache<string, number>(10);
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.size).toBe(2);
    });

    it('should check existence with has()', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest item when exceeding maxSize', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4);
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(true);
      expect(cache.has('c')).toBe(true);
      expect(cache.has('d')).toBe(true);
    });

    it('should update LRU order on get()', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.get('a');
      cache.set('d', 4);
      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
    });

    it('should update LRU order on set() of existing key', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('a', 10);
      cache.set('d', 4);
      expect(cache.has('a')).toBe(true);
      expect(cache.get('a')).toBe(10);
      expect(cache.has('b')).toBe(false);
    });
  });

  describe('eviction callback', () => {
    it('should call onEvict when item is evicted', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string, number>(2, onEvict);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(onEvict).toHaveBeenCalledWith('a', 1);
    });

    it('should call onEvict when item is deleted', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string, number>(3, onEvict);
      cache.set('a', 1);
      cache.delete('a');
      expect(onEvict).toHaveBeenCalledWith('a', 1);
    });

    it('should call onEvict for all items on clear()', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string, number>(3, onEvict);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      expect(onEvict).toHaveBeenCalledTimes(2);
    });
  });

  describe('delete', () => {
    it('should remove item and return true', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      expect(cache.delete('a')).toBe(true);
      expect(cache.has('a')).toBe(false);
    });

    it('should return false for non-existent key', () => {
      const cache = new LRUCache<string, number>(3);
      expect(cache.delete('missing')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all items', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.has('a')).toBe(false);
    });
  });

  describe('setMaxSize', () => {
    it('should evict items when reducing size', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4);
      cache.set('e', 5);
      cache.setMaxSize(2);
      expect(cache.size).toBe(2);
      expect(cache.has('d')).toBe(true);
      expect(cache.has('e')).toBe(true);
    });

    it('should call onEvict for evicted items', () => {
      const onEvict = vi.fn();
      const cache = new LRUCache<string, number>(3, onEvict);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.setMaxSize(1);
      expect(onEvict).toHaveBeenCalledTimes(2);
    });
  });

  describe('iteration', () => {
    it('should iterate keys', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      expect([...cache.keys()]).toEqual(['a', 'b']);
    });

    it('should iterate values', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      expect([...cache.values()]).toEqual([1, 2]);
    });

    it('should iterate entries', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      expect([...cache.entries()]).toEqual([['a', 1], ['b', 2]]);
    });
  });

  describe('toRecord', () => {
    it('should convert to plain object', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.toRecord()).toEqual({ a: 1, b: 2 });
    });
  });
});

describe('revokeBlobUrl', () => {
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;

  beforeEach(() => {
    originalRevokeObjectURL = URL.revokeObjectURL;
    URL.revokeObjectURL = vi.fn();
  });

  it('should revoke blob URLs', () => {
    revokeBlobUrl('key', 'blob:http://example.com/123');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://example.com/123');
  });

  it('should not revoke non-blob URLs', () => {
    revokeBlobUrl('key', 'https://example.com/image.jpg');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('should not revoke data URLs', () => {
    revokeBlobUrl('key', 'data:image/png;base64,abc123');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
});
