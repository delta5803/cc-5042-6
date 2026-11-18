// 屏幕空间轴对齐矩形的均匀网格索引（宽相位 / broad phase）。
// 目的：把“每个候选矩形与全部已放置矩形逐一精确相交”降为“先查可能相邻的
// 网格单元，再做精确 AABB 测试”，而**不改变**任何判定结果：
//   - 查询返回的是超集，调用方仍用 rectsIntersect 做真正的相交判定；
//   - 索引是哈希网格（Map 键为整数单元坐标），不按视口裁剪，
//     越界/负坐标矩形照常入索引，因此不会漏掉画布外或跨边缘的要素；
//   - 插入与查询都是确定性操作，不含随机数或时间依赖。
//
import { rectsIntersect } from './geometry.js';

// 正确性论证（与 rectsIntersect 的严格不等式一致）：
// 若矩形 A 与 B（A 可先按 padding 膨胀）真实相交，则交集区域面积为正，
// 区域内必有一点 p；p 同时落在 A、B 覆盖的某单元 C 内。插入时 B 被写入它
// 覆盖的所有单元，查询时又遍历 A 覆盖的所有单元，故 C 一定被查到，B 不会漏。
// 单元范围两端都取 Math.floor（边界单元可能被多查一次，只会产生超集，安全）。

export class RectSpatialIndex {
  constructor({ cellSize = 64, maxCellsPerRect = 256 } = {}) {
    if (!(Number.isFinite(cellSize) && cellSize > 0)) {
      throw new Error('RectSpatialIndex: cellSize 必须为正数');
    }
    this.cellSize = cellSize;
    // 单个矩形横跨的单元数超过阈值时放入 oversized 列表，查询时始终参与精确测试。
    // 这样既能处理超长标签/极端坐标，又不会让一次插入写入海量单元。
    this.maxCellsPerRect = maxCellsPerRect;
    this.cells = new Map();
    this.oversized = [];
    this.size = 0;
    this._querySeq = 0;
  }

  _cellKey(cx, cy) {
    return `${cx},${cy}`;
  }

  _cellRange(rect, padding) {
    const cs = this.cellSize;
    return {
      x0: Math.floor((rect.x - padding) / cs),
      y0: Math.floor((rect.y - padding) / cs),
      x1: Math.floor((rect.right + padding) / cs),
      y1: Math.floor((rect.bottom + padding) / cs),
    };
  }

  insert(rect, data = rect) {
    const entry = { rect, data, _qid: 0 };
    const { x0, y0, x1, y1 } = this._cellRange(rect, 0);
    const span = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (!Number.isFinite(span) || span > this.maxCellsPerRect) {
      this.oversized.push(entry);
    } else {
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = this._cellKey(cx, cy);
          let bucket = this.cells.get(key);
          if (!bucket) {
            bucket = [];
            this.cells.set(key, bucket);
          }
          bucket.push(entry);
        }
      }
    }
    this.size += 1;
    return entry;
  }

  // 返回所有“可能与 query（按 padding 膨胀）相交”的条目的去重超集。
  // 调用方必须自行做精确相交判定。
  query(query, padding = 0) {
    const seq = ++this._querySeq;
    const out = [];
    const collect = (entry) => {
      if (entry._qid !== seq) {
        entry._qid = seq;
        out.push(entry);
      }
    };
    for (const entry of this.oversized) collect(entry);
    const { x0, y0, x1, y1 } = this._cellRange(query, padding);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = this.cells.get(this._cellKey(cx, cy));
        if (bucket) for (const entry of bucket) collect(entry);
      }
    }
    return out;
  }

  // 宽相位 + 精确测试，返回真正相交（考虑 padding）的条目，顺序为首次出现顺序。
  search(query, padding = 0) {
    const hits = [];
    for (const entry of this.query(query, padding)) {
      if (rectsIntersect(entry.rect, query, padding)) hits.push(entry);
    }
    return hits;
  }
}
