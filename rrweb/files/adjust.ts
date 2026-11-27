// Feedback while editing: while a change is being processed, a ring with a percentage sits next to the slider that
// made it. RapidRAW renders the whole image on the GPU in one pass and doesn't report how far along it is, so the
// ring fills by real time: how long the same change (same slider; preview while dragging or final) took on the
// server before, and once the relay reports the server is done (__rr_rendered: duration, size), the rest is the
// preview's transfer at the measured speed. If it takes much longer than usual, it shows the elapsed time instead.
// RapidRAW always renders only the newest state (it skips older ones), so all pending changes finish with the same,
// last preview. Changes that don't come from a slider (curves, masks, crop…) get a label at the top.
// RapidRAW's UI is not touched: the marks sit above it, aligned with the slider.
import { on, onCall } from '../shim/transport';
import { el } from './ui';

type Job = { id: number; t0: number; interactive: boolean; key: string; rendered?: { at: number; ms: number; bytes: number } };
type Mark = { name: string; slider: HTMLElement | null; job: Job; shown: boolean; doneAt?: number; ring?: HTMLElement; clip?: HTMLElement | null };

const SHOW_AFTER = 150; // faster changes get no mark (no flicker)
const KEEP = 350;       // a finished mark stays full this long, then disappears; a new change of the same slider takes it over
const TOUCH_MS = 1500;  // a change belongs to the slider touched at most this long before
const SUPERSEDED = 'Superseded or worker failed';
const C = 2 * Math.PI * 6;
// names of settings that aren't sliders (from the changed keys)
const NAMES: Record<string, string> = {
  curves: 'Curves', hsl: 'Color mixer', colorGrading: 'Color grading', masks: 'Masks', aiPatches: 'AI edits',
  lutPath: 'LUT', lutData: 'LUT', crop: 'Crop', rotation: 'Rotate', flipHorizontal: 'Flip', flipVertical: 'Flip',
  orientationSteps: 'Rotate', aspectRatio: 'Crop',
};
const human = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase());
// large values (masks, AI patches as base64) are not compared whole
const str = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'string' && x.length > 256 ? `#${x.length}` : x)) ?? '';

// Slider (RapidRAW ui/Slider): <div class="mb-2 group"><div>(label)(value)</div><div><input type=range></div></div>
function sliderOf(t: EventTarget | null): HTMLElement | null {
  const box = t instanceof Element ? t.closest('div.group') : null;
  return box instanceof HTMLElement && box.querySelectorAll('input[type="range"]').length === 1 ? box : null;
}
const labelOf = (s: HTMLElement) => s.querySelector('span')?.textContent?.trim() || 'Adjustment';

