// 测试用文字度量器：与 CanvasTextMeasurer 同接口，但不依赖浏览器。
// 宽度按“实际字形类别”逐字符累加（全角/窄拉丁/阿拉伯/组合附加），
// 模拟真实 shaping 的比例差异，同样不是“字符数 × 固定宽度”。
// 它只用于 Node 测试；生产渲染路径始终使用 canvas measureText 的真实包围盒。

// code point 区间判定，避免源码编码差异导致字形分类失效
const FULLWIDTH_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f],
  [0xff00, 0xff60], [0xffe0, 0xffe6],
];
const ARABIC_RANGES = [[0x0600, 0x06ff], [0x0750, 0x077f], [0xfb50, 0xfdff], [0xfe70, 0xfeff]];
const GREEK_CYRILLIC_RANGES = [[0x0370, 0x03ff], [0x0400, 0x04ff]];

const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

const GLYPH_RULES = [
  { test: (ch) => inRanges(ch.codePointAt(0), FULLWIDTH_RANGES), width: 1.0, name: 'fullwidth' },
  { test: (ch) => 'WIwMm'.includes(ch), width: 0.78, name: 'wide-latin' },
  { test: (ch) => "iljt .,'’!:;|".includes(ch), width: 0.32, name: 'narrow-latin' },
  { test: (ch) => inRanges(ch.codePointAt(0), ARABIC_RANGES), width: 0.62, name: 'arabic' },
  { test: (ch) => inRanges(ch.codePointAt(0), GREEK_CYRILLIC_RANGES), width: 0.6, name: 'greek-cyrillic' },
];

export class FakeTextMeasurer {
  constructor(options = {}) {
    this.paddingX = options.paddingX ?? 5;
    this.paddingY = options.paddingY ?? 2;
    this.halo = options.halo ?? 2.5;
    this.calls = [];
  }

  glyphAdvance(ch) {
    for (const rule of GLYPH_RULES) {
      if (rule.test(ch)) return rule.width;
    }
    return 0.56; // 普通拉丁/其他
  }

  measure(text, options = {}) {
    const fontSize = options.fontSize ?? 13;
    const fontWeight = options.fontWeight ?? 600;
    const paddingX = options.paddingX ?? this.paddingX;
    const paddingY = options.paddingY ?? this.paddingY;
    const halo = options.halo ?? this.halo;
    this.calls.push(text);

    const glyphWidth =
      [...String(text)].reduce((sum, ch) => sum + this.glyphAdvance(ch), 0) * fontSize;
    const ascent = fontSize * 0.8;
    const descent = fontSize * 0.22;
    const glyphHeight = ascent + descent;

    return {
      font: `${fontWeight} ${fontSize}px test-sans`,
      fontSize,
      fontWeight,
      glyphWidth,
      glyphHeight,
      ascent,
      descent,
      paddingX,
      paddingY,
      halo,
      width: glyphWidth + 2 * paddingX + 2 * halo,
      height: glyphHeight + 2 * paddingY + 2 * halo,
      textOffsetX: paddingX + halo,
      textOffsetY: paddingY + halo + ascent,
    };
  }

  clearCache() {}
}
