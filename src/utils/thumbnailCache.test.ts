import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeThumbnailCache, setVisibleThumbnails, THUMBNAIL_CACHE_LIMIT } from './thumbnailCache';

test('scrolling across ten thousand photos keeps URL storage bounded and visible photos pinned', () => {
  let cache: Record<string, string> = {};
  setVisibleThumbnails(['first']);
  cache = mergeThumbnailCache(cache, { first: 'asset://first' });
  for (let i = 0; i < 10_000; i += 100) {
    cache = mergeThumbnailCache(
      cache,
      Object.fromEntries(Array.from({ length: 100 }, (_, j) => [`photo-${i + j}`, `asset://${i + j}`])),
    );
    assert.ok(Object.keys(cache).length <= THUMBNAIL_CACHE_LIMIT);
    assert.equal(cache.first, 'asset://first');
  }
  assert.equal(cache['photo-0'], undefined);
  assert.equal(cache['photo-9999'], 'asset://9999');
  setVisibleThumbnails(['photo-0']);
  cache = mergeThumbnailCache(cache, { 'photo-0': 'asset://0' });
  assert.equal(cache['photo-0'], 'asset://0');
  assert.equal(Object.keys(cache).length, THUMBNAIL_CACHE_LIMIT);
  setVisibleThumbnails([]);
});
