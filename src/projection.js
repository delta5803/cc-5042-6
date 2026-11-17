// 世界坐标 <-> 屏幕坐标（CSS 像素）变换。
// 视图状态：世界中心点、缩放（每世界单位对应 CSS 像素）、旋转角（弧度）、视口尺寸、DPR。
// 标注引擎始终在 CSS 像素空间运算；DPR 只影响画布后备存储的像素密度，不改变标注布局，
// 因此 DPR 变化后重映射得到的标签矩形（CSS 像素）保持一致。

export class View {
  constructor({ width, height, scale = 1, rotation = 0, cx = 0, cy = 0, dpr = 1 } = {}) {
    if (!(Number.isFinite(width) && width > 0) || !(Number.isFinite(height) && height > 0)) {
      throw new Error('视口宽高必须为正数');
    }
    this.width = width;
    this.height = height;
    this.scale = scale;
    this.rotation = rotation;
    this.cx = cx;
    this.cy = cy;
    this.dpr = dpr;
  }

  clone() {
    return new View({
      width: this.width,
      height: this.height,
      scale: this.scale,
      rotation: this.rotation,
      cx: this.cx,
      cy: this.cy,
      dpr: this.dpr,
    });
  }
}

export function worldToScreen(view, point) {
  const dx = (point.x - view.cx) * view.scale;
  const dy = (point.y - view.cy) * view.scale;
  const cos = Math.cos(view.rotation);
  const sin = Math.sin(view.rotation);
  return {
    x: dx * cos - dy * sin + view.width / 2,
    y: dx * sin + dy * cos + view.height / 2,
  };
}

export function screenToWorld(view, point) {
  const sx = point.x - view.width / 2;
  const sy = point.y - view.height / 2;
  const cos = Math.cos(view.rotation);
  const sin = Math.sin(view.rotation);
  // 旋转矩阵的逆为转置
  const dx = sx * cos + sy * sin;
  const dy = -sx * sin + sy * cos;
  return {
    x: dx / view.scale + view.cx,
    y: dy / view.scale + view.cy,
  };
}

export function transformRing(view, ring) {
  return ring.map((p) => worldToScreen(view, p));
}

// 视口四个角在世界空间中的位置，用于计算可见范围。
export function viewportCornersInWorld(view) {
  const corners = [
    { x: 0, y: 0 },
    { x: view.width, y: 0 },
    { x: view.width, y: view.height },
    { x: 0, y: view.height },
  ];
  return corners.map((p) => screenToWorld(view, p));
}
