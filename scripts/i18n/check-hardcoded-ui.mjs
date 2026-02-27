import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'src');
const OUTPUT_LIMIT = 200;

const FILE_EXCLUDES = [
  /\.d\.tsx?$/,
  /\/i18n\//,
];

const VALUE_ALLOWLIST = new Set([
  'RapidRAW',
  'GitHub',
  'Ko-Fi',
  'RAW',
  'EXIF',
  'XMP',
  'ISO',
  'GPU',
  'CPU',
  'AI',
  'VC',
  'JPEG',
  'PNG',
  'TIFF',
  'Vulkan',
  'OpenGL',
  'Metal',
  'DirectX 12',
  'Auto',
]);

const VALUE_ALLOWLIST_REGEX = [
  /^https?:\/\//,
  /^[\w.-]+\/[\w./-]+$/,
  /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/i,
  /^\{[\w_]+\}$/,
  /^v\d+(\.\d+)*$/i,
];

// Conservative: only capture same-line explicit JSX text nodes.
const JSX_TEXT_PATTERN = /<[^\n>]*>\s*([^<>{}\n]+?)\s*<\/[^\n>]+>/g;
const JSX_PROP_PATTERN = /\b(data-tooltip|placeholder|aria-label|title|alt)\s*=\s*(["'])(.*?)\2/g;
const OBJECT_COPY_PATTERN = /\b(label|title|description|buttonText|confirmText|message)\s*:\s*(["'])(.*?)\2/g;

const hasLetters = (value) => /[A-Za-z]/.test(value);

const isAllowedValue = (raw) => {
  const value = raw.trim();
  if (!value) return true;
  if (!hasLetters(value)) return true;
  if (VALUE_ALLOWLIST.has(value)) return true;
  return VALUE_ALLOWLIST_REGEX.some((re) => re.test(value));
};

const shouldSkipFile = (filePath) => FILE_EXCLUDES.some((re) => re.test(filePath));

const lineFromIndex = (content, index) => content.slice(0, index).split('\n').length;

const allTsxFiles = [];
const walk = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!entry.name.endsWith('.tsx')) continue;
    allTsxFiles.push(fullPath);
  }
};

if (!fs.existsSync(ROOT)) {
  console.error(`Missing source directory: ${ROOT}`);
  process.exit(1);
}

walk(ROOT);

const violations = [];

for (const filePath of allTsxFiles) {
  const rel = path.relative(process.cwd(), filePath);
  if (shouldSkipFile(rel)) continue;

  const content = fs.readFileSync(filePath, 'utf-8');

  for (const match of content.matchAll(JSX_TEXT_PATTERN)) {
    const text = (match[1] ?? '').replace(/\s+/g, ' ').trim();
    if (!text || isAllowedValue(text)) continue;

    const start = match.index ?? 0;
    violations.push({
      file: rel,
      line: lineFromIndex(content, start),
      kind: 'jsx-text',
      value: text,
    });
  }

  for (const match of content.matchAll(JSX_PROP_PATTERN)) {
    const propName = match[1];
    const value = (match[3] ?? '').replace(/\s+/g, ' ').trim();
    if (!value || isAllowedValue(value)) continue;

    const start = match.index ?? 0;
    violations.push({
      file: rel,
      line: lineFromIndex(content, start),
      kind: `jsx-prop:${propName}`,
      value,
    });
  }

  for (const match of content.matchAll(OBJECT_COPY_PATTERN)) {
    const key = match[1];
    const value = (match[3] ?? '').replace(/\s+/g, ' ').trim();
    if (!value || isAllowedValue(value)) continue;

    const start = match.index ?? 0;
    violations.push({
      file: rel,
      line: lineFromIndex(content, start),
      kind: `object-prop:${key}`,
      value,
    });
  }
}

if (violations.length > 0) {
  console.error(`Hardcoded UI check failed: ${violations.length} potential hardcoded strings found.`);
  violations
    .slice(0, OUTPUT_LIMIT)
    .forEach((v) => console.error(`- ${v.file}:${v.line} [${v.kind}] ${v.value}`));

  if (violations.length > OUTPUT_LIMIT) {
    console.error(`... ${violations.length - OUTPUT_LIMIT} more not shown.`);
  }

  process.exit(1);
}

console.log(`Hardcoded UI check passed across ${allTsxFiles.length} TSX files.`);
