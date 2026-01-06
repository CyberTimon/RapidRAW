/**
 * Mock implementations for Tauri APIs when running in browser (pnpm dev)
 * This allows testing the UI without the Rust backend
 */

import type { AppSettings } from '../blocs/app/SettingsBloc';
import type { ImageFile } from '../types/library';

// Check if we're running in Tauri or browser
export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

// Default mock settings
const mockSettings: AppSettings = {
  theme: 'dark',
  lastRootPath: null,
  lastFolderState: null,
  pinnedFolders: [],
  editorPreviewResolution: 2560,
  enableZoomHifi: true,
  enableAiTagging: false,
  enableExifReading: true,
  thumbnailSize: 'medium',
  thumbnailAspectRatio: 'cover',
  copyPasteSettings: { mode: 'merge', includedAdjustments: [] },
};

// Mock image files for testing
const mockImages: ImageFile[] = [
  {
    path: '/mock/image1.jpg',
    name: 'image1.jpg',
    extension: 'jpg',
    size: 1024000,
    modified: Date.now(),
    created: Date.now() - 86400000,
    isRaw: false,
    tags: ['landscape'],
  },
  {
    path: '/mock/image2.arw',
    name: 'image2.arw',
    extension: 'arw',
    size: 25000000,
    modified: Date.now() - 86400000,
    created: Date.now() - 172800000,
    isRaw: true,
    tags: ['portrait'],
  },
];

// Type for invoke command handlers
type InvokeHandler = (args?: Record<string, unknown>) => Promise<unknown>;

// Mock implementations for Tauri invoke commands
const mockInvokeHandlers: Record<string, InvokeHandler> = {
  load_settings: async () => mockSettings,
  save_settings: async () => undefined,
  list_images_in_dir: async () => mockImages,
  list_images_recursive: async () => mockImages,
  get_folder_tree: async (args) => ({
    path: args?.rootPath || '/mock',
    name: 'mock',
    children: [],
    isExpanded: true,
  }),
  get_pinned_folder_trees: async () => [],
  load_metadata: async () => ({
    adjustments: null,
    rating: 0,
    colorLabel: null,
    tags: [],
  }),
  generate_thumbnails: async () => undefined,
  generate_thumbnails_progressive: async () => undefined,
  cancel_thumbnail_generation: async () => undefined,
  load_presets: async () => [],
  save_presets: async () => undefined,
  get_supported_file_types: async () => ({
    raw: ['arw', 'cr2', 'cr3', 'nef', 'raf', 'dng'],
    nonRaw: ['jpg', 'jpeg', 'png', 'tiff', 'webp'],
  }),
  get_log_file_path: async () => '/mock/rapidraw.log',
  clear_thumbnail_cache: async () => undefined,
};

/**
 * Mock invoke function that returns mock data when not in Tauri
 */
export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Simulate network delay
  await new Promise((resolve) => setTimeout(resolve, 50));

  const handler = mockInvokeHandlers[cmd];
  if (handler) {
    return handler(args) as Promise<T>;
  }

  console.warn(`[TauriMock] Unhandled command: ${cmd}`, args);
  throw new Error(`Mock not implemented for command: ${cmd}`);
}

/**
 * Mock listen function that returns a no-op unsubscribe
 */
export async function mockListen<T>(
  _event: string,
  _handler: (event: { payload: T }) => void
): Promise<() => void> {
  // Return a no-op unsubscribe function
  return () => {};
}

/**
 * Mock open dialog that returns null (user cancelled)
 */
export async function mockOpenDialog(): Promise<string | null> {
  console.log('[TauriMock] Open dialog called - returning null (cancelled)');
  return null;
}

/**
 * Mock getVersion
 */
export async function mockGetVersion(): Promise<string> {
  return '0.0.0-dev';
}

/**
 * Mock shell open
 */
export async function mockShellOpen(url: string): Promise<void> {
  console.log('[TauriMock] Opening URL:', url);
  window.open(url, '_blank');
}
