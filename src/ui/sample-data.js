// 示例数据：密集点群、长短混合与多文字体系名称、贴近/跨越画布边缘的点、区域要素。
// 坐标为世界坐标，初始视图中心 (500,400)、缩放 1。

import { makePointFeature, makeRegionFeature } from '../features.js';

export function sampleData() {
  const features = [];

  // 1) 密集点群：5×6 网格、间距 26 世界单位，名称长短与文字体系混合
  const denseNames = [
    'W', '中央公园 Central Park', '故宫博物院', '東京タワー',
    'Москва', 'محمية طبيعية', 'Île-de-France', '一个非常非常非常长的中文地名标签',
    'San Francisco', '서울특별시', 'Αθήνα', 'i',
    'København', 'القاهرة', 'São Paulo dos Campos', 'Berlín',
    '日月潭', 'Óváros', 'Łódź', 'Žilina',
    '新城', 'Ακρόπολη Αθηνών', 'תל אביב', 'Tórshavn',
    'บางกอก', 'Thành phố Hồ Chí Minh', 'ལྷ་ས', 'München',
    '大阪市中央区本町', 'Genève', 'Reykjavíkurborg', 'Ερμούπολη',
  ];
  let k = 0;
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 5; col++) {
      features.push(
        makePointFeature({
          name: denseNames[k % denseNames.length],
          x: 300 + col * 26 + (row % 2) * 6,
          y: 180 + row * 26,
          priority: (k % 4 === 0 ? 2 : 0) + (k % 7 === 0 ? 1 : 0),
          fontSize: k % 5 === 0 ? 15 : 12,
        }),
      );
      k += 1;
    }
  }

  // 2) 跨画布边缘点（初始视口约 0–1000 / 0–800）
  features.push(
    makePointFeature({ id: 'edge-left', name: '左边缘标签 Left Edge', x: 8, y: 120, priority: 3 }),
    makePointFeature({ id: 'edge-right', name: '右边缘标签 Right Edge', x: 992, y: 260, priority: 3 }),
    makePointFeature({ id: 'edge-top', name: '顶部边缘', x: 500, y: 6, priority: 1 }),
    makePointFeature({ id: 'edge-bottom', name: '底部边缘标签 Bottom Edge Label', x: 520, y: 794, priority: 1 }),
    makePointFeature({ id: 'corner-ne', name: '东北角 NE Corner', x: 985, y: 12, priority: 2 }),
  );

  // 3) 高优先与低优先近距离对照：验证高优先先占位、低优先换候选或被隐藏并给出原因
  features.push(
    makePointFeature({ id: 'hi-1', name: '高优先枢纽 High Priority Hub', x: 760, y: 520, priority: 5, fontSize: 15 }),
    makePointFeature({ id: 'lo-1', name: '低优先站点', x: 778, y: 524, priority: 0 }),
    makePointFeature({ id: 'lo-2', name: '次级站点 Secondary', x: 744, y: 536, priority: 0 }),
  );

  // 4) 区域：一个大多边形和一个小多边形，含长名称
  features.push(
    makeRegionFeature({
      id: 'region-lake',
      name: '青云湖流域 Qingyun Lake Watershed（长区域名称测试）',
      ring: [
        { x: 120, y: 480 },
        { x: 240, y: 440 },
        { x: 400, y: 470 },
        { x: 470, y: 560 },
        { x: 420, y: 690 },
        { x: 260, y: 720 },
        { x: 140, y: 650 },
        { x: 96, y: 560 },
      ],
      priority: 1,
      fontSize: 14,
    }),
    makeRegionFeature({
      id: 'region-park',
      name: '河畔公园',
      ring: [
        { x: 620, y: 620 },
        { x: 760, y: 600 },
        { x: 820, y: 700 },
        { x: 740, y: 770 },
        { x: 630, y: 730 },
      ],
      priority: 2,
    }),
  );

  // 5) 区域内点：地理上位于区域内部，验证屏幕碰撞与“在区域内”是两回事
  features.push(
    makePointFeature({ id: 'in-region-1', name: '湖中心观测站', x: 270, y: 580, priority: 4 }),
    makePointFeature({ id: 'in-region-2', name: '码头 Pier', x: 300, y: 600, priority: 0 }),
  );

  return features;
}
