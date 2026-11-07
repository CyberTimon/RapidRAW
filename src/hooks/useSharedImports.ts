// Photos handed to RapidRAW on Android: "Share → RapidRAW" and "Open with → RapidRAW".
// MainActivity.kt copies them into the app's library (Imports/Shared/YYYY-MM-DD) and leaves a note that
// take_shared_imports (src-tauri/src/shared_import.rs) hands over once; this hook asks for it when the UI has
// loaded (cold start) and whenever MainActivity calls window.__rapidrawSharedImports (the app was running).
// One photo opens in the editor, several open in the library in their folder.
import { useEffect, useRef } from 'react';
import i18n from 'i18next';
import { toast, Id } from 'react-toastify';
import { invoke } from '@tauri-apps/api/core';

import { Invokes } from '../components/ui/AppProperties';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';

export interface SharedImports {
  paths: string[];
  folder: string | null;
  unsupported: string[];
  failed: number;
}

declare global {
  interface Window {
    __rapidrawSharedImports?: (state: string, count: number) => void;
  }
}

// i18next's t (its typed key union does not take these keys with options)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const t = (key: string, options?: any): string => (i18n.t as any)(key, options);

const separatorOf = (p: string) => (p.includes('/') ? '/' : '\\');
const trimEnd = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);
const baseName = (p: string) => trimEnd(p).split(/[\\/]/).pop() ?? p;

/** root, root/a, root/a/b … up to folder (when folder is inside root). */
export function foldersBetween(root: string, folder: string): string[] {
  const r = trimEnd(root);
  const f = trimEnd(folder);
  if (f !== r && !f.startsWith(r + separatorOf(r))) return [f];
  const out = [r];
  let current = r;
  for (const part of f.slice(r.length).split(/[\\/]/).filter(Boolean)) {
    current = current + separatorOf(r) + part;
    out.push(current);
  }
  return out;
}

function currentRoots(): string[] {
  const { appSettings } = useSettingsStore.getState();
  const { rootPaths } = useLibraryStore.getState();
  if (rootPaths?.length) return rootPaths;
  if (appSettings?.rootFolders?.length) return appSettings.rootFolders;
  return appSettings?.lastRootPath ? [appSettings.lastRootPath] : [];
}

interface Props {
  handleImageSelect: (path: string) => unknown;
  handleSelectSubfolder: (path: string | null, isNewRoot?: boolean) => Promise<void>;
  refreshAllFolderTrees: () => Promise<void>;
}

export function useSharedImports(props: Props) {
  const appSettingsLoaded = useSettingsStore((state) => state.appSettings !== null);
  const osPlatform = useSettingsStore((state) => state.osPlatform);
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });

  const ready = osPlatform === 'android' && appSettingsLoaded;

  useEffect(() => {
    if (!ready) return;
    let busy = false;
    let again = false;
    let receiving: Id | null = null;

    // shows root (added to the library if needed) with folder open and selected
    const showFolder = async (root: string, folder: string) => {
      const { appSettings, handleSettingsChange } = useSettingsStore.getState();
      const { expandedFolders, setLibrary } = useLibraryStore.getState();
      let roots = currentRoots();
      if (!roots.includes(root)) {
        roots = [...roots, root];
        if (appSettings) handleSettingsChange({ ...appSettings, rootFolders: roots });
      }
      const expanded = new Set(expandedFolders);
      foldersBetween(root, folder).forEach((f) => expanded.add(f));
      setLibrary({ rootPaths: roots, expandedFolders: expanded });
      await propsRef.current.refreshAllFolderTrees();
      await propsRef.current.handleSelectSubfolder(folder, false);
    };

    const open = async (shared: SharedImports) => {
      if (shared.unsupported.length) {
        toast.warn(t('library.sharedImports.unsupported', { names: shared.unsupported.join(', ') }), {
          autoClose: 10000,
        });
      }
      if (shared.failed) {
        toast.error(t('library.sharedImports.failed', { count: shared.failed }), { autoClose: 10000 });
      }
      if (!shared.paths.length || !shared.folder) return;

      const root = await invoke<string>(Invokes.GetOrCreateInternalLibraryRoot);
      const target = { root, folder: shared.folder, paths: shared.paths };

      await showFolder(target.root, target.folder);
      if (target.paths.length === 1) {
        await propsRef.current.handleImageSelect(target.paths[0]);
      } else {
        toast.success(
          t('library.sharedImports.opened', { count: target.paths.length, folder: baseName(target.folder) }),
        );
      }
    };

    const take = async () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          const shared = await invoke<SharedImports>('take_shared_imports');
          if (shared.paths.length || shared.unsupported.length || shared.failed) {
            if (receiving !== null) toast.dismiss(receiving);
            receiving = null;
            await open(shared);
          }
        } while (again);
      } catch (e) {
        console.error('Failed to open shared files:', e);
        toast.error(t('library.sharedImports.error', { error: String(e) }));
      } finally {
        busy = false;
      }
    };

    window.__rapidrawSharedImports = (state: string, count: number) => {
      if (state === 'receiving') {
        if (receiving !== null) toast.dismiss(receiving);
        receiving = toast.info(t('library.sharedImports.receiving', { count }), { autoClose: false });
        return;
      }
      if (receiving !== null) toast.dismiss(receiving);
      receiving = null;
      void take();
    };
    void take();

    return () => {
      delete window.__rapidrawSharedImports;
    };
  }, [ready]);
}
