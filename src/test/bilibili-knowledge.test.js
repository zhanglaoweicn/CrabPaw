/**
 * B站站点知识包反证测试（wiring 三连：加载 → 触发 → 注入）。
 *
 * 移植 browser-harness domain-skills 范式第一步：bilibili-knowledge 纯知识技能。
 * 反证原则：断言"知识包真的被加载、被路由命中、被注入 system prompt"，
 * 防纸面定义（本项目历史 6 P0 + 27 P1 复盘结论：全部为 wiring 断层）。
 *
 * 关键机制（实现时核对）：
 * - skillHint 分支（skill-router.getRecommendedSkills L510-535）是无 executor 技能的
 *   唯一可达路径（category 分支 L547-551 与 CapabilityRegistry 分支 L584-587 都跳过）；
 * - injectSkillGuidance（ai.js L1057-1111）读 SKILL.md 前 3000 字符注入 system prompt。
 */
const fs = require('fs');
const path = require('path');
const { SkillRouter, initializeRouter } = require('../core/skill-router');
const skillSystem = require('../core/skill-system');

const SKILL_DIR = path.join(__dirname, '..', '..', 'skills', 'bilibili-knowledge');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');
const MANIFEST = path.join(__dirname, '..', '..', 'skills', 'manifest.json');

function loadRegistry() {
  return skillSystem.load({ force: true });
}

describe('bilibili-knowledge 站点知识包 wiring', () => {
  test('T1 技能加载：bilibili-knowledge 进入注册表且无 executor', () => {
    const reg = loadRegistry();
    const skill = reg['bilibili-knowledge'];
    expect(skill).toBeTruthy();
    expect(skill.hasExecutor).toBe(false);
    expect(fs.existsSync(skill.filePath)).toBe(true);
  });

  test('T2 注入窗口：SKILL.md 前 3000 字符含关键知识 token（回归锁）', () => {
    const md = fs.readFileSync(SKILL_MD, 'utf-8').slice(0, 3000);
    for (const token of ['BilibiliSearch', 'SceneMedia', 'result_type', 'qn', 'BV1', 'bilibili.com/read']) {
      expect(md).toContain(token);
    }
  });

  test('T3 路由命中：B站搜索意图 → BILIBILI + bilibili-knowledge 推荐 top-1', () => {
    const router = new SkillRouter();
    router.setSkillRegistry(loadRegistry());
    const cls = router.classifyTask('帮我在B站搜一下罗翔的视频');
    expect(cls.category).toBe('BILIBILI');
    expect(cls.skillHint).toBe('bilibili-knowledge');
    const recs = router.getRecommendedSkills('帮我在B站搜一下罗翔的视频');
    expect(recs[0].name).toBe('bilibili-knowledge');
  });

  test('T4 BV/AV 号触发', () => {
    const router = new SkillRouter();
    router.setSkillRegistry(loadRegistry());
    expect(router.classifyTask('播放BV1GJ411x7h').category).toBe('BILIBILI');
    expect(router.classifyTask('看av170001').category).toBe('BILIBILI');
  });

  test('T5 误触发反例：热门/PDF/英文含 av 前缀词均不命中 BILIBILI', () => {
    const router = new SkillRouter();
    router.setSkillRegistry(loadRegistry());
    for (const input of ['今天有什么热门新闻', '帮我把这个文件转成PDF', 'the average cost', 'available']) {
      expect(router.classifyTask(input).category).not.toBe('BILIBILI');
    }
  });

  test('T6 manifest noExecutor 登记', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
    expect(manifest.noExecutor).toContain('bilibili-knowledge');
  });

  test('T7 _skillHasExecutor 判定为 false（无 executor 文件）', () => {
    const router = new SkillRouter();
    expect(router._skillHasExecutor({ name: 'bilibili-knowledge', baseDir: SKILL_DIR })).toBe(false);
  });

  test('T8 端到端注入：injectSkillGuidance 把知识注入 system prompt（尾置段）', () => {
    const { injectSkillGuidance } = require('../core/ai');
    initializeRouter(loadRegistry());
    // 2026-08-25 缓存优化约定: guidance 追加到最后一条 user 前(或末尾), 不再污染
    // messages[0] 稳定 system 前缀(DеepSeek 前缀缓存命中的关键)。
    const messages = [{ role: 'system', content: '' }, { role: 'user', content: '帮我在B站搜一下罗翔的视频' }];
    const ok = injectSkillGuidance(messages, '帮我在B站搜一下罗翔的视频');
    expect(ok).toBe(true);
    const joined = messages.map(m => (m.content || '')).join('\n');
    expect(joined).toContain('bilibili-knowledge');
    expect(joined).toContain('SceneMedia');
    expect(messages[0].content).not.toContain('bilibili-knowledge'); // 稳定前缀不被污染
  });
});
