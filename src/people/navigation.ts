import { invoke } from '@tauri-apps/api/core';
import type { ImageFile } from '../components/ui/AppProperties';
import { useLibraryStore } from '../store/useLibraryStore';
import { peopleInvoke, usePeopleStore } from './store';
export async function loadPersonBucket(id: string) {
  const paths = await peopleInvoke<string[]>('paths', { id });
  const images = await invoke<ImageFile[]>('get_album_images', { paths });
  useLibraryStore.getState().setLibrary({
    currentFolderPath: null,
    activeAlbumId: null,
    imageList: images,
    multiSelectedPaths: [],
    libraryActivePath: null,
    libraryScrollTop: 0,
    imageRatings: Object.fromEntries(images.map((i) => [i.path, i.rating])),
  });
  usePeopleStore.setState({ activePersonId: id });
}
