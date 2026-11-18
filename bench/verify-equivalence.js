#!/usr/bin/env node
// 等价性门禁：在多视图、多数据集上逐字节比较“空间索引加速”与“暴力基准”的
// 最终采用集（放置/隐藏/逐候选原因）与代价计数。任何差异以非零码退出。
// 与 bench 共用数据生成器，但只做正确性校验，不做计时。

import { readFileSync } from 'node:fs';
import { View } from '../src/projection.js';
import { runLabeling } from '../src/labeler.js';
import { FakeTextMeasurer } from '../test/helpers/fake-measurer.js';
import { denseFeatures, snapshot, median } from './labeling-bench.js';

const measurer = new FakeTextMeasurer();

function loadSample() {
  const parsed = JSON.parse(readFileSync(new URL('../data/sample-features.json', import.meta.url), 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.features;
}

const viewSpecs = [
  { name: '默认', width: 1000, height: 800, scale: 1, rotation: 0, cx: 500, cy: 400 },
  { name: '旋转45°', width: 1000, height: 800, scale: 1, rotation: Math.PI / 4, cx: 500, cy: 400 },
  { name: '放大3×', width: 1000, height: 800, scale: 3, rotation: 0, cx: 500, cy: 400 },
  { name: '缩小0.4×', width: 1000, height: 800, scale: 0.4, rotation: 0, cx: 500, cy: 400 },
  { name: '小视口480×320', width: 480, height: 320, scale: 1, rotation: 0, cx: 500, cy: 400 },
  { name: '视图远离数据', width: 800, height: 600, scale: 1, rotation: 0.35, cx: -3000, cy: 4000 },
];

const datasets = [
  { name: '样例数据', features: loadSample() },
  { name: '密集22×16', features: denseFeatures({ cols: 22, rows: 16, spacing: 22, seed: 7 }) },
  { name: '更密集30×22', features: denseFeatures({ cols: 30, rows: 22, spacing: 16, seed: 11 }) },
];

let checked = 0;
let failures = 0;
let exactSaved = 0;
let exactTotal = 0;

for (const ds of datasets) {
  for (const spec of viewSpecs) {
    const view = new View(spec);
    const fast = runLabeling({ features: ds.features, view, measurer, options: { collisionStrategy: 'spatial-index' } });
    const slow = runLabeling({ features: ds.features, view, measurer, options: { collisionStrategy: 'brute-force' } });
    checked += 1;
    const same = snapshot(fast) === snapshot(slow);
    const countsSame =
      fast.cost.labelCollisions === slow.cost.labelCollisions &&
      fast.cost.markerCollisions === slow.cost.markerCollisions &&
      fast.cost.candidates === slow.cost.candidates;
    exactSaved += slow.cost.exactTests - fast.cost.exactTests;
    exactTotal += slow.cost.exactTests;
    if (!same || !countsSame) {
      failures += 1;
      console.error(`✗ ${ds.name} / ${spec.name}：采用集一致=${same} 碰撞数一致=${countsSame}`);
    }
  }
}

console.log(`等价性门禁：${checked} 个数据集×视图组合，失败 ${failures} 个`);
console.log(`精确相交测试：暴力 ${exactTotal} → 空间索引 ${exactTotal - exactSaved}（减少 ${((exactSaved / Math.max(1, exactTotal)) * 100).toFixed(1)}%）`);
if (failures > 0) process.exit(1);
console.log('✓ 所有组合最终采用集与碰撞数逐字节一致');
