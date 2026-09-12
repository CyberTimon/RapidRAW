import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ADJUSTMENTS, DEFAULT_OPTIONS } from './types';
import { migrateAutoState } from './store';
import { buildAutoWhiteBalanceOptions, prepareAutoApplyOptions, resolveAutoPanelPaths } from './applyOptions';

test('new Auto defaults enable only tone and white balance', () => {
  assert.deepEqual(DEFAULT_ADJUSTMENTS, {
    tone: true,
    whiteBalance: true,
    curves: false,
    presence: false,
    color: false,
    colorGrading: false,
    colorMixer: false,
  });
});

test('v1 settings migrate without losing saved controls or groups', () => {
  const migrated = migrateAutoState({
    enabled: false,
    options: { controls: { strength: 0.75 }, skipEdited: false, groups: { one: { scene: 'night' } } },
  });
  assert.equal(migrated.options.controls.strength, 0.75);
  assert.equal(migrated.options.skipEdited, false);
  assert.equal(migrated.options.groups.one.scene, 'night');
  assert.deepEqual(migrated.options.adjustments, DEFAULT_ADJUSTMENTS);
  assert.equal('enabled' in migrated, false);
});

test('dedicated Auto white balance targets selected photos without touching other families', () => {
  const options = buildAutoWhiteBalanceOptions(DEFAULT_OPTIONS);
  assert.deepEqual(options.adjustments, {
    tone: false,
    whiteBalance: true,
    curves: false,
    presence: false,
    color: false,
    colorGrading: false,
    colorMixer: false,
  });
  assert.equal(options.whiteBalanceIntent, 'neutralize');
  assert.equal(options.skipEdited, false);
  assert.equal(options.controls.consistency, 0);
  assert.deepEqual(options.groups, {});
});

test('an explicit one-photo Auto run never silently skips an edited photo', () => {
  assert.equal(prepareAutoApplyOptions(DEFAULT_OPTIONS, 1).skipEdited, false);
  assert.equal(prepareAutoApplyOptions(DEFAULT_OPTIONS, 2).skipEdited, true);
});

test('editor Auto ignores a retained Library multi-selection', () => {
  assert.deepEqual(resolveAutoPanelPaths('editor', 'open.raw', ['open.raw', 'other.raw'], 'other.raw'), ['open.raw']);
  assert.deepEqual(resolveAutoPanelPaths('library', 'open.raw', ['one.raw', 'two.raw'], 'one.raw'), [
    'one.raw',
    'two.raw',
  ]);
});
