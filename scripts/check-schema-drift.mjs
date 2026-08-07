#!/usr/bin/env node
/**
 * Guards schema/rrdata-v1.schema.json against the TypeScript defaults it describes.
 *
 * The sidecar format is a public integration point: third-party tools read and
 * write .rrdata directly. Nothing in the type system encodes value ranges, so
 * the schema is written by hand, which means it can silently fall behind
 * INITIAL_ADJUSTMENTS. This script fails CI when that happens.
 *
 * Checks:
 *   1. the schema compiles as valid JSON Schema draft-07
 *   2. every key in INITIAL_ADJUSTMENTS is described, and vice versa
 *   3. every key in INITIAL_MASK_ADJUSTMENTS is described, and vice versa
 *   4. the committed examples validate
 *   5. deliberately malformed documents are rejected
 *
 * Usage: node scripts/check-schema-drift.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = join(ROOT, 'schema/rrdata-v1.schema.json');
const ADJUSTMENTS_TS = join(ROOT, 'src/utils/adjustments.ts');
const EXAMPLES_DIR = join(ROOT, 'schema/examples');

const failures = [];
const fail = (msg) => failures.push(msg);

/**
 * Pull the top-level keys out of an exported object literal in adjustments.ts.
 *
 * Deliberately a brace-matching scan rather than a TS parse: the file imports
 * from React component modules, so it cannot simply be imported here, and
 * pulling in a TypeScript parser to read a list of key names would cost more
 * than it protects. Only depth-1 keys are needed.
 */
function topLevelKeysOf(source, exportName) {
  const anchor = new RegExp(`export const ${exportName}\\b[^=]*=\\s*\\{`).exec(source);
  if (!anchor) throw new Error(`could not locate "export const ${exportName}" in adjustments.ts`);

  const open = anchor.index + anchor[0].length - 1;
  let depth = 0;
  let end = -1;
  let inString = null;

  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inString = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`unbalanced braces while scanning ${exportName}`);

  const body = source.slice(open + 1, end);
  const keys = new Set();
  depth = 0;
  inString = null;
  let lineStart = 0;

  for (let i = 0; i <= body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;

    if (i === body.length || ch === ',' || ch === '\n') {
      if (depth === 0) {
        const segment = body.slice(lineStart, i);
        // Unicode-aware: the format contains a genuinely accented key ("centré").
        const m = /^\s*(?:'([^']+)'|"([^"]+)"|([\p{L}_$][\p{L}\p{N}_$]*))\s*:/u.exec(segment);
        if (m) keys.add(m[1] ?? m[2] ?? m[3]);
        lineStart = i + 1;
      }
    }
  }
  return keys;
}

const diff = (label, expected, actual, expectedLabel, actualLabel) => {
  const missing = [...expected].filter((k) => !actual.has(k)).sort();
  const extra = [...actual].filter((k) => !expected.has(k)).sort();
  if (missing.length) {
    fail(`${label}: in ${expectedLabel} but not described in ${actualLabel}:\n    ${missing.join('\n    ')}`);
  }
  if (extra.length) {
    fail(`${label}: described in ${actualLabel} but absent from ${expectedLabel}:\n    ${extra.join('\n    ')}`);
  }
};

// ---------------------------------------------------------------------------

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const ts = readFileSync(ADJUSTMENTS_TS, 'utf8');

const ajv = new Ajv({ allErrors: true, strict: false });
let validate;
try {
  validate = ajv.compile(schema);
} catch (e) {
  console.error(`FAIL  schema does not compile: ${e.message}`);
  process.exit(1);
}

// 2 + 3: key parity against the TypeScript defaults
diff(
  'adjustments',
  topLevelKeysOf(ts, 'INITIAL_ADJUSTMENTS'),
  new Set(Object.keys(schema.definitions.adjustments.properties)),
  'INITIAL_ADJUSTMENTS',
  'schema definitions.adjustments',
);

// Mask adjustments carry an optional "id" that is not part of the defaults object.
const maskDescribed = new Set(Object.keys(schema.definitions.maskAdjustments.properties));
maskDescribed.delete('id');
diff(
  'maskAdjustments',
  topLevelKeysOf(ts, 'INITIAL_MASK_ADJUSTMENTS'),
  maskDescribed,
  'INITIAL_MASK_ADJUSTMENTS',
  'schema definitions.maskAdjustments',
);

// 4: committed examples must validate
for (const name of readdirSync(EXAMPLES_DIR).sort()) {
  if (!name.endsWith('.json')) continue;
  const doc = JSON.parse(readFileSync(join(EXAMPLES_DIR, name), 'utf8'));
  if (!validate(doc)) {
    fail(`example ${name} does not validate:\n    ${ajv.errorsText(validate.errors, { separator: '\n    ' })}`);
  }
}

// 5: the schema must actually reject bad documents, or it is decorative
const mustReject = [
  ['missing version', { rating: 0, adjustments: null }],
  ['wrong version', { version: 2, rating: 0, adjustments: null }],
  ['rating above range', { version: 1, rating: 9, adjustments: null }],
  ['exposure as string', { version: 1, rating: 0, adjustments: { exposure: '1.5' } }],
  ['exposure out of range', { version: 1, rating: 0, adjustments: { exposure: 42 } }],
  ['unknown toneMapper', { version: 1, rating: 0, adjustments: { toneMapper: 'filmic' } }],
  [
    'bad submask mode',
    {
      version: 1,
      rating: 0,
      adjustments: {
        masks: [
          {
            name: 'm',
            visible: true,
            invert: false,
            opacity: 100,
            adjustments: {},
            subMasks: [{ id: 'a', type: 'radial', visible: true, mode: 'sideways', parameters: {} }],
          },
        ],
      },
    },
  ],
];
for (const [label, doc] of mustReject) {
  if (validate(doc)) fail(`schema wrongly accepted an invalid document: ${label}`);
}

// The preservation guarantee: unknown keys must NOT be rejected.
const mustAccept = [
  ['unknown top-level key', { version: 1, rating: 0, adjustments: null, futureThing: 1 }],
  ['unknown adjustment key', { version: 1, rating: 0, adjustments: { myPipelineTag: 'x' } }],
  ['null adjustments', { version: 1, rating: 0, adjustments: null }],
];
for (const [label, doc] of mustAccept) {
  if (!validate(doc)) {
    fail(
      `schema wrongly rejected a valid document (${label}): ` + ajv.errorsText(validate.errors, { separator: '; ' }),
    );
  }
}

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error('Sidecar schema drift check FAILED\n');
  for (const f of failures) console.error(`  - ${f}\n`);
  console.error(
    'If you added or removed an adjustment, update schema/rrdata-v1.schema.json\n' +
      'and docs/sidecar-format.md to match, then re-run this check.\n',
  );
  process.exit(1);
}

console.log('Sidecar schema drift check passed.');
