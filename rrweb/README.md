# RapidRAW Web

**RapidRAW in a browser, with all processing on a computer in your network.**

RapidRAW Web runs the regular RapidRAW backend on one machine, a PC or a server with a GPU and your photos, and shows the **exact same RapidRAW interface** in a browser on any other device: a laptop, a tablet, a mini PC. It is not a remote desktop or a video stream, and not a reimplemented web version. It is RapidRAW's own React UI, talking to RapidRAW's own backend over the network.

Everything lives in this folder. **No RapidRAW file is changed**: the desktop app builds and works exactly as before, and the web build is a separate target.

## How it works

RapidRAW is a Tauri app: its interface is a React web app that talks to a Rust backend over IPC. RapidRAW Web moves that IPC onto the network:

```
Browser (RapidRAW UI + shims)
    │  WebSocket /ipc   JSON calls ↑   rendered previews (JPEG bytes) / events ↓
    ▼
Relay (Node.js, rrweb/relay)  ─ serves the UI, routes calls, schedules thumbnails
    │  WebSocket /bridge (loopback only)
    ▼
RapidRAW Web Bridge  ─ the regular RapidRAW backend, rendering on the GPU (wgpu)
    │
    ▼
GPU + photo storage
```

- **The browser runs RapidRAW's UI.** The web build (`vite.web.config.mjs`) compiles the same `src/` and replaces the `@tauri-apps/*` imports with small shims (`shim/`) that send every `invoke()` over a WebSocket and deliver backend events back.
- **The bridge is RapidRAW.** `tauri.bridge.json` is a config overlay that builds the normal backend with a separate identifier and binary name (`rapidraw-web-bridge`), and with a 3 KB page (`bridge/`) instead of the UI. That page calls the real `invoke()` for every request from the relay and forwards every event the UI listens to (`gen-events.mjs` collects their names from `src/` on every build).
- **The relay connects them.** It serves the web UI, passes calls to the bridge and binary previews back (`[u32 LE id][bytes]` frames), and adds the parts a browser needs: server-side file pickers, a Files tab, folders from the browsing computer, thumbnail scheduling and progress reporting.
- **Rendering stays where it was.** A slider change is rendered by RapidRAW on the server's GPU, and the browser receives the compressed preview: a few hundred KB, a few milliseconds on a LAN. On Windows and macOS the bridge turns off RapidRAW's direct-to-window renderer (`useWgpuRenderer`), so previews come back as images.

## Features

- **The full RapidRAW editor in a browser**, on any device in your network (or anywhere, through a VPN or tunnel). Nothing to install on that device.
- **All processing on the server**: RAW decoding, every slider, masks, AI tools and exports.
- **Photo library and folder pickers.** The photo library is the top folder of your photos on the server, chosen in the bridge window. Wherever RapidRAW asks for a folder or file (*Add Folder*, export destination, import, LUTs, presets), the browser shows a picker of the server's photo folders instead of a native dialog. *Type a path…* accepts any path.
- **Files tab** (next to *Editor*, top centre): a file manager for the photo folders on the server, to get exports out and organise shoots. Download (several items as a `.zip`), upload (button or drag & drop), new folder, rename, copy/cut/paste, delete to the trash. A photo's edit files (`.rrdata`, virtual copies, `.rrexif`) go along with it. It only reaches inside the photo folders.
- **Folders from the browsing computer** (Files tab → *This computer*, Chrome or Edge): edit photos that stay on your laptop. The browser acts as the storage over a WebSocket (File System Access API):
  - *Copy*: the folder is copied to the server in the background (resumable), and a watcher sends edits and exports back. Works on every server OS.
  - *On demand*: the folder is mounted as a disk on the server (`fuse/`: FUSE on Linux, WinFsp on Windows). Each read fetches just the needed range into a server-side cache, so you can start editing right away. Everything RapidRAW writes goes back into the folder. Originals are never deleted permanently (they go to a hidden `.rrweb-trash`).
