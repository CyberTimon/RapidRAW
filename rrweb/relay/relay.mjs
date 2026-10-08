// rrweb relay: serves the web UI and /files (thumbnails, images), and connects browser clients to the bridge.
//
// Env:
//   RR_PORT   (8780)        port
//   RR_HOST   (0.0.0.0)     bind address
//   RR_ROOTS  (required)    directories /files may serve, separated by path.delimiter (':' on Linux, ';' on Windows)
//   RR_AUTH   (optional)    "user:pass" → HTTP Basic auth for the UI, /files, /fm and /ipc
//   RR_PHOTOS (optional)    extra folder for the Files tab (besides the folders opened in RapidRAW)
//   RR_CONFIG (optional)    JSON with relay settings ({"library": "<photo library folder>"}), written by the bridge window
//   RR_ORIGINS (optional)   extra allowed Origins, comma-separated (e.g. https://photos.example.com behind a proxy)
//   RR_WORK   (tmp/rrweb-remote) work folder for folders from browsing computers (mirror, cache, FUSE mounts)
//   RR_FUSE_BIN               rrweb-fuse binary (default ../fuse/<arch>/rrweb-fuse[.exe] or next to Node.js)
//   RR_BRIDGE_PORT (8780)   loopback port the bridge connects to (VITE_RR_RELAY when the bridge is built)
//   RR_DIST   (../dist-web)
//   RR_NO_BROWSER=1           the bridge doesn't open a browser (server without a screen; detected under xvfb-run)
//   RR_LOG                    copy of the output in a file (bridge/run.sh: <app data>/logs/relay.log; up to 5 MB, then .1)
//   RR_VERBOSE=1              log every IPC call and the file operations of on-demand folders
// FUSE calls made by the relay itself (Files tab on a folder from a browsing computer) and their answers share the
// libuv thread pool
process.env.UV_THREADPOOL_SIZE ??= '64';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { WebSocketServer } from 'ws';
import { createFiles, validName } from './files.mjs';
import { createRemote, editor } from './remote.mjs';
import { createThumbs } from './thumbs.mjs';
import { createExif } from './exif.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// The bundled relay only writes into the bridge window: keep a copy in a file, so errors (e.g. a RapidRAW crash)
// can be looked at later
if (process.env.RR_LOG) {
  try {
    const LOG = process.env.RR_LOG;
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    if (fs.statSync(LOG, { throwIfNoEntry: false })?.size > 5 << 20) fs.renameSync(LOG, `${LOG}.1`);
    const out = fs.createWriteStream(LOG, { flags: 'a' });
    out.on('error', () => {});
    for (const k of ['log', 'warn', 'error']) {
      const orig = console[k].bind(console);
      console[k] = (...a) => { orig(...a); out.write(`${new Date().toISOString()} ${format(...a)}\n`); };
    }
  } catch (e) { console.warn(`[relay] RR_LOG: ${e.message}`); }
}
const PORT = +(process.env.RR_PORT ?? 8780);
const BRIDGE_PORT = +(process.env.RR_BRIDGE_PORT ?? 8780); // = port in VITE_RR_RELAY of the bridge build
const HOST = process.env.RR_HOST ?? '0.0.0.0';
const DIST = path.resolve(process.env.RR_DIST ?? path.join(here, '../dist-web'));
const AUTH = process.env.RR_AUTH ? 'Basic ' + Buffer.from(process.env.RR_AUTH).toString('base64') : null;
const ROOTS = (process.env.RR_ROOTS ?? '').split(path.delimiter).filter(Boolean).map((r) => fs.realpathSync(r));
if (!ROOTS.length) { console.error('RR_ROOTS is not set'); process.exit(1); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.tif': 'image/tiff', '.tiff': 'image/tiff' };
const SPEED = randomBytes(16 << 20); // random, so a proxy or gzip can't shrink it
const isLoopback = (a = '') => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const authed = (req) => !AUTH || req.headers.authorization === AUTH;
const underRoots = (p) => ROOTS.some((r) => p === r || p.startsWith(r + path.sep));
// Browsers always send Origin: accept only our own host (or RR_ORIGINS), so another website can't reach /ipc and /fm
const ORIGINS = (process.env.RR_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o || ORIGINS.includes(o)) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

function sendFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': cache, 'Last-Modified': st.mtime.toUTCString() });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (!authed(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="RapidRAW"' }).end(); return; }
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/files') {
    let real;
    try { real = fs.realpathSync(u.searchParams.get('path') ?? ''); } catch { res.writeHead(404).end(); return; }
    if (!underRoots(real)) { console.warn('[files] 403 outside RR_ROOTS:', real); res.writeHead(403).end(); return; }
    sendFile(res, real, 'private, max-age=60');
    return;
  }
  if (u.pathname.startsWith('/fm/')) {
    if (req.method !== 'GET' && !sameOrigin(req)) { res.writeHead(403).end(); return; }
    files.http(req, res, u);
    return;
  }
  if (u.pathname === '/rr/speed') { // connection speed test for the preview quality recommendation (rrweb/files/network.ts)
    editor.touch(); // background transfers (folders from browsing computers) pause while it measures
    if (req.method === 'POST') { // upload: the browser sends, the relay only counts
      let n = 0;
      req.on('data', (c) => { n += c.length; });
      req.on('end', () => res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ bytes: n })));
      return;
    }
    const n = Math.min(Math.max(+u.searchParams.get('bytes') || 0, 1 << 16), SPEED.length);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': n, 'Cache-Control': 'no-store' });
    res.end(SPEED.subarray(0, n));
    return;
  }
  if (u.pathname.startsWith('/rfs/')) {
    if (!sameOrigin(req)) { res.writeHead(403).end(); return; }
    remote.http(req, res, u);
    return;
  }
  const rel = path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, '');
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (!err && st.isFile()) sendFile(res, file, rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    else sendFile(res, path.join(DIST, 'index.html'), 'no-cache');
  });
});

