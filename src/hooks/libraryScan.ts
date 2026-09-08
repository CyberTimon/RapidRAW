import { Channel, invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import type { ImageFile } from '../components/ui/AppProperties';
import { useLibraryStore } from '../store/useLibraryStore';
import { isCurrentLibraryLoad } from './libraryRatingScan';

interface ScanBatch {
  scan_id: string;
  images: ImageFile[];
  warnings: string[];
  done: boolean;
}

export async function scanLibrary(path: string, recursive: boolean, scanId: string): Promise<ImageFile[]> {
  useLibraryStore.getState().setLibrary({ isDiscovering: true });
  const files: ImageFile[] = [];
  const warnings: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    timer = undefined;
    if (!isCurrentLibraryLoad(scanId)) return;
    useLibraryStore.getState().setLibrary((state) => {
      const existing = new Map(state.imageList.map((image) => [image.path, image]));
      return { imageList: files.map((image) => existing.get(image.path) ?? image), isViewLoading: false };
    });
  };
  const channel = new Channel<ScanBatch>();
  let complete!: () => void;
  const delivered = new Promise<void>((resolve) => {
    complete = resolve;
  });
  channel.onmessage = (batch) => {
    if (batch.scan_id === scanId && batch.done) complete();
    if (batch.scan_id !== scanId || !isCurrentLibraryLoad(scanId)) return;
    const first = files.length === 0;
    files.push(...batch.images);
    warnings.push(...batch.warnings);
    if (first) publish();
    else if (!timer) timer = setTimeout(publish, 100);
  };
  try {
    await invoke('start_library_scan', { path, recursive, scanId, onBatch: channel });
    await delivered;
  } finally {
    clearTimeout(timer);
    publish();
    if (isCurrentLibraryLoad(scanId)) useLibraryStore.getState().setLibrary({ isDiscovering: false });
    if (warnings.length && isCurrentLibraryLoad(scanId)) {
      console.warn('Some folders could not be read', warnings);
      toast.warn(`Could not read ${warnings.length} folder entries. Available photos are shown.`);
    }
  }
  return isCurrentLibraryLoad(scanId) ? useLibraryStore.getState().imageList : files;
}
