import { invoke } from '@tauri-apps/api/core';
import type { ImageFile } from '../components/ui/AppProperties';
import { useLibraryStore } from '../store/useLibraryStore';
import { peopleInvoke, usePeopleStore } from './store';

type LibraryReturnState = Pick<
  ReturnType<typeof useLibraryStore.getState>,
  | 'currentFolderPath'
  | 'activeAlbumId'
  | 'imageList'
  | 'imageRatings'
  | 'multiSelectedPaths'
  | 'libraryActivePath'
  | 'libraryScrollTop'
>;

let libraryReturnState: LibraryReturnState | null = null;

export async function loadPersonBucket(id: string) {
  if (!usePeopleStore.getState().activePersonId) {
    const library = useLibraryStore.getState();
    libraryReturnState = {
      currentFolderPath: library.currentFolderPath,
      activeAlbumId: library.activeAlbumId,
      imageList: library.imageList,
      imageRatings: library.imageRatings,
      multiSelectedPaths: library.multiSelectedPaths,
      libraryActivePath: library.libraryActivePath,
      libraryScrollTop: library.libraryScrollTop,
    };
  }
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

export function restoreLibraryAfterPeople() {
  usePeopleStore.setState({ activePersonId: null });
  if (!libraryReturnState) return;
  useLibraryStore.getState().setLibrary(libraryReturnState);
  libraryReturnState = null;
}
