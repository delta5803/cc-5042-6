#!/usr/bin/env node
// 标注搜索基准：在“密集标签 + 慢速平移”负载下，对比碰撞候选加速（空间索引）
// 与暴力基准（保留的旧路径）的碰撞数与布局耗时。
//
// 基准不是用默认值遮掩差异：所有参数都有显式值并打印，且每一步都校验两种策略的
// 最终采用集（放置/隐藏/逐候选原因）逐字节一致；若不一致，基准以非零码失败。
// 计时只作参考：同进程内先各跑预热，再交替取样，报告去掉首轮后的中位/均值。

import { View } from '../src/projection.js';
import { makePointFeature, makeRegionFeature } from '../src/features.js';
import { runLabeling } from '../src/labeler.js';

const measurer = makeTestMeasurer();

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

function makeTestMeasurer() {
  const FULLWIDTH = [
    [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
    [0x4e00, 0x9fff], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f],
    [0xff00, 0xff60], [0xffe0, 0xffe6],
  ];
  const ARABIC = [[0x0600, 0x06ff], [0x0750, 0x077f], [0xfb50, 0xfdff], [0xfe70, 0xfeff]];
  const GREEK_CYR = [[0x0370, 0x03ff], [0x0400, 0x04ff]];
  const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
  const advance = (ch) => {
    const cp = ch.codePointAt(0);
    if (inRanges(cp, FULLWIDTH)) return 1.0;
    if ('WIwMm'.includes(ch)) return 0.78;
    if ("iljt .,'’!:;|".includes(ch)) return 0.32;
    if (inRanges(cp, ARABIC)) return 0.62;
    if (inRanges(cp, GREEK_CYR)) return 0.6;
    return 0.56;
  };
  return {
    measure(text, options = {}) {
      const fontSize = options.fontSize ?? 13;
      const glyphWidth = [...String(text)].reduce((s, ch) => s + advance(ch), 0) * fontSize;
      const ascent = fontSize * 0.8;
      const descent = fontSize * 0.22;
      const paddingX = 5;
      const paddingY = 2;
      const halo = 2.5;
      return {
        font: `600 ${fontSize}px test-sans`,
        fontSize,
        fontWeight: 600,
        glyphWidth,
        glyphHeight: ascent + descent,
        ascent,
        descent,
        paddingX,
        paddingY,
        halo,
        width: glyphWidth + 2 * paddingX + 2 * halo,
        height: ascent + descent + 2 * paddingY + 2 * halo,
        textOffsetX: paddingX + halo,
        textOffsetY: paddingY + halo + ascent,
      };
    },
    clearCache() {},
  };
}

// 密集标签数据：cols×rows 近距点阵，名称长短/文字体系混合，为保证碰撞提供密集负载。
export function denseFeatures({ cols, rows, spacing, seed, origin = { x: 200, y: 150 } }) {
  const rand = mulberry32(seed);
  const names = [
    'W', '中央公园 Central Park', '故宫博物院', '東京タワー', 'Москва',
    'محمية طبيعية', '一个非常长的中文地名标签', 'San Francisco', '서울특별시', 'i',
    'København', 'القاهرة', 'São Paulo dos Campos', '日月潭', 'Ακρόπολη Αθηνών',
  ];
  const features = [];
  let k = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      features.push(
        makePointFeature({
          id: `d-${k}`,
          name: names[k % names.length],
          x: origin.x + col * spacing + (row % 2) * (spacing * 0.25),
          y: origin.y + row * spacing,
          priority: Math.floor(rand() * 5),
          fontSize: 11 + Math.floor(rand() * 5),
        }),
      );
      k += 1;
    }
  }
  return features;
}

// 慢速平移序列：每步平移 1 CSS 像素对应的世界位移，模拟拖拽时的连续重排。
export function panViews({ base, steps, dxPerStep, dyPerStep, scale = 1, rotation = 0 }) {
  const views = [];
  for (let i = 0; i < steps; i++) {
    views.push(
      new View({
        width: base.width,
        height: base.height,
        scale,
        rotation,
        cx: base.cx + (i * dxPerStep) / scale,
        cy: base.cy + (i * dyPerStep) / scale,
      }),
    );
  }
  return views;
}

