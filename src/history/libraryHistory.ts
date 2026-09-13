import { invoke } from '@tauri-apps/api/core';
import { Invokes, type ImageFile } from '../components/ui/AppProperties';
import { protectManualRatings } from '../hooks/libraryRatingScan';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { globalImageCache } from '../utils/ImageLRUCache';
import { discardUndoableAction, recordUndoableAction } from './actionHistory';
import { queuePhotoMutation } from './persistence';

type Values<T> = Record<string, T>;

const groupValues = <T>(values: Values<T>) => {
  const groups = new Map<string, { paths: string[]; value: T }>();
  Object.entries(values).forEach(([path, value]) => {
    const key = JSON.stringify(value);
    const group = groups.get(key) ?? { paths: [], value };
    group.paths.push(path);
    groups.set(key, group);
  });
  return [...groups.values()];
};

function applyRatings(values: Values<number>) {
  const paths = new Set(Object.keys(values));
  protectManualRatings([...paths]);
  useLibraryStore.getState().setLibrary((state) => ({
    imageRatings: { ...state.imageRatings, ...values },
    imageList: state.imageList.map((image) =>
      paths.has(image.path) ? { ...image, rating: values[image.path], rating_state: 'ready' } : image,
    ),
  }));
}

async function persistRatings(values: Values<number>) {
  for (const group of groupValues(values))
    await invoke(Invokes.SetRatingForPaths, { paths: group.paths, rating: group.value });
}

export const commitRatingChange = (paths: string[], rating: number) =>
  queuePhotoMutation(async () => {
    const state = useLibraryStore.getState();
    const before = Object.fromEntries(
      paths.map((path) => [
        path,
        state.imageRatings[path] ?? state.imageList.find((image) => image.path === path)?.rating ?? 0,
      ]),
    );
    const after = Object.fromEntries(paths.map((path) => [path, rating]));
    if (JSON.stringify(before) === JSON.stringify(after)) return;

    applyRatings(after);
    const actionId = recordLibraryAction(
      'Change rating',
      () => replayRatings(before, after),
      () => replayRatings(after, before),
    );
    try {
      await persistRatings(after);
    } catch (error) {
      applyRatings(before);
      discardUndoableAction(actionId);
      throw error;
    }
  });

async function replayRatings(values: Values<number>, rollback: Values<number>) {
  await queuePhotoMutation(async () => {
    applyRatings(values);
    try {
      await persistRatings(values);
    } catch (error) {
      applyRatings(rollback);
      throw error;
    }
  });
}

const colorFor = (image: ImageFile | undefined) =>
  image?.tags?.find((tag) => tag.startsWith('color:'))?.slice('color:'.length) ?? null;

function applyColors(values: Values<string | null>) {
  useLibraryStore.getState().setLibrary((state) => ({
    imageList: state.imageList.map((image) => {
      if (!(image.path in values)) return image;
      const tags = (image.tags ?? []).filter((tag) => !tag.startsWith('color:'));
      if (values[image.path]) tags.push(`color:${values[image.path]}`);
      return { ...image, tags: tags.length ? tags : null };
    }),
  }));
}

async function persistColors(values: Values<string | null>) {
  for (const group of groupValues(values))
    await invoke(Invokes.SetColorLabelForPaths, { paths: group.paths, color: group.value });
}

export const commitColorChange = (paths: string[], color: string | null) =>
  queuePhotoMutation(async () => {
    const images = useLibraryStore.getState().imageList;
    const before = Object.fromEntries(
      paths.map((path) => [path, colorFor(images.find((image) => image.path === path))]),
    );
    const after = Object.fromEntries(paths.map((path) => [path, color]));
    if (JSON.stringify(before) === JSON.stringify(after)) return;

    applyColors(after);
    const actionId = recordLibraryAction(
      'Change color label',
      () => replayColors(before, after),
      () => replayColors(after, before),
    );
    try {
      await persistColors(after);
    } catch (error) {
      applyColors(before);
      discardUndoableAction(actionId);
      throw error;
    }
  });

async function replayColors(values: Values<string | null>, rollback: Values<string | null>) {
  await queuePhotoMutation(async () => {
    applyColors(values);
    try {
      await persistColors(values);
    } catch (error) {
      applyColors(rollback);
      throw error;
    }
  });
}

function applyTags(values: Values<boolean>, tag: string) {
  useLibraryStore.getState().setLibrary((state) => ({
    imageList: state.imageList.map((image) => {
      if (!(image.path in values)) return image;
      const tags = new Set(image.tags ?? []);
      if (values[image.path]) tags.add(tag);
      else tags.delete(tag);
      const sorted = [...tags].sort();
      return { ...image, tags: sorted.length ? sorted : null };
    }),
  }));
}