- **Editing comes first.** The relay takes over RapidRAW's thumbnail requests and hands them to RapidRAW a few at a time, the visible tiles first. While a photo is open in the editor, it works only in short pauses between edits: quick thumbnails (unedited RAWs, from the embedded preview) for every photo, full renders only for the photos next to the open one in the filmstrip (the next ones first). How many at a time and how long it waits adapts to the server: it times slider previews and photo opening with and without thumbnails running, and backs off when editing gets slower. For folders on the browsing computer, the photo you open is fetched first, ahead of thumbnails and the background copy.
- **You can see what is happening**: progress while a photo opens (download, then decoding), labels on thumbnails that aren't ready (*Queued #3 · ~5 s*, *Rendering…*), the number left in the top bar, and a ring with a percentage next to the slider you just moved while its preview renders. RapidRAW renders in one GPU pass without reporting progress, so the ring fills by the measured time of the same slider on this server, then the transfer.
- **Connection badge**: measures download, upload and ping, and recommends RapidRAW's *preview size* and *live preview quality* for the connection, or lets you pick them. If the connection dies silently, it shows *Reconnecting…*; the browser opens a new connection within about 20 s and repeats the requests that were waiting.
- **Fuji RAF EXIF without reading whole files**: the library reads the EXIF of every photo in a folder; for RAF files the relay gives RapidRAW just the embedded JPEG's EXIF header (about 65 KB) instead of the whole 30–45 MB file, which matters most for folders on the browsing computer.

## Building

Needs what RapidRAW needs (Rust, Node.js 20+, on Linux the WebKitGTK 4.1 development packages), plus `cargo` for the on-demand helper.

```bash
./rrweb/build.sh                            # web UI, relay, rrweb-fuse and an all-in-one bridge (no installer)
BUNDLES=deb,rpm,appimage ./rrweb/build.sh   # also installer packages (Windows: BUNDLES=nsis, macOS: BUNDLES=dmg)
RR_PLAIN=1 ./rrweb/build.sh                 # a bridge without the bundled relay (start the relay with run.sh)
```

`build.sh` first runs `check-shims.mjs`, which fails if the UI (or a Tauri plugin package it uses) imports a Tauri module or function the shims don't cover, or if one of the few RapidRAW details the web layer relies on has changed. The desktop build is not affected either way.

