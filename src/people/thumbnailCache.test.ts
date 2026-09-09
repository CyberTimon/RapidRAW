import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createThumbnailCache } from './thumbnailCache';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test('deduplicates in-flight crops and bounds concurrency', async () => {
  const releases = new Map<string, (value: string) => void>();
  let active = 0,
    peak = 0;
  const cache = createThumbnailCache((id) => {
    active += 1;
    peak = Math.max(peak, active);
    return new Promise<string>((resolve) =>
      releases.set(id, (value) => {
        active -= 1;
        resolve(value);
      }),
    );
  });
  const a = cache.get('a'),
    duplicate = cache.get('a'),
    b = cache.get('b'),
    c = cache.get('c');
  assert.equal(a, duplicate);
  await tick();
  assert.equal(releases.size, 2);
  releases.get('a')!('A');
  await tick();
  assert.ok(releases.has('c'));
  releases.get('b')!('B');
  releases.get('c')!('C');
  assert.deepEqual(await Promise.all([a, b, c]), ['A', 'B', 'C']);
  assert.equal(peak, 2);
});
test('failed crops can retry and successful crops use LRU eviction', async () => {
  let attempts = 0;
  const cache = createThumbnailCache(async (id) => {
    attempts += 1;
    if (attempts === 1) throw new Error('offline');
    return id;
  }, 2);
  await assert.rejects(cache.get('a'));
  await tick();
  assert.equal(await cache.get('a'), 'a');
  await cache.get('b');
  await cache.get('a');
  await cache.get('c');
  await tick();
  const before = attempts;
  await cache.get('b');
  assert.equal(attempts, before + 1);
});
test('clearing during a request never restores a stale crop', async () => {
  const releases: Array<(value: string) => void> = [];
  const cache = createThumbnailCache(() => new Promise((resolve) => releases.push(resolve)));
  const old = cache.get('a');
  await tick();
  cache.clear();
  const current = cache.get('a');
  await tick();
  releases[1]('new');
  await current;
  releases[0]('old');
  await old;
  await tick();
  assert.equal(await cache.get('a'), 'new');
});
