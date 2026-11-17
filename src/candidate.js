// 标签候选位置生成。
// 候选顺序是固定的（Imhof 式优先级），同一要素每次布局都按相同顺序试探，
// 保证选择确定、轻微移动时标签尽量稳定、不会出现帧间随机跳动。

import { Rect } from './geometry.js';

// 点要素：锚点周围的 12 个候选（屏幕方位）。
export const POINT_CANDIDATE_ORDER = [
  'right',
  'above-right',
  'above',
  'above-left',
  'left',
  'below-left',
  'below',
  'below-right',
  'top',
  'bottom',
  'center-right',
  'center-left',
];

// 区域要素：先试居中（锚点处），再向各方向外移。
export const REGION_CANDIDATE_ORDER = [
  'center',
  'right',
  'left',
  'above',
  'below',
  'above-right',
  'below-left',
  'above-left',
  'below-right',
];

export function candidateOffsets(kind, anchor, metrics, gap) {
  const w = metrics.width;
  const h = metrics.height;
  const g = gap;
  const halfW = w / 2;
  const halfH = h / 2;

  if (kind === 'point') {
    // x/y 为候选矩形左上角相对锚点的偏移
    return {
      right: { dx: g, dy: -halfH },
      'above-right': { dx: g, dy: -h - g },
      above: { dx: -halfW, dy: -h - g },
      'above-left': { dx: -w - g, dy: -h - g },
      left: { dx: -w - g, dy: -halfH },
      'below-left': { dx: -w - g, dy: g },
      below: { dx: -halfW, dy: g },
      'below-right': { dx: g, dy: g },
      top: { dx: -halfW, dy: -g - h - anchor.markerRadius },
      bottom: { dx: -halfW, dy: g + anchor.markerRadius },
      'center-right': { dx: g + anchor.markerRadius, dy: -halfH },
      'center-left': { dx: -w - g - anchor.markerRadius, dy: -halfH },
    };
  }

  return {
    center: { dx: -halfW, dy: -halfH },
    right: { dx: halfW + g, dy: -halfH },
    left: { dx: -halfW * 3 - g, dy: -halfH },
    above: { dx: -halfW, dy: -halfH * 3 - g },
    below: { dx: -halfW, dy: halfH + g },
    'above-right': { dx: halfW + g, dy: -halfH * 3 - g },
    'below-left': { dx: -halfW * 3 - g, dy: halfH + g },
    'above-left': { dx: -halfW * 3 - g, dy: -halfH * 3 - g },
    'below-right': { dx: halfW + g, dy: halfH + g },
  };
}

export function buildCandidates(feature, screenAnchor, metrics, options = {}) {
  const gap = options.candidateGap ?? 4;
  const kind = feature.kind;
  const order = kind === 'point' ? POINT_CANDIDATE_ORDER : REGION_CANDIDATE_ORDER;
  const offsets = candidateOffsets(kind, screenAnchor, metrics, gap);

  return order.map((placement) => {
    const off = offsets[placement];
    const rect = new Rect(screenAnchor.x + off.dx, screenAnchor.y + off.dy, metrics.width, metrics.height);
    return {
      featureId: feature.id,
      placement,
      rect,
      metrics,
      // 引线判定：候选中心到锚点的像素距离超过该阈值时绘制引线
      anchorScreen: { x: screenAnchor.x, y: screenAnchor.y },
      needsLeader:
        Math.hypot(rect.cx - screenAnchor.x, rect.cy - screenAnchor.y) >
        metrics.height * 1.6 + (feature.kind === 'point' ? feature.markerRadius : 0),
    };
  });
}
