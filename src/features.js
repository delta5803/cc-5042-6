// 地图要素模型：点要素与区域要素。纯数据，标注锚点由几何模块确定性计算。

import { poleOfInaccessibility } from './geometry.js';

let seq = 0;
export function nextFeatureId(prefix) {
  seq += 1;
  return `${prefix}-${seq.toString(36)}`;
}

export function makePointFeature({
  id,
  name,
  x,
  y,
  priority = 0,
  fontSize = 13,
  markerRadius = 5,
} = {}) {
  if (!name || !String(name).length) throw new Error('要素必须包含名称文字');
  if (![x, y].every(Number.isFinite)) throw new Error('点要素坐标必须为有限数');
  return {
    kind: 'point',
    id: id || nextFeatureId('p'),
    name: String(name),
    x,
    y,
    priority: Number(priority) || 0,
    fontSize: Number(fontSize) || 13,
    markerRadius: Number(markerRadius) || 5,
  };
}

export function makeRegionFeature({
  id,
  name,
  ring,
  priority = 0,
  fontSize = 13,
  anchor,
} = {}) {
  if (!name || !String(name).length) throw new Error('要素必须包含名称文字');
  if (!Array.isArray(ring) || ring.length < 3) throw new Error('区域要素至少需要 3 个环顶点');
  if (!ring.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
    throw new Error('区域环顶点坐标必须为有限数');
  }
  const resolvedAnchor = anchor || poleOfInaccessibility(ring);
  return {
    kind: 'region',
    id: id || nextFeatureId('r'),
    name: String(name),
    ring,
    priority: Number(priority) || 0,
    fontSize: Number(fontSize) || 13,
    anchor: { x: resolvedAnchor.x, y: resolvedAnchor.y },
    anchorScore: resolvedAnchor.score ?? 0,
  };
}

export function validateFeature(feature) {
  if (!feature || typeof feature !== 'object') throw new Error('要素必须为对象');
  if (!feature.id || !feature.name) throw new Error('要素缺少 id 或 name');
  if (feature.kind === 'point') {
    if (![feature.x, feature.y].every(Number.isFinite)) throw new Error(`点要素 ${feature.id} 坐标非法`);
  } else if (feature.kind === 'region') {
    if (!Array.isArray(feature.ring) || feature.ring.length < 3) {
      throw new Error(`区域要素 ${feature.id} 环非法`);
    }
  } else {
    throw new Error(`要素 ${feature.id} 的 kind 非法: ${feature.kind}`);
  }
}
