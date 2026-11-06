// Dialogs choose a path on the SERVER: a browser of the photo folders (rrweb/files/picker.ts), starting in the photo library.
import { pick } from '../files/picker';
type Filter = { name: string; extensions: string[] };
type OpenOpts = { directory?: boolean; multiple?: boolean; defaultPath?: string; title?: string; filters?: Filter[] };
export async function open(opts: OpenOpts = {}): Promise<string | string[] | null> {
  return pick({ mode: opts.directory ? 'dir' : 'file', multiple: opts.multiple, title: opts.title,
    defaultPath: opts.defaultPath, extensions: opts.filters?.flatMap((f) => f.extensions) });
}
export async function save(opts: { defaultPath?: string; title?: string; filters?: Filter[] } = {}): Promise<string | null> {
  return pick({ mode: 'save', title: opts.title, defaultPath: opts.defaultPath,
    extensions: opts.filters?.flatMap((f) => f.extensions) }) as Promise<string | null>;
}
export const ask = async (msg: string) => window.confirm(msg);
export const confirm = ask;
export const message = async (msg: string) => window.alert(msg);