function scrollParent(e: HTMLElement): HTMLElement | null {
  for (let p = e.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

export function mountAdjustProgress() {
  // --- which slider was touched last ---
  let touched: { slider: HTMLElement; at: number } | null = null;
  const touch = (ev: Event) => {
    const s = sliderOf(ev.target);
    if (s) touched = { slider: s, at: performance.now() };
    else if (ev.type === 'pointerdown') touched = null; // a click on something else (curve, mask, image)
  };
  for (const t of ['pointerdown', 'wheel', 'keydown', 'input']) document.addEventListener(t, touch, { capture: true, passive: true });
  // dragging can take long: the slider stays "touched" while the mouse button is down
  document.addEventListener('pointermove', (ev) => { if (touched && ev.buttons) touched.at = performance.now(); }, { capture: true, passive: true });

  // --- learned duration and speed ---
  const learned = new Map<string, number>();         // `${label}|${interactive}` → ms on the server
  const bytesE = [300e3, 40e3];                       // [final, while dragging] average preview size
  let rate = 0;                                       // B/ms preview transfer to the browser
  const ema = (k: string, v: number) => learned.set(k, learned.has(k) ? learned.get(k)! * 0.7 + v * 0.3 : v);
  const expectMs = (j: Job) => learned.get(`${j.key}|${+j.interactive}`) ?? learned.get(`|${+j.interactive}`) ?? (j.interactive ? 120 : 300);

  function progress(j: Job, now: number) {
    const er = expectMs(j);
    const et = (j.rendered?.bytes ?? bytesE[+j.interactive]) / (rate || 2500);
    const share = er / (er + et);
    const elapsed = now - j.t0;
    const slow = elapsed > Math.max(1000, 2 * (er + et));
    if (!j.rendered) return { frac: share * Math.min(0.95, elapsed / er), slow, elapsed };
    return { frac: share + (1 - share) * Math.min(0.95, (now - j.rendered.at) / Math.max(1, et)), slow, elapsed };
  }

  // --- apply_adjustments calls ---
  const jobs = new Map<number, Job>();
  const marks = new Map<HTMLElement | string, Mark>(); // slider or name of the change
  let prev: Record<string, string> | null = null;      // last settings sent (to name a change that isn't from a slider)

  function changed(adj: Record<string, unknown>) {
    const cur: Record<string, string> = {};
    for (const [k, v] of Object.entries(adj)) cur[k] = str(v);
    const keys = prev ? Object.keys(cur).filter((k) => cur[k] !== prev![k]) : null;
    prev = cur;
    return keys;
  }

  onCall((cmd, args, result, id) => {
    if (cmd === 'load_image') { prev = null; return; } // the first preview of a new photo is covered by the opening panel (progress.ts)
    if (cmd !== 'apply_adjustments') return;
    const a = args as { jsAdjustments?: Record<string, unknown>; isInteractive?: boolean };
    const keys = a?.jsAdjustments ? changed(a.jsAdjustments) : null;
    const now = performance.now();
    const slider = touched && now - touched.at < TOUCH_MS && touched.slider.isConnected ? touched.slider : null;
    const names = [...new Set((keys ?? []).map((k) => NAMES[k] ?? human(k)))];
    const name = slider ? labelOf(slider) : names.length && names.length <= 3 ? names.join(', ') : 'Preview';
    const job: Job = { id, t0: now, interactive: !!a?.isInteractive, key: name };
    jobs.set(id, job);
    for (const m of marks.values()) if (m.doneAt === undefined) m.job = job; // pending changes arrive with this preview
    // a mark: a change from a slider or a recognised change (zooming and a higher resolution without a change get none)
    if (slider || (keys && keys.length)) {
      const k = slider ?? name;
      const m = marks.get(k);
      if (m) { m.job = job; m.doneAt = undefined; } else marks.set(k, { name, slider, job, shown: false });
    }
    frame();
    result.then(() => finish(job, true), (e) => finish(job, e === SUPERSEDED ? null : false));
  });

  on('__rr_rendered', (p) => {
    const { id, ms, bytes } = p as { id: number; ms: number; bytes: number };
    const j = jobs.get(id);
    if (j) j.rendered = { at: performance.now(), ms, bytes };
  });

  function finish(job: Job, ok: boolean | null) {
    jobs.delete(job.id);
    if (ok === null) return; // skipped: the marks already wait for a newer preview
    if (!ok) { // an error: RapidRAW reports it itself, the mark just disappears
      for (const [k, m] of marks) if (m.job === job) { m.ring?.remove(); marks.delete(k); }
      frame();
      return;
    }
    const now = performance.now();
    if (job.rendered) {
      ema(`${job.key}|${+job.interactive}`, job.rendered.ms);
      ema(`|${+job.interactive}`, job.rendered.ms);
      bytesE[+job.interactive] = bytesE[+job.interactive] * 0.7 + job.rendered.bytes * 0.3;
      const t = now - job.rendered.at;
      if (job.rendered.bytes > 32768 && t > 0) rate = rate ? rate * 0.7 + (job.rendered.bytes / t) * 0.3 : job.rendered.bytes / t;
    }
    for (const m of marks.values()) if (m.job === job) m.doneAt = now;
    frame();
  }

  // --- display ---
  const pill = el('div', { class: 'rrl-load rre-pill', hidden: true });
  document.body.append(pill);
  let raf = 0;
  function frame() { raf ||= requestAnimationFrame(draw); }

  function ring(m: Mark) {
    if (!m.ring) {
      m.ring = el('div', { class: 'rre-ring', hidden: true });
      m.ring.innerHTML = `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" class="bg"/><circle cx="8" cy="8" r="6" class="fg" stroke-dasharray="${C.toFixed(2)}"/></svg><b></b>`;
      document.body.append(m.ring);
      m.clip = scrollParent(m.slider!);
    }
    return m.ring;
  }

  function draw() {
    raf = 0;
    const now = performance.now();
    const pending: string[] = [];
    let pillFrac = 0;
    for (const [k, m] of marks) {
      const done = m.doneAt !== undefined;
      if (done && (!m.shown || now - m.doneAt! > KEEP)) { m.ring?.remove(); marks.delete(k); continue; }
      if (!m.shown && !done && now - m.job.t0 >= SHOW_AFTER) m.shown = true;
      if (!m.shown) continue;
      const p = done ? { frac: 1, slow: false, elapsed: 0 } : progress(m.job, now);
      const text = done ? '' : p.slow ? `${(p.elapsed / 1000).toFixed(1)} s` : `${Math.round(p.frac * 100)}%`;
      if (!m.slider) {
        if (!done) { pending.push(`${m.name} · ${p.slow ? `processing ${text}` : text}`); pillFrac = Math.max(pillFrac, p.frac); }
        continue;
      }
      const r = ring(m);
      // slider in the right panel: the value (number) is the last element of the first row; the ring goes left of it
      const value = (m.slider.firstElementChild?.lastElementChild?.firstElementChild ?? m.slider) as HTMLElement;
      const box = value.getBoundingClientRect();
      const clip = m.clip?.getBoundingClientRect();
      const visible = m.slider.isConnected && !!m.slider.offsetParent && box.height > 0
        && (!clip || (box.top >= clip.top && box.bottom <= clip.bottom));
      r.hidden = !visible;
      if (!visible) continue;
      r.classList.toggle('done', done);
      r.classList.toggle('slow', p.slow);
      (r.querySelector('.fg') as SVGElement).style.strokeDashoffset = String(C * (1 - p.frac));
      r.querySelector('b')!.textContent = text;
      r.style.transform = `translate(${Math.round(box.left - r.offsetWidth - 6)}px, ${Math.round(box.top + box.height / 2 - r.offsetHeight / 2)}px)`;
    }
    pill.hidden = !pending.length;
    if (pending.length) {
      pill.replaceChildren(el('div', {}, pending.join('   ')), el('div', { class: 'rrl-bar' }, el('i', { style: `width:${Math.round(pillFrac * 100)}%` })));
    }
    if (marks.size) frame();
  }
}
