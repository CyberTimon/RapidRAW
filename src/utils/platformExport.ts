import { open, save } from '@tauri-apps/plugin-dialog';
import { isAndroidClient } from './platform';

export const ANDROID_EXPORT_ROOT = 'RapidRaw';

interface ExportFolderOptions {
  defaultPath?: string;
  title: string;
}

interface ExportFileFilter {
  extensions: string[];
  name: string;
}

interface ExportFileOptions {
  defaultPath: string;
  fileName: string;
  filters: ExportFileFilter[];
  title: string;
}

export function joinExportPath(dirPath: string, fileName: string): string {
  return `${dirPath.replace(/[\\/]+$/, '')}/${fileName}`;
}

export function getExportDirectoryPath(filePath: string): string {
  const lastSeparatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSeparatorIndex >= 0 ? filePath.substring(0, lastSeparatorIndex) : '';
}

export async function pickExportFolder({
  defaultPath,
  title,
}: ExportFolderOptions): Promise<string | null> {
  if (isAndroidClient()) {
    return ANDROID_EXPORT_ROOT;
  }

  const selected = await open({
    directory: true,
    title,
    defaultPath: defaultPath ?? undefined,
  });

  return typeof selected === 'string' ? selected : null;
}

export async function pickExportFile({
  defaultPath,
  fileName,
  filters,
  title,
}: ExportFileOptions): Promise<string | null> {
  if (isAndroidClient()) {
    return joinExportPath(ANDROID_EXPORT_ROOT, fileName);
  }

  return await save({
    title,
    defaultPath,
    filters,
  });
}
