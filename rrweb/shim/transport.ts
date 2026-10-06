// One WebSocket connection to the relay. Binary answers: [u32 LE id][payload].
type Pending = { res: (v: any) => void; rej: (e: any) => void; cmd: string; t0: number; frame: string; sent: boolean; tries: number };
type Handler = (payload: unknown) => void;

const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ipc`;
const pending = new Map<number, Pending>();
const handlers = new Map<string, Set<Handler>>();
const queue: number[] = []; // ids of calls waiting for the connection
// duration and size of answers (rrweb/files/network.ts watches previews: apply_adjustments)
const timings = new Set<(cmd: string, ms: number, bytes: number) => void>();
export const onTiming = (fn: (cmd: string, ms: number, bytes: number) => void) => timings.add(fn);
const done = (p: Pending, bytes: number) => timings.forEach((fn) => fn(p.cmd, performance.now() - p.t0, bytes));
// start of a call (rrweb/files/progress.ts: opening a photo, thumbnail paths; adjust.ts: processing changes, the id
// for __rr_rendered); result must not be left unhandled
type Start = (cmd: string, args: unknown, result: Promise<unknown>, id: number) => void;
const starts = new Set<Start>();
export const onCall = (fn: Start) => starts.add(fn);
let ws: WebSocket;
let seq = 0;
let backoff = 250;

// A connection can die silently (TCP without any answer: Wi-Fi, a filter on the computer…), and the browser notices
// only after a few minutes; until then everything stands still. So: when nothing arrives for a while, __rr_ping; if
// that gets no answer either, a new connection. Sent calls that are safe to repeat (opening a photo, previews,
// listings, reads) go to the new connection, the others fail.
const IDLE_MS = 5000;
const STALL_MS = 12000;
const RETRY = /^(load_|list_|get_|read_|generate_)|^(apply_adjustments|update_thumbnail_queue)$|^__rr_(progress|thumbs|thumbs_summary|view|ping|home|share_caps|share_list|share_have)$/;
let lastRecv = 0;
let pingAt = 0;
// connection state for the UI (rrweb/files/network.ts: badge "Reconnecting…")
let online = true; // while the first connection opens, the badge doesn't report a break
const stateFns = new Set<(online: boolean) => void>();
export const onConnection = (fn: (online: boolean) => void) => { stateFns.add(fn); fn(online); };
const setOnline = (v: boolean) => { if (v !== online) { online = v; stateFns.forEach((fn) => fn(v)); } };

function send(p: Pending) {
  ws.send(p.frame);
  p.sent = true;
}

function lost() {
  for (const [id, p] of pending) {
    if (!p.sent) continue; // still queued: it goes as soon as the connection opens
    if (RETRY.test(p.cmd) && p.tries < 2) { p.tries++; p.sent = false; queue.push(id); continue; }
    pending.delete(id);
    p.rej('rrweb: connection lost');
  }
}

setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (pingAt && lastRecv >= pingAt) pingAt = 0;
  if (pingAt && now - pingAt > 3000) setOnline(false); // a ping without an answer: the UI shows it waits for the connection
  if (pingAt && now - pingAt > STALL_MS) {
    const dead = ws;
    dead.onclose = dead.onmessage = null;
    try { dead.close(); } catch { /* already closed */ }
    console.warn('rrweb: no answer from the server, reconnecting');
    lost();
    connect();
    return;
  }
  if (!pingAt && now - lastRecv > IDLE_MS) {
    pingAt = now;
    ws.send(JSON.stringify({ id: 0, cmd: '__rr_ping', args: {} }));
  }
}, 2000);

function connect() {
  const sock = new WebSocket(url);
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => {
    backoff = 250;
    lastRecv = Date.now();
    pingAt = 0;
    setOnline(true);
    for (const id of queue.splice(0)) { const p = pending.get(id); if (p && !p.sent) send(p); }
  };
  sock.onmessage = (m) => {
    lastRecv = Date.now();
    setOnline(true);
    if (m.data instanceof ArrayBuffer) {
      const id = new DataView(m.data).getUint32(0, true);
      const p = pending.get(id);
      pending.delete(id);
      if (p) { done(p, m.data.byteLength - 4); p.res(m.data.slice(4)); }
      return;
    }
    const msg = JSON.parse(m.data);
    if (msg.event !== undefined) {
      handlers.get(msg.event)?.forEach((h) => h(msg.payload));
      return;
    }
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (!p) return;
    done(p, m.data.length);
    'error' in msg ? p.rej(msg.error) : p.res(msg.result);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    setOnline(false);
    lost();
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 5000);
  };
}
connect();

export function call<T>(cmd: string, args: unknown = {}): Promise<T> {
  seq = (seq + 1) >>> 0 || 1;
  const id = seq;
  const frame = JSON.stringify({ id, cmd, args });
  const result = new Promise<T>((res, rej) => {
    const p: Pending = { res, rej, cmd, t0: performance.now(), frame, sent: false, tries: 0 };
    pending.set(id, p);
    if (ws.readyState === WebSocket.OPEN) send(p); else queue.push(id);
  });
  starts.forEach((fn) => { try { fn(cmd, args, result, id); } catch { /* an observer must not break the call */ } });
  return result;
}

// An event as if it came from the backend (Files tab: refresh RapidRAW's library after changes on disk)
export function emitLocal(event: string, payload: unknown = null) {
  handlers.get(event)?.forEach((h) => h(payload));
}

export function on(event: string, h: Handler): () => void {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event)!.add(h);
  return () => { handlers.get(event)?.delete(h); };
}