// --- IPC routing ---
let bridge = null;
const clients = new Set();
const inflight = new Map(); // relayId -> { client, id, cmd, t0 }
let rid = 0;
// Photo library folder: chosen in the RapidRAW Web window on the server (native dialog), stored in RR_CONFIG
const CONFIG = process.env.RR_CONFIG;
let config = {};
try { if (CONFIG && fs.existsSync(CONFIG)) config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { console.warn(`[relay] ${CONFIG}: ${e.message}`); }
function setLibrary(p) {
  if (!fs.statSync(p).isDirectory()) throw new Error('not a folder');
  config.library = fs.realpathSync(p);
  if (CONFIG) fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
  files.invalidate();
  console.log(`[relay] photo library: ${config.library}`);
}
// Server without a screen (systemd service, xvfb-run): the bridge doesn't open a browser (xdg-open/kde-open would
// just fail without a screen)
const HEADLESS = !!process.env.RR_NO_BROWSER || /xvfb-run/.test(process.env.XAUTHORITY ?? '');
const libraryState = () => ({ rr: 'library', path: config.library ?? null, env: process.env.RR_PHOTOS ?? null, headless: HEADLESS });

const files = createFiles({
  settings: () => bridgeCall('load_settings', {}),
  bridge: bridgeCall,
  library: () => config.library ?? null,
  extraRoots: () => [...(process.env.RR_PHOTOS ? [process.env.RR_PHOTOS] : []), ...remote.roots()],
  labels: () => remote.labels(),
  offline: (p) => remote.offline(p),
});
// Folders from the browsing computer (the browser is the storage): rrweb/relay/remote.mjs
const remote = createRemote({ validName, insideRoots: (p) => files.within(p), onChange: () => files.invalidate() });
// Thumbnails are handed to RapidRAW by the relay, so the photo open in the editor always comes first (thumbs.mjs)
const thumbs = createThumbs({
  offline: (p) => remote.offline(p),
  fetching: (p) => remote.fetching(p),
  settings: () => bridgeCall('load_settings', {}),
  bridge: bridgeCall,
});
// Fuji RAF EXIF from the embedded JPEG's header instead of the whole file (exif.mjs)
const exif = createExif({ locate: (p) => remote.locate(p), offline: (p) => remote.offline(p), bridge: bridgeCall, work: remote.work });
// Progress for the UI (rrweb/files/progress.ts): opening a photo, and thumbnails that aren't ready yet
let decodeMs = 0; // average RAW decoding time (load_image without waiting for the browsing computer)
const progressCommands = {
  __rr_progress: ({ path: p }) => ({ ...(remote.progress(p) ?? { phase: 'decoding' }), decodeMs: Math.round(decodeMs) }),
  __rr_thumbs: ({ paths, ahead }) => thumbs.status(Array.isArray(paths) ? paths.slice(0, 300) : [], ahead),
  __rr_view: ({ mode }, ws) => { if (mode === 'library' || mode === 'editor') editor.setView(mode, ws); return null; },
  __rr_thumbs_summary: () => thumbs.summary(),
};
function loadDone(f) {
  if (f.cmd !== 'load_image' || !f.started) return;
  const from = Math.max(f.started, remote.progress(f.path)?.completedAt ?? 0);
  const ms = Date.now() - from;
  if (ms > 0 && ms < 120000) decodeMs = decodeMs ? decodeMs * 0.7 + ms * 0.3 : ms;
  if (ms > 0 && ms < 120000) thumbs.editTiming('load', ms);
}
const LOCAL = { ...progressCommands, __rr_home: () => os.homedir(), __rr_ping: () => Date.now(), ...files.commands, ...remote.commands };

// A RapidRAW command called by the relay itself (Files tab: settings, delete to trash)
function bridgeCall(cmd, args) {
  return new Promise((resolve, reject) => {
    if (!bridge) { reject(new Error('the RapidRAW bridge is not connected')); return; }
    rid = (rid + 1) >>> 0 || 1;
    const client = { send: (data, opts) => {
      if (opts?.binary) { resolve(data.subarray(4)); return; }
      const m = JSON.parse(data);
      'error' in m ? reject(new Error(String(m.error))) : resolve(m.result);
    } };
    inflight.set(rid, { client, id: 0, cmd, t0: process.hrtime.bigint() });
    bridge.send(JSON.stringify({ id: rid, cmd, args }));
  });
}

const wssClient = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 << 20 });
const wssBridge = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 << 30 });
const wssRfs = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 << 20 });

