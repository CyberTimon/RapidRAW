// Thumbnails for the library, scheduled so that the photo open in the editor always comes first.
// RapidRAW's UI asks for thumbnails with update_thumbnail_queue. The relay keeps that list and hands the photos to
// RapidRAW itself, a few at a time:
//  - light: unedited RAW files, which RapidRAW makes from the embedded preview; heavy: everything else (edited photos
//    and virtual copies are rendered from the whole RAW on the GPU, other formats are decoded whole).
//  - In the library: OUT_LIGHT light and OUT_LIBRARY heavy ones at a time, the tiles you can see first (the UI
//    reports them).
//  - While a photo is open in the editor (remote.mjs: editor): only in the pauses between edits (tune.gapMs without a
//    change, nothing opening). Light ones for every photo, heavy ones only for the photos next to the open one in the
//    filmstrip (the UI reports them, the next ones first). How many at a time and how long the pause is adapt to the
//    server (editTiming).
// The UI sees the relay's progress (progress, status) and the total in the top bar (summary).
import fsp from 'node:fs/promises';
import os from 'node:os';
import { editor } from './remote.mjs';

const OUT_LIBRARY = 4;    // heavy thumbnails RapidRAW makes at a time while you are in the library
const OUT_LIGHT = 8;      // light ones at a time in the library
const OUT_EDITOR = 1;     // …with an older UI that doesn't report its view, while the editor is idle
// heavy ones at a time while a photo is open, at most (by CPU threads: 12 → 3, 4 → 1); starts at 1
const OUT_EDITOR_MAX = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 4)));
const CLASSIFY = 16;      // photos checked at a time (RAW? edit file next to it?)
const NEAR_TTL = 30000;   // the list of photos next to the open one (the UI repeats it every second while tiles wait)
const OUT_WAIT = 60000;   // a thumbnail that never reported back (error) must not hold a slot forever

