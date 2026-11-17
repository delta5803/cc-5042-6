import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Rect,
  rectsIntersect,
  pointInPolygon,
  poleOfInaccessibility,
  polygonCentroid,
  distanceToSegment,
} from '../src/geometry.js';
import { View, worldToScreen, screenToWorld } from '../src/projection.js';

test('Rect 相交与包含判定', () => {
  const a = new Rect(0, 0, 10, 10);
  const b = new Rect(5, 5, 10, 10);
  const c = new Rect(20, 20, 4, 4);
  assert.equal(rectsIntersect(a, b), true);
  assert.equal(rectsIntersect(a, c), false);
  assert.equal(a.contains(5, 5), true);
  assert.equal(a.contains(11, 5), false);
  assert.equal(rectsIntersect(a, c, 12), true);
});

test('pointInPolygon 射线法区分内外', () => {
  const ring = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  assert.equal(pointInPolygon(5, 5, ring), true);
  assert.equal(pointInPolygon(-1, 5, ring), false);
  assert.equal(pointInPolygon(11, 11, ring), false);
});

test('poleOfInaccessibility 返回多边形内部且比质心离边更远或相等', () => {
  const ring = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 60 },
    { x: 0, y: 60 },
  ];
  const pole = poleOfInaccessibility(ring, { grid: 32 });
  assert.equal(pointInPolygon(pole.x, pole.y, ring), true);
  assert.equal(pole.fellBack, false);
  const centroid = polygonCentroid(ring);
  assert.ok(Math.abs(centroid.x - 50) < 1e-9 && Math.abs(centroid.y - 30) < 1e-9);
  // 退化多边形回退质心
  const flat = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 5, y: 0 },
  ];
  const fb = poleOfInaccessibility(flat);
  assert.equal(fb.fellBack, true);
});

test('distanceToSegment 计算点到线段最近距离', () => {
  assert.ok(Math.abs(distanceToSegment(0, 5, 0, 0, 10, 0) - 5) < 1e-9);
  assert.ok(Math.abs(distanceToSegment(-4, 0, 0, 0, 10, 0) - 4) < 1e-9);
});

test('worldToScreen 与 screenToWorld 互逆（含旋转）', () => {
  const view = new View({ width: 800, height: 600, scale: 2.5, rotation: 0.7, cx: 30, cy: -12 });
  const world = { x: 123.4, y: -56.7 };
  const screen = worldToScreen(view, world);
  const back = screenToWorld(view, screen);
  assert.ok(Math.abs(back.x - world.x) < 1e-9);
  assert.ok(Math.abs(back.y - world.y) < 1e-9);
});

test('无旋转时世界距离与屏幕距离按 scale 线性对应', () => {
  const view = new View({ width: 400, height: 400, scale: 2 });
  const a = worldToScreen(view, { x: 0, y: 0 });
  const b = worldToScreen(view, { x: 10, y: 0 });
  assert.ok(Math.abs((b.x - a.x) - 20) < 1e-9);
});
