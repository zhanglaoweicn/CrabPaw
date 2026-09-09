/**
 * 股票名称搜索多源降级解析测试（2026-08-21）
 *
 * 实机 bug：688836 宇树科技（新股上市 3 天）→ 东财 suggest 未收录 → null →
 * WebSearch 兜底返回"宇"字字典页 → 空态卡。腾讯/新浪 suggest 收录更及时
 * （实测双中 688836），故 searchStockByName 降级链 + 纯函数解析锚点：
 * 网络链路免测（真网调用不稳定），解析逻辑单测锁定。
 */

const { _parseTencentResult, _parseSinaResult } = require('../tools/stock/stock-utils');

describe('_parseTencentResult（smartbox 响应解析）', () => {
  test('标准响应提取首个 A 股条目', () => {
    const raw = 'v_hint="sh~688836~\\u5b87\\u6811\\u79d1\\u6280W~yskjw~GP-A-KCB;sz~300674~yuxin~yxkj~GP-A"';
    const hit = _parseTencentResult(raw);
    expect(hit).toEqual({ code: '688836', market: 'SH' });
  });

  test('无引号包裹的裸响应同样可解析', () => {
    const hit = _parseTencentResult('v_hint="sz~000858~wly~wly~GP-A"');
    expect(hit).toEqual({ code: '000858', market: 'SZ' });
  });

  test('港股代码（5位）也支持', () => {
    const hit = _parseTencentResult('v_hint="hk~00700~tencent~tc~HK"');
    expect(hit).toEqual({ code: '00700', market: 'HK' });
  });

  test('无有效条目 → null', () => {
    expect(_parseTencentResult('v_hint="~abc~"')).toBeNull();
    expect(_parseTencentResult('')).toBeNull();
    expect(_parseTencentResult(null)).toBeNull();
  });
});

describe('_parseSinaResult（suggest 响应解析，GBK 源只取 ASCII 字段）', () => {
  test('标准响应提取代码与市场', () => {
    // GBK 中文名在 latin1 下为乱码字节，但代码/市场字段 ASCII 不受影响
    const raw = 'var suggestvalue="ÓîÊ÷¿Æ¼¼,11,688836,sh688836,,,ÓîÊ÷¿Æ¼¼,99,1,,,;ÓîÐÅ¿Æ¼¼,11,300674,sz300674,,,ÓîÐÅ¿Æ¼¼,99,1,,,;"';
    const hit = _parseSinaResult(raw);
    expect(hit).toEqual({ code: '688836', market: 'SH' });
  });

  test('取首个条目（同名多股时取第一个）', () => {
    const raw = 'var suggestvalue="ÓîÊ÷,11,300674,sz300674,,,ÓîÊ÷,11,688836,sh688836,,,;"';
    const hit = _parseSinaResult(raw);
    expect(hit.code).toBe('300674');
  });

  test('无有效条目 → null', () => {
    expect(_parseSinaResult('var suggestvalue=""')).toBeNull();
    expect(_parseSinaResult(null)).toBeNull();
    expect(_parseSinaResult('not a suggest response')).toBeNull();
  });
});