async function persistTags(values: Values<boolean>, tag: string) {
  for (const group of groupValues(values))
    await invoke(group.value ? Invokes.AddTagForPaths : Invokes.RemoveTagForPaths, { paths: group.paths, tag });
}

export const commitTagChange = (paths: string[], tag: string, present: boolean) =>
  queuePhotoMutation(async () => {
    const images = useLibraryStore.getState().imageList;
    const before = Object.fromEntries(
      paths.map((path) => [path, images.find((image) => image.path === path)?.tags?.includes(tag) ?? false]),
    );
    const after = Object.fromEntries(paths.map((path) => [path, present]));
    if (JSON.stringify(before) === JSON.stringify(after)) return;

    applyTags(after, tag);
    const actionId = recordLibraryAction(
      'Change tags',
      () => replayTags(before, after, tag),
      () => replayTags(after, before, tag),
    );
    try {
      await persistTags(after, tag);
    } catch (error) {
      applyTags(before, tag);
      discardUndoableAction(actionId);
      throw error;
    }
  });

async function replayTags(values: Values<boolean>, rollback: Values<boolean>, tag: string) {
  await queuePhotoMutation(async () => {
    applyTags(values, tag);
    try {
      await persistTags(values, tag);
    } catch (error) {
      applyTags(rollback, tag);
      throw error;
    }
  });
}

function applyExif(values: Values<Record<string, string>>) {
  const physicalPaths = new Set(Object.keys(values));
  const update = (path: string, exif: Record<string, string> | null | undefined) => ({
    ...(exif ?? {}),
    ...(values[path.split('?vc=')[0]] ?? {}),
  });
  useLibraryStore.getState().setLibrary((state) => ({
    imageList: state.imageList.map((image) =>
      physicalPaths.has(image.path.split('?vc=')[0]) ? { ...image, exif: update(image.path, image.exif) } : image,
    ),
  }));
  useEditorStore.getState().setEditor((state) =>
    state.selectedImage && physicalPaths.has(state.selectedImage.path.split('?vc=')[0])
      ? {
          selectedImage: { ...state.selectedImage, exif: update(state.selectedImage.path, state.selectedImage.exif) },
        }
      : {},
  );
  useLibraryStore.getState().imageList.forEach((image) => {
    const cached = globalImageCache.get(image.path);
    if (cached?.selectedImage && physicalPaths.has(image.path.split('?vc=')[0]))
      globalImageCache.set(image.path, {
        ...cached,
        selectedImage: { ...cached.selectedImage, exif: update(image.path, cached.selectedImage.exif) },
      });
  });
}

async function persistExif(values: Values<Record<string, string>>) {
  for (const group of groupValues(values))
    await invoke(Invokes.UpdateExifFields, { paths: group.paths, updates: group.value });
}

export const commitExifChange = (paths: string[], updates: Record<string, string>) =>
  queuePhotoMutation(async () => {
    const state = useLibraryStore.getState();
    const editor = useEditorStore.getState();
    const physicalPaths = [...new Set(paths.map((path) => path.split('?vc=')[0]))];
    const before = Object.fromEntries(
      physicalPaths.map((path) => {
        const exif =
          state.imageList.find((image) => image.path.split('?vc=')[0] === path)?.exif ??
          (editor.selectedImage?.path.split('?vc=')[0] === path ? editor.selectedImage.exif : {});
        return [path, Object.fromEntries(Object.keys(updates).map((key) => [key, String(exif?.[key] ?? '')]))];
      }),
    );
    const after = Object.fromEntries(physicalPaths.map((path) => [path, { ...updates }]));
    if (JSON.stringify(before) === JSON.stringify(after)) return;

    applyExif(after);
    const actionId = recordLibraryAction(
      'Edit metadata',
      () => replayExif(before, after),
      () => replayExif(after, before),
    );
    try {
      await persistExif(after);
    } catch (error) {
      applyExif(before);
      discardUndoableAction(actionId);
      throw error;
    }
  });

async function replayExif(values: Values<Record<string, string>>, rollback: Values<Record<string, string>>) {
  await queuePhotoMutation(async () => {
    applyExif(values);
    try {
      await persistExif(values);
    } catch (error) {
      applyExif(rollback);
      throw error;
    }
  });
}

function recordLibraryAction(label: string, undo: () => Promise<void>, redo: () => Promise<void>) {
  return recordUndoableAction({ label, undo, redo });
}
