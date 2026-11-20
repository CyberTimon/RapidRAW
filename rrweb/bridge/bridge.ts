// Runs INSIDE the real RapidRAW (Tauri) process, instead of its UI.
// Receives calls from the relay, calls the real invoke(), returns the result; forwards every event.
// If no relay is running (e.g. started from the menu), it starts the bundled one (all-in-one package) and opens a browser.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appCacheDir, appDataDir, delimiter, join, resourceDir } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as pickFolder } from '@tauri-apps/plugin-dialog';
import { Command, open } from '@tauri-apps/plugin-shell';
import { EVENTS } from './events';

declare const __RR_VERSION__: string;
const RELAY: string = import.meta.env.VITE_RR_RELAY ?? 'ws://127.0.0.1:8780/bridge';
const DEFAULT_UI = `http://localhost:${new URL(RELAY).port || 80}`; // a relay with another RR_PORT prints its own addresses
const NODE = '../rrweb/bundle/bin/rrweb-node'; // sidecar from rrweb/bundle/prepare.mjs
const el = (id: string) => document.getElementById(id)!;
let ws: WebSocket | undefined;
let calls = 0;
let failures = 0;
let relay: 'external' | 'bundled' | 'none' | undefined; // who started the relay
let opened = false;
let relayExited = false;
let quickExits = 0; // a bundled relay that stops right after starting (e.g. port taken) is not restarted forever
let library: string | null | undefined; // undefined = the relay hasn't reported yet
const urls = new Set<string>(); // "[relay] url …" lines of the bundled relay

const send = (o: unknown) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
EVENTS.forEach((ev) => listen(ev, (e) => send({ event: ev, payload: e.payload })));

// On Windows/macOS RapidRAW by default draws the preview straight into the native window (wgpu surface) and returns
// "WGPU_RENDER" instead of an image → the browser sees nothing. So the bridge always keeps it off.
// Must happen before the first image is processed: the GPU context (and surface) is created lazily.
type Settings = Record<string, unknown>;
async function disableNativeRenderer() {
  const s = await invoke<Settings>('load_settings');
  if (s.useWgpuRenderer !== false) await invoke('save_settings', { settings: { ...s, useWgpuRenderer: false } });
}

function status(text: string, ok = false) {
  el('s').textContent = text;
  el('s').className = ok ? 'ok' : '';
}
function log(line: string) {
  const l = el('log');
  l.textContent = (l.textContent + line.trimEnd() + '\n').split('\n').slice(-30).join('\n');
}
function showUrls() {
  el('urls').replaceChildren(...(urls.size ? [...urls] : [DEFAULT_UI]).map((url) => {
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.onclick = (e) => { e.preventDefault(); open(url); };
    return a;
  }));
}

async function startBundledRelay() {
  relay = 'bundled';
  status('Starting server…');
  const started = Date.now();
  try {
    const script = await join(await resourceDir(), '_up_', 'rrweb', 'relay', 'relay.mjs');
    const env = {
      RR_ROOTS: [await appDataDir(), await appCacheDir()].join(delimiter()),
      RR_CONFIG: await join(await appDataDir(), 'rrweb.json'),
      RR_WORK: await join(await appCacheDir(), 'remote'),
      RR_LOG: await join(await appDataDir(), 'logs', 'relay.log'),
      RR_EXIT_WITH_PARENT: '1',
    };
    const cmd = Command.sidecar(NODE, [script], { env });
    const line = (l: string) => {
      log(l);
      const m = /^\[relay\] url (\S+)/.exec(l);
      if (m) { urls.add(m[1]); showUrls(); }
    };
    cmd.stdout.on('data', line);
    cmd.stderr.on('data', line);
    cmd.on('close', ({ code }) => {
      log(`[relay] stopped (exit ${code})`);
      // the relay crashed: start it again, the browser and the bridge reconnect by themselves
      quickExits = Date.now() - started < 10000 ? quickExits + 1 : 0;
      if (quickExits < 3) { status('Server stopped, restarting…'); setTimeout(startBundledRelay, 2000); return; }
      relayExited = true;
      status('Server stopped, see the log below. Restart the app.');
    });
    await cmd.spawn();
    el('hint').textContent = 'Open RapidRAW in your browser (other devices: use your network address). Close this window to stop the server.';
  } catch (e) {
    // No bundled relay (a build without the rrweb/bundle overlay): run.sh / run.ps1 start the relay
    relay = 'none';
    log(String(e));
    el('hint').textContent = 'No bundled server in this build. Start the relay with rrweb/run.sh or rrweb/run.ps1.';
  }
}

function connect() {
  const sock = new WebSocket(RELAY);
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => {
    failures = 0;
    relay ??= 'external';
    status('Running', true);
    if (relay !== 'bundled') el('hint').textContent = '';
  };
  sock.onclose = () => {
    if (relay === undefined && ++failures >= 2) startBundledRelay(); // ~1 s to give run.sh/run.ps1 time to start its relay
    else if (!relayExited && (relay !== 'bundled' || opened)) status(`Server offline, retrying… (${RELAY})`);
    setTimeout(connect, 1000);
  };
  sock.onmessage = async (m) => {
    const msg = JSON.parse(m.data);
    if (msg.rr === 'library') {
      // the bundled relay's first message: open RapidRAW in the browser, except on a server without a screen
      if (relay === 'bundled' && !opened) {
        opened = true;
        if (!msg.headless) open([...urls][0] ?? DEFAULT_UI).catch(() => {});
      }
      showLibrary(msg.path ?? msg.env); // with a library chosen the window minimizes, without one it stays open
      return;
    }
    const { id, cmd, args } = msg;
    if (cmd === 'save_settings' && args?.settings) args.settings.useWgpuRenderer = false;
    try {
      const result: unknown = await invoke(cmd, args);
      const bytes = result instanceof ArrayBuffer ? new Uint8Array(result)
        : result instanceof Uint8Array ? result : null;
      if (bytes) {
        const frame = new Uint8Array(4 + bytes.byteLength);
        new DataView(frame.buffer).setUint32(0, id, true);
        frame.set(bytes, 4);
        sock.send(frame);
      } else send({ id, result: result ?? null });
    } catch (error) {
      send({ id, error: String(error) });
    }
    el('calls').textContent = `${++calls} calls · last: ${cmd}`;
  };
}

// Photo library: the folder with photos on THIS computer, always first in the Files tab and the pickers in the browser
function showLibrary(path: string | null) {
  const first = library === undefined;
  library = path;
  el('libpath').textContent = path ?? 'not chosen yet';
  el('lib').className = path ? '' : 'todo';
  if (first && path && relay === 'bundled' && opened) getCurrentWindow().minimize();
}
el('libpick').onclick = async () => {
  const p = await pickFolder({ directory: true, title: 'Photo library folder', defaultPath: library ?? undefined });
  if (typeof p === 'string') send({ rr: 'set-library', path: p });
};

el('ver').textContent = `RapidRAW ${__RR_VERSION__}`;
el('min').onclick = () => getCurrentWindow().minimize();
el('close').onclick = () => getCurrentWindow().close();
showUrls();
disableNativeRenderer().catch((e) => console.error('rrweb: useWgpuRenderer', e)).finally(connect);
