import { useLibraryStore } from '../store/useLibraryStore';
import { requestLibraryExif } from './libraryExifQueue';

/** Selecting a library item never creates or changes an editor session. */
export function selectLibraryImage(path: string) {
  const library = useLibraryStore.getState();
  const alreadySelected = library.multiSelectedPaths.includes(path);
  library.setLibrary({
    libraryActivePath: path,
    multiSelectedPaths: alreadySelected ? library.multiSelectedPaths : [path],
    selectionAnchorPath: alreadySelected ? (library.selectionAnchorPath ?? path) : path,
  });
  requestLibraryExif([path]);
}
