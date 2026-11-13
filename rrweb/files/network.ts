// Preview quality for the connection to the server. RapidRAW already has a preview size (editorPreviewResolution)
// and a live preview quality (livePreviewQuality: performance / high / full); the backend reads them on every render.
// Once per tab (and on click) it measures ping and the download (previews) and upload (folders from this computer)
// speed, suggests settings, and while you work it watches real previews (apply_adjustments) and says when they get slow.
import { call, onConnection, onTiming } from '../shim/transport';
import { el } from './ui';

type Quality = 'performance' | 'high' | 'full';
type Reco = { resolution: number; quality: Quality; why: string };
type Measure = { mbps: number; up?: number; rtt: number; at: number };

const QUALITY_LABEL: Record<Quality, string> = { performance: 'Performance', high: 'High', full: 'Full' };
const RESOLUTIONS = [720, 1280, 1920, 2560, 3840]; // as in RapidRAW: Settings → Processing
const mbit = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}G` : v < 10 ? v.toFixed(1) : String(Math.round(v)));

export function recommend(mbps: number, rtt: number): Reco {
  if (mbps < 5 || rtt > 200) return { resolution: 1280, quality: 'performance', why: 'slow or distant connection' };
  if (mbps < 15) return { resolution: 1920, quality: 'performance', why: 'mobile-class connection' };
  if (mbps < 50) return { resolution: 1920, quality: 'high', why: 'good connection' };
  return { resolution: 2560, quality: 'high', why: 'fast connection (LAN)' };
}

async function measure(): Promise<Measure> {
  const rtts: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    await call('__rr_ping');
    rtts.push(performance.now() - t);
  }
  rtts.sort((a, b) => a - b);
  const rtt = rtts[2];
  const mbps = await rate(rtt, async (per) => {
    const sizes = await Promise.all(Array.from({ length: STREAMS }, async () => {
      const r = await fetch(`/rr/speed?bytes=${per}&t=${Math.random()}`, { cache: 'no-store' });
      return (await r.arrayBuffer()).byteLength;
    }));
    return sizes.reduce((a, b) => a + b, 0);
  });
  const up = await rate(rtt, async (per) => {
    const body = new Uint8Array(per);
    for (let i = 0; i < per; i += 65536) crypto.getRandomValues(body.subarray(i, Math.min(per, i + 65536)));
    await Promise.all(Array.from({ length: STREAMS }, () => fetch('/rr/speed', { method: 'POST', body, cache: 'no-store' })));
    return per * STREAMS;
  });
  return { mbps, up, rtt, at: Date.now() };
}

// Several parallel connections (like speed tests): one TCP connection through a tunnel with a higher ping doesn't get
// up to speed. The size grows until one round takes ~1 s (at most STREAMS × 16 MB); waiting for the first byte (ping)
// is not counted.
const STREAMS = 4;
async function rate(rtt: number, round: (perStream: number) => Promise<number>) {
  let per = 1 << 18;
  for (;;) {
    const t = performance.now();
    const bytes = await round(per);
    const s = (performance.now() - t) / 1000;
    const mbps = (bytes * 8) / Math.max(s - rtt / 1000, s / 2) / 1e6;
    if (s > 1 || per >= 16 << 20) return mbps;
    per = Math.min(per * 4, 16 << 20);
  }
}

export function mountNetwork(tabs: HTMLElement) {
  let last: Measure | null = null;
  let settings: Record<string, unknown> = {};
  const recent: { ms: number; bytes: number }[] = []; // last previews
  const badge = el('button', { class: 'rrn-badge', title: 'Connection to the server and preview quality' }, '…');
  const panel = el('div', { class: 'rrn-panel', hidden: true });
  tabs.append(badge);
  document.body.append(panel);

  const current = () => ({ resolution: Number(settings.editorPreviewResolution ?? 1920), quality: (settings.livePreviewQuality ?? 'high') as Quality });
  const differs = (r: Reco) => r.resolution !== current().resolution || r.quality !== current().quality;
  const previewStats = () => {
    if (recent.length < 3) return null;
    const ms = recent.reduce((s, x) => s + x.ms, 0) / recent.length;
    const kb = recent.reduce((s, x) => s + x.bytes, 0) / recent.length / 1024;
    return { ms, kb };
  };

  // manual choice (RapidRAW's settings editorPreviewResolution / livePreviewQuality)
  const res = el('select', {}) as HTMLSelectElement;
  const qual = el('select', {}) as HTMLSelectElement;
  for (const v of RESOLUTIONS) res.append(el('option', { value: String(v) }, `${v} px`));
  for (const q of ['performance', 'high', 'full'] as Quality[]) qual.append(el('option', { value: q }, QUALITY_LABEL[q]));

  // the connection to the server doesn't answer (transport.ts opens a new one by itself): the badge shows it
  let connected = true;

  function render() {
    const r = last && recommend(last.mbps, last.rtt);
    if (document.activeElement !== res && document.activeElement !== qual) {
      res.value = String(current().resolution);
      qual.value = current().quality;
    }
    const p = previewStats();
    const slow = p && p.ms > 400;
    badge.textContent = !connected ? 'Reconnecting…' : !last ? '…' : `↓${mbit(last.mbps)}${last.up ? ` ↑${mbit(last.up)}` : ''} Mb/s`;
    badge.className = `rrn-badge${!connected || (r && differs(r)) || slow ? ' warn' : ''}`;
    const c = current();
    panel.replaceChildren(
      el('b', {}, 'Connection to the server'),
      el('p', {}, last ? `${last.mbps.toFixed(1)} Mbit/s download${last.up ? ` · ${last.up.toFixed(1)} Mbit/s upload` : ''} · ${Math.round(last.rtt)} ms ping` : 'Measuring…'),
      ...(last?.up ? [el('p', { class: 'rrn-note' }, 'Download carries the previews; folders used from this computer travel at the upload speed.')] : []),
      ...(p ? [el('p', { class: slow ? 'rrn-warn' : '' }, `Recent previews: ${Math.round(p.kb)} KB in ${Math.round(p.ms)} ms on average${slow ? ' (slow, a lower setting will feel smoother)' : ''}`)] : []),
      ...(r ? [el('p', {}, el('b', {}, `Recommended: ${r.resolution} px, ${QUALITY_LABEL[r.quality]}`), ` (${r.why})`)] : []),
      el('div', { class: 'rrn-actions' },
        el('button', { onclick: () => test() }, 'Test again'),
        ...(r && differs(r) ? [el('button', { class: 'primary', onclick: () => apply(r) }, 'Use recommended')] : [])),
      el('b', {}, 'Preview'),
      el('div', { class: 'rrn-choose' },
        el('label', {}, 'Size ', res), el('label', {}, 'Live quality ', qual),
        el('button', { onclick: () => apply({ resolution: Number(res.value), quality: qual.value as Quality, why: 'manual' }) }, 'Save')),
      el('p', { class: 'rrn-note' }, 'Larger previews look sharper but need more bandwidth; saving reloads the editor. Also in RapidRAW: Settings → Processing.'));
  }

  async function loadSettings() {
    settings = await call<Record<string, unknown>>('load_settings').catch(() => settings);
  }

  async function test() {
    last = null;
    render();
    try {
      await loadSettings();
      last = await measure();
      try { sessionStorage.setItem('rrweb-net', JSON.stringify(last)); } catch { /* no storage */ }
    } catch { /* relay unreachable; try again on click */ }
    render();
    const r = last && recommend(last.mbps, last.rtt);
    if (r && differs(r)) panel.hidden = false; // suggest right away
  }

  // RapidRAW keeps its settings in the UI's memory: reload it after saving, otherwise it would overwrite them with the old ones
  async function apply(r: Reco) {
    await loadSettings();
    await call('save_settings', { settings: { ...settings, editorPreviewResolution: r.resolution, livePreviewQuality: r.quality } });
    location.reload();
  }

  onTiming((cmd, ms, bytes) => {
    if (cmd !== 'apply_adjustments' || bytes < 1024) return;
    recent.push({ ms, bytes });
    if (recent.length > 20) recent.shift();
    if (recent.length % 5 === 0) render();
  });
  badge.onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) render(); };
  document.addEventListener('mousedown', (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node) && e.target !== badge) panel.hidden = true;
  });

  try { last = JSON.parse(sessionStorage.getItem('rrweb-net') ?? 'null'); } catch { last = null; }
  if (last && last.up === undefined) last = null; // an older measurement, without upload
  if (last) loadSettings().then(render);
  else setTimeout(test, 1500); // once per tab, after RapidRAW has loaded
  onConnection((v) => { connected = v; render(); });
}
