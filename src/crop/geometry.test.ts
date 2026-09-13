import test from 'node:test';
import assert from 'node:assert/strict';
import { HANDLES, angleDelta, constrainRect, resizeRect, withinImage } from './geometry';

for (const ratio of [1, 3 / 2, 2 / 3])
  for (const handle of HANDLES) {
    test(`locked ${ratio} crop resizes from ${handle}`, () => {
      const start = { x: 200, y: 200, width: 180 * ratio, height: 180 };
      const next = resizeRect(start, handle, handle.includes('w') ? -30 : 30, handle.includes('n') ? -20 : 20, ratio);
      assert.ok(Math.abs(next.width / next.height - ratio) < 1e-10);
      assert.notDeepEqual(next, start);
      if (!handle.includes('e') && !handle.includes('w'))
        assert.equal(next.x + next.width / 2, start.x + start.width / 2);
      if (!handle.includes('n') && !handle.includes('s'))
        assert.equal(next.y + next.height / 2, start.y + start.height / 2);
      if (handle.includes('w')) assert.equal(next.x + next.width, start.x + start.width);
      if (handle.includes('n')) assert.equal(next.y + next.height, start.y + start.height);
    });
  }
test('centered resize preserves center', () => {
  const start = { x: 200, y: 200, width: 300, height: 200 };
  for (const handle of HANDLES) {
    const next = resizeRect(start, handle, 20, 30, 1.5, true);
    assert.equal(next.x + next.width / 2, 350);
    assert.equal(next.y + next.height / 2, 300);
  }
});
test('free edges change only their dimension', () => {
  const start = { x: 100, y: 100, width: 300, height: 200 };
  assert.equal(resizeRect(start, 'n', 99, 20, null).width, 300);
  assert.equal(resizeRect(start, 'e', 20, 99, null).height, 200);
});
test('boundary clamping retains ratio at rotated corners', () => {
  for (const rotation of [-45, -20, 0, 20, 45]) {
    const start = { x: 350, y: 250, width: 300, height: 200 };
    const bounds = { width: 1000, height: 700, rotation, minimum: 64 };
    for (const handle of HANDLES) {
      const next = constrainRect(start, resizeRect(start, handle, 3000, -3000, 1.5), bounds);
      assert.ok(withinImage(next, bounds));
      assert.ok(Math.abs(next.width / next.height - 1.5) < 1e-9);
    }
  }
});
test('moving clamps without resizing', () => {
  const start = { x: 100, y: 100, width: 100, height: 100 };
  const next = constrainRect(start, { ...start, x: 9999 }, { width: 400, height: 400, rotation: 0 });
  assert.ok(Math.abs(next.x - 300) < 1e-5);
  assert.equal(next.width, 100);
});
test('rejects empty geometry and unwraps rotation across 180 degrees', () => {
  assert.equal(withinImage({ x: 0, y: 0, width: 0, height: 1 }, { width: 100, height: 100, rotation: 0 }), false);
  assert.equal(angleDelta(179, -179), 2);
  assert.equal(angleDelta(-179, 179), -2);
});