const upgrade = (bridgeOnly) => (req, sock, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/bridge' && isLoopback(req.socket.remoteAddress)) wssBridge.handleUpgrade(req, sock, head, (ws) => wssBridge.emit('connection', ws));
  else if (p === '/ipc' && !bridgeOnly && authed(req) && sameOrigin(req)) wssClient.handleUpgrade(req, sock, head, (ws) => wssClient.emit('connection', ws, req));
  else if (p === '/rfs' && !bridgeOnly && authed(req) && sameOrigin(req)) {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    wssRfs.handleUpgrade(req, sock, head, (ws) => remote.attach(ws, id));
  }
  else sock.destroy();
};
server.on('upgrade', upgrade(false));
// The bridge always connects to 127.0.0.1:8780 (VITE_RR_RELAY in the bridge build), so with another RR_PORT also
// listen there (only if nobody uses 8780: Windows would otherwise allow 127.0.0.1:8780 next to someone else's
// 0.0.0.0:8780 and take their traffic)
if (PORT !== BRIDGE_PORT) {
  const probe = net.connect(BRIDGE_PORT, '127.0.0.1');
  probe.on('connect', () => {
    probe.destroy();
    console.error(`[relay] port ${BRIDGE_PORT} is used by another program: the RapidRAW bridge cannot reach this relay`);
  });
  probe.on('error', () => {
    http.createServer((_req, res) => res.writeHead(404).end()).on('upgrade', upgrade(true))
      .on('error', (e) => console.error(`[relay] bridge port ${BRIDGE_PORT}: ${e.message}`))
      .listen(BRIDGE_PORT, '127.0.0.1');
  });
}

// A WebSocket without an 'error' listener throws (invalid frame, connection cut through a tunnel) and takes the
// whole relay down
const quiet = (ws, what) => ws.on('error', (e) => console.warn(`[relay] ${what}: ${e.message}`));
// Tunnels and proxies (Cloudflare: 100 s) close an idle WebSocket, so it is pinged. A connection that dies silently
// (TCP without any answer, e.g. Wi-Fi or a filter on the computer) would otherwise hang around for many minutes: one
// that answers nothing for CLIENT_SILENT is dropped. Generous, because a browser that uploads a folder over a slow
// uplink can be late with its answers for a while; the browser detects a dead connection itself (shim/transport.ts).
const CLIENT_SILENT = 90000;
const keepalive = (ws, what) => {
  let heard = Date.now();
  const ok = () => { heard = Date.now(); };
  ws.on('pong', ok);
  ws.on('message', ok);
  const t = setInterval(() => {
    if (ws.readyState !== 1) return;
    if (Date.now() - heard > CLIENT_SILENT) { console.warn(`[relay] ${what} not responding, closing the connection`); ws.terminate(); return; }
    ws.ping();
  }, 20000);
  ws.on('close', () => clearInterval(t));
};

