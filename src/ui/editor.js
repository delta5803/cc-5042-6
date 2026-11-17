// 矢量编辑窗口控制器：平移/缩放/旋转、点与区域绘制、优先级编辑、
// 候选与拒绝原因展示、异常统一在界面提示。所有标注文字由 canvas 矢量绘制。

import { View, screenToWorld, worldToScreen } from '../projection.js';
import { CanvasTextMeasurer } from '../text-measure.js';
import { makePointFeature, makeRegionFeature, validateFeature } from '../features.js';
import { runLabeling, REJECT_REASONS } from '../labeler.js';
import { renderScene } from '../renderer.js';
import { pointInPolygon } from '../geometry.js';
import { sampleData } from './sample-data.js';

const STORAGE_KEY = 'map-label-engine-state-v1';

const REASON_TEXT = {
  [REJECT_REASONS.OFF_CANVAS]: '超出画布边缘',
  [REJECT_REASONS.LABEL_COLLISION]: '与已放置标签碰撞',
  [REJECT_REASONS.MARKER_COLLISION]: '与点标记碰撞',
  [REJECT_REASONS.OUTSIDE_REGION]: '标签中心落在区域外',
};

class LabelEditor {
  constructor() {
    this.canvas = document.getElementById('map');
    this.toastEl = document.getElementById('toast');
    this.hudEl = document.getElementById('hud');
    this.statusEl = document.getElementById('status');
    this.modeHintEl = document.getElementById('mode-hint');
    this.measurer = new CanvasTextMeasurer(this.canvas);

    this.tool = 'select';
    this.features = [];
    this.selectedId = null;
    this.debug = true;
    this.showCandidates = true;
    this.showHidden = true;
    this.draftRing = null;
    this.pan = null;
    this.layout = null;
    this._toastTimer = null;

    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.view = new View({
      width: Math.max(320, rect.width),
      height: Math.max(240, rect.height),
      scale: 1,
      rotation: 0,
      cx: 500,
      cy: 400,
      dpr: window.devicePixelRatio || 1,
    });

    this.bindEvents();
    this.restoreOrLoadSample();
    this.observeResize();
  }

  // ---------- 基础设施 ----------