// offline(p) → is the browser of p's folder disconnected; fetching(p) → { fetched, total } while p is fetched from
// the browsing computer; settings() → RapidRAW settings; bridge(cmd, args) → call a RapidRAW command
export function createThumbs({ offline, fetching = () => null, settings, bridge }) {
  let gen = 0;               // update_thumbnail_queue({ paths: [] }) cancels everything that waits
  const queue = [];          // waiting to be classified
  const pending = new Set();
  let running = 0;
  const light = [];
  const heavy = [];
  const out = new Map();     // handed to RapidRAW → { heavy, inEditor, hit, at, timer }
  let done = 0;              // for the progress in the UI
  let heavyMs = 0;           // average time of a heavy thumbnail (for the estimate in the UI)
  const ema = (old, v) => (old ? old * 0.7 + v * 0.3 : v);
  let near = { list: [], at: 0 }; // photos next to the open one in the filmstrip, the next ones first (UI)
  const nearby = () => (Date.now() - near.at < NEAR_TTL ? near.list : []);
  // While a photo is open: k at a time, after gapMs without a change in the editor. A slider preview or opening a
  // photo slower than usual (base: without thumbnails) while one is made → fewer at a time and a longer pause;
  // three thumbnails without interference → one more (up to OUT_EDITOR_MAX) and a shorter pause
  const tune = { k: 1, gapMs: 1500, clean: 0, base: {} };
  const outOf = (isHeavy) => [...out.values()].filter((o) => o.heavy === isHeavy);
  function retune(k, gapMs, why) {
    if (k === tune.k && gapMs === tune.gapMs) return;
    tune.k = k;
    tune.gapMs = gapMs;
    console.log(`[thumbs] while editing: ${k} at a time, after ${(gapMs / 1000).toFixed(1)} s without changes (${why})`);
  }

  // RapidRAW's RAW extensions (get_supported_file_types) and "always decode RAW thumbnails"
  let cfg = null;
  let cfgAt = 0;
  async function config() {
    if (!cfg || Date.now() - cfgAt > 30000) {
      const [s, types] = await Promise.all([
        settings().catch(() => ({})),
        cfg?.raw ? null : bridge('get_supported_file_types', {}).catch(() => null),
      ]);
      cfg = { raw: types?.raw ? new Set(types.raw.map((e) => String(e).toLowerCase())) : cfg?.raw ?? null, decodeAll: !!s?.alwaysDecodeRawThumbnails };
      cfgAt = Date.now();
    }
    return cfg;
  }

  // light: an unedited RAW file (no .rrdata next to it), which RapidRAW makes from the embedded preview
  async function isLight(p) {
    if (p.includes('?vc=')) return false; // a virtual copy always has its own edits
    const c = await config();
    const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
    if (c.decodeAll || !c.raw?.has(ext)) return false;
    return !(await fsp.access(`${p}.rrdata`).then(() => true, () => false));
  }

  function submit(paths, isHeavy, inEditor) {
    if (!paths.length) return;
    for (const p of paths) out.set(p, { heavy: isHeavy, inEditor, hit: false, at: Date.now(), timer: setTimeout(() => finished(p), OUT_WAIT) });
    bridge('update_thumbnail_queue', { paths }).catch(() => paths.forEach((p) => finished(p)));
  }

  function finished(p, ok = false) {
    const o = out.get(p);
    if (!o) return;
    if (ok && o.heavy) heavyMs = ema(heavyMs, Date.now() - o.at);
    if (ok && o.inEditor && o.heavy && !o.hit && ++tune.clean >= 3) {
      tune.clean = 0;
      retune(Math.min(OUT_EDITOR_MAX, tune.k + 1), Math.max(1000, Math.round(tune.gapMs * 0.8)), 'editing stayed fast');
    }
    clearTimeout(o.timer);
    out.delete(p);
    done++;
    pumpOut();
  }

  // how many RapidRAW may make at a time: while a photo is open only in a pause between edits
  // (with an older UI that doesn't report its view: one heavy at a time, when the editor is idle)
  function limits() {
    if (editor.editing()) return editor.open(tune.gapMs) ? { light: tune.k * 2, heavy: tune.k } : { light: 0, heavy: 0 };
    if (editor.busy()) return { light: 0, heavy: 0 };
    return { light: OUT_LIGHT, heavy: editor.viewKnown() || !editor.recent() ? OUT_LIBRARY : OUT_EDITOR };
  }

  // Hand thumbnails to RapidRAW according to what the editor does; photos from folders whose browser is not
  // connected wait
  function pumpOut() {
    const editing = editor.editing();
    const lim = limits();
    const ready = (p) => !offline(p);
    for (const [arr, isHeavy] of [[light, false], [heavy, true]]) {
      let active = outOf(isHeavy).length;
      const max = isHeavy ? lim.heavy : lim.light;
      const batch = [];
      if (editing) { // the photos next to the open one first; heavy ones only those
        for (const p of nearby()) {
          if (active >= max) break;
          const i = arr.indexOf(p);
          if (i < 0 || !ready(p)) continue;
          batch.push(...arr.splice(i, 1));
          active++;
        }
      }
      if (!editing || !isHeavy) {
        for (let i = arr.length - 1; i >= 0 && active < max; i--) { // last requested (visible) first, like RapidRAW
          if (!ready(arr[i])) continue;
          batch.push(...arr.splice(i, 1));
          active++;
        }
      }
      submit(batch, isHeavy, editing);
    }
    if (!busyWork()) done = 0;
  }
  setInterval(pumpOut, 500).unref(); // continue when the editor gets quiet

  const busyWork = () => queue.length + running + light.length + heavy.length + out.size > 0;

  // requested tiles to the end of the queues (they are handed over from the end), the first one last, so it comes first
  function prioritize(paths) {
    const rank = new Map();
    paths.forEach((p, i) => { if (!rank.has(p)) rank.set(p, i); });
    if (!rank.size) return;
    const order = (arr, key) => {
      const want = arr.filter((x) => rank.has(key(x)));
      if (!want.length) return;
      want.sort((a, b) => rank.get(key(b)) - rank.get(key(a)));
      arr.splice(0, arr.length, ...arr.filter((x) => !rank.has(key(x))), ...want);
    };
    order(heavy, (p) => p);
    order(light, (p) => p);
    order(queue, (i) => i.p);
  }

  function pump() {
    while (running < CLASSIFY && queue.length) {
      const item = queue.pop();
      running++;
      isLight(item.p)
        .catch(() => false)
        .then((ok) => {
          running--;
          pending.delete(item.p);
          if (item.gen === gen) (ok ? light : heavy).push(item.p);
          pumpOut();
          pump();
        });
    }
  }

  return {
    // update_thumbnail_queue from the UI: the relay hands them to RapidRAW itself (pumpOut); an empty list cancels the
    // queue (returns true if the request must be passed on to RapidRAW)
    takeThumbs(paths) {
      if (!paths.length) {
        gen++;
        queue.length = 0;
        pending.clear();
        light.length = 0;
        heavy.length = 0;
        done = 0;
        return true;
      }
      for (const p of paths) {
        if (typeof p !== 'string' || pending.has(p) || out.has(p) || light.includes(p) || heavy.includes(p)) continue;
        pending.add(p);
        queue.push({ p, gen });
      }
      pump();
      pumpOut();
      return false;
    },

    // thumbnail-generated from RapidRAW
    generated(p) { finished(p, true); },

    // State of thumbnails for the UI (rrweb/files/progress.ts): queued (position, estimate), downloading, rendering;
    // finished and unknown ones are not returned. paths: tiles visible right now; ahead: in the editor, the photos
    // next to the open one in the filmstrip, the next ones first (only they may get heavy thumbnails while a photo
    // is open)
    status(paths, ahead) {
      if (Array.isArray(ahead)) near = { list: ahead.filter((p) => typeof p === 'string').slice(0, 40), at: Date.now() };
      prioritize([...(Array.isArray(ahead) ? near.list : []), ...paths]); // to the front of the queue
      pumpOut();
      const editing = editor.editing();
      const nearSet = new Set(editing ? nearby() : []);
      const busy = !editing && editor.busy();
      const limit = editing ? tune.k : Math.max(1, limits().heavy || OUT_LIBRARY);
      const res = {};
      for (const p of paths) {
        const o = out.get(p);
        if (o) {
          const dl = fetching(p);
          res[p] = dl ? { state: 'downloading', ...dl } : { state: 'rendering', ms: Date.now() - o.at };
        } else if (heavy.includes(p)) {
          // in the editor: position among the photos next to the open one; the others wait for the library
          const pos = editing ? near.list.filter((q) => heavy.includes(q)).indexOf(p) + 1 : heavy.length - heavy.lastIndexOf(p);
          const paused = busy || (editing && !nearSet.has(p));
          res[p] = { state: 'queued', pos: pos || undefined, paused, eta: paused ? null : Math.round(Math.ceil(pos / limit) * (heavyMs || 3000) / 1000) };
        } else if (light.includes(p) || pending.has(p)) res[p] = { state: 'queued', paused: busy };
      }
      return res;
    },
    // thumbnail-generation-complete: RapidRAW has nothing left in its queue (including the ones that failed and
    // never reported back)
    drained() { for (const p of [...out.keys()]) finished(p); },
    // progress for the UI while the relay still has work (null: let the UI see RapidRAW's own)
    progress() { return busyWork() ? { current: done, total: done + queue.length + running + light.length + heavy.length + out.size } : null; },

    // total for the top bar: how many are left, the estimate, whether they wait because of the editor
    summary() {
      const outHeavy = outOf(true).length;
      const left = queue.length + running + light.length + heavy.length + out.size;
      const editing = editor.editing();
      const paused = !editing && editor.busy();
      const eta = Math.round(Math.ceil((heavy.length + outHeavy) / OUT_LIBRARY) * (heavyMs || 3000) / 1000);
      // in the editor: how many wait for the library (heavy ones not next to the open photo)
      const nearSet = new Set(editing ? nearby() : []);
      const later = editing ? heavy.filter((p) => !nearSet.has(p)).length : 0;
      return { left, heavy: heavy.length + outHeavy, paused, eta: left && !editing ? eta : 0, editing, later };
    },

    // Timing of editor work (relay.mjs): 'interactive' and 'final' previews, 'load' (decoding a photo). Slower than
    // usual while RapidRAW makes a thumbnail handed over in the editor → fewer at a time, longer pause
    editTiming(kind, ms) {
      const running = [...out.values()];
      const base = tune.base[kind] ?? 0;
      if (!running.length) { tune.base[kind] = ema(base, ms); return; }
      if (!base || !running.some((o) => o.inEditor) || ms <= base * 1.5 + 40) return;
      for (const o of running) o.hit = true;
      tune.clean = 0;
      retune(Math.max(1, tune.k - 1), Math.min(8000, Math.round(tune.gapMs * 1.5)),
        `${kind === 'load' ? 'opening a photo' : 'a slider preview'} took ${Math.round(ms)} ms instead of ~${Math.round(base)} ms`);
    },
  };
}
