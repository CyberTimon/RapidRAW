import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImageFile } from '../components/ui/AppProperties';
import { applyRatingBatch, canAcceptThumbnailRating, type RatingBatch } from './ratingUpdates';
import { computeSortedLibrary, requiresLibraryExif } from '../hooks/useSortedLibrary';

const photo = (path: string, rating_state: ImageFile['rating_state'] = 'pending'): ImageFile => ({
  path, rating_state, rating: 0, modified: 0, is_edited: false, tags: null, exif: null,
  is_virtual_copy: false, is_cloud_placeholder: false, is_raw: true, group_id: null,
});
function filtered(images: ImageFile[], ratings: Record<string, number>, rating: number) {
  return computeSortedLibrary({ imageList: images, imageRatings: ratings,
    filterCriteria: { rating, colors: [], rawStatus: 'all' },
    searchCriteria: { tags: [], text: '', mode: 'OR' }, sortCriteria: { key: 'name', order: 'asc' },
  }, { appSettings: { grouping: 'off' } }).map((image) => image.path);
}
const batch: RatingBatch = { scan_id: 'new', checked: 1, total: 2, failed: 0, done: false,
  updates: [{ path: 'one.CR3', rating: 1, rating_state: 'ready', is_edited: false, tags: null }] };

test('full EXIF is requested only for supported metadata sorts and queries', () => {
  assert.equal(requiresLibraryExif('name', []), false);
  assert.equal(requiresLibraryExif('rating', ['rating:1', 'color:red']), false);
  for (const query of ['camera Canon', 'model:EOS R', 'iso>=800', 'lens EF'])
    assert.equal(requiresLibraryExif('name', [query]), true);
  assert.equal(requiresLibraryExif('date_taken', []), true);
});

test('rating progress never treats pending or failed files as unrated', () => {
  const images = [photo('one.CR3'), photo('two.CR3'), photo('bad.CR3', 'failed')];
  assert.deepEqual(filtered(images, {}, -1), []);
  assert.equal(filtered(images, {}, 0).length, 3);
  const next = applyRatingBatch('new', images, {}, batch, new Set())!;
  assert.deepEqual(filtered(next.imageList, next.imageRatings, 1), ['one.CR3']);
  assert.deepEqual(filtered(next.imageList, next.imageRatings, -1), []);
  assert.equal(next.ratingProgress.done, false);
});
test('late rating scans cannot change a new folder or manual override', () => {
  const images = [photo('one.CR3', 'ready')];
  assert.equal(applyRatingBatch('other', images, {}, batch, new Set()), null);
  const next = applyRatingBatch('new', images, { 'one.CR3': 0 }, batch, new Set(['one.CR3']))!;
  assert.equal(next.imageRatings['one.CR3'], 0);
  assert.deepEqual(filtered(next.imageList, next.imageRatings, -1), ['one.CR3']);
});
test('thumbnail events cannot replace pending, failed, or resolved scan ratings', () => {
  for (const state of ['pending', 'ready', 'failed'] as const) assert.equal(canAcceptThumbnailRating(photo('one.CR3', state)), false);
  assert.equal(canAcceptThumbnailRating(undefined), false);
  const legacy = photo('legacy.CR2'); delete legacy.rating_state;
  assert.equal(canAcceptThumbnailRating(legacy), true);
});
