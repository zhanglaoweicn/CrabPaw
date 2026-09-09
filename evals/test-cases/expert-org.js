/**
 * Expert Org（部门化组织）—— 部门化重组 P1 的登记纪律套件（2026-09-04）。
 *
 * 断言四层事实：
 *  1. 部门注册表完整性——七部门齐备、别名可用、主管可解析、每部门有在编成员
 *  2. 导入管线产物——experts-org.json 全量 267 位带组织字段，在编/泊车分布合理
 *  3. 两级路由——部门别名命中、岗位别名强命中、泊车岗位被排除在自动路由之外
 *  4. 召唤解析四形态——id/岗位别名→expert、部门→department、未知→null、泊车显式可达
 * 套件红 = 有人破坏组织层（删部门/清别名/让泊车回流路由/管线产物损坏）。
 */

const fs = require('fs');
const path = require('path');

// 工具自注册副作用（与 wiring-invariants 同因：registry 需由 src/tools 装配）
require('../../src/tools');

const experts = require('../../src/core/experts');
const { DEPARTMENT_IDS, TEAM_PRESETS } = require('../../src/core/experts/departments');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ORG_FILE = path.join(REPO_ROOT, 'data', 'experts-org.json');

module.exports = {
  name: 'Expert Org (部门化组织)',
  cases: [
    {
      id: 'eorg_001',
      name: '部门注册表完整性: 七部门齐备/别名可用/主管可解析/每部门有在编成员',
      category: 'expert-org',
      run: async () => {
        if (DEPARTMENT_IDS.length !== 7) throw new Error(`部门数 ${DEPARTMENT_IDS.length} ≠ 7`);
        const depts = experts.getDepartments();
        const problems = [];
        for (const d of depts) {
          if (!d.label || (d.voiceAliases || []).length < 3) problems.push(`${d.id} 缺 label/别名`);
          if (!d.lead) problems.push(`${d.id} 无主管(成员为空?)`);
          if (d.memberCount === 0) problems.push(`${d.id} 在编成员为 0`);
        }
        if (problems.length > 0) throw new Error(`部门问题:\n  ${problems.join('\n  ')}`);
        return `七部门在编: ${depts.map(d => `${d.label}${d.memberCount}`).join(' ')}`;
      },
    },
    {
      id: 'eorg_002',
      name: '导入管线产物: 全量带组织字段, 在编/泊车分布合理, 星标岗位断言',
      category: 'expert-org',
      run: async () => {
        if (!fs.existsSync(ORG_FILE)) throw new Error('data/experts-org.json 不存在——导入管线未跑(npm run experts:org)');
        const org = JSON.parse(fs.readFileSync(ORG_FILE, 'utf8'));
        const list = org.experts || [];
        if (list.length !== 267) throw new Error(`组织库 ${list.length} ≠ 267(源数据被改动?)`);
        const bad = list.filter(e => !['active', 'parked'].includes(e.status)
          || (e.status === 'active' && !e.department));
        if (bad.length > 0) throw new Error(`${bad.length} 位缺合法 status/department: ${bad.slice(0, 3).map(e => e.id).join(',')}`);
        const active = list.filter(e => e.status === 'active').length;
        if (active < 60 || active > 120) throw new Error(`在编 ${active} 超出 [60,120] 合理区间——编制政策被改动?`);
        const xhs = list.find(e => e.id === 'marketing-xiaohongshu-specialist');
        if (!xhs || xhs.department !== 'marketing' || xhs.status !== 'active' || !(xhs.aliases || []).includes('小红书')) {
          throw new Error('星标岗位 marketing-xiaohongshu-specialist 组织字段异常');
        }
        const parked = list.length - active;
        return `全量 267: 在编 ${active} / 泊车 ${parked}`;
      },
    },
    {
      id: 'eorg_003',
      name: '两级路由: 部门别名命中/岗位别名强命中/泊车岗位被排除',
      category: 'expert-org',
      run: async () => {
        const r1 = experts.routeMessage('叫财务来看看这个月的账');
        if (!r1.length || r1[0].expertId !== 'finance_advisor') {
          throw new Error(`"叫财务来看看" 首位应为 finance_advisor, 实际 ${r1[0]?.expertId || '无'}`);
        }
        const r2 = experts.routeMessage('小红书怎么运营');
        if (!r2.length || r2[0].expertId !== 'marketing-xiaohongshu-specialist') {
          throw new Error(`"小红书怎么运营" 首位应为小红书专员, 实际 ${r2[0]?.expertId || '无'}`);
        }
        const r3 = experts.routeMessage('帮我写个游戏 mod');
        if (r3.length > 0) throw new Error(`泊车岗位回流自动路由: ${r3.map(r => r.expertId).join(',')}`);
        // 部门命中标记存在
        if (!r1[0].departmentMatched) throw new Error('finance_advisor 未标记 departmentMatched(部门别名命中丢失)');
        return `路由: 财务部点名✓ 岗位别名✓ 泊车排除✓`;
      },
    },
    {
      id: 'eorg_004',
      name: '召唤解析四形态: id/岗位别名→expert, 部门→department, 未知→null, 泊车显式可达',
      category: 'expert-org',
      run: async () => {
        const s1 = experts.resolveSummon('finance_advisor');
        if (!s1 || s1.type !== 'expert') throw new Error('id 召唤失败');
        const s2 = experts.resolveSummon('小红书');
        if (!s2 || s2.type !== 'expert' || s2.expert.id !== 'marketing-xiaohongshu-specialist') {
          throw new Error(`"小红书" 应精确命中岗位(优先于部门), 实际 ${s2?.type}:${s2?.expert?.id || ''}`);
        }
        const s3 = experts.resolveSummon('财务部');
        if (!s3 || s3.type !== 'department' || s3.department.lead !== 'finance_advisor') {
          throw new Error('"财务部" 应命中部门且主管为 finance_advisor');
        }
        if (experts.resolveSummon('完全不存在的岗位xyz') !== null) throw new Error('未知 query 应返回 null');
        const s4 = experts.resolveSummon('engineering-cms-developer');
        if (!s4 || s4.type !== 'expert' || s4.expert.status !== 'parked') {
          throw new Error('泊车岗位应可显式召唤(外部人才库语义)');
        }
        return `召唤: id✓ 别名✓ 部门✓ 泊车显式可达✓`;
      },
    },
    {
      id: 'eorg_005',
      name: '预设班组: 模板岗位全部真实存在且成员数达标',
      category: 'expert-org',
      run: async () => {
        const presets = experts.getTeamPresets();
        if (presets.length !== TEAM_PRESETS.length) throw new Error(`班组 ${presets.length} ≠ 模板 ${TEAM_PRESETS.length}`);
        const problems = [];
        for (const p of presets) {
          if (p.memberCount < 2) problems.push(`${p.label} 仅 ${p.memberCount} 人(模板引用了不存在的岗位?)`);
          for (const id of p.expertIds) {
            if (!experts.getExpert(id)) problems.push(`${p.label} 引用不存在岗位: ${id}`);
          }
        }
        if (problems.length > 0) throw new Error(`班组问题:\n  ${problems.join('\n  ')}`);
        return `班组: ${presets.map(p => `${p.label}${p.memberCount}人`).join(' ')}`;
      },
    },
    {
      id: 'eorg_008',
      name: '技能面偏置: 本岗位×1.3/非岗位×0.3(纯函数) + getRecommendedSkills userId 链路',
      category: 'expert-org',
      run: async () => {
        const { SkillRouter } = require('../../src/core/skill-router');
        const { activateExpert, getActiveExpertSkills, reset } = require('../../src/core/expert-context');
        // 1) 纯函数: 加权/降权/排序
        const recs = SkillRouter.applyExpertSkillBias([
          { name: 'report-generator', score: 1.0 },
          { name: 'code-review', score: 1.0 },
        ], ['report-generator', 'excel-xlsx']);
        const rg = recs.find(r => r.name === 'report-generator');
        const cr = recs.find(r => r.name === 'code-review');
        if (Math.abs(rg.score - 1.3) > 1e-9) throw new Error(`本岗位未加权: ${rg.score}`);
        if (Math.abs(cr.score - 0.3) > 1e-9) throw new Error(`非岗位未降权: ${cr.score}`);
        if (recs[0].name !== 'report-generator') throw new Error('偏置后排序错误');
        // 2) userId 链路: 财务专家激活 → hint 命中 → 分数带 1.3 偏置
        const uid = 'eorg_skill_user';
        try {
          activateExpert(uid, 'finance_advisor', { source: 'eval' });
          if (!getActiveExpertSkills(uid)?.includes('report-generator')) throw new Error('财务技能包缺 report-generator');
          const router = new SkillRouter({});
          router.setSkillRegistry({ 'report-generator': { name: 'report-generator' } });
          router.classifyTask = () => ({ skillHint: 'report-generator', confidence: 0.8, category: null });
          const recs2 = router.getRecommendedSkills('帮我写一份报告', { maxResults: 5, minScore: 0, userId: uid });
          const hit = recs2.find(r => r.name === 'report-generator');
          if (!hit || Math.abs(hit.score - 0.8 * 1.3) > 1e-6) throw new Error(`userId 链路偏置未生效: ${hit?.score}`);
          if (hit.expertBias !== 1.3) throw new Error('expertBias 标记缺失');
          // 3) 无激活专家 → 不偏置
          reset(uid);
          const recs3 = router.getRecommendedSkills('帮我写一份报告', { maxResults: 5, minScore: 0, userId: uid });
          const hit3 = recs3.find(r => r.name === 'report-generator');
          if (hit3 && hit3.expertBias) throw new Error('无激活专家不应偏置');
          return '技能面偏置✓: ×1.3/×0.3 + userId 链路 + 无激活跳过';
        } finally {
          reset(uid);
        }
      },
    },
    {
      id: 'eorg_007',
      name: '工具面 enforcement: 财务专家收窄排除 messaging, 基线保留 web/file, 地板守卫防空收窄',
      category: 'expert-org',
      run: async () => {
        const { activateExpert, getActiveExpertToolsets, reset } = require('../../src/core/expert-context');
        const { buildToolDefinitions } = require('../../src/core/ai/tool-definitions');
        const uid = 'eorg_enforce_user';
        try {
          activateExpert(uid, 'finance_advisor', { source: 'eval' });
          const toolsets = getActiveExpertToolsets(uid);
          if (!toolsets || !toolsets.includes('file')) throw new Error('getActiveExpertToolsets 未返回财务工具面');
          const defs = buildToolDefinitions('cli', '帮我看报表', { expertToolsets: toolsets });
          const names = new Set(defs.map(d => d.function.name));
          // 实测财务面 46/210: Bash/Shell/Lark/Stock/Desktop/WeCom 等被排除
          if (names.has('Bash')) throw new Error('Bash 未被收窄排除(财务工具面不含 terminal)');
          if (names.has('StockQuery')) throw new Error('StockQuery 未被排除(财务顾问不含 stock)');
          if (names.has('DesktopControl')) throw new Error('DesktopControl 未被排除');
          if (!names.has('Read')) throw new Error('file 工具面基线丢失');
          if (!names.has('WebSearch')) throw new Error('web 基线丢失(老板永远保留搜索)');
          if (defs.length < 8) throw new Error(`收窄后仅 ${defs.length} 个工具(<8), 地板守卫失效`);
          // 地板守卫: 全不存在的工具集 → 不收窄(数量与不传一致)
          const baseline = buildToolDefinitions('cli', '帮我看报表', {});
          const guard = buildToolDefinitions('cli', '帮我看报表', { expertToolsets: ['__nonexistent__'] });
          if (guard.length !== baseline.length) throw new Error(`地板守卫失效: ${baseline.length}→${guard.length}`);
          // 泊车/无激活 → null 不收窄
          reset(uid);
          if (getActiveExpertToolsets(uid) !== null) throw new Error('reset 后应返回 null');
          return `enforcement✓: 财务面 ${defs.length}/${baseline.length} 工具, messaging 已排除, 地板守卫✓`;
        } finally {
          reset(uid);
        }
      },
    },
    {
      id: 'eorg_006',
      name: '部门例会两级树: 成员并行→主管汇总(注入 runner 实跑), 错误路径拦截',
      category: 'expert-org',
      run: async () => {
        const collab = require('../../src/core/experts/collaboration');
        const fakeRunner = async (defs) => defs.map(def => ({
          status: 'done',
          result: def.goal.includes('主持汇总') ? '【例会结论】共识与行动清单。' : '【成员意见】建议优先做 X。',
        }));
        const h = await collab.startDepartmentMeeting({ presetId: 'ops_review', goal: '下季度预算怎么切' }, { runner: fakeRunner, deadlineMs: 8000 });
        if (h.kind !== 'department-meeting' || !h.lead || h.tasks.length < 2) {
          throw new Error(`例会句柄异常: kind=${h.kind} lead=${h.lead?.name} tasks=${h.tasks.length}`);
        }
        let st = null;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 250));
          st = collab.getCollabStatus(h.collabId);
          if (st && st.status !== 'running' && st.status !== 'synthesizing') break;
        }
        if (!st || st.status !== 'done') throw new Error(`例会终态异常: ${st?.status}`);
        if (!st.summary || !st.summary.includes('例会结论')) throw new Error('主管汇总结论缺失');
        if (!st.summary.includes('成员意见')) throw new Error('成员意见附页缺失');
        const synth = st.tasks.find(t => t.taskId === 'synthesis');
        if (!synth || synth.status !== 'done') throw new Error('synthesis 任务未落定');
        try {
          await collab.startDepartmentMeeting({ department: '__nope__', goal: 'x' }, { runner: fakeRunner });
          throw new Error('未知部门未被拦截');
        } catch (e) {
          if (String(e.message).includes('未被拦截')) throw e;
        }
        return `例会两级树✓: ${h.departmentLabel} ${h.tasks.length} 成员 + ${synth.expertName} 汇总`;
      },
    },
  ],
};
