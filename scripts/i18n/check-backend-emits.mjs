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
  'export-error',
  'import-error',
  'panorama-error',
  'hdr-error',
]);

const violations = [];
const EMIT_PATTERN = /emit\(\s*"([^"]+)"\s*,([\s\S]*?)\)\s*;/g;

const walk = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!entry.name.endsWith('.rs')) continue;

    const content = fs.readFileSync(fullPath, 'utf-8');
    for (const match of content.matchAll(EMIT_PATTERN)) {
      const eventName = match[1];
      if (!TARGET_EVENTS.has(eventName)) continue;
      const payload = match[2].trim();
      const hasKeyPayload = /"key"\s*:/.test(payload);

      if (hasKeyPayload) continue;

      const startOffset = match.index ?? 0;
      const lineNumber = content.slice(0, startOffset).split('\n').length;
      const snippet = payload.replace(/\s+/g, ' ').slice(0, 120);
      violations.push(
        `${path.relative(process.cwd(), fullPath)}:${lineNumber} -> '${eventName}' must emit { key, params }, got: ${snippet}`,
      );
    }
  }
};

walk(ROOT);

if (violations.length > 0) {
  console.error('Backend emit check failed:');
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exit(1);
}

console.log('Backend emit check passed.');
