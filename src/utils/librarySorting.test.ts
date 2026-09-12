import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSortedLibrary } from '../hooks/useSortedLibrary';
import type { ImageFile } from '../components/ui/AppProperties';

const photo = (path: string, date?: string): ImageFile => ({
  path, rating: 1, rating_state: 'ready', modified: 0, is_edited: false,
  tags: null, exif: date ? { DateTimeOriginal: date } : null,
  is_virtual_copy: false, is_cloud_placeholder: false, is_raw: true, group_id: null,
});
function sorted(images: ImageFile[], key = 'name', order = 'asc') {
  return computeSortedLibrary({
    imageList: images, imageRatings: Object.fromEntries(images.map(i => [i.path, 1])),
    filterCriteria: { rating: 1, colors: [] },
    searchCriteria: { tags: [], text: '', mode: 'OR' }, sortCriteria: { key, order },
  }, { appSettings: { grouping: 'off' } }).map(i => i.path);
}

test('filtered recursive CR2 and CR3 filenames sort numerically in both directions', () => {
  for (const extension of ['CR2', 'CR3']) {
    const images = [102, 13, 123, 10, 849, 89, 98, 988].map((n, i) =>
      photo(`/folder${i % 2}/EOSR_${n}.${extension}`));
    const expected = [...images].sort((a, b) =>
      Number(a.path.match(/_(\d+)/)![1]) - Number(b.path.match(/_(\d+)/)![1])).map(i => i.path);
    assert.deepEqual(sorted(images), expected);
    assert.deepEqual(sorted(images, 'name', 'desc'), [...expected].reverse());
    assert.deepEqual(sorted(images, 'rating'), expected);
  }
});

test('duplicate names have deterministic folder tie breaks', () => {
  const images = [photo('/folder10/image.CR3'), photo('/folder2/image.CR3')];
  assert.deepEqual(sorted(images), ['/folder2/image.CR3', '/folder10/image.CR3']);
  assert.deepEqual(sorted([...images].reverse()), sorted(images));
});

test('capture time handles EXIF and normalized dates across folders; missing dates stay last', () => {
  const images = [photo('/a/10.CR3', '2026-09-05 12:00:00'),
    photo('/z/13.CR2', '2026:09:05 09:00:00'), photo('/a/1.CR3'),
    photo('/a/2.CR3', 'invalid')];
  assert.deepEqual(sorted(images, 'date_taken'), ['/z/13.CR2', '/a/10.CR3', '/a/1.CR3', '/a/2.CR3']);
  assert.deepEqual(sorted(images, 'date_taken', 'desc'), ['/a/10.CR3', '/z/13.CR2', '/a/2.CR3', '/a/1.CR3']);
});

test('capture ties use natural filenames, not file modification times', () => {
  const images = [photo('/a/102.CR3', '2026-09-05 12:00:00'), photo('/a/13.CR3', '2026-09-05 12:00:00')];
  images[1].modified = 999;
  assert.deepEqual(sorted(images, 'date_taken'), ['/a/13.CR3', '/a/102.CR3']);
});
