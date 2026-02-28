import fs from 'node:fs';
import path from 'node:path';

const LOCALES_ROOT = path.join(process.cwd(), 'src', 'i18n', 'locales');
const SOURCE_LOCALE = 'en';
const TARGET_LOCALES = ['fr', 'es', 'zh'];

const PLACEHOLDER_PATTERN = /\{([a-zA-Z_][\w]*)\s*(?:,|\})/g;
const BLOCKED_EMPTY_MARKERS = /^(TODO|TBD|__MISSING__)$/i;

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf-8'));

const flatten = (obj, prefix = '', result = {}) => {
  if (obj === null || obj === undefined) {
    result[prefix] = obj;
    return result;
  }

  if (typeof obj !== 'object' || Array.isArray(obj)) {
    result[prefix] = obj;
    return result;
  }

  for (const [key, value] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    flatten(value, next, result);
  }

  return result;
};

const getPlaceholders = (value) => {
  const set = new Set();
  if (typeof value !== 'string') return set;

  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    set.add(match[1]);
  }

  return set;
};

const samePlaceholderSet = (a, b) => {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
};

const sourceDir = path.join(LOCALES_ROOT, SOURCE_LOCALE);
if (!fs.existsSync(sourceDir)) {
  console.error(`Missing source locale directory: ${sourceDir}`);
  process.exit(1);
}

const namespaceFiles = fs.readdirSync(sourceDir).filter((entry) => entry.endsWith('.json')).sort();
if (namespaceFiles.length === 0) {
  console.error(`No namespace files found in ${sourceDir}`);
  process.exit(1);
}

let hasErrors = false;

for (const locale of TARGET_LOCALES) {
  let missing = 0;
  let empty = 0;
  let typeMismatch = 0;
  let placeholderMismatch = 0;
  let orphan = 0;

  const issues = [];
  const warnings = [];

  for (const namespaceFile of namespaceFiles) {
    const sourcePath = path.join(LOCALES_ROOT, SOURCE_LOCALE, namespaceFile);
    const targetPath = path.join(LOCALES_ROOT, locale, namespaceFile);

    if (!fs.existsSync(targetPath)) {
      hasErrors = true;
      issues.push(`${locale}/${namespaceFile}: missing namespace file`);
      continue;
    }

    const sourceFlat = flatten(readJson(sourcePath));
    const targetFlat = flatten(readJson(targetPath));

    for (const [key, sourceValue] of Object.entries(sourceFlat)) {
      if (!(key in targetFlat)) {
        missing += 1;
        issues.push(`${locale}/${namespaceFile}:${key} missing`);
        continue;
      }

      const targetValue = targetFlat[key];
      const sourceType = sourceValue === null ? 'null' : typeof sourceValue;
      const targetType = targetValue === null ? 'null' : typeof targetValue;

      if (sourceType !== targetType) {
        typeMismatch += 1;
        issues.push(`${locale}/${namespaceFile}:${key} type mismatch (${sourceType} vs ${targetType})`);
        continue;
      }

      if (typeof targetValue === 'string') {
        const trimmed = targetValue.trim();
        if (!trimmed || BLOCKED_EMPTY_MARKERS.test(trimmed)) {
          empty += 1;
          issues.push(`${locale}/${namespaceFile}:${key} empty or placeholder marker`);
          continue;
        }

        const sourcePlaceholders = getPlaceholders(sourceValue);
        const targetPlaceholders = getPlaceholders(targetValue);
        if (!samePlaceholderSet(sourcePlaceholders, targetPlaceholders)) {
          placeholderMismatch += 1;
          issues.push(`${locale}/${namespaceFile}:${key} placeholder mismatch`);
        }
      }
    }

    for (const key of Object.keys(targetFlat)) {
      if (!(key in sourceFlat)) {
        orphan += 1;
        warnings.push(`${locale}/${namespaceFile}:${key} orphan key`);
      }
    }
  }

  const totalSourceKeys = namespaceFiles.reduce((sum, namespaceFile) => {
    const sourcePath = path.join(LOCALES_ROOT, SOURCE_LOCALE, namespaceFile);
    return sum + Object.keys(flatten(readJson(sourcePath))).length;
  }, 0);

  const invalid = missing + empty + typeMismatch + placeholderMismatch;
  const completion = totalSourceKeys === 0 ? 100 : (((totalSourceKeys - invalid) / totalSourceKeys) * 100).toFixed(2);

  if (invalid > 0) hasErrors = true;

  console.log(`\nLocale ${locale}:`);
  console.log(`- completion: ${completion}%`);
  console.log(`- missing: ${missing}, empty: ${empty}, typeMismatch: ${typeMismatch}, placeholderMismatch: ${placeholderMismatch}`);
  console.log(`- orphan warnings: ${orphan}`);

  if (issues.length > 0) {
    console.log('- errors:');
    issues.slice(0, 50).forEach((entry) => console.log(`  - ${entry}`));
  }

  if (warnings.length > 0) {
    console.log('- warnings:');
    warnings.slice(0, 50).forEach((entry) => console.log(`  - ${entry}`));
  }
}

if (hasErrors) {
  console.error('\nTranslation validation failed.');
  process.exit(1);
}

console.log('\nTranslation validation passed.');