export function snapshot(layout) {
  return JSON.stringify({
    ordered: layout.orderedFeatureIds,
    labels: layout.labels.map((l) => [l.featureId, l.placement, l.rect.x, l.rect.y, l.needsLeader, l.outsideRegion]),
    hidden: layout.hidden.map((h) => [h.featureId, h.primaryReason, h.allReasons]),
    trials: [...layout.trials].map(([id, ts]) => [id, ts.map((t) => [t.placement, t.reasons])]),
  });
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function runScenario({ name, features, views, warmups = 3, iterations = 12 }) {
  const strategies = ['spatial-index', 'brute-force'];
  const times = { 'spatial-index': [], 'brute-force': [] };
  const costs = { 'spatial-index': null, 'brute-force': null };
  let collisions = { 'spatial-index': 0, 'brute-force': 0 };

  // 预热（不取样），并校验两策略逐视图一致。
  for (let w = 0; w < warmups; w++) {
    for (const view of views) {
      const a = runLabeling({ features, view, measurer, options: { collisionStrategy: 'spatial-index' } });
      const b = runLabeling({ features, view, measurer, options: { collisionStrategy: 'brute-force' } });
      if (snapshot(a) !== snapshot(b)) {
        throw new Error(`基准一致性失败（${name}）：两种策略最终采用集不一致`);
      }
    }
  }

  // 交替取样，避免 JIT/GC 偏向某一策略。
  for (let it = 0; it < iterations; it++) {
    for (const view of views) {
      for (const strategy of strategies) {
        const t0 = performance.now();
        const layout = runLabeling({ features, view, measurer, options: { collisionStrategy: strategy } });
        const dt = performance.now() - t0;
        times[strategy].push(dt);
        costs[strategy] = layout.cost;
        collisions[strategy] += layout.cost.labelCollisions + layout.cost.markerCollisions;
      }
    }
  }

  const result = {};
  for (const strategy of strategies) {
    result[strategy] = {
      medianMsPerLayout: median(times[strategy]),
      meanMsPerLayout: mean(times[strategy]),
      samples: times[strategy].length,
      exactTests: costs[strategy].exactTests,
      broadPhaseHits: costs[strategy].broadPhaseHits,
      candidates: costs[strategy].candidates,
      collisions: collisions[strategy],
      labelCollisions: costs[strategy].labelCollisions,
      markerCollisions: costs[strategy].markerCollisions,
    };
  }

  // 采用集与碰撞数必须与策略无关（碰撞数是同一判定的计数）。
  if (collisions['spatial-index'] !== collisions['brute-force']) {
    throw new Error(`基准碰撞数不一致（${name}）：${collisions['spatial-index']} vs ${collisions['brute-force']}`);
  }

  return { name, features: features.length, views: views.length, result };
}

export function formatScenario(sc) {
  const fast = sc.result['spatial-index'];
  const slow = sc.result['brute-force'];
  const speedup = fast.medianMsPerLayout > 0 ? slow.medianMsPerLayout / fast.medianMsPerLayout : 0;
  const testReduction = slow.exactTests > 0 ? 1 - fast.exactTests / slow.exactTests : 0;
  return [
    `## ${sc.name}`,
    `要素 ${sc.features} · 视图采样 ${sc.views} 个/轮 · 每策略样本 ${fast.samples}`,
    `距离策略      每帧中位(ms)  每帧均值(ms)  布局耗时中位(ms)  精确测试  宽相位命中  碰撞数(标签+标记)`,
    `空间索引      ${fast.medianMsPerLayout.toFixed(3).padStart(12)}  ${fast.meanMsPerLayout.toFixed(3).padStart(12)}  ${fast.medianMsPerLayout.toFixed(3).padStart(16)}  ${String(fast.exactTests).padStart(8)}  ${String(fast.broadPhaseHits).padStart(10)}  ${fast.labelCollisions}+${fast.markerCollisions}`,
    `暴力基准      ${slow.medianMsPerLayout.toFixed(3).padStart(12)}  ${slow.meanMsPerLayout.toFixed(3).padStart(12)}  ${slow.medianMsPerLayout.toFixed(3).padStart(16)}  ${String(slow.exactTests).padStart(8)}  ${String(slow.broadPhaseHits).padStart(10)}  ${slow.labelCollisions}+${slow.markerCollisions}`,
    `加速比 ${speedup.toFixed(2)}× · 精确相交测试减少 ${(testReduction * 100).toFixed(1)}% · 碰撞数一致 ${fast.collisions === slow.collisions ? '是' : '否'}`,
  ].join('\n');
}

async function main() {
  const scenarios = [];

  const grid = denseFeatures({ cols: 22, rows: 16, spacing: 22, seed: 7 });
  const pan = panViews({ base: { width: 1000, height: 800, cx: 500, cy: 400 }, steps: 24, dxPerStep: 1, dyPerStep: 0.5 });
  scenarios.push(
    runScenario({ name: '密集网格 22×16 · 慢速平移 24 步', features: grid, views: pan }),
  );

  const denser = denseFeatures({ cols: 30, rows: 22, spacing: 16, seed: 11 });
  const pan2 = panViews({ base: { width: 1200, height: 900, cx: 600, cy: 450 }, steps: 18, dxPerStep: 1, dyPerStep: 1 });
  scenarios.push(
    runScenario({ name: '更密集 30×22 · 慢速平移 18 步', features: denser, views: pan2 }),
  );

  // 区域 + 点的混合负载
  const mixed = [
    ...denseFeatures({ cols: 18, rows: 12, spacing: 24, seed: 3 }),
  ];
  let rid = 0;
  for (let i = 0; i < 6; i++) {
    const cx = 260 + i * 130;
    const cy = 220 + (i % 3) * 160;
    mixed.push(
      makeRegionFeature({
        id: `reg-${rid++}`,
        name: '混合区域 Mixed Region',
        ring: [
          { x: cx, y: cy },
          { x: cx + 200, y: cy },
          { x: cx + 210, y: cy + 120 },
          { x: cx + 40, y: cy + 150 },
        ],
        priority: 2,
        fontSize: 13,
      }),
    );
  }
  const mixedViews = panViews({ base: { width: 1000, height: 800, cx: 500, cy: 400 }, steps: 20, dxPerStep: 0.8, dyPerStep: 0.6, scale: 1.3, rotation: Math.PI / 6 });
  scenarios.push(runScenario({ name: '点+区域混合 · 旋转 30° 慢速平移', features: mixed, views: mixedViews }));

  console.log('=== 标注搜索基准（碰撞候选加速 vs 保留的暴力基准）===');
  console.log('说明：耗时仅作同机参照；所有场景均先校验两策略最终采用集逐字节一致，再比较耗时与碰撞数。');
  console.log('');
  for (const sc of scenarios) {
    console.log(formatScenario(sc));
    console.log('');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`基准失败：${err.message}`);
    process.exit(1);
  });
}
