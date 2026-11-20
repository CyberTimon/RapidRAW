// Choosing a folder/file/destination on the SERVER for RapidRAW's dialogs (rrweb/shim/dialog.ts): Add Folder, export,
// import, LUTs, presets. Starts in the photo library; a path can also be typed in ("Type a path…").
import { call } from '../shim/transport';
import { collator, el, errText, icon, joinPath, ls, rootName, type Listing } from './ui';
import './files.css';

export type PickOptions = {
  mode: 'dir' | 'file' | 'save';
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  extensions?: string[]; // without the dot; empty or '*' = all files
};

const splitPath = (p: string) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i) || p.slice(0, 1), name: p.slice(i + 1) };
};

export function pick(opts: PickOptions): Promise<string | string[] | null> {
  return new Promise((resolve) => {
    const exts = (opts.extensions ?? []).map((e) => e.toLowerCase()).filter((e) => e && e !== '*');
    const wanted = (name: string) => !exts.length || exts.some((e) => name.toLowerCase().endsWith(`.${e}`));
    const start = opts.defaultPath ? (opts.mode === 'dir' ? opts.defaultPath : splitPath(opts.defaultPath).dir) : '';
    let listing: Listing | null = null;
    let selected = new Set<string>();

    const title = opts.title ?? (opts.mode === 'dir' ? 'Choose a folder' : opts.mode === 'save' ? 'Save as' : 'Choose files');
    const roots = el('select', { class: 'rrp-roots', title: 'Photo folders',
      onchange: () => load(roots.value) }) as HTMLSelectElement;
    const crumbs = el('div', { class: 'rrf-crumbs rrp-crumbs' });
    const list = el('div', { class: 'rrp-list' });
    const msg = el('div', { class: 'rrp-msg' });
    const name = el('input', { class: 'rrp-name', type: 'text', placeholder: 'File name',
      value: opts.mode === 'save' && opts.defaultPath ? splitPath(opts.defaultPath).name : '' }) as HTMLInputElement;
    const ok = el('button', { class: 'rrp-ok', onclick: () => confirm() }, '');
    const box = el('div', { class: 'rrp', role: 'dialog', 'aria-label': title },
      el('div', { class: 'rrp-head' }, el('b', {}, title), roots),
      crumbs, list, msg,
      el('div', { class: 'rrp-foot' },
        ...(opts.mode === 'save' ? [name] : []),
        el('button', { class: 'rrp-link', onclick: () => typePath(), title: 'For a path outside the photo folders' }, 'Type a path…'),
        el('span', { class: 'rrf-grow' }),
        el('button', { onclick: () => close(null) }, 'Cancel'), ok));
    const back = el('div', { class: 'rrp-back', onmousedown: (e: MouseEvent) => { if (e.target === back) close(null); } }, box);

    function close(result: string | string[] | null) {
      window.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(result);
    }

    function render() {
      if (!listing) return;
      roots.replaceChildren(...listing.roots.map((r) => el('option', { value: r, selected: listing!.crumbs[0]?.path === r }, rootName(listing!, r))));
      roots.hidden = listing.roots.length < 2;
      crumbs.replaceChildren(...listing.crumbs.flatMap((c, i) =>
        [...(i ? [el('span', { class: 'rrf-sep-char' }, '›')] : []), el('button', { onclick: () => load(c.path) }, c.name)]));
      const items = listing.items
        .filter((i) => (i.dir || (opts.mode !== 'dir' && wanted(i.name))) && !i.sidecar)
        .sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));
      list.replaceChildren(...items.map((it) => el('div', {
        class: `rrp-row${selected.has(it.name) ? ' sel' : ''}`,
        onclick: (e: MouseEvent) => {
          if (it.dir && opts.mode !== 'dir') { load(joinPath(listing!, it.name)); return; }
          if (opts.multiple && (e.ctrlKey || e.metaKey)) { if (!selected.delete(it.name)) selected.add(it.name); }
          else selected = new Set([it.name]);
          if (opts.mode === 'save' && !it.dir) name.value = it.name;
          render();
        },
        ondblclick: () => (it.dir ? load(joinPath(listing!, it.name)) : confirm()),
      }, icon(it.dir), el('span', {}, it.name))));
      if (!items.length) list.append(el('div', { class: 'rrf-empty' }, listing.path ? 'Nothing to choose here' : 'No photo folders yet'));
      const [one] = [...selected];
      ok.textContent = opts.mode === 'save' ? 'Save'
        : opts.mode === 'dir' ? `Choose “${one ?? listing.crumbs.at(-1)?.name ?? ''}”`
        : selected.size > 1 ? `Open ${selected.size} files` : 'Open';
      ok.toggleAttribute('disabled', !listing.path || (opts.mode === 'file' && !selected.size));
    }

    async function load(path: string | null) {
      try {
        const next = await ls(path);
        if (!next.path && next.roots.length) return load(next.library ?? next.roots[0]);
        listing = next;
        selected = new Set();
        msg.textContent = next.roots.length ? '' : 'No photo folders yet. Choose the photo library in the RapidRAW Web window on the server, or type a path.';
        render();
      } catch (e) {
        if (path) return load(null); // e.g. a defaultPath outside the photo folders
        msg.textContent = errText(e);
      }
    }

    function confirm() {
      if (!listing?.path) return;
      if (opts.mode === 'dir') close([...selected][0] ? joinPath(listing, [...selected][0]) : listing.path);
      else if (opts.mode === 'save') {
        const n = name.value.trim();
        if (!n || /[\\/]/.test(n)) { msg.textContent = 'Enter a file name'; name.focus(); return; }
        close(joinPath(listing, n));
      } else {
        const paths = [...selected].map((n) => joinPath(listing!, n));
        if (paths.length) close(opts.multiple ? paths : paths[0]);
      }
    }

    async function typePath() {
      const def = listing?.path ?? (await call<string>('__rr_home'));
      const v = window.prompt(`${title} (path on the server${opts.multiple ? ', several separated by ;' : ''}):`, def);
      if (!v?.trim()) return;
      close(opts.multiple ? v.split(';').map((s) => s.trim()).filter(Boolean) : v.trim());
    }

    // RapidRAW must not get keys while the dialog is open; typing into the name field still works
    function onKey(e: KeyboardEvent) {
      e.stopImmediatePropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); confirm(); }
      else if (e.key === 'Backspace' && e.target !== name && listing && listing.crumbs.length > 1) {
        e.preventDefault();
        load(listing.crumbs[listing.crumbs.length - 2].path);
      }
    }
    window.addEventListener('keydown', onKey, true);
    document.body.append(back);
    if (opts.mode === 'save') name.focus();
    load(start || null);
  });
}

