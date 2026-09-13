import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLibraryImage } from './librarySelection';
import { useLibraryStore } from '../store/useLibraryStore';
import { resetLibraryExifQueue } from './libraryExifQueue';
import type { ImageFile } from '../components/ui/AppProperties';

test('gallery selection requests metadata only and preserves multiselection', async () => {
  const calls: string[] = [];
  Object.assign(globalThis, {
    __rapidrawInvoke: async (command: string) => {
      calls.push(command);
      return {};
    },
  });
  resetLibraryExifQueue();
  const image = (path: string): ImageFile => ({
    path,
    exif: null,
    modified: 1,
    rating: 0,
    tags: [],
    is_edited: false,
    is_raw: true,
    is_virtual_copy: false,
    is_cloud_placeholder: false,
    group_id: null,
  });
  useLibraryStore.setState({
    imageList: [image('a.CR3'), image('b.CR3')],
    multiSelectedPaths: ['a.CR3', 'b.CR3'],
    selectionAnchorPath: 'a.CR3',
  });
  selectLibraryImage('b.CR3');
  await Promise.resolve();
  assert.equal(useLibraryStore.getState().libraryActivePath, 'b.CR3');
  assert.deepEqual(useLibraryStore.getState().multiSelectedPaths, ['a.CR3', 'b.CR3']);
  assert.equal(useLibraryStore.getState().selectionAnchorPath, 'a.CR3');
  assert.deepEqual(calls, ['read_exif_for_paths']);
});
