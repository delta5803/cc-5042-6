// 矢量渲染器：地图与标注全部直接绘制在 <canvas> 上（含文字、光晕、引线），
// 不使用任何 HTML/浏览器原生标签做文字标注——那样根本没有真实避让。
// DPR 只作用于画布后备存储，布局坐标始终是 CSS 像素。

import { transformRing } from './projection.js';

export const COLORS = {
  regionFill: 'rgba(64, 132, 246, 0.12)',
  regionStroke: 'rgba(64, 132, 246, 0.75)',
  regionFillSelected: 'rgba(245, 166, 35, 0.18)',
  regionStrokeSelected: 'rgba(245, 166, 35, 0.95)',
  marker: '#1f6feb',
  markerSelected: '#f5a623',
  labelFill: '#16202c',
  labelHalo: 'rgba(255,255,255,0.92)',
  labelHaloOutside: 'rgba(255, 244, 214, 0.95)',
  leader: 'rgba(120, 120, 120, 0.85)',
  candidateOk: 'rgba(46, 160, 67, 0.55)',
  candidateRejected: 'rgba(210, 60, 60, 0.5)',
  candidateStrokeOk: 'rgba(46, 160, 67, 0.9)',
  candidateStrokeRejected: 'rgba(210, 60, 60, 0.9)',
  hidden: 'rgba(160, 70, 70, 0.9)',
  anchor: 'rgba(160, 40, 180, 0.9)',
  grid: 'rgba(100, 116, 139, 0.18)',
};

export function configureCanvas(canvas, view) {
  const dpr = view.dpr || 1;
  const targetW = Math.round(view.width * dpr);
  const targetH = Math.round(view.height * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  canvas.style.width = `${view.width}px`;
  canvas.style.height = `${view.height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function drawGrid(ctx, view) {
  ctx.save();
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  const step = 40;
  for (let x = (view.width / 2) % step; x < view.width; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, view.height);
    ctx.stroke();
  }
  for (let y = (view.height / 2) % step; y < view.height; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(view.width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRegion(ctx, feature, view, selected) {
  const ring = transformRing(view, feature.ring);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ring[0].x, ring[0].y);
  for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
  ctx.closePath();
  ctx.fillStyle = selected ? COLORS.regionFillSelected : COLORS.regionFill;
  ctx.strokeStyle = selected ? COLORS.regionStrokeSelected : COLORS.regionStroke;
  ctx.lineWidth = selected ? 2 : 1.25;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawMarker(ctx, screen, radius, selected) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = selected ? COLORS.markerSelected : COLORS.marker;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.restore();
}

function drawLeader(ctx, label) {
  const { rect, anchorScreen } = label;
  const ex = rect.cx;
  const ey = rect.cy;
  if (Math.hypot(ex - anchorScreen.x, ey - anchorScreen.y) < label.metrics.height) return;
  ctx.save();
  ctx.strokeStyle = COLORS.leader;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(anchorScreen.x, anchorScreen.y);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  ctx.restore();
}

function drawLabel(ctx, label) {
  const { rect, metrics } = label;
  ctx.save();
  ctx.font = metrics.font;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const textX = rect.x + metrics.textOffsetX;
  const textY = rect.y + metrics.textOffsetY;

  // 白色光晕保证地图底图上的可读性，宽度取自真实度量里的 halo 余量
  ctx.lineWidth = metrics.halo * 1.6;
  ctx.strokeStyle = label.outsideRegion ? COLORS.labelHaloOutside : COLORS.labelHalo;
  ctx.lineJoin = 'round';
  ctx.strokeText(label.name, textX, textY);
  ctx.fillStyle = COLORS.labelFill;
  ctx.fillText(label.name, textX, textY);
  ctx.restore();
}

function drawRectOutline(ctx, rect, strokeStyle, fillStyle, lineWidth = 1) {
  ctx.save();
  ctx.strokeStyle = strokeStyle;
  ctx.fillStyle = fillStyle;
  ctx.lineWidth = lineWidth;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

// 调试层：候选矩形、拒绝原因、隐藏标记、区域锚点。
export function drawDebug(ctx, layout, { showCandidates = true, showHidden = true } = {}) {
  if (showCandidates) {
    for (const [, trials] of layout.trials) {
      for (const trial of trials) {
        const rejected = trial.reasons.length > 0;
        drawRectOutline(
          ctx,
          trial.rect,
          rejected ? COLORS.candidateStrokeRejected : COLORS.candidateStrokeOk,
          rejected ? 'rgba(210,60,60,0.08)' : 'rgba(46,160,67,0.08)',
          rejected ? 1 : 1.25,
        );
      }
    }
  }

  if (showHidden) {
    for (const item of layout.hidden) {
      const { anchorScreen } = item;
      ctx.save();
      ctx.strokeStyle = COLORS.hidden;
      ctx.lineWidth = 1.5;
      const r = 6;
      ctx.beginPath();
      ctx.moveTo(anchorScreen.x - r, anchorScreen.y - r);
      ctx.lineTo(anchorScreen.x + r, anchorScreen.y + r);
      ctx.moveTo(anchorScreen.x + r, anchorScreen.y - r);
      ctx.lineTo(anchorScreen.x - r, anchorScreen.y + r);
      ctx.stroke();
      ctx.font = "600 11px " + "'Noto Sans',sans-serif";
      ctx.fillStyle = COLORS.hidden;
      ctx.fillText(`${item.name} ✕ ${item.primaryReason}`, anchorScreen.x + 9, anchorScreen.y - 8);
      ctx.restore();
    }
  }

  for (const label of layout.labels) {
    if (label.kind !== 'region') continue;
    const a = label.anchorScreen;
    ctx.save();
    ctx.strokeStyle = COLORS.anchor;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

export function renderScene(canvas, view, features, layout, options = {}) {
  const ctx = configureCanvas(canvas, view);
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.fillStyle = options.background || '#f7f9fc';
  ctx.fillRect(0, 0, view.width, view.height);

  drawGrid(ctx, view);

  const selectedId = options.selectedId || null;
  for (const f of features) {
    if (f.kind === 'region') drawRegion(ctx, f, view, f.id === selectedId);
  }

  for (const f of features) {
    if (f.kind !== 'point') continue;
    const anchor = layout.markerObstacles.find((m) => m.featureId === f.id);
    const screen = anchor
      ? { x: anchor.rect.cx, y: anchor.rect.cy }
      : null;
    if (screen) drawMarker(ctx, screen, f.markerRadius, f.id === selectedId);
  }

  if (options.debug) {
    drawDebug(ctx, layout, {
      showCandidates: options.showCandidates !== false,
      showHidden: options.showHidden !== false,
    });
  }

  for (const label of layout.labels) {
    if (label.needsLeader) drawLeader(ctx, label);
  }
  for (const label of layout.labels) {
    drawLabel(ctx, label);
    if (options.debug) {
      drawRectOutline(ctx, label.rect, 'rgba(31,111,235,0.9)', 'rgba(31,111,235,0.06)', 1.5);
    }
  }
}
