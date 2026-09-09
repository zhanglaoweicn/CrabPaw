/**
 * manifest-validate.js — 内置专家清单校验器（Phase 3d 收编, 2026-08-25）
 *
 * 收编语义：专家定义保持数据出生地（代码数组 BUILTIN_EXPERTS / experts.json 用户层），
 * 本模块只做"清单面约束校验"——防新增专家缺字段/id 撞车/collab 引用孤儿：
 *   ① id 唯一 ② 必填字段(name/description/category) ③ collaborationChain 引用存在
 *   ④ routingKeywords 非空。校验失败仅告警（专家系统可降级运行）。
 *
 * 2026-09-05: capabilities 移出必填清单——路由(expert-context)只消费 routingKeywords,
 * capabilities 仅内置 10 岗手工声明; 导入人设(experts-org.json 268 位)从未携带该字段,
 * 强校验只会让「清单异常」徽章对全量导入专家常亮(噪声而非信号)。
 */
const REQUIRED_FIELDS = ['id', 'name', 'description', 'category', 'routingKeywords'];

/**
 * @param {Array} experts 专家列表（BUILTIN_EXPERTS 或用户层）
 * @returns {{valid: boolean, problems: string[]}}
 */
function validateExpertManifest(experts) {
  const problems = [];
  const seen = new Set();
  const ids = new Set((experts || []).map((e) => e.id));

  for (const e of experts || []) {
    if (!e || typeof e.id !== 'string' || !e.id.trim()) {
      problems.push('存在缺 id 的专家条目');
      continue;
    }
    if (seen.has(e.id)) {
      problems.push(`id 重复: ${e.id}`);
      continue;
    }
    seen.add(e.id);
    for (const f of REQUIRED_FIELDS) {
      const v = e[f];
      const empty = v === undefined || v === null
        || (Array.isArray(v) && v.length === 0)
        || (typeof v === 'string' && v.trim() === '');
      if (empty) {
        problems.push(`专家 ${e.id} 缺失必填字段: ${f}`);
      }
    }
    if (Array.isArray(e.collaborationChain)) {
      for (const ref of e.collaborationChain) {
        if (ref && !ids.has(ref)) {
          problems.push(`专家 ${e.id} collaborationChain 引用不存在: ${ref}`);
        }
      }
    }
    // 部门化重组(2026-09-04 P1): department/状态/别名组织约束——仅告警不阻断。
    // department 缺失只对显式 status:'active' 生效——P1 前的 legacy 条目无 status 不追溯。
    if (e.status === 'active' && !e.department) {
      problems.push(`专家 ${e.id} 在编但缺 department(应入编或标记 status=parked)`);
    }
    if (e.department && e.status === 'parked') {
      problems.push(`专家 ${e.id} 有 department 但 status=parked(泊车应清空 department)`);
    }
    if (e.aliases !== undefined && !Array.isArray(e.aliases)) {
      problems.push(`专家 ${e.id} aliases 应为数组`);
    }
  }
  return { valid: problems.length === 0, problems };
}

module.exports = { validateExpertManifest, REQUIRED_FIELDS };
