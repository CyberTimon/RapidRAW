import { getCurrentWindow } from '@tauri-apps/api/window';

export type CloseGuard = () => Promise<boolean>;

const guards = new Set<CloseGuard>();

export const guardWindowClose = (guard: CloseGuard) => {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
};

const allowWindowClose = async () => {
  for (const guard of [...guards]) {
    if (!(await guard().catch(() => true))) return false;
  }
  return true;
};

export const watchWindowClose = () =>
  getCurrentWindow().onCloseRequested(async (event) => {
    if (!(await allowWindowClose())) event.preventDefault();
  });
