/**
 * mentions.js — @提及召唤（2026-09-05 部门化 P4）
 *
 * 语义：聊天消息里的 "@财务部" / "@小红书专员" 是**显式指定专家**的控制指令，
 * 优先级高于关键词自动路由（L0 说事转接）——用户点名了就听点名的。
 *
 * 解析规则：
 *   - 提取所有 @token（@ 后跟非空白/非标点，1-24 字符）
 *   - 每个 token 经 resolveSummon 四形态解析（部门/岗位/消歧/未知）
 *   - 解析成功(expert/department) → 从消息中移除该 token（控制指令不是内容）、激活对应岗位
 *   - 解析失败(未知/歧义) → 保留原文（邮箱 user@gmail.com、普通 @词 不误伤）
 *
 * 消费方：chat-handler（@mention 命中时跳过关键词路由，改用显式激活的专家人设）。
 * resolve 可注入（单测防重依赖）。
 */

const { resolveSummon } = require('./index');
const { activateExpert } = require('../expert-context');

const MENTION_RE = /@([^\s@，。！？、；;：:（）()【】[\]{}"'']{1,24})/gu;

/**
 * 解析消息中的 @提及。
 * @param {string} message 原始消息
 * @param {{resolve?: (query: string) => object|null}} [io] resolve 可注入（默认 experts.resolveSummon）
 * @returns {{ tokens: Array<{raw:string, query:string, resolution:object}>, cleanedMessage: string }}
 *   tokens: 全部 @token 及其解析结果（resolution 为 null 表示未识别）
 */
function parseExpertMentions(message, io = {}) {
  const resolve = io.resolve || resolveSummon;
  const text = String(message || '');
  const tokens = [];
  const removals = [];

  for (const m of text.matchAll(MENTION_RE)) {
    const raw = m[0];
    const query = m[1].trim();
    if (!query) continue;
    const resolution = resolve(query);
    tokens.push({ raw, query, resolution });
    // 只有明确解析成功(expert/department)才移除 @token——歧义/未知保留原文
    // (歧义交给关键词路由或消歧交互; @邮箱等普通文本不误伤)
    if (resolution && (resolution.type === 'expert' || resolution.type === 'department')) {
      removals.push(raw);
    }
  }

  let cleanedMessage = text;
  for (const raw of removals) {
    cleanedMessage = cleanedMessage.replace(raw, '').replace(/\s{2,}/g, ' ').trim();
  }
  return { tokens, cleanedMessage };
}

/**
 * 解析并激活消息中的 @提及（chat-handler 主链路调用，每轮一次）。
 * 激活语义：按出现顺序逐个激活——最终生效人设为最后一个被激活的岗位
 * （"@财务部 @营销部 都看看" → 营销部视角收尾）；部门 → 主管岗。
 * @param {string} userId 会话用户
 * @param {string} message 原始消息
 * @returns {{ handled: boolean, cleanedMessage: string, activated: Array, unresolved: string[] }}
 *   handled=true 时调用方应跳过关键词路由(routeAndActivate)，改用 cleanedMessage。
 */
function consumeMentions(userId, message) {
  const { tokens, cleanedMessage } = parseExpertMentions(message);
  const recognized = tokens.filter((t) => t.resolution);
  if (recognized.length === 0) {
    return { handled: false, cleanedMessage: message, activated: [], unresolved: [] };
  }

  const activated = [];
  for (const t of recognized) {
    const r = t.resolution;
    try {
      if (r.type === 'expert') {
        activateExpert(userId, r.expert.id, { source: 'mention' });
        activated.push({ type: 'expert', id: r.expert.id, name: r.expert.name, departmentLabel: r.expert.departmentLabel || null });
      } else if (r.type === 'department' && r.department.lead) {
        activateExpert(userId, r.department.lead, { source: 'mention-department' });
        activated.push({ type: 'department', id: r.department.id, label: r.department.label, lead: r.department.lead, memberCount: r.department.memberCount });
      }
    } catch (e) {
      console.warn('[mentions] 激活失败(跳过):', e.message);
    }
  }

  const unresolved = tokens.filter((t) => !t.resolution).map((t) => t.raw);
  if (activated.length > 0) {
    console.log(`📣 [mentions] @提及召唤生效: ${activated.map((a) => a.name || a.label).join('、')} (共 ${activated.length})`);
  }
  return { handled: activated.length > 0, cleanedMessage, activated, unresolved };
}

module.exports = { parseExpertMentions, consumeMentions, MENTION_RE };