// Events from RapidRAW go to every browser tab. A tab that loses its connection reconnects and says which event it
// got last (?seq=…&boot=…); the relay replays what it missed from the last EVENT_KEEP ms, so e.g. thumbnails that
// finished meanwhile don't stay "loading". boot changes when the relay restarts (then all kept events are replayed).
const EVENT_KEEP = 120000;
const BOOT = Math.random().toString(36).slice(2, 8);
const recentEvents = []; // [seq, at, json]
let eventSeq = 0;
function broadcast(msg) {
  msg.seq = ++eventSeq;
  msg.boot = BOOT;
  const s = JSON.stringify(msg);
  const now = Date.now();
  recentEvents.push([eventSeq, now, s]);
  while (recentEvents.length > 5000 || now - recentEvents[0][1] > EVENT_KEEP) recentEvents.shift();
  clients.forEach((c) => c.send(s));
}
function replay(ws, req) {
  const q = new URL(req?.url ?? '/', 'http://x').searchParams;
  const last = Number(q.get('seq')) || 0;
  if (!last) return; // a new tab: nothing missed
  const from = q.get('boot') === BOOT ? last : 0;
  for (const [n, , s] of recentEvents) if (n > from) ws.send(s);
}

wssBridge.on('connection', (ws) => {
  if (bridge) bridge.close();
  bridge = ws;
  quiet(ws, 'bridge');
  console.log('[relay] bridge connected');
  ws.send(JSON.stringify(libraryState()));
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const r = data.readUInt32LE(0);
      const f = inflight.get(r); inflight.delete(r);
      if (!f) return;
      if (f.cmd === 'load_image') { editor.loaded(r); loadDone(f); }
      // the preview after a change is done on the server; from now on the UI (rrweb/files/adjust.ts) counts the transfer
      if (f.cmd === 'apply_adjustments') {
        const ms = Number(process.hrtime.bigint() - f.t0) / 1e6;
        thumbs.editTiming(f.interactive ? 'interactive' : 'final', ms);
        if (f.id) f.client.send(JSON.stringify({ event: '__rr_rendered', payload: { id: f.id, ms: Math.round(ms), bytes: data.length - 4 } }));
      }
      data.writeUInt32LE(f.id, 0);           // rewrite relayId → the client's id
      f.client.send(data, { binary: true });
      log(f, data.length - 4);
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.rr === 'set-library') {
      try { setLibrary(msg.path); } catch (e) { console.error(`[relay] photo library ${msg.path}: ${e.message}`); }
      ws.send(JSON.stringify(libraryState()));
      return;
    }
    if (msg.event !== undefined) {
      if (msg.event === 'thumbnail-generated') thumbs.generated(msg.payload?.path);
      // the relay hands thumbnails to RapidRAW (thumbs.mjs): while it still has some, the UI sees the relay's progress
      if (msg.event === 'thumbnail-progress' || msg.event === 'thumbnail-generation-complete') {
        if (msg.event === 'thumbnail-generation-complete') thumbs.drained();
        const p = thumbs.progress();
        if (p) {
          if (msg.event === 'thumbnail-generation-complete') return;
          msg.payload = p;
        }
      }
      broadcast(msg);
      return;
    }
    const f = inflight.get(msg.id); inflight.delete(msg.id);
    if (!f) return;
    if (f.cmd === 'load_image') { editor.loaded(msg.id); if (!('error' in msg)) loadDone(f); }
    msg.id = f.id;
    f.client.send(JSON.stringify(msg));
    log(f);
  });
  ws.on('close', () => {
    if (bridge === ws) bridge = null;
    console.log('[relay] bridge disconnected');
    for (const [r, f] of inflight) { f.client.send(JSON.stringify({ id: f.id, error: 'bridge disconnected' })); inflight.delete(r); }
    editor.loads.clear();
  });
});

