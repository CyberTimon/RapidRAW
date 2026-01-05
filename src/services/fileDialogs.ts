import { open, save } from '@tauri-apps/plugin-dialog';
import { IMAGE_EXTENSIONS, RAW_EXTENSIONS } from '../types/library';

export interface FileDialogOptions {
  title?: string;
  defaultPath?: string;
  multiple?: boolean;
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export async function openImageDialog(options: FileDialogOptions = {}): Promise<string | string[] | null> {
  try {
    const result = await open({
      multiple: options.multiple ?? false,
      title: options.title ?? 'Select Image',
      defaultPath: options.defaultPath,
      filters: [
        {
          name: 'All Images',
          extensions: IMAGE_EXTENSIONS,
        },
        {
          name: 'RAW Files',
          extensions: RAW_EXTENSIONS,
        },
        {
          name: 'Standard Images',
          extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'tiff', 'tif', 'bmp'],
        },
      ],
    });
    return result;
  } catch (err) {
    console.error('Failed to open image dialog:', err);
    return null;
  }
}

export async function openFolderDialog(options: FileDialogOptions = {}): Promise<string | null> {
  try {
    const result = await open({
      directory: true,
      multiple: false,
      title: options.title ?? 'Select Folder',
      defaultPath: options.defaultPath,
    });
    return result as string | null;
  } catch (err) {
    console.error('Failed to open folder dialog:', err);
    return null;
  }
}

export async function saveFileDialog(options: SaveDialogOptions = {}): Promise<string | null> {
  try {
    const result = await save({
      title: options.title ?? 'Save File',
      defaultPath: options.defaultPath,
      filters: options.filters ?? [
        { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
        { name: 'PNG', extensions: ['png'] },
        { name: 'TIFF', extensions: ['tiff', 'tif'] },
      ],
    });
    return result;
  } catch (err) {
    console.error('Failed to open save dialog:', err);
    return null;
  }
}

export async function openPresetDialog(): Promise<string | null> {
  try {
    const result = await open({
      multiple: false,
      title: 'Import Preset',
      filters: [
        {
          name: 'RapidRAW Preset',
          extensions: ['rrpreset', 'json'],
        },
      ],
    });
    return result as string | null;
  } catch (err) {
    console.error('Failed to open preset dialog:', err);
    return null;
  }
}

export async function openLUTDialog(): Promise<string | null> {
  try {
    const result = await open({
      multiple: false,
      title: 'Select LUT File',
      filters: [
        {
          name: 'LUT Files',
          extensions: ['cube', '3dl', 'look', 'csp'],
        },
      ],
    });
    return result as string | null;
  } catch (err) {
    console.error('Failed to open LUT dialog:', err);
    return null;
  }
}
