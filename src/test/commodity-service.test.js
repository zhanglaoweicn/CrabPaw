/**
 * commodity-service.test.js — 商品查询服务纯函数（多模态解析/规范化）
 */
const { parseItemsText, parseAriaText } = require('../core/commodity/commodity-service');

describe('commodity-service 纯函数', () => {
  test('parseItemsText 正常 JSON 提取+规范化', () => {
    const r = parseItemsText('{"items":[{"name":"小米手机 14","price":"¥3999.00","sales":"已售1万+","shop":"小米官方旗舰店"},{"name":"耳机","price":199,"sales":"","shop":""}]}');
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ name: '小米手机 14', price: 3999, sales: '已售1万+', shop: '小米官方旗舰店' });
    expect(r.items[1].price).toBe(199);
  });

  test('markdown 围栏包裹（LLM 常见输出）也能提取', () => {
    const r = parseItemsText('```json\n{"items":[{"name":"键盘","price":129,"sales":"","shop":"店A"}]}\n```');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].name).toBe('键盘');
  });

  test('note 透传（需要登录/无结果）', () => {
    expect(parseItemsText('{"items":[],"note":"需要登录"}').note).toBe('需要登录');
    expect(parseItemsText('{"items":[]}').items).toEqual([]);
  });

  test('异常/非 JSON → 解析失败空数组', () => {
    expect(parseItemsText('这段文字没有JSON').items).toEqual([]);
    expect(parseItemsText('')).toEqual({ items: [], note: null });
    expect(parseItemsText('{"items":"不是数组"}').note).toBe('结构异常');
  });

  test('parseAriaText 启发式行程提取（价格锚）', () => {
    const aria = '小米手机 14\n¥3999\n华为 Mate60\n¥5499 已售200';
    const items = parseAriaText(aria);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].name).toContain('小米手机');
    expect(items[0].price).toBeGreaterThan(0);
  });
});
