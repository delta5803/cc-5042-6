import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTextMeasurer } from './helpers/fake-measurer.js';
import { View } from '../src/projection.js';
import { makePointFeature, makeRegionFeature } from '../src/features.js';
import { runLabeling } from '../src/labeler.js';
import { Rect, rectsIntersect } from '../src/geometry.js';
import { RectSpatialIndex } from '../src/spatial-index.js';

const measurer = new FakeTextMeasurer();

// 可复现的伪随机源：仅用于生成测试输入，不进入引擎实现。
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomFeatures(seed, count) {
  const rand = mulberry32(seed);
  const names = ['W', '中央公园 Central Park', '東京タワー', 'i', 'Москва', 'محمية', '长名称标签 Long Label'];
  const features = [];
  for (let i = 0; i < count; i++) {
    if (rand() < 0.85) {
      features.push(
        makePointFeature({
          id: `p${i}`,
          name: names[Math.floor(rand() * names.length)],
          x: (rand() - 0.2) * 1600,
          y: (rand() - 0.2) * 1200,
          priority: Math.floor(rand() * 6),
          fontSize: 10 + Math.floor(rand() * 8),
          markerRadius: 3 + Math.floor(rand() * 5),
        }),
      );
    } else {
      const cx = (rand() - 0.2) * 1400;
      const cy = (rand() - 0.2) * 1000;
      const w = 40 + rand() * 260;
      const h = 40 + rand() * 220;
      features.push(
        makeRegionFeature({
          id: `r${i}`,
          name: names[Math.floor(rand() * names.length)],
          ring: [
            { x: cx, y: cy },
            { x: cx + w, y: cy },
            { x: cx + w, y: cy + h },
            { x: cx, y: cy + h },
          ],
          priority: Math.floor(rand() * 6),
        }),
      );
    }
  }
  return features;
}

// 结果快照：采用集、隐藏及原因、逐候选试探全部纳入，逐字节比较两种策略。
function snapshot(layout) {
  return JSON.stringify({
    ordered: layout.orderedFeatureIds,
    labels: layout.labels.map((l) => [
      l.featureId,
      l.placement,
      l.rect.x,
      l.rect.y,
      l.rect.width,
      l.rect.height,
      l.needsLeader,
      l.outsideRegion,
    ]),
    hidden: layout.hidden.map((h) => [h.featureId, h.primaryReason, h.allReasons, h.trials.map((t) => [t.placement, t.reasons])]),
    trials: [...layout.trials].map(([id, ts]) => [id, ts.map((t) => [t.placement, t.rect.x, t.rect.y, t.reasons, t.outsideRegion])]),
  });
}

const views = [
  new View({ width: 1000, height: 800, scale: 1, rotation: 0, cx: 500, cy: 400 }),
  new View({ width: 1000, height: 800, scale: 2.3, rotation: Math.PI / 4, cx: 420, cy: 360 }),
  new View({ width: 640, height: 480, scale: 0.4, rotation: -0.6, cx: 700, cy: 500 }),
  new View({ width: 480, height: 320, scale: 5, rotation: 1.1, cx: 300, cy: 240 }),
  // 视图中心远离要素群：大量要素在屏幕外，用于验证索引没有按可见区裁剪
  new View({ width: 800, height: 600, scale: 1, rotation: 0.3, cx: -1800, cy: 2500 }),
];

test('空间索引加速与暴力基准在多种视图/数据下最终采用集完全一致', () => {
  for (let seed = 1; seed <= 12; seed++) {
    for (const count of [20, 60, 120]) {
      const features = randomFeatures(seed * 100 + count, count);
      for (const view of views) {
        const fast = runLabeling({
          features,
          view,
          measurer,
          options: { collisionStrategy: 'spatial-index' },
        });
        const slow = runLabeling({
          features,
          view,
          measurer,
          options: { collisionStrategy: 'brute-force' },
        });
        assert.equal(snapshot(fast), snapshot(slow), `策略结果不一致 seed=${seed} count=${count}`);
        // 成本分解应证明筛选确实减少了精确相交测试（宽相位是超集，不是跳检）
        assert.ok(
          fast.cost.exactTests <= slow.cost.exactTests,
          `空间索引精确测试数不应多于暴力基准：${fast.cost.exactTests} vs ${slow.cost.exactTests}`,
        );
        assert.equal(fast.cost.labelCollisions, slow.cost.labelCollisions);
        assert.equal(fast.cost.markerCollisions, slow.cost.markerCollisions);
        assert.equal(fast.cost.candidates, slow.cost.candidates);
      }
    }
  }
});

