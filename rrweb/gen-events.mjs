// Extracts every event name the frontend listens to → the bridge forwards them. Runs on every bridge build.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(f) ? [p] : [];
});
const names = new Set();
for (const f of walk('src'))
  for (const m of readFileSync(f, 'utf8').matchAll(/listen(?:<[^>]*>)?\(\s*['"`]([\w:-]+)['"`]/g)) names.add(m[1]);
const list = [...names].sort();
writeFileSync('rrweb/bridge/events.ts', `export const EVENTS = ${JSON.stringify(list, null, 2)};\n`);
console.log(`rrweb: ${list.length} events`);
