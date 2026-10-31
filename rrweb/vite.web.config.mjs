// Browser build: the same RapidRAW UI, with @tauri-apps/* replaced by shims.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));
const pkg = JSON.parse(readFileSync(r('../src-tauri/tauri.conf.json'), 'utf8'));
const shims = {
  '@tauri-apps/api/core': 'core', '@tauri-apps/api/event': 'event',
  '@tauri-apps/api/window': 'window', '@tauri-apps/api/path': 'path',
  '@tauri-apps/api/app': 'app', '@tauri-apps/plugin-dialog': 'dialog',
  '@tauri-apps/plugin-os': 'os', '@tauri-apps/plugin-process': 'process',
  '@tauri-apps/plugin-shell': 'shell', '@tauri-apps/plugin-http': 'http',
};

// The Files tab (rrweb/files) goes into RapidRAW's index.html as an extra script, without touching RapidRAW's code
const filesTab = {
  name: 'rrweb-files-tab',
  transformIndexHtml: {
    order: 'pre',
    handler: () => [{ tag: 'script', attrs: { type: 'module', src: '/rrweb/files/files.ts' }, injectTo: 'body' }],
  },
};

export default defineConfig({
  root: r('..'),
  plugins: [tailwindcss(), react(), filesTab],
  define: {
    __RR_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: Object.entries(shims).map(([m, f]) => ({
      find: new RegExp(`^${m.replace(/[/.]/g, '\\$&')}$`),
      replacement: r(`./shim/${f}.ts`),
    })),
  },
  build: { outDir: r('./dist-web'), emptyOutDir: true },
});
