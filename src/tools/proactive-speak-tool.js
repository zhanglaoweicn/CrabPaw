/**
 * ProactiveSpeak — CrabPaw 主动发声工具（LLM 通道）
 *
 * LLM 在推理中判断"此事值得主动告诉老板"时调用，经 proactive 决策层
 * （静默时段/去重/打扰价值）决定是否发声；不发声时结果照常返回，
 * 由前端表达为面板通知。与被动回复（TextToSpeech）区别：本工具走
 * 打扰抑制流程，可能不发声。
 */
const { registry } = require('./registry')
const proactive = require('../core/proactive')

registry.register({
  name: 'ProactiveSpeak',
  toolset: 'voice',
  category: 'proactive',
  description:
    'CrabPaw 主动发声：在用户未下达新指令时，主动向老板播报重要事项（会议提醒、任务到期、文档到达、重要进展）。会经过打扰抑制（静默时段 22-8 / 30 分钟去重），可能只入面板不发声。返回 state 说明实际状态：broadcast=已发声 / queued_silent=静默期已排队稍后补播 / suppressed=被抑制（去重或静默）。',
  whenNotToUse:
    '用户正在对话中请勿调用（此时用正常回复通道回答）；用户明确要求静音/勿扰时请勿调用；信息价值低于打扰成本（琐碎状态、进度播报）时请勿调用；用户几分钟内已被告知过相同事项时请勿重复调用。',
  riskLevel: 'low',
  schema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '播报内容：一句话、口语化、直接对老板说话，如「老板，您要的文档已生成」',
      },
      trigger: {
        type: 'string',
        description: '触发场景标识（reminder/task_due/document_ready/workflow_progress/agent）',
        default: 'agent',
      },
      intent: {
        type: 'string',
        enum: ['confront', 'inform', 'ambient', 'silent'],
        description: '打扰强度：confront=紧急必须打扰 / inform=正常通知 / ambient=纯背景 / silent=只入面板不发声',
        default: 'inform',
      },
      surface: {
        type: 'object',
        description: '可选面板数据 { kind: "text", data: { title, body } }，随事件广播供前端渲染',
      },
    },
    required: ['text'],
  },
  handler: async (params) => {
    const res = proactive.notify({
      trigger: params.trigger || 'agent',
      text: params.text,
      intent: params.intent || 'inform',
      surface: params.surface,
    })
    if (!res.ok) {
      // 去重/非法请求/内部错误：被抑制是正常控制流，不是工具异常
      return { success: true, state: 'suppressed', reason: res.reason }
    }
    return { success: true, state: res.reason === 'silent_hours' ? 'queued_silent' : 'broadcast', reason: res.reason }
  },
  checkFn: () => true,
  timeout: 10000,
})
