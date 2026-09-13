import test from 'node:test';
import assert from 'node:assert/strict';
import type { ImageFile, SelectedImage } from '../components/ui/AppProperties';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { getActionHistorySnapshot, redoLastAction, resetActionHistory, undoLastAction } from './actionHistory';
import { commitColorChange, commitExifChange, commitRatingChange, commitTagChange } from './libraryHistory';

type TestRuntime = typeof globalThis & {
  __rapidrawInvoke?: (command: string, args: unknown) => Promise<unknown>;
};

const runtime = globalThis as TestRuntime;
const image = (path: string, rating: number, tags: string[] | null, exif: Record<string, string>): ImageFile => ({
  path,
  rating,
  tags,
  exif,
  is_edited: false,
  modified: 0,
  is_virtual_copy: path.includes('?vc='),
  is_cloud_placeholder: false,
  is_raw: false,
  group_id: null,
});

function reset() {
  resetActionHistory();
  const images = [
    image('a.jpg', 1, ['color:red', 'user:one'], { Artist: 'A' }),
    image('b.jpg', 2, ['user:two'], { Artist: 'B' }),
    image('a.jpg?vc=1', 1, ['color:red'], { Artist: 'A' }),
  ];
  useLibraryStore.setState({ imageList: images, imageRatings: { 'a.jpg': 1, 'b.jpg': 2, 'a.jpg?vc=1': 1 } });
  useEditorStore.setState({
    selectedImage: {
      path: 'a.jpg?vc=1',
      exif: { Artist: 'A' },
      width: 1,
      height: 1,
      isRaw: false,
      isReady: true,
    } as SelectedImage,
  });
  const calls: Array<{ command: string; args: unknown }> = [];
  runtime.__rapidrawInvoke = async (command, args) => {
    calls.push({ command, args });
  };
  return calls;
}

test('ratings restore each photo value and redo the batch', async () => {
  const calls = reset();
  await commitRatingChange(['a.jpg', 'b.jpg'], 5);
  assert.equal(useLibraryStore.getState().imageRatings['a.jpg'], 5);
  assert.equal(useLibraryStore.getState().imageRatings['b.jpg'], 5);
  await undoLastAction();
  assert.equal(useLibraryStore.getState().imageRatings['a.jpg'], 1);
  assert.equal(useLibraryStore.getState().imageRatings['b.jpg'], 2);
  await redoLastAction();
  assert.equal(useLibraryStore.getState().imageRatings['a.jpg'], 5);
  assert.equal(calls.filter(({ command }) => command === 'set_rating_for_paths').length, 4);
});

test('rating is undoable before its first native write resolves', async () => {
  reset();
  let release: (() => void) | undefined;
  let first = true;
  runtime.__rapidrawInvoke = async () => {
    if (!first) return;
    first = false;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };

  const commit = commitRatingChange(['a.jpg'], 4);
  assert.equal(getActionHistorySnapshot().canUndo, true);
  const undo = undoLastAction();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(release);
  release();
  await commit;
  await undo;
  assert.equal(useLibraryStore.getState().imageRatings['a.jpg'], 1);
});

test('overlapping rating writes keep their capture and undo order', async () => {
  reset();
  let release: (() => void) | undefined;
  let first = true;
  runtime.__rapidrawInvoke = async () => {
    if (!first) return;
    first = false;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };

  const firstCommit = commitRatingChange(['a.jpg'], 4);
  const secondCommit = commitRatingChange(['a.jpg'], 5);
  assert.equal(useLibraryStore.getState().imageRatings['a.jpg'], 4);
  release?.();
  await Promise.all([firstCommit, secondCommit]);
  assert.equal(useLibraryStore.getState().imageRatings['a.jpg'], 5);

  await undoLastAction();
  assert.equal(useLibraryStore.getState().imageRatings['a.jpg'], 4);
  await undoLastAction();
  assert.equal(useLibraryStore.getState().imageRatings['a.jpg'], 1);
});

test('color labels and tags preserve unrelated tags across undo', async () => {
  reset();
  await commitColorChange(['a.jpg', 'b.jpg'], 'blue');
  assert.deepEqual(useLibraryStore.getState().imageList[0].tags, ['user:one', 'color:blue']);
  await undoLastAction();
  assert.deepEqual(useLibraryStore.getState().imageList[0].tags, ['user:one', 'color:red']);
  assert.deepEqual(useLibraryStore.getState().imageList[1].tags, ['user:two']);

  await commitTagChange(['a.jpg', 'b.jpg'], 'user:one', true);
  await undoLastAction();
  assert.equal(useLibraryStore.getState().imageList[0].tags?.includes('user:one'), true);
  assert.equal(useLibraryStore.getState().imageList[1].tags?.includes('user:one'), false);
});

test('EXIF undo updates physical and virtual copies plus the selected editor image', async () => {
  reset();
  await commitExifChange(['a.jpg?vc=1'], { Artist: 'Changed' });
  assert.equal(useLibraryStore.getState().imageList[0].exif?.Artist, 'Changed');
  assert.equal(useLibraryStore.getState().imageList[2].exif?.Artist, 'Changed');
  assert.equal(useEditorStore.getState().selectedImage?.exif.Artist, 'Changed');
  await undoLastAction();
  assert.equal(useLibraryStore.getState().imageList[0].exif?.Artist, 'A');
  assert.equal(useLibraryStore.getState().imageList[2].exif?.Artist, 'A');
  assert.equal(useEditorStore.getState().selectedImage?.exif.Artist, 'A');
  assert.equal(getActionHistorySnapshot().canRedo, true);
});

test('failed metadata persistence rolls optimistic state back and records no history', async () => {
  reset();
  runtime.__rapidrawInvoke = async () => {
    throw new Error('write failed');
  };
  await assert.rejects(commitRatingChange(['a.jpg'], 4), /write failed/);
  assert.equal(useLibraryStore.getState().imageRatings['a.jpg'], 1);
  assert.equal(getActionHistorySnapshot().canUndo, false);
});
