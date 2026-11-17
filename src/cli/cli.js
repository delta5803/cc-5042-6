#!/usr/bin/env node
// 命令行仅作地图标注的辅助工具：离线布局报告、自检、静态服务。
// 图形入口是 src/ui/index.html 的矢量标注编辑窗口（见 README）。

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { View } from '../projection.js';
import { runLabeling, REJECT_REASONS } from '../labeler.js';
import { validateFeature } from '../features.js';
import { FakeTextMeasurer } from '../../test/helpers/fake-measurer.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const REASON_TEXT = {
  [REJECT_REASONS.OFF_CANVAS]: '超出画布边缘',
  [REJECT_REASONS.LABEL_COLLISION]: '标签碰撞',
  [REJECT_REASONS.MARKER_COLLISION]: '点标记碰撞',
  [REJECT_REASONS.OUTSIDE_REGION]: '区域外',
};

function loadFeatures(path) {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`文件不存在：${abs}`);
  const parsed = JSON.parse(readFileSync(abs, 'utf8'));
  const features = Array.isArray(parsed) ? parsed : parsed.features;
  if (!Array.isArray(features)) throw new Error('JSON 需为要素数组或包含 features 数组');
  features.forEach(validateFeature);
  return features;
}

function buildLayout(features, options = {}) {
  const v = new View({
    width: options.width ?? 1000,
    height: options.height ?? 800,
    scale: options.scale ?? 1,
    rotation: ((options.rotate ?? 0) * Math.PI) / 180,
    cx: options.cx ?? 500,
    cy: options.cy ?? 400,
    dpr: 1,
  });
  return runLabeling({ features, view: v, measurer: new FakeTextMeasurer() });
}

function printReport(layout) {
  const s = layout.stats;
  console.log('');
  console.log('=== 标注布局报告（离线度量，与引擎同一套选择/碰撞逻辑）===');
  console.log(
    `要素 ${s.total} | 已放置 ${s.placed} | 隐藏 ${s.hidden} | 放置率 ${(s.placementRate * 100).toFixed(1)}%`,
  );
  console.log('');
  console.log('处理顺序  结果  优先级  候选/主拒绝原因          名称');
  console.log('-'.repeat(78));
  const placedById = new Map(layout.labels.map((l) => [l.featureId, l]));
  const hiddenById = new Map(layout.hidden.map((h) => [h.featureId, h]));
  layout.orderedFeatureIds.forEach((id, i) => {
    const placed = placedById.get(id);
    const hidden = hiddenById.get(id);
    const feature = (placed || hidden).feature;
    const result = placed
      ? `显示(${placed.placement})`.padEnd(22, ' ')
      : `隐藏: ${hidden.allReasons.map((r) => REASON_TEXT[r] || r).join('/')}`.padEnd(22, ' ');
    console.log(
      `${String(i + 1).padStart(3, ' ')}      ${String(feature.priority).padStart(3, ' ')}     ${result}  ${feature.name}`,
    );
  });
  console.log('');
}

function startServer(port) {
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let filePath = normalize(join(ROOT, urlPath === '/' ? 'src/ui/index.html' : urlPath));
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
      res.end(readFileSync(filePath));
    } catch (err) {
      res.writeHead(500);
      res.end(err.message);
    }
  });
  server.listen(port, () => {
    console.log(`地图标注编辑窗口：http://localhost:${port}/src/ui/index.html`);
    console.log('（Ctrl+C 退出）');
  });
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === 'report') {
    const file = args._[0];
    if (!file) throw new Error('用法：cli.js report <features.json> [--width --height --rotate --scale]');
    const features = loadFeatures(file);
    const layout = buildLayout(features, {
      width: Number(args.width) || undefined,
      height: Number(args.height) || undefined,
      rotate: Number(args.rotate) || 0,
      scale: Number(args.scale) || undefined,
    });
    printReport(layout);
    if (args.json) {
      writeFileSync(
        args.json === true ? 'label-report.json' : args.json,
        JSON.stringify(
          {
            stats: layout.stats,
            labels: layout.labels.map((l) => ({
              featureId: l.featureId,
              placement: l.placement,
              rect: l.rect,
            })),
            hidden: layout.hidden.map((h) => ({
              featureId: h.featureId,
              primaryReason: h.primaryReason,
              allReasons: h.allReasons,
            })),
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  if (command === 'selfcheck') {
    const { sampleData } = await import('../ui/sample-data.js');
    const scenarios = [
      { name: '默认视图', options: {} },
      { name: '旋转 45°', options: { rotate: 45 } },
      { name: '放大 3×', options: { scale: 3 } },
      { name: '缩小 0.4×', options: { scale: 0.4 } },
      { name: '小视口 480×320', options: { width: 480, height: 320 } },
    ];
    for (const scenario of scenarios) {
      const layout = buildLayout(sampleData(), scenario.options);
      printReport(layout);
    }
    return;
  }

  if (command === 'serve') {
    startServer(Number(args.port) || 8080);
    return;
  }

  console.log(`地图标注引擎 CLI（辅助工具；图形入口见 src/ui/index.html）

用法：
  node src/cli/cli.js serve [--port 8080]           启动本地服务并打开编辑窗口
  node src/cli/cli.js report <features.json> [选项]  离线标注报告
    --width 1000 --height 800 --rotate 45 --scale 1.5
    --json [out.json]                                同时输出机器可读结果
  node src/cli/cli.js selfcheck                      示例数据多场景自检`);
}

main().catch((err) => {
  console.error(`错误：${err.message}`);
  process.exit(1);
});
