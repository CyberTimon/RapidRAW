import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import i18next from 'i18next';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localeDir = path.resolve(scriptDir, 'locales');
const pluralSuffix = /_(zero|one|two|few|many|other)$/;
const countCandidates = [
  ...Array.from({ length: 201 }, (_, count) => count),
  0.1,
  1.1,
  2.1,
  5.1,
  10.1,
  1_000,
  1_000_000,
];

const flatten = (object, prefix = '', leaves = new Map()) => {
  for (const [key, value] of Object.entries(object)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, fullKey, leaves);
    } else {
      leaves.set(fullKey, value);
    }
  }
  return leaves;
};

const localeFiles = fs
  .readdirSync(localeDir)
  .filter((filename) => filename.endsWith('.json'))
  .sort();
const resources = {};
const pluralKeysByLocale = new Map();
const leavesByLocale = new Map();
const failures = [];

for (const filename of localeFiles) {
  const locale = path.basename(filename, '.json');
  const translations = JSON.parse(fs.readFileSync(path.join(localeDir, filename), 'utf8'));
  const leaves = flatten(translations);
  const pluralKeys = new Set();

  for (const [key, value] of leaves) {
    if (value === '') {
      failures.push(`${locale}:${key} is empty`);
    }
    if (pluralSuffix.test(key)) {
      pluralKeys.add(key.replace(pluralSuffix, ''));
    }
  }

  resources[locale] = { translation: translations };
  pluralKeysByLocale.set(locale, pluralKeys);
  leavesByLocale.set(locale, leaves);
}

const i18n = i18next.createInstance();
await i18n.init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  returnEmptyString: false,
  interpolation: {
    escapeValue: false,
  },
});

let checkedResolutions = 0;

for (const filename of localeFiles) {
  const locale = path.basename(filename, '.json');
  const pluralRules = new Intl.PluralRules(locale);
  const sampleByCategory = new Map();

  for (const count of countCandidates) {
    const category = pluralRules.select(count);
    if (!sampleByCategory.has(category)) {
      sampleByCategory.set(category, count);
    }
  }

  for (const category of pluralRules.resolvedOptions().pluralCategories) {
    if (!sampleByCategory.has(category)) {
      failures.push(`${locale}: no test count found for plural category ${category}`);
    }
  }

  for (const key of pluralKeysByLocale.get(locale)) {
    for (const [category, count] of sampleByCategory) {
      const details = i18n.t(key, { lng: locale, count, returnDetails: true });
      const expectedKey = `${key}_${category}`;
      checkedResolutions += 1;

      if (details.usedLng !== locale) {
        failures.push(`${locale}:${expectedKey} resolved through ${details.usedLng}`);
      }
      if (details.exactUsedKey !== expectedKey) {
        failures.push(`${locale}:${expectedKey} resolved as ${details.exactUsedKey}`);
      }
      if (typeof details.res !== 'string' || details.res.trim() === '') {
        failures.push(`${locale}:${expectedKey} resolved to an empty value`);
      }
    }
  }
}

// Placeholders: a translation must keep every {{variable}} its English source passes. A plural form may
// drop {{count}} only when its category covers nothing but 0 and 1 (Russian `one` also covers 21, 31…).
const variables = (value) =>
  new Set(typeof value === 'string' ? [...value.matchAll(/{{\s*([\w.]+)[^}]*}}/g)].map((m) => m[1]) : []);
const english = leavesByLocale.get('en');
let checkedPlaceholders = 0;

for (const [locale, leaves] of leavesByLocale) {
  if (locale === 'en') continue;
  const pluralRules = new Intl.PluralRules(locale);
  const onlyZeroOrOne = (category) =>
    Array.from({ length: 201 }, (_, n) => n)
      .filter((n) => pluralRules.select(n) === category)
      .every((n) => n <= 1);

  for (const [key, value] of leaves) {
    const match = key.match(pluralSuffix);
    const base = match ? key.replace(pluralSuffix, '') : key;
    // a plural form is checked against English `_other`, which carries every variable the call passes
    const source = match ? (english.get(`${base}_other`) ?? english.get(base)) : english.get(key);
    if (source === undefined) continue;
    checkedPlaceholders += 1;
    const kept = variables(value);
    for (const name of variables(source)) {
      if (kept.has(name)) continue;
      if (name === 'count' && match && onlyZeroOrOne(match[1])) continue;
      failures.push(`${locale}:${key} drops {{${name}}}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`i18n runtime validation failed with ${failures.length} issue(s):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${checkedResolutions} plural resolutions and ${checkedPlaceholders} placeholder sets across ${localeFiles.length} locales.`,
  );
}
