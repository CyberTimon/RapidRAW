// Shared by the Files tab and the folder/file pickers (picker.ts)
import { call } from '../shim/transport';

export type Item = { name: string; dir: boolean; size: number; mtime: number; sidecar: boolean };
export type Listing = {
  path: string | null; roots: string[]; library: string | null; labels?: Record<string, string>; sep: string;
  crumbs: { name: string; path: string }[]; items: Item[];
};

export const ls = (path: string | null) => call<Listing>('__rr_fs_ls', { path });

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) (e as unknown as Record<string, unknown>)[k] = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, String(v));
  }
  e.append(...kids);
  return e;
}

const ICONS = {
  dir: '<svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6.5 3H14l5 5v11.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3zM14 3v5h5"/></svg>',
};
export function icon(dir: boolean) {
  const s = el('span', { class: dir ? 'rrf-ico dir' : 'rrf-ico' });
  s.innerHTML = dir ? ICONS.dir : ICONS.file;
  return s;
}

export const errText = (e: unknown) => (typeof e === 'string' ? e : (e as Error)?.message ?? String(e));
export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
export const joinPath = (l: Listing, name: string) => (l.path!.endsWith(l.sep) ? l.path! + name : l.path! + l.sep + name);
export const rootName = (l: Listing, r: string) => l.labels?.[r] ?? baseName(r);
export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function fmtSize(n: number) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(n < 10 ? 1 : 0) : n} ${u[i]}`;
}

// navigator.clipboard works only on https/localhost; over a LAN (http://192.168…) the old execCommand is used
export async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* fallback below */ }
  }
  const ta = el('textarea', { readonly: true, style: 'position:fixed;opacity:0' }) as HTMLTextAreaElement;
  ta.value = text;
  document.body.append(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}
