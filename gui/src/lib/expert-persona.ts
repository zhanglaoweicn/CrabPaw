/**
 * 专家音色人设（P4）— archetype/专家 → 播报前缀 + 豆包 style 注入文本。
 * 数据源：SUBAGENT_LABELS 同名 archetype 枚举（subagent-tools.js）扩展。
 */
export interface Persona {
  label: string          // "XX专家" 短名（前缀用）
  style: string          // 豆包 style 描述（context_texts 注入）
  icon: string           // 卫星卡图标名（轨道图用）
}

export const ARCHETYPE_PERSONA: Record<string, Persona> = {
  planner:       { label: '规划专家', style: '清晰沉稳的规划口吻，条理分明', icon: 'Map' },
  researcher:    { label: '研究员',   style: '严谨客观的研究汇报口吻，强调数据与事实', icon: 'Search' },
  code_executor: { label: '代码专家', style: '干练直接的工程口吻，简短有力', icon: 'Code' },
  critic:        { label: '评审专家', style: '审慎挑剔的评审口吻，直指问题', icon: 'Shield' },
  summarizer:    { label: '总结专家', style: '凝练清晰的总结口吻', icon: 'FileText' },
  tools_agent:   { label: '执行专家', style: '干脆利落的执行口吻', icon: 'Wrench' },
  archivist:     { label: '记忆专家', style: '温和沉稳的记忆整理口吻', icon: 'Database' },
  orchestrator:  { label: '主理人',   style: '从容大气的主持口吻，掌控全场', icon: 'Orbit' },
}

export const DEFAULT_PERSONA: Persona = { label: '专家', style: '自然亲切的助手口吻', icon: 'User' }

export function resolvePersona(archetype: string): Persona {
  return ARCHETYPE_PERSONA[archetype] || DEFAULT_PERSONA
}

/** 播报前缀："XX专家汇报：" */
export function personaPrefix(archetype: string): string {
  return `${resolvePersona(archetype).label}汇报：`
}

/** 豆包 style 注入文本 */
export function resolveVoiceStyle(archetype: string): string {
  return resolvePersona(archetype).style
}

// ── 岗位音色 → TTS voice 映射（2026-09-04 部门化 P3） ─────────────────────
// voiceStyle 是中文风格描述（"严谨细致的财务顾问口吻"），TTS 需要 voice id。
// 启发式映射：按风格关键词选音色（Azure/Edge zh-CN 系），未命中回落默认女声。
const TTS_VOICE_DEFAULT = 'zh-CN-XiaoxiaoNeural'

const TTS_VOICE_RULES: { keywords: string[]; voice: string; note: string }[] = [
  { keywords: ['沉稳', '严谨', '保守', '审慎', '谨慎', '冷静'], voice: 'zh-CN-YunyangNeural', note: '新闻男声——严肃专业域(财务/法务/税务)' },
  { keywords: ['干练', '直接', '犀利', '干脆', '结果导向', '行动'], voice: 'zh-CN-YunxiNeural', note: '活力男声——销售/执行域' },
  { keywords: ['温和', '亲切', '凝练', '自然'], voice: 'zh-CN-XiaoyiNeural', note: '温柔女声——人事/助理域' },
  { keywords: ['大气', '从容', '掌控'], voice: 'zh-CN-YunjianNeural', note: '浑厚男声——主持/战略域' },
]

/** 岗位 voiceStyle 文本 → TTS voice id（无命中回落默认音色） */
export function resolveExpertTtsVoice(voiceStyle?: string | null): string {
  if (!voiceStyle) return TTS_VOICE_DEFAULT
  for (const rule of TTS_VOICE_RULES) {
    if (rule.keywords.some(k => voiceStyle.includes(k))) return rule.voice
  }
  return TTS_VOICE_DEFAULT
}
