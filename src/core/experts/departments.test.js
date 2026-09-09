/**
 * departments 单元测试——部门化组织数据层（2026-09-04 P1）
 * 纯函数断言：注册表完整性、编制政策解析、别名/班组/工具面数据纪律。
 * 路由与召唤的行为断言在 evals/test-cases/expert-org.js（eorg_003/004）。
 */

const {
  DEPARTMENTS,
  DEPARTMENT_IDS,
  DIVISION_POLICY,
  ROLE_ALIASES,
  TEAM_PRESETS,
  DEPARTMENT_TOOLSETS,
  DEPARTMENT_SKILLS,
  getDepartment,
  getDepartmentToolsets,
  getDepartmentSkills,
  resolveDivisionPolicy,
} = require('./departments');

describe('departments 注册表完整性', () => {
  test('七部门齐备且字段完整(label/description/voiceAliases≥3)', () => {
    expect(DEPARTMENT_IDS).toHaveLength(7);
    for (const id of DEPARTMENT_IDS) {
      const d = DEPARTMENTS[id];
      expect(d.label).toBeTruthy();
      expect(d.description).toBeTruthy();
      expect(d.voiceAliases.length).toBeGreaterThanOrEqual(3);
    }
  });

  test('部门 id 无重复、别名跨部门无冲突(语音点名不歧义)', () => {
    const seenAlias = new Map();
    for (const [id, d] of Object.entries(DEPARTMENTS)) {
      for (const a of d.voiceAliases) {
        if (seenAlias.has(a)) {
          // '账'/'税' 等近似词允许跨部门, 但完全相同别名不允许
          throw new Error(`别名 "${a}" 同时属于 ${seenAlias.get(a)} 与 ${id}`);
        }
        seenAlias.set(a, id);
      }
    }
  });

  test('getDepartment 未知 id 返回 null', () => {
    expect(getDepartment('__nope__')).toBeNull();
    expect(getDepartment('finance').label).toBe('财务部');
  });
});

describe('DIVISION_POLICY 编制政策解析', () => {
  test('active 部门直通', () => {
    expect(resolveDivisionPolicy('marketing')).toEqual({ dept: 'marketing', status: 'active', include: null });
    expect(resolveDivisionPolicy('finance')).toEqual({ dept: 'finance', status: 'active', include: null });
  });

  test('select 部门携带 include 关键词', () => {
    const p = resolveDivisionPolicy('engineering');
    expect(p.dept).toBe('tech_digital');
    expect(p.status).toBe('select');
    expect(p.include).toContain('architect');
  });

  test('未知 division 一律泊车(外部人才库语义)', () => {
    expect(resolveDivisionPolicy('__unknown__')).toEqual({ dept: null, status: 'parked', include: null });
    expect(resolveDivisionPolicy('game-development').status).toBe('parked');
  });
});

describe('数据纪律', () => {
  test('班组模板: id 唯一、expertIds 非空、defaultGoal 齐备', () => {
    const ids = new Set(TEAM_PRESETS.map(p => p.id));
    expect(ids.size).toBe(TEAM_PRESETS.length);
    for (const p of TEAM_PRESETS) {
      expect(p.expertIds.length).toBeGreaterThanOrEqual(2);
      expect(p.defaultGoal).toBeTruthy();
    }
  });

  test('工具面键必须为 toolset-manager CORE_TOOLSETS 真名(防漂移)', () => {
    const { getToolsetManager } = require('../toolset-manager');
    const tsm = getToolsetManager();
    for (const [deptId, toolsets] of Object.entries(DEPARTMENT_TOOLSETS)) {
      for (const ts of toolsets) {
        expect(tsm.getToolset(ts)).not.toBeNull();
      }
    }
  });

  test('技能包键抽样核对(skills/ 目录真名, 防漂移)', () => {
    const fs = require('fs');
    const path = require('path');
    const skillsDir = path.join(__dirname, '../../../skills');
    for (const [deptId, skills] of Object.entries(DEPARTMENT_SKILLS)) {
      for (const s of skills) {
        expect(fs.existsSync(path.join(skillsDir, s))).toBe(true);
      }
    }
  });

  test('getDepartmentToolsets/getDepartmentSkills 未知部门返回 null', () => {
    expect(getDepartmentToolsets('__nope__')).toBeNull();
    expect(getDepartmentSkills('__nope__')).toBeNull();
  });

  test('星标岗位别名表键非空且值≥1', () => {
    expect(Object.keys(ROLE_ALIASES).length).toBeGreaterThanOrEqual(8);
    for (const [id, aliases] of Object.entries(ROLE_ALIASES)) {
      expect(aliases.length).toBeGreaterThanOrEqual(1);
      expect(id).not.toMatch(/\s/);
    }
  });
});