  showError(message) {
    this.toastEl.textContent = message;
    this.toastEl.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.toastEl.hidden = true;
    }, 4200);
  }

  setStatus(text) {
    this.statusEl.textContent = text;
  }

  observeResize() {
    const ro = new ResizeObserver(() => {
      const rect = this.canvas.parentElement.getBoundingClientRect();
      this.view.width = Math.max(200, rect.width);
      this.view.height = Math.max(200, rect.height);
      this.view.dpr = window.devicePixelRatio || 1;
      this.frame();
    });
    ro.observe(this.canvas.parentElement);
  }

  persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          features: this.features,
          view: {
            cx: this.view.cx,
            cy: this.view.cy,
            scale: this.view.scale,
            rotation: this.view.rotation,
          },
        }),
      );
    } catch (err) {
      this.showError(`状态保存失败：${err.message}`);
    }
  }

  restoreOrLoadSample() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.loadFeatures(parsed.features || [], false);
        if (parsed.view) Object.assign(this.view, parsed.view);
        this.setStatus('已恢复上次编辑会话');
        return;
      }
    } catch (err) {
      this.showError(`本地状态读取失败，已载入示例：${err.message}`);
    }
    this.loadFeatures(sampleData(), false);
  }

  loadFeatures(features, persist = true) {
    for (const f of features) validateFeature(f);
    this.features = features;
    if (!this.features.some((f) => f.id === this.selectedId)) this.selectedId = null;
    if (persist) this.persist();
    this.frame();
  }

  frame() {
    try {
      this.layout = runLabeling({
        features: this.features,
        view: this.view,
        measurer: this.measurer,
      });
      renderScene(this.canvas, this.view, this.features, this.layout, {
        debug: this.debug,
        showCandidates: this.showCandidates,
        showHidden: this.showHidden,
        selectedId: this.selectedId,
      });
      this.drawDraftRing();
      this.updateHud();
      this.updateResults();
      this.updateInspector();
      this.persist();
    } catch (err) {
      this.showError(`标注运算异常：${err.message}`);
      this.setStatus(`异常：${err.message}`);
    }
  }

  drawDraftRing() {
    if (!this.draftRing || this.draftRing.length === 0) return;
    const ctx = this.canvas.getContext('2d');
    ctx.save();
    ctx.beginPath();
    const pts = this.draftRing.map((p) => worldToScreen(this.view, p));
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#f5a623';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#f5a623';
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------- 事件绑定 ----------

  bindEvents() {
    document.querySelectorAll('.tool[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => this.setTool(btn.dataset.tool));
    });
    document.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => this.runAction(btn.dataset.action));
    });

    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));

    document.getElementById('debug-toggle').addEventListener('change', (e) => {
      this.debug = e.target.checked;
      this.frame();
    });
    document.getElementById('candidate-toggle').addEventListener('change', (e) => {
      this.showCandidates = e.target.checked;
      this.frame();
    });
    document.getElementById('hidden-toggle').addEventListener('change', (e) => {
      this.showHidden = e.target.checked;
      this.frame();
    });

    document.getElementById('import-file').addEventListener('change', (e) => this.onImport(e));
  }

  setTool(tool) {
    this.tool = tool;
    document.querySelectorAll('.tool[data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });
    this.canvas.className = tool === 'select' ? '' : `tool-${tool}`;
    if (tool !== 'region') this.draftRing = null;
    const hints = {
      select: '拖拽平移地图；滚轮缩放；单击选中要素。',
      point: '单击地图放置点位，随后输入名称。',
      region: '逐点单击绘制区域边界，双击或按 Enter 完成，Esc 取消。',
    };
    this.modeHintEl.textContent = hints[tool] || '';
    this.frame();
  }

  runAction(action) {
    try {
      if (action === 'rotate-left' || action === 'rotate-right') {
        this.view.rotation += action === 'rotate-left' ? -Math.PI / 12 : Math.PI / 12;
        this.frame();
      } else if (action === 'reset-view') {
        this.view.scale = 1;
        this.view.rotation = 0;
        this.frame();
      } else if (action === 'export') {
        this.exportData();
      } else if (action === 'import') {
        document.getElementById('import-file').click();
      } else if (action === 'load-sample') {
        this.loadFeatures(sampleData());
        this.setStatus('已载入示例数据（密集点、多语言长短名称、跨边缘点）');
      }
    } catch (err) {
      this.showError(err.message);
    }
  }

  // ---------- 指针交互 ----------

  eventPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  onPointerDown(e) {
    const screen = this.eventPoint(e);
    if (this.tool === 'select') {
      const hit = this.hitTest(screen);
      if (hit) {
        this.selectedId = hit.id;
        this.updateInspector();
      }
      this.canvas.setPointerCapture(e.pointerId);
      this.pan = {
        sx: screen.x,
        sy: screen.y,
        cx: this.view.cx,
        cy: this.view.cy,
      };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    if (this.tool === 'point') {
      const world = screenToWorld(this.view, screen);
      const name = window.prompt('输入点名称（可含任意文字体系）：', '新点位');
      if (name && name.trim()) {
        this.features.push(
          makePointFeature({ name: name.trim(), x: world.x, y: world.y }),
        );
        this.frame();
      }
      return;
    }

    if (this.tool === 'region') {
      const world = screenToWorld(this.view, screen);
      if (!this.draftRing) this.draftRing = [];
      this.draftRing.push(world);
      this.frame();
    }
  }

  onPointerMove(e) {
    if (!this.pan) return;
    const screen = this.eventPoint(e);
    const dsx = screen.x - this.pan.sx;
    const dsy = screen.y - this.pan.sy;
    const { rotation, scale } = this.view;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const wx = (cos * dsx + sin * dsy) / scale;
    const wy = (-sin * dsx + cos * dsy) / scale;
    this.view.cx = this.pan.cx - wx;
    this.view.cy = this.pan.cy - wy;
    this.frame();
  }

  onPointerUp(e) {
    if (this.pan) {
      this.pan = null;
      this.canvas.style.cursor = this.tool === 'select' ? 'grab' : 'crosshair';
    }
  }

  onDblClick(e) {
    if (this.tool !== 'region' || !this.draftRing || this.draftRing.length < 3) return;
    e.preventDefault();
    try {
      const name = window.prompt('输入区域名称：', '新区域');
      if (name && name.trim()) {
        this.features.push(makeRegionFeature({ name: name.trim(), ring: [...this.draftRing] }));
      }
    } catch (err) {
      this.showError(`区域创建失败：${err.message}`);
    } finally {
      this.draftRing = null;
      this.frame();
    }
  }

  onWheel(e) {
    e.preventDefault();
    const screen = this.eventPoint(e);
    const before = screenToWorld(this.view, screen);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.view.scale = Math.min(40, Math.max(0.08, this.view.scale * factor));
    // 以光标为锚点缩放
    const dx = screen.x - this.view.width / 2;
    const dy = screen.y - this.view.height / 2;
    const cos = Math.cos(this.view.rotation);
    const sin = Math.sin(this.view.rotation);
    this.view.cx = before.x - (cos * dx + sin * dy) / this.view.scale;
    this.view.cy = before.y - (-sin * dx + cos * dy) / this.view.scale;
    this.frame();
  }

  onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape') {
      this.draftRing = null;
      this.frame();
    } else if (e.key === 'Enter' && this.tool === 'region' && this.draftRing?.length >= 3) {
      this.onDblClick({ preventDefault() {} });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelected();
    }
  }

  hitTest(screen) {
    // 先点，再区域
    for (const f of this.features) {
      if (f.kind !== 'point') continue;
      const sp = worldToScreen(this.view, f);
      if (Math.hypot(sp.x - screen.x, sp.y - screen.y) <= f.markerRadius + 4) return f;
    }
    for (const f of this.features) {
      if (f.kind !== 'region') continue;
      const ring = f.ring.map((p) => worldToScreen(this.view, p));
      if (pointInPolygon(screen.x, screen.y, ring)) return f;
    }
    return null;
  }

  deleteSelected() {
    if (!this.selectedId) return;
    this.features = this.features.filter((f) => f.id !== this.selectedId);
    this.selectedId = null;
    this.frame();
  }

  // ---------- 面板 ----------

  updateHud() {
    const v = this.view;
    document.getElementById('view-state').textContent =
      `中心 (${v.cx.toFixed(1)}, ${v.cy.toFixed(1)}) · 缩放 ${v.scale.toFixed(2)}× · ` +
      `旋转 ${((v.rotation * 180) / Math.PI).toFixed(0)}° · DPR ${v.dpr} · 视口 ${Math.round(v.width)}×${Math.round(v.height)}`;
    if (this.layout) {
      this.hudEl.innerHTML =
        `要素 ${this.layout.stats.total} · 已放置 <b>${this.layout.stats.placed}</b> · ` +
        `隐藏 <b>${this.layout.stats.hidden}</b> · 放置率 ${(this.layout.stats.placementRate * 100).toFixed(0)}%`;
    }
  }

  updateInspector() {
    const el = document.getElementById('inspector');
    const f = this.features.find((x) => x.id === this.selectedId);
    if (!f) {
      el.className = 'muted';
      el.textContent = '未选中要素（点选地图上的点或区域）。';
      return;
    }
    el.className = '';
    el.innerHTML = `
      <label>名称<input id="insp-name" type="text" value="${escapeHtml(f.name)}" /></label>
      <label>优先级（数字越大越优先）<input id="insp-priority" type="number" step="1" value="${f.priority}" /></label>
      <label>字号<input id="insp-size" type="number" min="8" max="32" step="1" value="${f.fontSize}" /></label>
      <div class="muted">类型：${f.kind === 'point' ? '点位' : '区域'} · ID：${f.id}</div>
      ${f.kind === 'region' ? `<div class="muted">标注锚点（最大内切点）：(${f.anchor.x.toFixed(1)}, ${f.anchor.y.toFixed(1)})</div>` : ''}
      <div class="row"><button id="insp-delete" style="background:#842323;border-color:#842323">删除要素</button></div>
    `;
    document.getElementById('insp-name').addEventListener('change', (e) => {
      f.name = e.target.value || f.name;
      this.frame();
    });
    document.getElementById('insp-priority').addEventListener('change', (e) => {
      const value = Number(e.target.value);
      if (Number.isFinite(value)) {
        f.priority = value;
        this.frame();
      } else {
        this.showError('优先级必须是数字');
      }
    });
    document.getElementById('insp-size').addEventListener('change', (e) => {
      const value = Number(e.target.value);
      if (value >= 8 && value <= 32) {
        f.fontSize = value;
        this.measurer.clearCache();
        this.frame();
      } else {
        this.showError('字号需在 8–32 之间');
      }
    });
    document.getElementById('insp-delete').addEventListener('click', () => this.deleteSelected());
  }

  updateResults() {
    const tbody = document.querySelector('#result-table tbody');
    const summary = document.getElementById('summary');
    if (!this.layout) return;
    const s = this.layout.stats;
    summary.innerHTML = `
      <div class="stat"><b>${s.total}</b><span class="muted">要素</span></div>
      <div class="stat"><b>${s.placed}</b><span class="muted">已放置</span></div>
      <div class="stat"><b>${s.hidden}</b><span class="muted">隐藏</span></div>
      <div class="stat"><b>${(s.placementRate * 100).toFixed(0)}%</b><span class="muted">放置率</span></div>
    `;

    const placedById = new Map(this.layout.labels.map((l) => [l.featureId, l]));
    const hiddenById = new Map(this.layout.hidden.map((h) => [h.featureId, h]));

    tbody.innerHTML = this.layout.orderedFeatureIds
      .map((id, index) => {
        const f = this.features.find((x) => x.id === id);
        const placed = placedById.get(id);
        const hidden = hiddenById.get(id);
        const selected = id === this.selectedId ? 'row-selected' : '';
        if (placed) {
          return `<tr class="row-placed ${selected}" data-id="${id}">
            <td>${index + 1}</td>
            <td>${escapeHtml(f.name)}</td>
            <td>${f.priority}</td>
            <td><span class="badge badge-ok">显示 · ${placed.placement}</span></td>
            <td class="muted">—</td>
          </tr>`;
        }
        const reasons = hidden.allReasons.map((r) => `<li>${REASON_TEXT[r] || r}</li>`).join('');
        return `<tr class="row-hidden ${selected}" data-id="${id}">
          <td>${index + 1}</td>
          <td>${escapeHtml(f.name)}</td>
          <td>${f.priority}</td>
          <td><span class="badge badge-hide">隐藏</span></td>
          <td><ul class="reason-list">${reasons}</ul></td>
        </tr>`;
      })
      .join('');

    tbody.querySelectorAll('tr[data-id]').forEach((row) => {
      row.addEventListener('click', () => {
        this.selectedId = row.dataset.id;
        this.frame();
      });
    });
  }

  // ---------- 导入导出 ----------

  exportData() {
    const blob = new Blob(
      [JSON.stringify({ version: 1, features: this.features }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'map-labels.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  onImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const features = Array.isArray(parsed) ? parsed : parsed.features;
        if (!Array.isArray(features)) throw new Error('JSON 中未找到 features 数组');
        this.loadFeatures(features);
        this.setStatus(`已导入 ${features.length} 个要素`);
      } catch (err) {
        this.showError(`导入失败：${err.message}`);
      } finally {
        e.target.value = '';
      }
    };
    reader.readAsText(file);
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

window.addEventListener('DOMContentLoaded', () => {
  try {
    window.editor = new LabelEditor();
  } catch (err) {
    const el = document.getElementById('toast');
    el.textContent = `编辑窗口初始化失败：${err.message}`;
    el.hidden = false;
  }
});
