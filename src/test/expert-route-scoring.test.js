/**
 * expert-route-scoring.test.js — 专家路由评分回归（2026-09-07 误路由修复）
 *
 * 实测场景：用户点名"财务分析师"，旧归一化分制下该专家 6 个关键词
 * (maxScore=7)只得 14 分低于激活下限 15，而消息里"数据"两字命中
 * tech_digital 部门别名，给仅 2 关键词的"反馈分析师"加成 33 分反超激活。
 *
 * 修复后分档：精确点名 +100 / 岗位别名 +80 / 关键词每命中 +20(上限 60) /
 * 部门别名主管 +20 成员 +10；tech_digital 别名移除"数据/系统/软件/网站"。
 */
const { registry: _unused } = require('../tools/registry');
const experts = require('../core/experts');
const { MIN_SCORE: ACTIVATION_MIN_SCORE } = require('../core/expert-context');

const NAMED_ANALYST_MSG = '让财务分析师基于这份销售明细的全量数据（128 行），按区域×产品线分析销售额结构，找出最强组合和最弱区域，并生成一个 HTML 可视化页面。';

describe('专家路由评分（2026-09-07 误路由修复回归）', () => {
  test('精确点名：消息含专家名 → 该专家最高分且超过激活下限', () => {
    const results = experts.routeMessage(NAMED_ANALYST_MSG);
    expect(results.length).toBeGreaterThan(0);
    const named = results.find(r => r.name === '财务分析师');
    expect(named).toBeDefined();
    expect(named.reason).toContain('精确点名');
    expect(named.score).toBeGreaterThanOrEqual(100);
    expect(results[0].expertId).toBe(named.expertId);
  });

  test('误路由反例：泛部门词不再让"反馈分析师"反超激活线', () => {
    const results = experts.routeMessage(NAMED_ANALYST_MSG);
    const feedback = results.find(r => r.name === '反馈分析师');
    if (feedback) {
      expect(feedback.score).toBeLessThan(ACTIVATION_MIN_SCORE);
    }
  });

  test('部门别名收窄：纯"数据"泛化消息不激活任何 tech_digital 成员', () => {
    const results = experts.routeMessage('分析一下我上传的销售数据表格');
    const activated = results.filter(r => r.score >= ACTIVATION_MIN_SCORE && r.department === 'tech_digital');
    expect(activated).toEqual([]);
  });

  test('部门点名：主管加成高于成员（叫财务来看看 → 财务顾问首位）', () => {
    const results = experts.routeMessage('叫财务来看看这个月的账');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].expertId).toBe('finance_advisor');
    expect(results[0].departmentMatched).toBe(true);
  });

  test('岗位别名：小红书 → 小红书运营专员首位（别名 80 分档）', () => {
    const results = experts.routeMessage('小红书怎么运营');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].expertId).toBe('marketing-xiaohongshu-specialist');
  });

  test('泊车岗位不回流自动路由', () => {
    const results = experts.routeMessage('帮我写个游戏 mod');
    expect(results).toEqual([]);
  });
});
