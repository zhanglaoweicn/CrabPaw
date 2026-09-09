/**
 * typhoon.test.js — 台风面板真实数据映射单测（2026-08-14 二次修复）
 *
 * 只测纯函数（mapToPanelData/parseRadiusString）：网络层（fetchActivityItems/
 * fetchTyphoonDetail）已有 typhoon-tools 的 eval 覆盖，这里不重复打网络。
 */

const { mapToPanelData, mapHistoryListItem, mapHistoryDetailToPanelData, parseRadiusString } = require('./typhoon');

describe('parseRadiusString — 风圈四象限字符串 → 圆形半径（均值）', () => {
  test('逗号分隔四象限', () => {
    expect(parseRadiusString('260,240,230,280')).toBe(253); // (260+240+230+280)/4 = 252.5 → 253
  });

  test('带前缀的象限字符串', () => {
    expect(parseRadiusString('NE:260;SE:240;SW:230;NW:280')).toBe(253);
  });

  test('单值', () => {
    expect(parseRadiusString('300')).toBe(300);
  });

  test('非法/空输入 → null（前端隐藏风圈）', () => {
    expect(parseRadiusString(null)).toBeNull();
    expect(parseRadiusString(undefined)).toBeNull();
    expect(parseRadiusString('')).toBeNull();
    expect(parseRadiusString('无数据')).toBeNull();
    expect(parseRadiusString(280)).toBeNull(); // 非字符串
  });
});

describe('mapToPanelData — 真实列表条目 + 详情 → 面板数据契约', () => {
  const item = {
    tfid: '202617', name: '浪卡', enname: 'NANGKA', lat: 21.5, lng: 125.3,
    strong: '台风', power: '13', pressure: 970, speed: 38,
    moveDir: '西北', moveSpeed: 20, radius7: '300,280', radius10: '120,100',
    warnLevel: 'orange',
  };

  test('详情完整路径（points + land）', () => {
    const detail = {
      name: '浪卡', enname: 'NANGKA', strong: '台风', power: '13',
      pressure: 968, speed: 40, moveDir: '西北', moveSpeed: 22,
      radius7: '320,300', radius10: '140,120', warnLevel: 'orange',
      lat: 21.8, lng: 124.9,
      land: [{ time: '2026-08-16 08:00:00', lat: 24.5, lng: 120.3 }],
      points: [
        { time: '2026-08-14 08:00:00', lat: 19.2, lng: 127.1, strong: '热带风暴', pressure: 985 },
        { time: '2026-08-15 08:00:00', lat: 21.8, lng: 124.9, strong: '台风', pressure: 968 },
      ],
      forecasts: [{ agency: 'CMA', pointCount: 5, summary: 'x' }],
    };
    const d = mapToPanelData(item, detail);

    expect(d.id).toBe('202617');
    expect(d.name).toBe('浪卡');
    expect(d.level).toBe('台风');
    expect(d.centerPressure).toBe(968);   // 详情优先
    expect(d.maxWindSpeed).toBe(40);
    expect(d.position).toEqual({ lat: 21.8, lon: 124.9 }); // 详情坐标优先
    expect(d.windRadii).toEqual({ r7: 310, r10: 130 });    // (320+300)/2, (140+120)/2
    expect(d.history).toHaveLength(2);
    expect(d.history[0]).toEqual({ time: '2026-08-14 08:00:00', lat: 19.2, lon: 127.1, level: '热带风暴', pressure: 985, speed: null, radius7: null, radius10: null });
    expect(d.forecast).toEqual([]); // 详情未提供 forecastTrack → 空（无预报数据不编造）
    expect(d.tracks).toBeUndefined(); // tracks 由 getTyphoon 装配，mapToPanelData 不填
    expect(d.landfall).toEqual({ time: '2026-08-16 08:00:00', place: '东经120.3°、北纬24.5°' });
    expect(d.warnLevel).toBe('orange');
    expect(d.alerts.length).toBeGreaterThan(0);
    expect(d.disclaimer).toContain('官方');
    expect(d.updatedAt).toBeTruthy();
  });

  test('详情获取失败 → 列表条目兜底（无路径点/无登陆点，不虚构）', () => {
    const d = mapToPanelData(item, null);

    expect(d.name).toBe('浪卡');
    expect(d.centerPressure).toBe(970);   // 列表字段兜底
    expect(d.position).toEqual({ lat: 21.5, lon: 125.3 });
    expect(d.windRadii).toEqual({ r7: 290, r10: 110 });
    expect(d.history).toEqual([]);
    expect(d.forecast).toEqual([]);
    expect(d.landfall).toBeNull();
  });

  test('坐标为 null → position null（前端如实空态，不渲染地图）', () => {
    const d = mapToPanelData({ ...item, lat: null, lng: null }, null);
    expect(d.position).toBeNull();
  });

  // 2026-08-26: 实测源 centerlat/centerlng 滞后于 points 最新点（202618: center
  // 22.8/141.0 vs 路径终点 27.4/128.1，相距 ~1300km）——位置必须取最新路径点。
  test('位置取最新路径点而非滞后的 centerlat/centerlng', () => {
    const detail = {
      name: '沙德尔', lat: 22.8, lng: 141.0, strong: '强台风',
      points: [
        { time: '2026-08-25 14:00:00', lat: 26.7, lng: 130.1, strong: '强台风', pressure: 955 },
        { time: '2026-08-26 02:00:00', lat: 27.4, lng: 128.1, strong: '强台风', pressure: 955 },
      ],
    };
    const d = mapToPanelData(item, detail);
    expect(d.position).toEqual({ lat: 27.4, lon: 128.1 }); // 最新路径点
    expect(d.history).toHaveLength(2);
  });

  // 2026-08-26: 主源 current.forecast 实测带坐标（中国机构）——透传虚线预报路径；
  // 无 forecastTrack（备源/旧详情）仍为空数组，不编造。
  test('forecastTrack 透传 → 预报路径点（前端画虚线）', () => {
    const detail = {
      name: '沙德尔', lat: 27.4, lng: 128.1, strong: '强台风',
      points: [{ time: '2026-08-26 02:00:00', lat: 27.4, lng: 128.1, strong: '强台风', pressure: 955 }],
      forecastTrack: [
        { time: '2026-08-26 08:00:00', lat: 27.1, lng: 123.5, strong: '台风', pressure: 970 },
        { time: '2026-08-27 08:00:00', lat: 26.4, lng: 118.7, strong: '强热带风暴', pressure: 985 },
      ],
    };
    const d = mapToPanelData(item, detail);
    expect(d.forecast).toHaveLength(2);
    expect(d.forecast[0]).toEqual({ time: '2026-08-26 08:00:00', lat: 27.1, lon: 123.5, level: '台风', pressure: 970, speed: null });
    expect(d.forecast[1].level).toBe('强热带风暴');
  });
});

