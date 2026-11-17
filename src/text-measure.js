// 真实文字度量：边界来自 Canvas 2D 的实际字形布局（measureText 的实际包围盒），
// 加上显式的内边距与描边光晕余量。绝不用“字符数 × 固定宽度”估算——
// 不同文字体系（拉丁比例宽度、CJK 全角、阿拉伯文 shaping、西里尔/希腊字母等）
// 与同体系内不同字符（如 W 与 i）宽度差异必须由字体 shaping 结果决定。

export const DEFAULT_FONT_FAMILY =
  "'Inter','Helvetica Neue','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC','Noto Sans Arabic','Noto Sans',Arial,sans-serif";

export class CanvasTextMeasurer {
  constructor(canvas, { fontFamily = DEFAULT_FONT_FAMILY } = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new Error('CanvasTextMeasurer 需要一个 <canvas> 元素');
    }
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.fontFamily = fontFamily;
    this._cache = new Map();
  }

  buildFont({ fontSize = 13, fontWeight = 600 } = {}) {
    return `${fontWeight} ${fontSize}px ${this.fontFamily}`;
  }

  measure(text, options = {}) {
    const {
      fontSize = 13,
      fontWeight = 600,
      paddingX = 5,
      paddingY = 2,
      halo = 2.5,
    } = options;
    const key = `${text}|${fontSize}|${fontWeight}|${paddingX}|${paddingY}|${halo}`;
    const cached = this._cache.get(key);
    if (cached) return cached;

    const font = this.buildFont({ fontSize, fontWeight });
    this.ctx.font = font;
    const m = this.ctx.measureText(text);

    // 优先使用实际字形包围盒；不支持的环境回退到 advance width 与字号比例。
    const actualLeft = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : null;
    const actualRight = Number.isFinite(m.actualBoundingBoxRight)
      ? m.actualBoundingBoxRight
      : null;
    const glyphWidth =
      actualLeft !== null && actualRight !== null && actualLeft + actualRight > 0
        ? actualLeft + actualRight
        : m.width;

    const ascent = Number.isFinite(m.actualBoundingBoxAscent)
      ? m.actualBoundingBoxAscent
      : fontSize * 0.8;
    const descent = Number.isFinite(m.actualBoundingBoxDescent)
      ? m.actualBoundingBoxDescent
      : fontSize * 0.2;

    const metrics = {
      font,
      fontSize,
      fontWeight,
      glyphWidth,
      glyphHeight: ascent + descent,
      ascent,
      descent,
      paddingX,
      paddingY,
      halo,
      // 标签碰撞矩形：实际字形尺寸 + 两侧内边距 + 光晕余量
      width: glyphWidth + 2 * paddingX + 2 * halo,
      height: ascent + descent + 2 * paddingY + 2 * halo,
      // 绘制时文本基线相对矩形左上角的偏移
      textOffsetX: paddingX + halo,
      textOffsetY: paddingY + halo + ascent,
    };

    this._cache.set(key, metrics);
    return metrics;
  }

  clearCache() {
    this._cache.clear();
  }
}
