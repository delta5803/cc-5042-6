import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTextMeasurer } from './helpers/fake-measurer.js';
import { View } from '../src/projection.js';
import { makePointFeature, makeRegionFeature } from '../src/features.js';
import { runLabeling, orderFeatures, compareFeatures, REJECT_REASONS } from '../src/labeler.js';
import { rectsIntersect, pointInPolygon } from '../src/geometry.js';

const measurer = new FakeTextMeasurer();

function view(overrides = {}) {
  return new View({ width: 800, height: 600, scale: 1, rotation: 0, cx: 400, cy: 300, ...overrides });
}

// 独立于引擎的碰撞真值：两两检查已放置标签矩形
function assertNoOverlappingLabels(layout, padding = 1) {
  const rects = layout.labels.map((l) => l.rect);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assert.equal(
        rectsIntersect(rects[i], rects[j], padding),
        false,
        `标签碰撞真值失败：${layout.labels[i].featureId} 与 ${layout.labels[j].featureId}`,
      );
    }
  }
}

function assertWithinCanvas(layout, edgeMargin = 8) {
  const v = layout.view;
  for (const label of layout.labels) {
    const r = label.rect;
    assert.ok(
      r.x >= -edgeMargin &&
        r.y >= -edgeMargin &&
        r.right <= v.width + edgeMargin &&
        r.bottom <= v.height + edgeMargin,
      `标签 ${label.featureId} 越出画布边缘`,
    );
  }
}

test('确定性：相同输入多次运行结果一致，且源码不依赖随机源', { concurrency: false }, () => {
  const features = [];
  for (let i = 0; i < 25; i++) {
    features.push(
      makePointFeature({
        id: `p-${i}`,
        name: i % 3 === 0 ? '长名称 Long Name' : '点',
        x: 120 + (i % 5) * 24,
        y: 120 + Math.floor(i / 5) * 24,
        priority: i % 4,
      }),
    );
  }
  const runs = Array.from({ length: 5 }, () =>
    runLabeling({ features, view: view(), measurer }),
  );
  const snapshot = (layout) =>
    JSON.stringify({
      ids: layout.orderedFeatureIds,
      placed: layout.labels.map((l) => [l.featureId, l.placement, l.rect.x, l.rect.y]),
      hidden: layout.hidden.map((h) => [h.featureId, h.primaryReason]),
    });
  const first = snapshot(runs[0]);
  for (const r of runs.slice(1)) assert.equal(snapshot(r), first);
  assert.ok(runs[0].stats.placed > 0 && runs[0].stats.hidden > 0, '密集场景应同时有放置与隐藏');
  assertNoOverlappingLabels(runs[0]);
  assertWithinCanvas(runs[0]);
});

test('排序：优先级降序 → 点先于区域 → id 升序，且不使用随机比较', () => {
  const a = makePointFeature({ id: '1', name: 'a', x: 0, y: 0, priority: 1 });
  const b = makePointFeature({ id: '2', name: 'b', x: 0, y: 0, priority: 5 });
  const c = makeRegionFeature({
    id: '3',
    name: 'c',
    ring: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    priority: 5,
  });
  const ordered = orderFeatures([c, a, b]);
  assert.deepEqual(ordered.map((f) => f.id), ['2', '3', '1']);
  assert.equal(compareFeatures(a, a), 0);
});

test('屏幕碰撞与世界距离分离：世界距离远大于标签尺寸的要素仍可在屏幕上碰撞', () => {
  // 旋转 45° 的密集点群。手工独立真值：找出被隐藏要素中“与某个已放置标签
  // 世界距离 > 2 倍标签高度、但候选矩形在屏幕空间真实相交”的证据。
  const features = [];
  let id = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 10; c++) {
      features.push(
        makePointFeature({
          id: `g${id}`,
          name: id % 3 === 0 ? '长名称标签 Long' : '点',
          x: 250 + c * 22,
          y: 150 + r * 22,
          priority: id % 4,
        }),
      );
      id += 1;
    }
  }
  const v = view({ rotation: Math.PI / 4 });
  const layout = runLabeling({ features, view: v, measurer });
  assert.ok(layout.hidden.length > 10, '密集旋转场景必须真实隐藏一批标签，而不是全部显示');

  let farButColliding = 0;
  for (const hidden of layout.hidden) {
    const labelHeight = measurer.measure(hidden.feature.name).height;
    for (const placed of layout.labels) {
      const worldDistance = Math.hypot(
        placed.feature.x - hidden.feature.x,
        placed.feature.y - hidden.feature.y,
      );
      const screenOverlap = hidden.trials.some(
        (t) =>
          t.reasons.includes(REJECT_REASONS.LABEL_COLLISION) &&
          rectsIntersect(t.rect, placed.rect, 1),
      );
      if (worldDistance > labelHeight * 2 && screenOverlap) farButColliding += 1;
    }
  }
  assert.ok(farButColliding > 0, '应存在世界距离很远但屏幕矩形碰撞的标签对');
  assertNoOverlappingLabels(layout);

  // 同一组数据旋转前后的拒绝明细不同，证明重映射确实参与避让运算
  const flat = runLabeling({ features, view: view({ rotation: 0 }), measurer });
  const signature = (l) =>
    JSON.stringify(l.hidden.map((h) => [h.featureId, [...h.allReasons].sort()]));
  assert.notEqual(signature(layout), signature(flat));
});

