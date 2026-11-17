// 标注避让引擎核心。
// 设计要点（对应需求约束）：
// 1. 选择顺序完全确定：优先级降序、点先于区域、id 字典序兜底，任何一帧都不会随机重排；
// 2. 碰撞在屏幕空间（CSS 像素）用真实字形矩形做 AABB 判定，与世界空间距离是两套概念——
//    两个地理上相距很远的要素，旋转/缩放后屏幕上可能重叠，照样拒绝；
// 3. 每个被拒候选记录具体拒绝原因，界面据实展示，不靠“隐藏全部低优先项”假装完成避让；
// 4. 不使用 Math.random / 时间戳等不确定来源，轻微平移时布局尽量稳定。

import { Rect, rectsIntersect, pointInPolygon } from './geometry.js';
import { worldToScreen, transformRing } from './projection.js';
import { buildCandidates } from './candidate.js';
import { validateFeature } from './features.js';

export const REJECT_REASONS = Object.freeze({
  OFF_CANVAS: 'off-canvas',
  LABEL_COLLISION: 'label-collision',
  MARKER_COLLISION: 'marker-collision',
  OUTSIDE_REGION: 'outside-region',
});

const REASON_PRECEDENCE = [
  REJECT_REASONS.OFF_CANVAS,
  REJECT_REASONS.LABEL_COLLISION,
  REJECT_REASONS.MARKER_COLLISION,
  REJECT_REASONS.OUTSIDE_REGION,
];

export const DEFAULT_OPTIONS = {
  edgeMargin: 8,          // 标签矩形允许溢出画布的余量（CSS 像素）
  collisionPadding: 1,    // 标签之间额外的碰撞间距
  candidateGap: 4,        // 候选与锚点/标记的基础间距
  markerPadding: 1,       // 点标记碰撞盒额外膨胀
};

export function compareFeatureId(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && a !== '' && b !== '') return na - nb;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function compareFeatures(a, b) {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.kind !== b.kind) return a.kind === 'point' ? -1 : 1;
  return compareFeatureId(a.id, b.id);
}

export function orderFeatures(features) {
  return [...features].sort(compareFeatures);
}

function withinCanvas(rect, view, edgeMargin) {
  return (
    rect.x >= -edgeMargin &&
    rect.y >= -edgeMargin &&
    rect.right <= view.width + edgeMargin &&
    rect.bottom <= view.height + edgeMargin
  );
}

function markerRect(screenPoint, radius, padding) {
  const r = radius + padding;
  return new Rect(screenPoint.x - r, screenPoint.y - r, r * 2, r * 2);
}

// 一次完整布局。输入要素（世界坐标）、视图、真实文字度量器；
// 输出已放置标签、隐藏要素（含全部拒绝原因）、候选试探明细与标记障碍。
export function runLabeling({ features, view, measurer, options = {} }) {
  if (!view) throw new Error('runLabeling 缺少 view');
  if (!measurer || typeof measurer.measure !== 'function') {
    throw new Error('runLabeling 缺少文字度量器 measurer');
  }
  for (const f of features) validateFeature(f);

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const ordered = orderFeatures(features);

  // 屏幕锚点与区域环（旋转/缩放/DPR 变化后在此重新映射）
  const screenAnchors = new Map();
  const screenRings = new Map();
  const markerObstacles = [];
  for (const f of ordered) {
    if (f.kind === 'point') {
      const sp = worldToScreen(view, f);
      screenAnchors.set(f.id, sp);
      markerObstacles.push({
        featureId: f.id,
        rect: markerRect(sp, f.markerRadius, opts.markerPadding),
      });
    } else {
      screenAnchors.set(f.id, worldToScreen(view, f.anchor));
      screenRings.set(f.id, transformRing(view, f.ring));
    }
  }

  const placedLabels = [];
  const placedRects = [];
  const hidden = [];
  const allTrials = new Map();

  for (const feature of ordered) {
    const anchor = screenAnchors.get(feature.id);
    const metrics = measurer.measure(feature.name, { fontSize: feature.fontSize });
    const candidates = buildCandidates(feature, anchor, metrics, {
      candidateGap: opts.candidateGap,
    });
    const screenRing = screenRings.get(feature.id);
    const trials = [];
    let selected = null;

    for (const candidate of candidates) {
      const reasons = [];
      const { rect } = candidate;

      if (!withinCanvas(rect, view, opts.edgeMargin)) {
        reasons.push(REJECT_REASONS.OFF_CANVAS);
      }

      for (const placed of placedRects) {
        if (rectsIntersect(rect, placed, opts.collisionPadding)) {
          reasons.push(REJECT_REASONS.LABEL_COLLISION);
          break;
        }
      }

      // 与其他要素的点标记碰撞（允许触碰本要素标记，间距已在候选偏移中处理）
      if (!reasons.includes(REJECT_REASONS.LABEL_COLLISION)) {
        for (const obstacle of markerObstacles) {
          if (obstacle.featureId === feature.id) continue;
          if (rectsIntersect(rect, obstacle.rect, 0)) {
            reasons.push(REJECT_REASONS.MARKER_COLLISION);
            break;
          }
        }
      }

      let outsideRegion = false;
      if (feature.kind === 'region') {
        const centerInside = pointInPolygon(rect.cx, rect.cy, screenRing);
        if (!centerInside) {
          outsideRegion = true;
          // 居中候选必须落在区域内；外移候选允许出界（走引线），只作标记不拒绝
          if (candidate.placement === 'center') {
            reasons.push(REJECT_REASONS.OUTSIDE_REGION);
          }
        }
      }

      trials.push({
        placement: candidate.placement,
        rect,
        reasons: [...new Set(reasons)],
        outsideRegion,
        needsLeader: candidate.needsLeader,
      });

      if (!selected && reasons.length === 0) {
        selected = { candidate, trial: trials[trials.length - 1] };
      }
    }

    allTrials.set(feature.id, trials);

    if (selected) {
      const { candidate } = selected;
      const label = {
        featureId: feature.id,
        name: feature.name,
        kind: feature.kind,
        priority: feature.priority,
        placement: candidate.placement,
        rect: candidate.rect,
        metrics: candidate.metrics,
        anchorScreen: candidate.anchorScreen,
        needsLeader: candidate.needsLeader || selected.trial.outsideRegion,
        outsideRegion: selected.trial.outsideRegion,
        feature,
      };
      placedLabels.push(label);
      placedRects.push(candidate.rect);
    } else {
      const allReasons = [...new Set(trials.flatMap((t) => t.reasons))];
      const primaryReason =
        REASON_PRECEDENCE.find((r) => allReasons.includes(r)) || REJECT_REASONS.OFF_CANVAS;
      hidden.push({
        featureId: feature.id,
        name: feature.name,
        kind: feature.kind,
        priority: feature.priority,
        anchorScreen: anchor,
        primaryReason,
        allReasons,
        trials,
        feature,
      });
    }
  }

  return {
    view: view.clone(),
    orderedFeatureIds: ordered.map((f) => f.id),
    labels: placedLabels,
    hidden,
    trials: allTrials,
    markerObstacles,
    stats: {
      total: ordered.length,
      placed: placedLabels.length,
      hidden: hidden.length,
      placementRate: ordered.length ? placedLabels.length / ordered.length : 0,
    },
  };
}
