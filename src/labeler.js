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
import { RectSpatialIndex } from './spatial-index.js';

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
  // 碰撞候选加速开关（不改变选择结果，只改变候选筛选方式与成本）：
  //   'spatial-index' 先经屏幕空间网格索引缩小候选，再做精确 AABB；
  //   'brute-force'   保留原“与全部已放置矩形逐一精确比较”的运行参照。
  collisionStrategy: 'spatial-index',
  spatialCellSize: 64,    // 屏幕空间网格单元边长（CSS 像素）
};

const nowMs = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();

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
  if (opts.collisionStrategy !== 'spatial-index' && opts.collisionStrategy !== 'brute-force') {
    throw new Error(`未知碰撞策略：${opts.collisionStrategy}`);
  }
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

  const useIndex = opts.collisionStrategy === 'spatial-index';
  // 已放置标签与点标记障碍各自建索引：平移/缩放/旋转后本帧锚点、环已重映射，
  // 索引随本帧矩形重建，不存在跨帧陈旧条目；索引本身不按视口裁剪，
  // 画布外或跨边缘矩形照常入索引，故不会因可见区裁剪漏检越界标签。
  const placedIndex = useIndex
    ? new RectSpatialIndex({ cellSize: opts.spatialCellSize })
    : null;
  const markerIndex = useIndex
    ? new RectSpatialIndex({ cellSize: opts.spatialCellSize })
    : null;
  if (markerIndex) {
    for (const obstacle of markerObstacles) markerIndex.insert(obstacle.rect, obstacle);
  }

  const placedLabels = [];
  const placedRects = [];
  const hidden = [];
  const allTrials = new Map();

  // 成本分解：候选数、精确相交测试次数、宽相位命中数、标签/标记碰撞数。
  const cost = {
    candidates: 0,
    exactTests: 0,
    broadPhaseHits: 0,
    labelCollisions: 0,
    markerCollisions: 0,
    offCanvasCandidates: 0,
    outsideRegionCandidates: 0,
    layoutMs: 0,
  };
  const layoutStart = nowMs();

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
      cost.candidates += 1;
      const reasons = [];
      const { rect } = candidate;

      if (!withinCanvas(rect, view, opts.edgeMargin)) {
        reasons.push(REJECT_REASONS.OFF_CANVAS);
        cost.offCanvasCandidates += 1;
      }

      // 标签碰撞：只对宽相位给出的可能相交条目做精确 AABB。
      // 两种策略命中集合相同，唯一的差别是筛选成本与顺序证据。
      if (useIndex) {
        const hits = placedIndex.query(rect, opts.collisionPadding);
        cost.broadPhaseHits += hits.length;
        let collided = false;
        for (const entry of hits) {
          cost.exactTests += 1;
          if (rectsIntersect(rect, entry.rect, opts.collisionPadding)) {
            collided = true;
            break;
          }
        }
        if (collided) {
          reasons.push(REJECT_REASONS.LABEL_COLLISION);
          cost.labelCollisions += 1;
        }
      } else {
        for (const placed of placedRects) {
          cost.exactTests += 1;
          if (rectsIntersect(rect, placed, opts.collisionPadding)) {
            reasons.push(REJECT_REASONS.LABEL_COLLISION);
            cost.labelCollisions += 1;
            break;
          }
        }
      }

      // 与其他要素的点标记碰撞（允许触碰本要素标记，间距已在候选偏移中处理）
      if (!reasons.includes(REJECT_REASONS.LABEL_COLLISION)) {
        if (useIndex) {
          const hits = markerIndex.query(rect, 0);
          cost.broadPhaseHits += hits.length;
          let collided = false;
          for (const entry of hits) {
            const obstacle = entry.data;
            if (obstacle.featureId === feature.id) continue;
            cost.exactTests += 1;
            if (rectsIntersect(rect, obstacle.rect, 0)) {
              collided = true;
              break;
            }
          }
          if (collided) {
            reasons.push(REJECT_REASONS.MARKER_COLLISION);
            cost.markerCollisions += 1;
          }
        } else {
          for (const obstacle of markerObstacles) {
            if (obstacle.featureId === feature.id) continue;
            cost.exactTests += 1;
            if (rectsIntersect(rect, obstacle.rect, 0)) {
              reasons.push(REJECT_REASONS.MARKER_COLLISION);
              cost.markerCollisions += 1;
              break;
            }
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
            cost.outsideRegionCandidates += 1;
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
      if (placedIndex) placedIndex.insert(candidate.rect, label);
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

  cost.layoutMs = nowMs() - layoutStart;

  return {
    view: view.clone(),
    orderedFeatureIds: ordered.map((f) => f.id),
    labels: placedLabels,
    hidden,
    trials: allTrials,
    markerObstacles,
    collisionStrategy: opts.collisionStrategy,
    stats: {
      total: ordered.length,
      placed: placedLabels.length,
      hidden: hidden.length,
      placementRate: ordered.length ? placedLabels.length / ordered.length : 0,
    },
    // 成本分解：候选数、精确相交测试数、宽相位命中数、标签/标记碰撞数、布局耗时。
    cost,
  };
}
