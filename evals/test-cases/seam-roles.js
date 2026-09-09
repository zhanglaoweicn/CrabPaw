/**
 * Seam Roles（接缝三角色）—— dsh 对标机制③ 的登记册纪律套件（2026-09-03 P2-①）。
 *
 * 数据源：src/core/cordis/seams.js（单一事实源）。本套件强制四条纪律：
 *  1. 登记册完整性——每个接缝 verdict 合法、live 必须三角色齐备（定义+≥1 消费方），
 *     flagged(pseudo/dormant/dual) 必须带 note+action；
 *  2. 路径存在性——登记的 definition/consumers 路径必须真实存在（防登记册腐烂）；
 *  3. 机制覆盖——四类扩展机制每个至少有 1 条 live 接缝（防登记册漏掉整个机制）；
 *  4. flagged 不得静默消失——收敛某个伪/双轨接缝必须先改册（改 verdict/移除），
 *     否则红。防"顺手删了没记录"，收敛动作必须留痕。
 */

const fs = require('fs');
const path = require('path');

const {
  REGISTRY,
  VERDICTS,
  MECHANISMS,
  FLAGGED_SEAM_IDS,
  CONVERGED_SEAMS,
} = require('../../src/core/cordis/seams');

const REPO_ROOT = path.join(__dirname, '..', '..');

function pathExists(rel) {
  if (!rel || rel.includes('*')) return true; // 通配/目录模糊项不做存在性断言
  try {
    fs.statSync(path.join(REPO_ROOT, rel));
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  name: 'Seam Roles (接缝三角色)',
  cases: [
    {
      id: 'seam_001',
      name: '登记册完整性: verdict 合法 / live 三角色齐备 / flagged 带 note+action',
      category: 'seam-roles',
      run: async () => {
        if (REGISTRY.length < 10) throw new Error(`登记册仅 ${REGISTRY.length} 条(<10), 疑似被清空`);
        const problems = [];
        for (const seam of REGISTRY) {
          const tag = `[${seam.id}]`;
          if (!VERDICTS.includes(seam.verdict)) problems.push(`${tag} 非法 verdict: ${seam.verdict}`);
          if (!seam.title || !seam.note) problems.push(`${tag} 缺 title/note`);
          if (!Array.isArray(seam.definition) || seam.definition.length === 0) problems.push(`${tag} 缺 definition`);
          if (seam.verdict === 'live') {
            if (!Array.isArray(seam.consumers) || seam.consumers.length === 0) {
              problems.push(`${tag} live 但无消费方`);
            }
          } else {
            if (!seam.action) problems.push(`${tag} ${seam.verdict} 但缺 action(收敛方向)`);
            if (!seam.note || seam.note.length < 8) problems.push(`${tag} ${seam.verdict} 但 note 过简`);
          }
        }
        if (problems.length > 0) throw new Error(`登记册问题:\n  ${problems.join('\n  ')}`);
        const live = REGISTRY.filter((s) => s.verdict === 'live').length;
        const flagged = REGISTRY.length - live;
        return `登记册 ${REGISTRY.length} 条: live ${live} / flagged ${flagged}, 全部带三角色声明`;
      },
    },
    {
      id: 'seam_002',
      name: '路径存在性: 登记的 definition/consumers/providers 路径真实存在',
      category: 'seam-roles',
      run: async () => {
        const missing = [];
        for (const seam of REGISTRY) {
          for (const p of [...(seam.definition || []), ...(seam.consumers || []), ...(seam.providers || [])]) {
            if (!pathExists(p)) missing.push(`[${seam.id}] ${p}`);
          }
        }
        if (missing.length > 0) throw new Error(`登记册路径不存在(文件移动后未改册):\n  ${missing.join('\n  ')}`);
        return '全部登记路径存在, 登记册未腐烂';
      },
    },
    {
      id: 'seam_003',
      name: '机制覆盖: 四类扩展机制各有 ≥1 条 live 接缝',
      category: 'seam-roles',
      run: async () => {
        const gaps = [];
        for (const mech of MECHANISMS) {
          const liveCount = REGISTRY.filter((s) => s.mechanism === mech && s.verdict === 'live').length;
          if (liveCount === 0) gaps.push(`${mech}: 0 条 live`);
        }
        if (gaps.length > 0) throw new Error(`机制缺 live 接缝(整机制漏登记):\n  ${gaps.join('\n  ')}`);
        return `四机制全覆盖: ${MECHANISMS.join(' / ')}`;
      },
    },
    {
      id: 'seam_004',
      name: 'flagged 不得静默消失: 收敛必须改册留痕',
      category: 'seam-roles',
      run: async () => {
        const registered = new Set(REGISTRY.map((s) => s.id));
        const vanished = FLAGGED_SEAM_IDS.filter((id) => !registered.has(id));
        if (vanished.length > 0) {
          throw new Error(
            `以下已判伪/双轨接缝从登记册消失: ${vanished.join(', ')}。` +
            '收敛是允许的, 但必须留痕: 改码的同时更新 seams.js(移除 FLAGGED_SEAM_IDS 条目并在本套件记录收敛轮次)'
          );
        }
        const badVerdict = FLAGGED_SEAM_IDS
          .map((id) => REGISTRY.find((s) => s.id === id))
          .filter((s) => s.verdict === 'live');
        if (badVerdict.length > 0) {
          throw new Error(`flagged 接缝被静默改为 live(未走审判): ${badVerdict.map((s) => s.id).join(', ')}`);
        }
        // 收敛留痕纪律: 已收敛条目不得回流 flagged/REGISTRY(防僵死标记与静默复活)
        const registeredIds = new Set(REGISTRY.map((s) => s.id));
        const zombies = CONVERGED_SEAMS.filter((c) => registeredIds.has(c.id) || FLAGGED_SEAM_IDS.includes(c.id));
        if (zombies.length > 0) {
          throw new Error(`已收敛接缝回流登记册(僵尸标记): ${zombies.map((c) => c.id).join(', ')}`);
        }
        return `flagged ${FLAGGED_SEAM_IDS.length} 条在册 + 已收敛 ${CONVERGED_SEAMS.length} 条留痕, 无回流`;
      },
    },
  ],
};
