import assert from 'node:assert/strict';
import test from 'node:test';
import { stepSliderValue } from './sliderArrowKeys';

test('steps slider values in either direction', () => {
  assert.equal(stepSliderValue(0, 1, -100, 100, 1), 1);
  assert.equal(stepSliderValue(0, -1, -100, 100, 1), -1);
});

test('preserves decimal precision and clamps at slider bounds', () => {
  assert.equal(stepSliderValue(0.29, 1, -1, 1, 0.01), 0.3);
  assert.equal(stepSliderValue(1, 1, -1, 1, 0.01), 1);
  assert.equal(stepSliderValue(-1, -1, -1, 1, 0.01), -1);
});
