// 纯几何工具：屏幕空间轴对齐矩形、多边形判定、最大内切点（标注锚点）。
// 所有函数均为确定性函数，不包含随机数或隐藏状态。

export class Rect {
  constructor(x, y, width, height) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  get right() {
    return this.x + this.width;
  }

  get bottom() {
    return this.y + this.height;
  }

  get cx() {
    return this.x + this.width / 2;
  }

  get cy() {
    return this.y + this.height / 2;
  }

  intersects(other, padding = 0) {
    return rectsIntersect(this, other, padding);
  }

  contains(x, y) {
    return x >= this.x && x <= this.right && y >= this.y && y <= this.bottom;
  }

  expanded(px, py = px) {
    return new Rect(this.x - px, this.y - py, this.width + px * 2, this.height + py * 2);
  }
}

export function rectsIntersect(a, b, padding = 0) {
  return (
    a.x - padding < b.right &&
    a.right + padding > b.x &&
    a.y - padding < b.bottom &&
    a.bottom + padding > b.y
  );
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// 射线法，ring 为 [{x,y},...] 闭合环（首尾点可重复也可不重复）。
export function pointInPolygon(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function polygonBBox(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSq, 0, 1);
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function minDistanceToRingEdges(x, y, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    best = Math.min(best, distanceToSegment(x, y, a.x, a.y, b.x, b.y));
  }
  return best;
}

// 最大内切圆近似（polylabel 思路的确定性网格实现）：
// 粗网格找内部点中到边界距离最大者，再围绕最优点逐级细化。
export function poleOfInaccessibility(ring, { grid = 48, refinements = 2 } = {}) {
  const bbox = polygonBBox(ring);
  if (!(bbox.width > 0 && bbox.height > 0)) {
    return { x: bbox.minX, y: bbox.minY, score: 0, fellBack: true };
  }

  let best = null;
  let cell = Math.max(bbox.width, bbox.height) / grid;

  const scan = (minX, minY, maxX, maxY, step) => {
    const cols = Math.max(1, Math.round((maxX - minX) / step));
    const rows = Math.max(1, Math.round((maxY - minY) / step));
    for (let row = 0; row <= rows; row++) {
      const y = minY + row * step;
      for (let col = 0; col <= cols; col++) {
        const x = minX + col * step;
        if (!pointInPolygon(x, y, ring)) continue;
        const score = minDistanceToRingEdges(x, y, ring);
        if (!best || score > best.score) best = { x, y, score, fellBack: false };
      }
    }
  };

  scan(bbox.minX, bbox.minY, bbox.maxX, bbox.maxY, cell);

  for (let r = 0; r < refinements; r++) {
    if (!best) break;
    cell /= 4;
    scan(best.x - cell * 8, best.y - cell * 8, best.x + cell * 8, best.y + cell * 8, cell);
  }

  if (best) return best;

  const c = polygonCentroid(ring);
  return { x: c.x, y: c.y, score: 0, fellBack: true };
}

export function polygonCentroid(ring) {
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const cross = a.x * b.y - b.x * a.y;
    area2 += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (area2 === 0) {
    const bbox = polygonBBox(ring);
    return { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
  }
  return { x: cx / (3 * area2), y: cy / (3 * area2) };
}