**All-in-one bridge** (`bundle/prepare.mjs`): downloads the official Node.js for the target platform (checked against nodejs.org's SHA256 list) as a Tauri sidecar named `rrweb-node`, and writes a config overlay that bundles the relay and the web UI. Started from the menu, the bridge then starts the relay itself and opens the browser; closing its window stops both. On Linux the `.deb`/`.rpm` also install a systemd user service for servers without a screen (`linux/rapidraw-web.service`, uses `xvfb-run`).

## Running

**From a package**: start *RapidRAW Web Bridge*. Its window shows the addresses to open (`http://<this-computer>:8780`) and lets you choose the photo library. On a Linux server without a screen:

```bash
systemctl --user enable --now rapidraw-web    # starts now and at every login
sudo loginctl enable-linger $USER             # …and at boot, without logging in
systemctl --user edit rapidraw-web            # another photo folder: [Service] Environment=RR_PHOTOS=/mnt/photos
```

**From the repository**, with the relay in a terminal:

```bash
RR_PHOTOS=~/Pictures RR_VERBOSE=1 ./rrweb/run.sh          # Linux/macOS; uses xvfb-run when there is no display
$env:RR_PHOTOS="D:\Photos"; .\rrweb\run.ps1               # Windows
```

Folders from the browsing computer need a secure page (HTTPS or `localhost`), because browsers allow folder access only there: for example `tailscale serve --bg 8780`, or a reverse proxy with a certificate. On-demand mode needs `fuse3` on a Linux server, or [WinFsp](https://winfsp.dev) on a Windows server; copy mode works everywhere.

### Configuration

| Variable | Default | |
|---|---|---|
| `RR_PHOTOS` | `~/Pictures` in the Linux service; required by `run.sh`/`run.ps1` | Photo folder for the Files tab and the pickers (the library chosen in the bridge window comes first) |
| `RR_PORT` / `RR_HOST` | `8780` / `0.0.0.0` | Listen address |
| `RR_AUTH` | off | `user:pass` → HTTP Basic auth for UI, files and IPC |
| `RR_CONFIG` | `<bridge data dir>/rrweb.json` | Where the photo library chosen in the bridge window is stored |
| `RR_ORIGINS` | — | Extra allowed browser origins, comma-separated (behind a reverse proxy that changes the `Host` header) |
| `RR_ROOTS` | photos + bridge data/cache dirs | Directories `/files` may serve |
| `RR_WORK` | `<bridge cache dir>/remote` | Mirror, cache and mount points for folders from browsing computers |
| `RR_FUSE_BIN` | next to the bundled Node.js, or `fuse/<arch>/rrweb-fuse[.exe]` | Helper for on-demand folders |
| `RR_BRIDGE_PORT` | `8780` | Loopback port the bridge connects to (`VITE_RR_RELAY` when the bridge is built) |
| `RR_BRIDGE_BIN` | auto-detect | Path to `rapidraw-web-bridge` (`run.sh`/`run.ps1`) |
| `RR_VERBOSE` | off | Log every IPC call with its timing, and the file operations of on-demand folders |
| `RR_LOG` | `<data dir>/logs/relay.log` | Copy of the relay's log (up to 5 MB, then `.1`) |
| `RR_NO_BROWSER` | off (on in the Linux service and under `xvfb-run`) | Don't open a browser when the bridge starts its bundled relay |

For Vulkan inside a Docker container with an NVIDIA GPU, set `NVIDIA_DRIVER_CAPABILITIES=graphics,compute,utility` (not just `compute`).

## Security

The IPC channel can do everything RapidRAW can do on the server (browse and write files, export, delete). **Don't expose it to the internet without `RR_AUTH` and TLS**, or keep it behind a VPN. The bridge port accepts loopback connections only, `/files` serves only `RR_ROOTS`, the Files tab and the pickers stay inside the photo folders, and requests from other websites (a foreign `Origin`) are refused. A folder from a browsing computer is reachable only while that browser tab shares it, and only inside the folder picked there.

## Limitations

- One editing session at a time: RapidRAW's backend state is global, so two browsers editing different photos at once interfere.
- Desktop-only window features (window controls, drag & drop from the OS) do nothing in the browser. Tethering is not included. Features that call online services from the desktop app without CORS (e.g. cloud sign-in) are shown as unavailable.
- *Folders from this computer* need Chrome or Edge and HTTPS (or `localhost`); on-demand mode needs a Linux or Windows server for now.

## Files

| Path | What |
|---|---|
| `shim/` | Browser replacements for `@tauri-apps/*`: `invoke`/`listen` over a WebSocket (`transport.ts`, with reconnect and retry), dialogs through the server pickers, window/OS stubs |
| `bridge/` | The page the bridge loads instead of the UI: forwards IPC and events to the relay, starts the bundled relay, shows the addresses and the photo library |
| `relay/relay.mjs` | Node.js server: serves the web UI and `/files`, routes browser ⇄ bridge |
| `relay/files.mjs`, `files/files.ts`, `files/picker.ts` | Files tab and server-side pickers (server and browser side) |
| `relay/remote.mjs`, `files/remote.ts`, `fuse/` | Folders from the browsing computer: copy mode, and on-demand mode through `rrweb-fuse` (Rust; FUSE on Linux without libfuse, WinFsp on Windows) |
| `relay/thumbs.mjs` | Thumbnail scheduling around the editor, adapted to the server |
| `relay/exif.mjs` | Fuji RAF EXIF from the embedded JPEG's header |
| `files/progress.ts`, `files/adjust.ts`, `files/network.ts` | Progress labels, the ring next to sliders, the connection badge |
| `bundle/prepare.mjs`, `linux/rapidraw-web.service` | All-in-one bridge (bundled Node.js and relay) and the Linux service |
| `check-shims.mjs`, `gen-events.mjs` | Build-time checks and the list of forwarded events |
| `vite.web.config.mjs`, `vite.bridge.config.mjs`, `tauri.bridge.json` | Builds of the browser UI, the bridge page and the bridge |
| `build.sh`, `run.sh`, `run.ps1` | Build and start scripts |
