/**
 * mentions 单元测试——@提及召唤（2026-09-05 部门化 P4）
 * 解析纯函数：resolve 注入，四形态(部门/岗位/未知/歧义)全覆盖。
 */

const { parseExpertMentions, MENTION_RE } = require('./mentions');

/** 按 experts.resolveSummon 的真实四形态做的 fake resolve */
function makeResolve(overrides = {}) {
  return (query) => {
    if (overrides[query] !== undefined) return overrides[query];
    if (query === '财务部') return { type: 'department', department: { id: 'finance', label: '财务部', lead: 'finance_advisor', memberCount: 10 }, members: [] };
    if (query === '小红书') return { type: 'expert', expert: { id: 'marketing-xiaohongshu-specialist', name: '小红书专员', departmentLabel: '营销部' } };
    if (query === '歧义词') return { type: 'ambiguous', candidates: [{ id: 'a' }, { id: 'b' }] };
    return null;
  };
}

describe('parseExpertMentions 解析四形态', () => {
  test('① 部门别名: @财务部 → department, token 从消息移除', () => {
    const r = parseExpertMentions('@财务部 看看这个月的账', { resolve: makeResolve() });
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0].resolution.type).toBe('department');
    expect(r.cleanedMessage).toBe('看看这个月的账');
  });

  test('② 岗位别名: @小红书 → expert', () => {
    const r = parseExpertMentions('帮我问 @小红书 笔记怎么写', { resolve: makeResolve() });
    expect(r.tokens[0].resolution.type).toBe('expert');
    expect(r.cleanedMessage).toBe('帮我问 笔记怎么写');
  });

  test('③ 未知 @词保留原文(邮箱/普通@词不误伤)', () => {
    const r = parseExpertMentions('发邮件到 user@gmail.com 问一下', { resolve: makeResolve() });
    expect(r.tokens.every((t) => !t.resolution)).toBe(true);
    expect(r.cleanedMessage).toBe('发邮件到 user@gmail.com 问一下');
  });

  test('④ 歧义 @词保留原文(交给关键词路由/消歧交互)', () => {
    const r = parseExpertMentions('问问 @歧义词 吧', { resolve: makeResolve() });
    expect(r.tokens[0].resolution.type).toBe('ambiguous');
    expect(r.cleanedMessage).toContain('@歧义词');
  });

  test('多 mention: 全部解析并全部移除', () => {
    const r = parseExpertMentions('@财务部 和 @小红书 都看看', { resolve: makeResolve() });
    expect(r.tokens).toHaveLength(2);
    expect(r.cleanedMessage).toBe('和 都看看');
  });

  test('无 @: 原样返回', () => {
    const r = parseExpertMentions('普通消息没有任何提及', { resolve: makeResolve() });
    expect(r.tokens).toHaveLength(0);
    expect(r.cleanedMessage).toBe('普通消息没有任何提及');
  });

  test('MENTION_RE 边界: @后空白/标点即截断, 超长截到 24 字符', () => {
    // g 标志的 String.match 不含捕获组——用 source 重建无 g 正则取捕获组
    const capture = (text) => text.match(new RegExp(MENTION_RE.source))[1];
    expect(capture('@财务部 看看')).toBe('财务部');
    expect(capture('@财务部，帮我')).toBe('财务部');
    expect(capture('@' + 'a'.repeat(30)).length).toBe(24);
  });
});
