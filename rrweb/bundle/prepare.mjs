// All-in-one bridge (Windows, macOS, Linux): downloads the official Node.js (Tauri sidecar, SHA256 from nodejs.org
// SHASUMS256) and generates rrweb/bundle/tauri.bundle.json, an overlay that adds the relay + web UI to the bridge and
// allows the bridge to start the relay itself. Overlay fields replace (don't merge) the lists of tauri.conf.json, so
// its resources/capabilities are read and extended. Linux and Windows: also rrweb-fuse (on-demand folders from
// browsing computers; run cargo build in rrweb/fuse first), Linux also a systemd user service for a server without a
// screen (rrweb/linux/rapidraw-web.service) in the .deb/.rpm.
//   node rrweb/bundle/prepare.mjs      (RR_NODE_VERSION=v24.x.y for a fixed version; default: the latest LTS;
//                                      RR_BUNDLE_PLATFORM=darwin-arm64 etc. to test another platform)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = 'rrweb/bundle/bin';
// sidecar name; rrweb/bridge/bridge.ts uses the same. Not "node": the .deb/.rpm install sidecars into /usr/bin
const NODE = '../rrweb/bundle/bin/rrweb-node';
const FUSE = '../rrweb/bundle/bin/rrweb-fuse';
// platform → [rust target triple, Node.js dist file, path of the binary inside the archive]
const TARGETS = {
  'win32-x64': ['x86_64-pc-windows-msvc', 'win-x64/node.exe'],
  'win32-arm64': ['aarch64-pc-windows-msvc', 'win-arm64/node.exe'],
  'darwin-x64': ['x86_64-apple-darwin', 'node-{v}-darwin-x64.tar.gz', 'node-{v}-darwin-x64/bin/node'],
  'darwin-arm64': ['aarch64-apple-darwin', 'node-{v}-darwin-arm64.tar.gz', 'node-{v}-darwin-arm64/bin/node'],
  'linux-x64': ['x86_64-unknown-linux-gnu', 'node-{v}-linux-x64.tar.gz', 'node-{v}-linux-x64/bin/node'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', 'node-{v}-linux-arm64.tar.gz', 'node-{v}-linux-arm64/bin/node'],
};
const platform = process.env.RR_BUNDLE_PLATFORM ?? `${process.platform}-${process.arch}`;
const os = platform.split('-')[0];
if (!TARGETS[platform]) throw new Error(`no all-in-one bundle for ${platform}`);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
};

for (const p of ['rrweb/dist-web/index.html', 'rrweb/relay/node_modules/ws']) {
  if (!existsSync(p)) throw new Error(`${p} is missing: first vite build the web UI and npm install in rrweb/relay`);
}

const version = process.env.RR_NODE_VERSION
  ?? (await (await get('https://nodejs.org/dist/index.json')).json()).find((r) => r.lts).version;
const [triple, distTpl, innerTpl] = TARGETS[platform];
const dist = distTpl.replaceAll('{v}', version);
const exe = `${BIN}/rrweb-node-${triple}${os === 'win32' ? '.exe' : ''}`;
const stamp = `${exe}.version`; // which version/archive is already unpacked

const sums = await (await get(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
const want = sums.split('\n').find((l) => l.trim().endsWith(` ${dist}`))?.split(/\s+/)[0];
if (!want) throw new Error(`SHASUMS256 of ${version} has no ${dist}`);
mkdirSync(BIN, { recursive: true });
if (!existsSync(exe) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== `${dist} ${want}`) {
  const buf = Buffer.from(await (await get(`https://nodejs.org/dist/${version}/${dist}`)).arrayBuffer());
  if (sha256(buf) !== want) throw new Error(`${dist}: SHA256 mismatch`);
  if (!innerTpl) writeFileSync(exe, buf);
  else {
    const tmp = mkdtempSync(join(tmpdir(), 'rrweb-node-'));
    writeFileSync(join(tmp, 'node.tar.gz'), buf);
    const inner = innerTpl.replaceAll('{v}', version);
    execFileSync('tar', ['-xzf', 'node.tar.gz', inner], { cwd: tmp }); // relative: GNU tar reads "C:\…" as a host
    copyFileSync(join(tmp, inner), exe); // not rename: temp may be on another volume
    chmodSync(exe, 0o755);
    rmSync(tmp, { recursive: true, force: true });
  }
  writeFileSync(stamp, `${dist} ${want}`);
}
writeFileSync(`${BIN}/NODE-LICENSE.txt`, await (await get(`https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`)).text());

const withFuse = os === 'linux' || os === 'win32';
if (withFuse) { // the relay looks for it next to its Node binary (rrweb/relay/remote.mjs); Windows: also needs WinFsp
  const ext = os === 'win32' ? '.exe' : '';
  const built = process.env.RR_FUSE_BUILT ?? `rrweb/fuse/target/release/rrweb-fuse${ext}`;
  if (!existsSync(built)) throw new Error(`${built} is missing: first cargo build --release --manifest-path rrweb/fuse/Cargo.toml`);
  copyFileSync(built, `${BIN}/rrweb-fuse-${triple}${ext}`);
  chmodSync(`${BIN}/rrweb-fuse-${triple}${ext}`, 0o755);
}

const up = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const resources = up.bundle?.resources ?? [];
const capabilities = up.app?.security?.capabilities;
if (!Array.isArray(resources) || !Array.isArray(capabilities)) {
  throw new Error('tauri.conf.json: bundle.resources / app.security.capabilities are no longer lists, adapt rrweb/bundle/prepare.mjs');
}
const overlay = {
  bundle: {
    externalBin: [...(up.bundle?.externalBin ?? []), NODE, ...(withFuse ? [FUSE] : [])],
    resources: [...resources, '../rrweb/dist-web', '../rrweb/relay', `../${BIN}/NODE-LICENSE.txt`],
    // macOS: ad-hoc signature (no Apple Developer ID); without any signature Apple Silicon doesn't start the app
    ...(os === 'darwin' ? { macOS: { signingIdentity: '-' } } : {}),
    // Linux: a server without a screen (systemctl --user enable --now rapidraw-web); xvfb for WebKitGTK, fuse3 for on-demand folders
    ...(os === 'linux' ? { linux: {
      deb: { recommends: ['xvfb', 'fuse3'], files: { '/usr/lib/systemd/user/rapidraw-web.service': '../rrweb/linux/rapidraw-web.service' } },
      rpm: { recommends: ['xorg-x11-server-Xvfb', 'fuse3'], files: { '/usr/lib/systemd/user/rapidraw-web.service': '../rrweb/linux/rapidraw-web.service' } },
    } } : {}),
  },
  app: {
    security: {
      capabilities: [...capabilities, {
        identifier: 'rrweb-relay',
        description: 'RapidRAW Web: the bridge starts the bundled relay',
        windows: ['main'],
        permissions: [{
          identifier: 'shell:allow-spawn',
          allow: [{ name: NODE, sidecar: true, args: [{ validator: '.+[\\\\/]relay\\.mjs' }] }],
        }],
      }],
    },
  },
};
writeFileSync('rrweb/bundle/tauri.bundle.json', `${JSON.stringify(overlay, null, 2)}\n`);
console.log(`rrweb: Node.js ${version} (${platform}) → ${exe}, overlay → rrweb/bundle/tauri.bundle.json`);
