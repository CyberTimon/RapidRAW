// What happens while you wait: when a photo opens (fetched from the computer that shares it, then RAW decoding), on
// thumbnails that aren't ready yet (library and filmstrip: queued, downloading, rendering) and in total in the top
// bar. It also reports the view to the relay (editor or library) and, in the editor, the photos next to the open one
// in the filmstrip: while a photo is open, the relay makes thumbnails only in the pauses between edits, and heavy ones
// only for those photos (the next ones first).
// The data comes from the relay (__rr_progress, __rr_thumbs, __rr_thumbs_summary); RapidRAW's UI is not touched, the
// labels are only placed over its elements.
import { call, onCall } from '../shim/transport';
import { el, fmtSize } from './ui';

type Load = { phase: 'downloading' | 'decoding' | 'offline'; fetched?: number; total?: number; rate?: number; decodeMs?: number };
type Thumb = { state: 'queued' | 'preparing' | 'downloading' | 'rendering'; pos?: number; eta?: number | null; paused?: boolean; fetched?: number; total?: number };
type Summary = { left: number; heavy: number; paused: boolean; eta: number; editing?: boolean; later?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = (p: string) => p.split('?vc=')[0].split(/[\\/]/).pop() ?? p;
const secs = (s: number) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);

export function mountProgress(tabs: HTMLElement) {
  const names = new Map<string, string>(); // name on the tile → path (from update_thumbnail_queue)
  let openPath = '';                         // photo open in the editor (last load_image)

  // --- opening a photo in the editor ---
  const pill = el('div', { class: 'rrl-load', hidden: true });
  document.body.append(pill);
  type Cur = { path: string; t0: number; decodeFrom: number; downloaded: boolean };
  let current: Cur | null = null;

  async function watchLoad(cur: Cur) {
    await sleep(400); // a quick opening without flicker
    while (current === cur) {
      const p = await call<Load>('__rr_progress', { path: cur.path }).catch(() => null);
      if (current !== cur) break;
      if (p) render(cur, p);
      await sleep(400);
    }
  }

  function render(cur: Cur, p: Load) {
    const name = base(cur.path);
    let text: string;
    let frac: number | null = null;
    if (p.phase === 'offline') text = `${name} · the computer with this folder is not connected`;
    else if (p.phase === 'downloading' && p.total) {
      cur.downloaded = true;
      frac = (p.fetched ?? 0) / p.total;
      const left = p.total - (p.fetched ?? 0);
      text = `${name} · downloading ${fmtSize(p.fetched ?? 0)} of ${fmtSize(p.total)}`
        + (p.rate ? ` · ${fmtSize(p.rate)}/s · ~${secs(left / p.rate)} left` : '');
    } else if (p.phase === 'downloading') { cur.downloaded = true; text = `${name} · starting the download…`; } else {
      cur.decodeFrom ||= cur.downloaded ? performance.now() : cur.t0; // a local photo: decoding from the start
      const s = (performance.now() - cur.decodeFrom) / 1000;
      text = `${name} · decoding RAW… ${s.toFixed(1)} s${p.decodeMs ? ` (usually ~${(p.decodeMs / 1000).toFixed(1)} s)` : ''}`;
      if (p.decodeMs) frac = Math.min(0.95, s * 1000 / p.decodeMs);
    }
    pill.replaceChildren(el('div', {}, text), ...(frac !== null ? [el('div', { class: 'rrl-bar' }, el('i', { style: `width:${Math.round(frac * 100)}%` }))] : []));
    pill.hidden = false;
  }

  onCall((cmd, args, result) => {
    const a = args as { path?: unknown; paths?: unknown };
    if (cmd === 'update_thumbnail_queue' && Array.isArray(a?.paths)) {
      for (const p of a.paths) if (typeof p === 'string') names.set(base(p), p);
      scheduleThumbs();
    }
    if (cmd !== 'load_image' || typeof a?.path !== 'string') return;
    openPath = a.path;
    const cur: Cur = { path: a.path, t0: performance.now(), decodeFrom: 0, downloaded: false };
    current = cur;
    watchLoad(cur);
    result.then(() => {}, () => {}).finally(() => { if (current === cur) { current = null; pill.hidden = true; } });
  });

  // --- thumbnails that aren't ready yet ---
  let thumbTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleThumbs(ms = 600) { thumbTimer ??= setTimeout(() => { thumbTimer = null; updateThumbs(); }, ms); }

  // short: filmstrip (small tiles)
  function label(t: Thumb, short: boolean) {
    if (t.state === 'rendering') return short ? 'Rendering' : 'Rendering…';
    if (t.state === 'preparing') return short ? 'Preview…' : 'Fetching preview…';
    if (t.state === 'downloading') return `${short ? '' : 'Downloading '}${t.total ? Math.round(((t.fetched ?? 0) / t.total) * 100) : 0} %`;
    if (t.paused) return short ? 'Paused' : 'Paused while you edit';
    if (!t.pos) return 'Queued';
    return short ? `#${t.pos}${t.eta ? ` · ${secs(t.eta)}` : ''}` : `Queued #${t.pos}${t.eta ? ` · ~${secs(t.eta)}` : ''}`;
  }

  // Tiles without a thumbnail: the library grid (name in .truncate) and the filmstrip in the editor (name in data-tooltip)
  function waitingTiles() {
    const res: { host: HTMLElement; tile: HTMLElement; path: string; short: boolean }[] = [];
    const add = (tile: HTMLElement, host: HTMLElement, name: string, short: boolean) => {
      const path = names.get(name);
      if (tile.querySelector('img') || !path) { tile.querySelector('.rrt-badge')?.remove(); return; }
      res.push({ host, tile, path, short });
    };
    for (const tile of document.querySelectorAll<HTMLElement>('[data-bench-id="thumbnail"]')) {
      add(tile, (tile.firstElementChild as HTMLElement) ?? tile, tile.querySelector('.truncate')?.textContent?.trim() ?? '', false);
    }
    for (const tile of document.querySelectorAll<HTMLElement>('div[data-tooltip]')) {
      if (tile.dataset.benchId || !tile.querySelector('svg.lucide-image, img') || !tile.offsetParent) continue;
      add(tile, tile, tile.dataset.tooltip ?? '', true);
    }
    return res;
  }

  // Filmstrip in the editor: the photos next to the open one, up to 20 next and then 5 previous. The cells are virtual
  // (visible ones and 16 on each side), ordered by position; the open one has its name (or is highlighted)
  function aroundOpen(): string[] {
    const tiles = [...document.querySelectorAll<HTMLElement>('div[data-tooltip]')]
      .filter((t) => !t.dataset.benchId && t.offsetParent && t.querySelector('svg.lucide-image, img'))
      .map((t) => ({ t, x: t.getBoundingClientRect().left }))
      .sort((a, b) => a.x - b.x)
      .map((e) => e.t);
    let i = openPath ? tiles.findIndex((t) => t.dataset.tooltip === base(openPath)) : -1;
    if (i < 0) i = tiles.findIndex((t) => t.classList.contains('ring-accent'));
    if (i < 0) return [];
    const res: string[] = [];
    const add = (t?: HTMLElement) => { const p = t && names.get(t.dataset.tooltip ?? ''); if (p) res.push(p); };
    for (let k = 1; k <= 20; k++) add(tiles[i + k]);
    for (let k = 1; k <= 5; k++) add(tiles[i - k]);
    return res;
  }

  async function updateThumbs() {
    const waiting = waitingTiles();
    if (waiting.length) {
      const args = { paths: [...new Set(waiting.map((w) => w.path))], ...(inEditor ? { ahead: aroundOpen() } : {}) };
      const st = await call<Record<string, Thumb>>('__rr_thumbs', args).catch(() => ({} as Record<string, Thumb>));
      for (const { host, tile, path, short } of waiting) {
        const t = st[path];
        let badge = tile.querySelector<HTMLElement>('.rrt-badge');
        if (!t || tile.querySelector('img')) { badge?.remove(); continue; }
        if (!badge) {
          badge = el('div', { class: `rrt-badge${short ? ' short' : ''}` });
          host.append(badge);
        }
        badge.textContent = label(t, short);
      }
    }
    // while there are tiles without an image, keep refreshing; otherwise wait for the next thumbnail request
    if (waiting.length && document.visibilityState === 'visible') scheduleThumbs(1000);
    else if (waiting.length) scheduleThumbs(3000);
  }

  // --- total, in the top bar (also for thumbnails that aren't visible) ---
  const TOTAL_TITLE = 'Thumbnails still to make. In the library, the ones you can see come first.';
  const EDITOR_TITLE = 'While a photo is open, thumbnails are made only in short pauses between your edits: quick ones for every photo, full renders only for the photos next to this one in the filmstrip. The rest continue in the library. How many at a time adapts to this server, so editing stays fast.';
  const total = el('span', { class: 'rrf-thumbs', hidden: true, title: TOTAL_TITLE });
  tabs.insertBefore(total, tabs.querySelector('.rrf-tag'));
  setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    const s = await call<Summary>('__rr_thumbs_summary').catch(() => null);
    if (!s || !s.left) { total.hidden = true; return; }
    total.hidden = false;
    total.title = s.editing ? EDITOR_TITLE : TOTAL_TITLE;
    total.textContent = s.editing ? `Thumbnails ${s.left} · between edits${s.later ? `, ${s.later} in library` : ''}`
      : s.paused && s.heavy ? `Thumbnails ${s.left} · paused while editing` : `Thumbnails ${s.left}${s.eta ? ` · ~${secs(s.eta)}` : ''}`;
  }, 2000);
  // tiles also appear while scrolling (virtual grid)
  document.addEventListener('scroll', () => scheduleThumbs(300), { capture: true, passive: true });

  // The view for the relay: while a photo is open in the editor, thumbnails wait for pauses; going back to the library
  // resumes them at once. Reported on change and every 5 s (without a report for >30 s, e.g. a closed tab, the relay
  // works as without this UI)
  let inEditor: boolean | null = null;
  let sentAt = 0;
  setInterval(() => {
    // the editor stays in the DOM after going back to the library (only hidden)
    const now = !!document.querySelector<HTMLElement>('[data-bench-id="back-to-library"]')?.offsetParent;
    if (now !== inEditor || Date.now() - sentAt > 5000) {
      call('__rr_view', { mode: now ? 'editor' : 'library' }).catch(() => {});
      sentAt = Date.now();
      if (!now) scheduleThumbs(300);
    }
    inEditor = now;
  }, 1000);
}