wssClient.on('connection', (ws, req) => {
  clients.add(ws);
  quiet(ws, 'client');
  keepalive(ws, 'client');
  replay(ws, req);
  console.log(`[relay] client +1 (${clients.size})`);
  ws.on('message', async (data) => {
    let id, cmd, args;
    try { ({ id, cmd, args } = JSON.parse(data)); } catch { return; }
    if (LOCAL[cmd]) {
      try { ws.send(JSON.stringify({ id, result: (await LOCAL[cmd](args ?? {}, ws)) ?? null })); }
      catch (e) { ws.send(JSON.stringify({ id, error: e.message ?? String(e) })); }
      return;
    }
    if (!bridge) { ws.send(JSON.stringify({ id, error: 'the RapidRAW bridge is not connected' })); return; }
    // A photo from a folder whose computer is not connected: RapidRAW must not read it (a read error through mmap
    // crashes it)
    if (typeof args?.path === 'string' && remote.offline(args.path)) {
      ws.send(JSON.stringify({ id, error: 'The folder on the computer you are browsing from is not connected. Open RapidRAW Web in Chrome or Edge on that computer (Files → This computer → Reconnect).' }));
      return;
    }
    if (cmd === 'read_exif_for_paths' && Array.isArray(args?.paths)) {
      exif.readExif(args.paths).then(
        (result) => ws.send(JSON.stringify({ id, result: result ?? null })),
        (e) => ws.send(JSON.stringify({ id, error: e.message ?? String(e) })));
      return;
    }
    // the relay hands thumbnails to RapidRAW (thumbs.mjs), so the photo in the editor comes first; an empty list
    // (cancel) is passed on
    if (cmd === 'update_thumbnail_queue' && Array.isArray(args?.paths) && !thumbs.takeThumbs(args.paths)) {
      ws.send(JSON.stringify({ id, result: null }));
      return;
    }
    rid = (rid + 1) >>> 0 || 1;
    if (EDIT_CMDS.has(cmd)) editor.touch();
    if (cmd === 'load_image') { // the opened photo comes before all background transfers and thumbnails
      editor.loading(rid);
      remote.focus(args?.path);
    }
    inflight.set(rid, { client: ws, id, cmd, t0: process.hrtime.bigint(), ...(cmd === 'load_image' ? { path: args?.path, started: Date.now() } : {}),
      ...(cmd === 'apply_adjustments' ? { interactive: !!args?.isInteractive } : {}) });
    bridge.send(JSON.stringify({ id: rid, cmd, args }));
  });
  ws.on('close', () => {
    clients.delete(ws);
    editor.dropView(ws);
    for (const [r, f] of inflight) if (f.client === ws) { inflight.delete(r); editor.loaded(r); }
  });
});

const VERBOSE = !!process.env.RR_VERBOSE;
// Work in the editor: while it runs (and for a few seconds after), background work (thumbnails, folders from
// browsing computers) waits (remote.mjs: editor)
const EDIT_CMDS = new Set(['load_image', 'apply_adjustments', 'generate_uncropped_preview', 'generate_mask_overlay',
  'generate_preset_preview', 'apply_denoising', 'generate_ai_foreground_mask', 'generate_ai_sky_mask', 'generate_ai_subject_mask']);
// binary answers (previews) always; the rest with RR_VERBOSE or when it takes longer than 1 s (RapidRAW runs some
// commands on its main thread, so a slow command also stops slider previews)
function log(f, bytes) {
  const ms = Number(process.hrtime.bigint() - f.t0) / 1e6;
  if (!VERBOSE && bytes === undefined && ms < 1000) return;
  console.log(`[ipc] ${f.cmd} ${ms.toFixed(1)}ms${bytes !== undefined ? ` ${(bytes / 1024).toFixed(0)}KB` : ''}`);
}

// A relay started by the bridge (all-in-one packages) stops with it. RapidRAW exits without Tauri's Exit event, so
// the shell plugin doesn't get to kill the child process; this also covers a crashed bridge.
// On Linux an orphan gets a new parent (systemd, init), so a change of parent counts too.
if (process.env.RR_EXIT_WITH_PARENT) {
  const parent = process.ppid;
  setInterval(() => {
    let alive = process.ppid === parent;
    try { process.kill(parent, 0); } catch { alive = false; }
    if (!alive) { console.log('[relay] bridge exited, stopping'); shutdown(); }
  }, 2000).unref();
}
// On exit unmount the FUSE folders from browsing computers (otherwise "Transport endpoint is not connected" stays)
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 10000).unref(); // shutting down must not hang (e.g. on a dead FUSE mount) and keep the port
  await remote.shutdown();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);
// An error in one request must not take the relay down: RapidRAW would lose its connection, and FUSE mounts would die
process.on('uncaughtException', (e) => console.error('[relay] uncaught exception:', e));
process.on('unhandledRejection', (e) => console.error('[relay] unhandled rejection:', e));

server.on('error', (e) => { console.error(`[relay] ${e.code === 'EADDRINUSE' ? `port ${PORT} is already in use` : e.message}`); process.exit(1); });
server.listen(PORT, HOST, () => {
  remote.sweep();
  console.log(`[relay] http://${HOST}:${PORT}  dist=${DIST}  roots=${ROOTS.join(',')}  auth=${AUTH ? 'on' : 'off'}`);
  // the bridge reads the "[relay] url …" lines (window with the addresses to open in a browser)
  const lan = HOST === '0.0.0.0' || HOST === '::'
    ? Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address)
    : HOST === '127.0.0.1' || HOST === 'localhost' ? [] : [HOST];
  for (const h of ['localhost', ...lan]) console.log(`[relay] url http://${h}:${PORT}`);
});