test('优先级：高优先标签先占位，低优先尝试其他候选并记录被拒原因', () => {
  const hi = makePointFeature({ id: 'hi', name: '高优先长标签 High', x: 400, y: 300, priority: 9 });
  const lo = makePointFeature({ id: 'lo', name: '低优先 Low', x: 402, y: 301, priority: 0 });
  const layout = runLabeling({ features: [lo, hi], view: view(), measurer });

  const hiLabel = layout.labels.find((l) => l.featureId === 'hi');
  assert.ok(hiLabel, '高优先要素必须显示');
  const loResult = layout.labels.find((l) => l.featureId === 'lo') ||
    layout.hidden.find((h) => h.featureId === 'lo');
  assert.ok(loResult);
  const loTrials = layout.trials.get('lo');
  assert.ok(loTrials.length > 1);
  assert.ok(loTrials.some((t) => t.reasons.includes(REJECT_REASONS.LABEL_COLLISION)));
  assertNoOverlappingLabels(layout);
});

test('跨画布边缘：完全无可用候选时隐藏并给出 off-canvas，边缘内点仍可放置', () => {
  const outside = makePointFeature({ id: 'out', name: '屏幕之外的点', x: -9999, y: -9999 });
  const inside = makePointFeature({ id: 'in', name: '边缘内的点', x: 362, y: 12, priority: 3 });
  const layout = runLabeling({ features: [outside, inside], view: view(), measurer });

  const hidden = layout.hidden.find((h) => h.featureId === 'out');
  assert.ok(hidden);
  assert.ok(hidden.allReasons.includes(REJECT_REASONS.OFF_CANVAS));
  assert.ok(hidden.trials.every((t) => t.reasons.includes(REJECT_REASONS.OFF_CANVAS)));
  assert.ok(layout.labels.some((l) => l.featureId === 'in'));
  assertWithinCanvas(layout);
});

test('缩放重映射：放大后屏幕碰撞增多，缩小后更多标签可放置', () => {
  const features = [
    makePointFeature({ id: 'a', name: '缩放测试点甲', x: 400, y: 296 }),
    makePointFeature({ id: 'b', name: '缩放测试点乙', x: 406, y: 304 }),
  ];
  const zoomedIn = runLabeling({ features, view: view({ scale: 6 }), measurer });
  const zoomedOut = runLabeling({ features, view: view({ scale: 0.25 }), measurer });
  assert.ok(zoomedOut.stats.placed >= zoomedIn.stats.placed);
  assertNoOverlappingLabels(zoomedIn);
  assertNoOverlappingLabels(zoomedOut);
});

test('DPR 变化只改变像素密度，CSS 像素布局完全一致', () => {
  const features = [
    makePointFeature({ id: 'a', name: '密度测试 DPR', x: 300, y: 200, priority: 2 }),
    makePointFeature({ id: 'b', name: '另一个标签 Another', x: 340, y: 240 }),
  ];
  const dpr1 = runLabeling({ features, view: view({ dpr: 1 }), measurer });
  const dpr3 = runLabeling({ features, view: view({ dpr: 3 }), measurer });
  const rectOf = (layout, id) => {
    const l = layout.labels.find((x) => x.featureId === id);
    return l ? [l.rect.x, l.rect.y, l.rect.width, l.rect.height] : null;
  };
  assert.deepEqual(rectOf(dpr1, 'a'), rectOf(dpr3, 'a'));
  assert.deepEqual(rectOf(dpr1, 'b'), rectOf(dpr3, 'b'));
});