test('密集场景下空间索引显著减少精确相交测试，且碰撞计数与暴力一致', () => {
  const features = [];
  let k = 0;
  for (let row = 0; row < 14; row++) {
    for (let col = 0; col < 20; col++) {
      features.push(
        makePointFeature({
          id: `d-${k}`,
          name: k % 4 === 0 ? '密集标签 Dense Label' : '点',
          x: 200 + col * 16 + (row % 2) * 4,
          y: 150 + row * 16,
          priority: k % 5,
        }),
      );
      k += 1;
    }
  }
  const view = views[0];
  const fast = runLabeling({ features, view, measurer });
  const slow = runLabeling({ features, view, measurer, options: { collisionStrategy: 'brute-force' } });
  assert.equal(fast.collisionStrategy, 'spatial-index');
  assert.equal(fast.stats.placed, slow.stats.placed);
  assert.ok(fast.stats.placed > 0 && fast.stats.hidden > 0);
  assert.ok(
    fast.cost.exactTests < slow.cost.exactTests,
    `应当减少精确测试：${fast.cost.exactTests} vs ${slow.cost.exactTests}`,
  );
  assert.ok(fast.cost.exactTests < slow.cost.exactTests * 0.6, '密集场景应明显减少无关候选比较');
});

test('索引不按可见区裁剪：屏幕外与跨边缘矩形同样参与精确碰撞', () => {
  const index = new RectSpatialIndex({ cellSize: 32 });
  const outside = new Rect(-5000, -5000, 80, 30);
  const straddling = new Rect(-20, 300, 60, 30);
  index.insert(outside);
  index.insert(straddling);
  // 与画布外左侧矩形真正相交的查询也必须命中
  const probe = new Rect(-4990, -4995, 10, 10);
  const hits = index.search(probe, 0);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rect, outside);
  // 跨边缘矩形在负坐标单元仍可被查到
  assert.equal(index.search(new Rect(-5, 305, 5, 5), 0).length, 1);
  // 远处的无关矩形不命中
  assert.equal(index.search(new Rect(9000, 9000, 5, 5), 0).length, 0);
});

test('索引宽相位是精确相交的安全超集（含 padding 与边界贴合）', () => {
  const rand = mulberry32(2024);
  const index = new RectSpatialIndex({ cellSize: 17 });
  const rects = [];
  for (let i = 0; i < 300; i++) {
    const r = new Rect((rand() - 0.5) * 900, (rand() - 0.5) * 900, 1 + rand() * 120, 1 + rand() * 80);
    rects.push(r);
    index.insert(r);
  }
  for (let i = 0; i < 300; i++) {
    const probe = new Rect((rand() - 0.5) * 900, (rand() - 0.5) * 900, 1 + rand() * 90, 1 + rand() * 70);
    for (const padding of [0, 1, 5]) {
      const broad = new Set(index.query(probe, padding).map((e) => e.rect));
      for (const r of rects) {
        if (rectsIntersect(probe, r, padding)) {
          assert.ok(broad.has(r), `宽相位漏检真实相交矩形（padding=${padding}）`);
        }
      }
      const exact = new Set(index.search(probe, padding).map((e) => e.rect));
      for (const r of rects) {
        assert.equal(exact.has(r), rectsIntersect(probe, r, padding));
      }
    }
  }
});

test('超大矩形（超过单元数阈值）落入 oversized，查询仍精确命中', () => {
  const index = new RectSpatialIndex({ cellSize: 8, maxCellsPerRect: 4 });
  const huge = new Rect(-10000, -10000, 20000, 20000);
  const tiny = new Rect(3, 3, 2, 2);
  index.insert(huge);
  index.insert(tiny);
  const hits = index.search(new Rect(0, 0, 4, 4), 0);
  assert.equal(hits.length, 2);
});
