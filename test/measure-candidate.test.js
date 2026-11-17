import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeTextMeasurer } from './helpers/fake-measurer.js';
import { CanvasTextMeasurer } from '../src/text-measure.js';
import { buildCandidates, POINT_CANDIDATE_ORDER, REGION_CANDIDATE_ORDER } from '../src/candidate.js';
import { makePointFeature, makeRegionFeature } from '../src/features.js';

test('FakeTextMeasurer：同字符数不同文字体系宽度不同，拒绝固定字宽假设', () => {
  const m = new FakeTextMeasurer();
  const narrow = m.measure('iiii').glyphWidth;
  const wide = m.measure('WWWW').glyphWidth;
  assert.ok(wide > narrow * 1.8, 'W 应明显宽于 i');

  const cjk = m.measure('四个汉字').glyphWidth;
  const latin = m.measure('abcd').glyphWidth;
  assert.ok(cjk > latin * 1.3, '全角 CJK 应显著宽于同字符数普通拉丁');

  const arabic = m.measure('مرحبا').glyphWidth;
  assert.ok(arabic > 0);
  // 标签盒子包含内边距与光晕，而不只是字形宽度
  const box = m.measure('abcd');
  assert.ok(box.width > box.glyphWidth);
  assert.ok(box.height > box.glyphHeight);
});

test('长名称的度量宽度随真实字形逐字累加，任何单字符都没有统一固定宽度', () => {
  const m = new FakeTextMeasurer();
  // 若实现是“字符数 × 固定宽度”，同字符数的字符串宽度必然相等；这里逐对证伪
  const pairs = [
    ['iiii', 'WWWW'],
    ['四个汉字', 'abcd'],
    ['Mill', 'illi'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(a.length, b.length);
    assert.notEqual(
      m.measure(a).glyphWidth,
      m.measure(b).glyphWidth,
      `${a} 与 ${b} 字符数相同但实际字形宽度必须不同`,
    );
  }
  // 长混合名称宽度 = 各字形推进量之和，可独立复算
  const name = '中央公园 Central Park';
  const expected = [...name].reduce((sum, ch) => sum + m.glyphAdvance(ch), 0) * 13;
  assert.ok(Math.abs(m.measure(name).glyphWidth - expected) < 1e-9);
});

test('CanvasTextMeasurer 通过 canvas measureText 的真实包围盒取边界', () => {
  const calls = [];
  const fakeCtx = {
    font: '',
    measureText(text) {
      calls.push(text);
      return {
        width: 100,
        actualBoundingBoxLeft: 4,
        actualBoundingBoxRight: 90,
        actualBoundingBoxAscent: 11,
        actualBoundingBoxDescent: 3,
      };
    },
  };
  const measurer = new CanvasTextMeasurer({ getContext: () => fakeCtx });
  const metrics = measurer.measure('真实布局', { fontSize: 14, paddingX: 5, paddingY: 2, halo: 2 });
  assert.deepEqual(calls, ['真实布局']);
  assert.equal(metrics.glyphWidth, 94); // actualLeft + actualRight
  assert.equal(metrics.glyphHeight, 14);
  assert.equal(metrics.width, 94 + 10 + 4);
  assert.equal(metrics.textOffsetY, 2 + 2 + 11);
  // 带缓存：第二次不重复调用 measureText
  measurer.measure('真实布局', { fontSize: 14, paddingX: 5, paddingY: 2, halo: 2 });
  assert.equal(calls.length, 1);
});

test('buildCandidates 候选顺序固定且矩形与度量边界一致', () => {
  const m = new FakeTextMeasurer();
  const feature = makePointFeature({ id: 'p1', name: '站点', x: 0, y: 0 });
  const metrics = m.measure(feature.name, { fontSize: feature.fontSize });
  const candidates = buildCandidates(feature, { x: 200, y: 200 }, metrics, { candidateGap: 4 });
  assert.deepEqual(candidates.map((c) => c.placement), POINT_CANDIDATE_ORDER);
  for (const c of candidates) {
    assert.equal(c.rect.width, metrics.width);
    assert.equal(c.rect.height, metrics.height);
  }

  const region = makeRegionFeature({
    id: 'r1',
    name: '区域',
    ring: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
  });
  const rc = buildCandidates(region, { x: 50, y: 50 }, m.measure(region.name), {});
  assert.deepEqual(rc.map((c) => c.placement), REGION_CANDIDATE_ORDER);
  const center = rc.find((c) => c.placement === 'center');
  assert.ok(Math.abs(center.rect.cx - 50) < 1e-9 && Math.abs(center.rect.cy - 50) < 1e-9);
});
