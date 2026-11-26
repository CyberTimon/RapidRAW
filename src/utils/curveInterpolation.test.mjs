import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
const code = transformSync(readFileSync(new URL('./curveInterpolation.ts', import.meta.url), 'utf8'), {
  loader: 'ts',
  format: 'esm',
}).code;
const { naturalCurveTangents, evaluateNaturalCurve, naturalCurvePath } = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
);

const near = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('two points produce the exact straight line', () => {
  const points = [
    { x: 10, y: 30 },
    { x: 230, y: 140 },
  ];
  const tangents = naturalCurveTangents(points);
  assert.deepEqual(tangents, [0.5, 0.5]);
  near(evaluateNaturalCurve(points, tangents, 120), 85);
});

test('known natural spline through three points has the expected tangents and values', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 0 },
  ];
  const tangents = naturalCurveTangents(points);
  assert.deepEqual(tangents, [1.5, 0, -1.5]);
  near(evaluateNaturalCurve(points, tangents, 0.5), 0.6875);
});

test('nonuniform control points are interpolated with continuous first and second derivatives', () => {
  const points = [
    { x: 0, y: 10 },
    { x: 37, y: 60 },
    { x: 80, y: 61 },
    { x: 150, y: 220 },
    { x: 255, y: 240 },
  ];
  const tangents = naturalCurveTangents(points);
  const h = points.slice(1).map((p, i) => p.x - points[i].x);
  const d = h.map((w, i) => (points[i + 1].y - points[i].y) / w);
  const leftSecond = (i) => (6 * d[i] - 4 * tangents[i] - 2 * tangents[i + 1]) / h[i];
  const rightSecond = (i) => (-6 * d[i] + 2 * tangents[i] + 4 * tangents[i + 1]) / h[i];
  near(leftSecond(0), 0);
  near(rightSecond(h.length - 1), 0);
  for (let i = 1; i < h.length; i++) near(rightSecond(i - 1), leftSecond(i));
  for (const p of points) near(evaluateNaturalCurve(points, tangents, p.x), p.y);
});

test('the displayed path clamps overshoot to the same output range as rendering', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 50, y: 255 },
    { x: 100, y: 255 },
    { x: 255, y: 0 },
  ];
  const tangents = naturalCurveTangents(points);
  assert.ok(evaluateNaturalCurve(points, tangents, 75) > 255);
  const path = naturalCurvePath(points);
  const coords = [...path.matchAll(/[ML] ([\d.]+) ([\d.eE+-]+)/g)];
  assert.ok(coords.length > 500);
  assert.ok(coords.every(([, , y]) => Number(y) >= 0 && Number(y) <= 255));
  assert.ok(coords.some(([, x, y]) => Number(x) === 75 && Number(y) === 0));
});

test('invalid or duplicate x coordinates cannot produce spline tangents', () => {
  assert.equal(naturalCurveTangents([]), null);
  assert.equal(naturalCurveTangents([{ x: 0, y: 0 }]), null);
  assert.equal(
    naturalCurveTangents([
      { x: 1, y: 0 },
      { x: 1, y: 50 },
    ]),
    null,
  );
  assert.equal(
    naturalCurveTangents([
      { x: 0, y: 0 },
      { x: NaN, y: 50 },
    ]),
    null,
  );
});

test('near-diagonal control points can create a strongly non-identity natural spline', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 100, y: 100.49 },
    { x: 100.01, y: 99.52 },
    { x: 255, y: 255 },
  ];
  const tangents = naturalCurveTangents(points);
  assert.ok(points.every((p) => Math.abs(p.x - p.y) < 0.5));
  assert.ok(evaluateNaturalCurve(points, tangents, 50) > 255);
  assert.ok(evaluateNaturalCurve(points, tangents, 150) < 0);
});

test('a saved 17-point spline includes its final knot in the full solution', () => {
  const points = Array.from({ length: 17 }, (_, i) => ({ x: (i * 255) / 16, y: i === 16 ? 240 : i * 8 }));
  const tangents = naturalCurveTangents(points);
  assert.equal(tangents.length, 17);
  for (const p of points) near(evaluateNaturalCurve(points, tangents, p.x), p.y);
  assert.notEqual(tangents[15], naturalCurveTangents(points.slice(0, 16))[15]);
  assert.match(naturalCurvePath(points), /L 255 15$/);
});
