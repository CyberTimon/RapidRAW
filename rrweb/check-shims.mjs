// Checks that the shims cover every @tauri-apps/* module and every named import in src/, and that the few RapidRAW
// details the web layer relies on are unchanged. Fails (exit 1) with a list of what is missing → RapidRAW started
// using a new Tauri API, or changed something rrweb/ has to follow. Runs at the start of every web build (build.sh).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SHIMS = {
  '@tauri-apps/api/core': 'core', '@tauri-apps/api/event': 'event',
  '@tauri-apps/api/window': 'window', '@tauri-apps/api/path': 'path',
  '@tauri-apps/api/app': 'app', '@tauri-apps/plugin-dialog': 'dialog',
  '@tauri-apps/plugin-os': 'os', '@tauri-apps/plugin-process': 'process',
  '@tauri-apps/plugin-shell': 'shell', '@tauri-apps/plugin-http': 'http',
};
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(f) ? [p] : [];
});
const exportsOf = (mod) => {
  const src = readFileSync(`rrweb/shim/${SHIMS[mod]}.ts`, 'utf8');
  return new Set([...src.matchAll(/export\s+(?:async\s+)?(?:const|function|let|type)\s+(\w+)/g)].map((m) => m[1]));
};

const problems = [];
const re = /import\s+(type\s+)?(?:\{([^}]*)\}|\*\s+as\s+\w+|\w+)\s+from\s*['"](@tauri-apps\/[\w/-]+)['"]/g;
// the UI's own code, and Tauri plugin packages it uses (their JS imports @tauri-apps/* too)
const plugins = existsSync('node_modules') ? readdirSync('node_modules').filter((d) => d.startsWith('tauri-plugin-')).map((d) => join('node_modules', d)) : [];
for (const f of [...walk('src'), ...plugins.flatMap((d) => walk(d).filter((p) => !p.endsWith('.d.ts')))]) {
  for (const m of readFileSync(f, 'utf8').matchAll(re)) {
    const [, isType, names, mod] = m;
    if (!SHIMS[mod]) { problems.push(`${f}: module ${mod} has no shim`); continue; }
    if (isType || !names) continue;
    const have = exportsOf(mod);
    for (const raw of names.split(',')) {
      const n = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
      if (n && !raw.trim().startsWith('type ') && !have.has(n)) problems.push(`${f}: ${mod} → '${n}' is not in rrweb/shim/${SHIMS[mod]}.ts`);
    }
  }
}

const fm = readFileSync('src-tauri/src/file_management.rs', 'utf8');
const ex = readFileSync('src-tauri/src/exif_processing.rs', 'utf8');
const lib = readFileSync('src-tauri/src/lib.rs', 'utf8');
const settings = readFileSync('src-tauri/src/app_settings.rs', 'utf8');
const ui = readFileSync('src/hooks/useThumbnails.ts', 'utf8');
const nav = readFileSync('src/hooks/useAppNavigation.ts', 'utf8');
const slider = readFileSync('src/components/ui/Slider.tsx', 'utf8');
const checks = {
  // rrweb/relay/thumbs.mjs takes over the UI's thumbnail requests and tells light (embedded preview) from heavy ones
  'rrweb/relay/thumbs.mjs': [
    ['the UI asks for thumbnails with update_thumbnail_queue({ paths })', ui.includes("invoke('update_thumbnail_queue', { paths: pathsToSend })")],
    ['get_supported_file_types returns { raw: [extensions] }', /"raw": raw_extensions/.test(fm)],
    ['unedited RAWs use the embedded preview unless always_decode_raw_thumbnails', /if is_raw && adjustments\.is_null\(\) && preloaded_image\.is_none\(\) && !always_decode_raw/.test(fm)
      && settings.includes('pub always_decode_raw_thumbnails: Option<bool>')],
  ],
  // rrweb/relay/exif.mjs lets RapidRAW parse the embedded JPEG's EXIF header saved as a temporary .raf
  'rrweb/relay/exif.mjs': [
    ['the UI reads EXIF with read_exif_for_paths({ paths })', nav.includes('invoke(Invokes.ReadExifForPaths, { paths: chunk })')],
    ['EXIF of a RAW: kamadak-exif (extract_metadata) first, then rawler', /if is_raw_file\(path\)\s*&& let Some\(map\) = extract_metadata\(file_bytes\)/.test(ex)
      && /if !map\.is_empty\(\) \{(?:(?!\n    \}\n)[\s\S]){0,600}?return Some\(map\);\s*\}\s*let metadata = read_raw_metadata\(file_bytes\)\?;/.test(ex)],
  ],
  // rrweb/files/adjust.ts finds the slider by its markup and recognises skipped previews
  'rrweb/files/adjust.ts': [
    ['Slider: <div className="mb-2 group …"> with one <input type="range">', slider.includes('className={`mb-2 group ') && (slider.match(/type="range"/g) ?? []).length === 1],
    ['Slider: label in the first <span>, value in a right-aligned <div> after it', /<span[\s\S]*?\{label\}[\s\S]*?<div className="w-\d+ text-right[\s\S]*?handleValueClick/.test(slider)],
    ['skipped preview: "Superseded or worker failed"', lib.includes('"Superseded or worker failed"')],
  ],
};
for (const [file, list] of Object.entries(checks)) {
  for (const [what, ok] of list) if (!ok) problems.push(`RapidRAW changed (${what}): adapt ${file}`);
}
if (problems.length) { console.error('rrweb shim check FAILED:\n  ' + [...new Set(problems)].join('\n  ')); process.exit(1); }
console.log(`rrweb shim check OK (${Object.keys(SHIMS).length} modules)`);
