import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { Invokes } from '../components/ui/AppProperties';
import { useLibraryStore } from '../store/useLibraryStore';
import { CullingFlag, tagsWithCullingFlag } from '../utils/cullingFlags';

interface MutationQueue {
  confirmed: CullingFlag;
  pending: number;
  tail: Promise<void>;
  version: number;
}

const mutationQueues = new Map<string, MutationQueue>();

function updateLocalFlags(flags: Record<string, CullingFlag>) {
  useLibraryStore.getState().setLibrary((state) => ({
    imageList: state.imageList.map((image) =>
      Object.prototype.hasOwnProperty.call(flags, image.path)
        ? { ...image, tags: tagsWithCullingFlag(image.tags, flags[image.path]) }
        : image,
    ),
  }));
}

export async function setCullingFlagForPaths(
  paths: string[],
  flag: CullingFlag,
  options: { showErrorToast?: boolean } = {},
): Promise<void> {
  const uniquePaths = Array.from(new Set(paths));
  if (uniquePaths.length === 0) return;

  const state = useLibraryStore.getState();
  const previousFlags = Object.fromEntries(uniquePaths.map((path) => [path, state.cullingFlags[path] ?? null]));
  const queued = uniquePaths.map((path) => {
    const queue =
      mutationQueues.get(path) ||
      ({ confirmed: previousFlags[path], pending: 0, tail: Promise.resolve(), version: 0 } satisfies MutationQueue);
    const version = ++queue.version;
    queue.pending += 1;

    const operation = queue.tail
      .catch(() => undefined)
      .then(() => invoke(Invokes.SetCullingFlagForPaths, { paths: [path], flag }))
      .then(() => {
        queue.confirmed = flag;
      });
    queue.tail = operation;
    mutationQueues.set(path, queue);

    return operation
      .then(() => {
        if (queue.version === version) updateLocalFlags({ [path]: flag });
      })
      .catch((error) => {
        if (queue.version === version) updateLocalFlags({ [path]: queue.confirmed });
        throw error;
      })
      .finally(() => {
        queue.pending -= 1;
        if (queue.pending === 0 && queue.version === version) mutationQueues.delete(path);
      });
  });

  updateLocalFlags(Object.fromEntries(uniquePaths.map((path) => [path, flag])));

  try {
    await Promise.all(queued);
  } catch (error) {
    if (options.showErrorToast !== false) toast.error(`Failed to update culling flag: ${error}`);
    throw error;
  }
}
