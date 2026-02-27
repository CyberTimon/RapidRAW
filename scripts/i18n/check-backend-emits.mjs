import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'src-tauri', 'src');
const TARGET_EVENTS = new Set([
  'denoise-progress',
  'panorama-progress',
  'panorama-warning',
  'hdr-progress',
  'ai-model-download-start',
  'ai-model-download-finish',
]);

const violations = [];

const walk = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!entry.name.endsWith('.rs')) continue;

    const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
    lines.forEach((line, index) => {
      const match = line.match(/emit\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\)/);
      if (!match) return;

      const eventName = match[1];
      if (!TARGET_EVENTS.has(eventName)) return;

      violations.push(`${path.relative(process.cwd(), fullPath)}:${index + 1} -> raw text emit for '${eventName}'`);
    });
  }
};

walk(ROOT);

if (violations.length > 0) {
  console.error('Backend emit check failed:');
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exit(1);
}

console.log('Backend emit check passed.');