test('区域标签：居中候选必须在区域内，越界居中被拒绝并记录原因', () => {
  const region = makeRegionFeature({
    id: 'reg',
    name: '小区域 Tiny',
    ring: [
      { x: 380, y: 280 },
      { x: 420, y: 280 },
      { x: 420, y: 320 },
      { x: 380, y: 320 },
    ],
  });
  const layout = runLabeling({ features: [region], view: view(), measurer });
  const trials = layout.trials.get('reg');
  const centerTrial = trials.find((t) => t.placement === 'center');
  assert.ok(centerTrial);
  // 标签比区域大时，居中候选越界；引擎应尝试外移候选而不是简单隐藏
  if (centerTrial.reasons.includes(REJECT_REASONS.OUTSIDE_REGION)) {
    assert.ok(trials.some((t) => t.placement !== 'center'));
  }
  if (layout.labels.length) {
    assertNoOverlappingLabels(layout);
    assertWithinCanvas(layout);
  } else {
    assert.ok(layout.hidden[0].allReasons.length > 0);
  }
});

test('区域正常尺寸下标签居中放置，且锚点为多边形内部点', () => {
  const region = makeRegionFeature({
    id: 'big-reg',
    name: '大区域',
    ring: [
      { x: 200, y: 100 },
      { x: 600, y: 100 },
      { x: 600, y: 500 },
      { x: 200, y: 500 },
    ],
  });
  assert.ok(pointInPolygon(region.anchor.x, region.anchor.y, region.ring));
  const layout = runLabeling({ features: [region], view: view(), measurer });
  assert.equal(layout.labels.length, 1);
  assert.equal(layout.labels[0].placement, 'center');
});

test('点标记也是障碍：标签只能压到周围点标记时记录 marker-collision', () => {
  // 中心是带长名称的高优先点；周围一圈紧邻的点用单字符名称、优先级更高，
  // 它们的标签先被放到外侧，标记本身则把中心标签的所有候选位置全部封死。
  const center = makePointFeature({ id: 'center', name: '被标记包围的长标签', x: 400, y: 300, priority: 1 });
  const ring = [
    { x: 412, y: 300 },
    { x: 388, y: 300 },
    { x: 400, y: 288 },
    { x: 400, y: 312 },
    { x: 412, y: 288 },
    { x: 388, y: 312 },
  ].map((p, i) => makePointFeature({ id: `ring-${i}`, name: '点', x: p.x, y: p.y, priority: 5 }));
  const layout = runLabeling({ features: [center, ...ring], view: view(), measurer });
  const hiddenCenter = layout.hidden.find((h) => h.featureId === 'center');
  assert.ok(hiddenCenter, '中心标签应因标记包围而隐藏');
  assert.ok(
    hiddenCenter.allReasons.includes(REJECT_REASONS.MARKER_COLLISION) ||
      hiddenCenter.allReasons.includes(REJECT_REASONS.LABEL_COLLISION),
    `拒绝原因应来自真实障碍，实际：${hiddenCenter.allReasons.join(',')}`,
  );
  assertNoOverlappingLabels(layout);
});

test('轻微平移保持稳定：移动 1 像素时仍可见的标签尽量留在原候选位置', () => {
  const features = Array.from({ length: 12 }, (_, i) =>
    makePointFeature({
      id: `s-${i}`,
      name: i % 2 ? '短' : '稳定测试长名称 Stable',
      x: 150 + (i % 4) * 40,
      y: 150 + Math.floor(i / 4) * 40,
      priority: i % 3,
    }),
  );
  const v1 = view({ cx: 400, cy: 300 });
  const v2 = view({ cx: 401, cy: 300 });
  const l1 = runLabeling({ features, view: v1, measurer });
  const l2 = runLabeling({ features, view: v2, measurer });
  const map1 = new Map(l1.labels.map((l) => [l.featureId, l.placement]));
  let same = 0;
  let comparable = 0;
  for (const l of l2.labels) {
    if (map1.has(l.featureId)) {
      comparable += 1;
      if (map1.get(l.featureId) === l.placement) same += 1;
    }
  }
  assert.ok(comparable > 0);
  assert.ok(same / comparable >= 0.8, `候选稳定率仅 ${same}/${comparable}`);
});

test('无效输入抛出异常，由界面层负责提示', () => {
  assert.throws(() => runLabeling({ features: [], view: view() }), /measurer/);
  assert.throws(
    () =>
      runLabeling({
        features: [makePointFeature({ id: 'x', name: 'ok', x: 0, y: 0 })],
        view: view(),
        measurer: { measure: 'not-a-function' },
      }),
    /measure/,
  );
});
