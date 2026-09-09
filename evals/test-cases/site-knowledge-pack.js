/**
 * Site Knowledge Pack（2026-08-20）—— 站点知识包 wiring 反证套件。
 *
 * 移植 browser-harness domain-skills 范式第一步：bilibili-knowledge 纯知识技能。
 * 与 src/test/bilibili-knowledge.test.js 互补：本套件在 eval 流水线中锁定
 * 「知识包被加载 → 被路由触发 → 被注入 system prompt」三连接线，防纸面定义
 * （项目历史 6 P0 + 27 P1 复盘结论：全部为 wiring 断层）。
 *
 * 全部用例不触网：纯 fs / 模块断言。
 */

const fs = require('fs');
const path = require('path');
const { SkillRouter, initializeRouter } = require('../../src/core/skill-router');
const skillSystem = require('../../src/core/skill-system');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SKILL_DIR = path.join(REPO_ROOT, 'skills', 'bilibili-knowledge');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');

function readRel(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

function freshRouterWithRegistry() {
  const router = new SkillRouter();
  router.setSkillRegistry(skillSystem.load({ force: true }));
  return router;
}

module.exports = {
  name: 'Site Knowledge Pack',
  cases: [
    {
      id: 'skp_001',
      name: 'SKILL.md frontmatter 齐全（name/version/description/metadata.crabpaw）',
      category: 'site-knowledge',
      run: () => {
        const md = readRel('skills/bilibili-knowledge/SKILL.md');
        return /^---\nname: bilibili-knowledge\nversion: 1\.0\.0\ndescription:/.test(md)
          && md.includes('metadata:')
          && md.includes('crabpaw:');
      },
    },
    {
      id: 'skp_002',
      name: '三个 references 文件存在且非空',
      category: 'site-knowledge',
      run: () => {
        for (const f of ['partitions.md', 'url-patterns.md', 'browser-fallback.md']) {
          const p = path.join(SKILL_DIR, 'references', f);
          if (!fs.existsSync(p)) return false;
          if (fs.statSync(p).size < 200) return false;
        }
        return true;
      },
    },
    {
      id: 'skp_003',
      name: '注入窗口：SKILL.md 前 3000 字符含关键知识 token（回归锁）',
      category: 'site-knowledge',
      run: () => {
        const md = fs.readFileSync(SKILL_MD, 'utf-8').slice(0, 3000);
        return ['BilibiliSearch', 'SceneMedia', 'result_type', 'qn', 'BV1', 'bilibili.com/read']
          .every((t) => md.includes(t));
      },
    },
    {
      id: 'skp_004',
      name: 'manifest noExecutor 登记 bilibili-knowledge',
      category: 'site-knowledge',
      run: () => {
        const manifest = JSON.parse(readRel('skills/manifest.json'));
        return Array.isArray(manifest.noExecutor) && manifest.noExecutor.includes('bilibili-knowledge');
      },
    },
    {
      id: 'skp_005',
      name: 'TASK_CATEGORIES.BILIBILI 存在且关键词/技能接线',
      category: 'site-knowledge',
      run: () => {
        const { TASK_CATEGORIES } = require('../../src/core/skill-router');
        const cls = TASK_CATEGORIES && TASK_CATEGORIES.BILIBILI;
        return !!cls
          && Array.isArray(cls.keywords) && cls.keywords.includes('b站')
          && Array.isArray(cls.skills) && cls.skills.includes('bilibili-knowledge');
      },
    },
    {
      id: 'skp_006',
      name: 'INTENT_PATTERNS 含 BILIBILI skillHint 条目且正则在样例上实测通过',
      category: 'site-knowledge',
      run: () => {
        const { INTENT_PATTERNS } = require('../../src/core/skill-router');
        const entries = INTENT_PATTERNS.filter(
          (p) => p.skillHint === 'bilibili-knowledge' && p.category === 'BILIBILI');
        if (entries.length === 0) return false;
        // skillHint 分支是无 executor 技能唯一可达路径（category/CapabilityRegistry 分支均跳过）
        // 接线语义：每个 B 站样例都至少被一条 BILIBILI 正则命中（非每条正则都有样例）
        const samples = ['帮我在B站搜一下罗翔的视频', '播放BV1GJ411x7h', '看av170001'];
        return samples.every((s) => entries.some((e) => e.pattern.test(s)));
      },
    },
    {
      id: 'skp_007',
      name: 'getRecommendedSkills 推荐 top-1 为 bilibili-knowledge',
      category: 'site-knowledge',
      run: () => {
        const recs = freshRouterWithRegistry().getRecommendedSkills('帮我在B站搜一下罗翔的视频');
        return recs.length > 0 && recs[0].name === 'bilibili-knowledge';
      },
    },
    {
      id: 'skp_008',
      name: '反例：热门新闻/股票分析不推荐 bilibili-knowledge',
      category: 'site-knowledge',
      run: () => {
        const router = freshRouterWithRegistry();
        for (const input of ['今天有什么热门新闻', '帮我分析一下这只股票']) {
          const recs = router.getRecommendedSkills(input);
          if (recs.some((r) => r.name === 'bilibili-knowledge')) return false;
        }
        return true;
      },
    },
    {
      id: 'skp_009',
      name: 'injectSkillGuidance 把知识注入 system prompt',
      category: 'site-knowledge',
      run: () => {
        const { injectSkillGuidance } = require('../../src/core/ai');
        initializeRouter(skillSystem.load({ force: true }));
        const messages = [{ role: 'system', content: '' }];
        const ok = injectSkillGuidance(messages, '帮我在B站搜一下罗翔的视频');
        // 断言对齐 2026-08-25 尾置段缓存优化：guidance 插入最后一条 user 前（保持
        // system/工具/历史前缀字节稳定），在无 user 的输入下 push 为末位 system 消息。
        const injected = messages.find(m => m.role === 'system' && m.content && m.content.includes('bilibili-knowledge'));
        return ok === true
          && !!injected
          && injected.content.includes('SceneMedia');
      },
    },
  ],
};