describe('历史台风归一化（2026-08-16 历史入口, apizero status=all）', () => {
  test('mapHistoryListItem — 原始列表条目 → 面板条目（中文状态标签）', () => {
    const it = mapHistoryListItem({
      id: '3285913', tc_num: '20260015', name_cn: '热带低压', name_en: 'nameless',
      state: 'stop', is_active: false,
    });
    expect(it.id).toBe('3285913');
    expect(it.tcNum).toBe('20260015');
    expect(it.name).toBe('热带低压');
    expect(it.stateLabel).toBe('已停编');
    expect(it.isActive).toBe(false);
  });

  test('mapHistoryListItem — 未知状态显示原文（诚实映射）', () => {
    const it = mapHistoryListItem({ id: 'x', state: 'weird' });
    expect(it.stateLabel).toBe('weird');
  });

  test('mapHistoryDetailToPanelData — 实测响应结构 → 面板契约（完整路径 + 当前状态）', () => {
    const d = mapHistoryDetailToPanelData({
      id: '3285913', tc_num: '20260015', name_cn: '热带低压', name_en: 'nameless', is_active: false,
      current: {
        time_cst: '2026-08-03 08:00', grade: '热带低压',
        longitude: 123.4, latitude: 16.5, pressure: 1005, wind_speed: 12, wind_dir: '北西北',
      },
      point_count: 2,
      points: [
        { time_cst: '2026-08-01 20:00', grade: '热带低压', longitude: 125.5, latitude: 14.7, pressure: 1002, wind_speed: 15 },
        { time_cst: '2026-08-02 20:00', grade: '台风', longitude: 124.1, latitude: 15.9, pressure: 990, wind_speed: 38 },
      ],
    });

    expect(d.id).toBe('20260015');                    // tc_num 作面板编号
    expect(d.name).toBe('热带低压');
    expect(d.level).toBe('热带低压');                  // current.grade
    expect(d.levelCode).toBe(7);
    expect(d.position).toEqual({ lat: 16.5, lon: 123.4 });
    expect(d.centerPressure).toBe(1005);
    expect(d.maxWindSpeed).toBe(12);
    expect(d.moveDir).toBe('北西北');
    expect(d.windRadii).toBeNull();                   // apizero 无风圈 → 诚实空
    expect(d.landfall).toBeNull();
    expect(d.warnLevel).toBe('');
    expect(d.isHistory).toBe(true);
    expect(d.history).toHaveLength(2);
    expect(d.history[0]).toEqual({ time: '2026-08-01T20:00', lat: 14.7, lon: 125.5, level: '热带低压', pressure: 1002, speed: 15 });
    expect(d.history[1].level).toBe('台风');           // 路径点各自强度（前端分段着色用）
    expect(d.history[1].speed).toBe(38);               // 2026-08-16: apizero wind_speed 透传（hover 风力标注）
    expect(d.forecast).toEqual([]);
  });

  test('mapHistoryDetailToPanelData — 路径点乱序 → 按时间正序', () => {
    const d = mapHistoryDetailToPanelData({
      tc_num: '1', points: [
        { time_cst: '2026-08-02 20:00', grade: '台风', longitude: 124.1, latitude: 15.9 },
        { time_cst: '2026-08-01 20:00', grade: '热带低压', longitude: 125.5, latitude: 14.7 },
      ],
    });
    expect(d.history[0].time).toBe('2026-08-01T20:00');
    expect(d.history[1].time).toBe('2026-08-02T20:00');
  });

  test('mapHistoryDetailToPanelData — 无 current/无路径点 → 空态字段（不虚构）', () => {
    const d = mapHistoryDetailToPanelData({ tc_num: '2', points: [] });
    expect(d.position).toBeNull();
    expect(d.level).toBe('');
    expect(d.history).toEqual([]);
  });
});
