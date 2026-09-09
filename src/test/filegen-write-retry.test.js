/**
 * 执行验证门（shouldForceWriteRetry）回归测试（2026-08-22）
 *
 * 实机 bug：语音说「写一份关于OPC的演讲稿」→ FileGenPanel 卡「正在搜集资料」，
 * 但对话窗口已输出完整演讲稿全文。证据链：
 *   1. 语音 brevityHint（chat-handler:1191「1-2 句口语化短句回复，避免标题列表」）
 *      诱导模型文本直出全文而非调 Write 工具；
 *   2. 执行验证门（ai.js:3951）只拦「声称完成」（已生成/已写好/已完成…），
 *      模型说「我先把它写出来给你看」+ 全文 → 无完成词 → 门不触发；
 *   3. 验证门词表缺文章类词（文章/稿件/讲稿/稿子…）——「写演讲稿」即使
 *      声称完成也不命中（isFileGenIntent 扩展了 ARTICLE_DOCX_RE，验证门没同步）。
 *
 * 修复：判定抽为纯函数 shouldForceWriteRetry——「声称完成」或「长文本直出」
 * （≥300 字且 ≥2 个 markdown 标题）均强制 Write 重试；词表与意图判定统一。
 */

const { shouldForceWriteRetry, fileGenHintFor, FILEGEN_TASK_HINT, FILEGEN_TASK_HINT_DEEP } = require('../core/ai');

describe('fileGenHintFor 分档引导（2026-08-23）', () => {
  test('轻量文章（演讲稿/介绍性文章）→ 搜索 2-3 次引导', () => {
    const hint = fileGenHintFor('写一份关于OPC的演讲稿');
    expect(hint).toBe(FILEGEN_TASK_HINT);
    expect(hint).toContain('WebSearch');
    expect(hint).toContain('Write');
    expect(hint).not.toContain('子问题分解');
  });

  test('深度研究词表命中 → 5 步深度研究引导', () => {
    for (const msg of ['深度研究OPC智能体市场', '帮我做一份行业报告', '全面调研竞品情况', '竞品分析：智能体平台', '写一份学术综述']) {
      const hint = fileGenHintFor(msg);
      expect(hint).toBe(FILEGEN_TASK_HINT_DEEP);
      expect(hint).toContain('子问题分解');
      expect(hint).toContain('联邦搜索');
      expect(hint).toContain('Write');
    }
  });

  test('非字符串安全降级轻量引导', () => {
    expect(fileGenHintFor(undefined)).toBe(FILEGEN_TASK_HINT);
    expect(fileGenHintFor(null)).toBe(FILEGEN_TASK_HINT);
  });
});

describe('shouldForceWriteRetry 执行验证门', () => {
  test('声称完成但零工具调用 → 强制重试（既有行为回归）', () => {
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '帮我生成一份分析报告',
      fullContent: '报告已生成，保存在 D:/report.md',
    })).toBe(true);
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '写一个网页',
      fullContent: '网页已写好，路径 D:/index.html',
    })).toBe(true);
  });

  test('长文本直出全文但无完成词 → 强制重试（本次实机 bug）', () => {
    // 7176 实测回复形态：先简述思路 + 直接输出带 # 标题的完整演讲稿
    const speech =
      '明白，我先简单理一下思路：这份演讲稿要面向刚毕业的大学生，讲「一人公司」这个模式，主题要抓人、有观点，不能是空道理。我先把它写出来给你看。\n\n' +
      '# 《一个人，也能是家公司》\n\n' +
      '**——致刚毕业的你们**\n\n' +
      '## 一、为什么说一人公司是趋势\n\n' +
      '过去十年，一个人开公司的门槛极高——要注册、要记账、要报税、要请人。但现在不一样了，AI 工具把行政成本打了下来，一个人加一套工具，就能跑完一家公司的全部流程。\n\n' +
      '## 二、你需要的三样东西\n\n' +
      '第一样是产品，你得有一件拿得出手的东西；第二样是工具，把重复劳动交给 AI 和自动化；第三样是心态，一个人也要有老板思维，学会取舍和聚焦。\n\n' +
      '## 三、最后的话\n\n' +
      '毕业不是终点，而是你成为自己老板的起点。\n\n'.repeat(3);
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '写一份关于OPC的演讲稿，主要面向刚毕业的大学生',
      fullContent: speech,
    })).toBe(true);
  });

  test('加粗标题 + 分隔线的全文直出（无 # 标题）→ 强制重试（实机：deepseek 演讲稿用 **粗体** 排版）', () => {
    // 16:12 实机形态：模型用 **加粗** 标题 + --- 分隔线输出演讲稿全文，无 markdown # 标题
    const speech =
      '给你备好了，直接可用——**智能体时代，你是驾驶者**（约310字）：\n\n' +
      '---\n\n' +
      '各位同学，今天毕业，说点我这几年观察到的。\n\n' +
      '过去二十年，我们教人学会工具——打字、搜索、用软件。但接下来，工具会反过来学会你。\n\n' +
      '**它更像助理，不像机器。**\n\n' +
      '你说帮我做个市场调研，它知道分几步、去哪些渠道、整理成什么样。\n\n' +
      '**智能体是引擎，你是握方向盘的那个人。**\n\n' +
      '恭喜毕业，未来在你们手里。谢谢。\n\n' +
      '---\n\n' +
      '共约 310 字，语气激励又不空洞，适合开场或结语。'.repeat(6);
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '写一份关于智能体的演讲稿，300字左右',
      fullContent: speech,
    })).toBe(true);
  });

  test('正常聊天长回复（无结构标记）不强制重试', () => {
    const longChat = '今天天气不错，适合出门走走，不过下午可能会下雨，记得带伞。'.repeat(20);
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '今天天气怎么样', fullContent: longChat,
    })).toBe(false);
  });

  test('语音 brevityHint 叠加的文本直出 → 强制重试', () => {
    const msg = '写一份关于OPC的演讲稿\n\n' +
      '[系统提示：当前是语音对话模式，你的回复将被 TTS 朗读——用户在听而不是在读。请默认用 1-2 句口语化的短句回复。避免标题、列表、代码块、URL、括号、破折号等不适合朗读的结构。保持自然简洁。]';
    const speech = '# 一人公司\n\n## 一、定义\n' + '正文内容……'.repeat(120);
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: msg, fullContent: speech,
    })).toBe(true);
  });

  test('文章类词（讲稿/文章/总结）声称完成 → 强制重试（词表漂移回归）', () => {
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '写一份演讲稿', fullContent: '已写好，全文如下',
    })).toBe(true);
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '写一篇介绍性文章', fullContent: '文章已生成',
    })).toBe(true);
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '写一份项目总结', fullContent: '总结已完成',
    })).toBe(true);
  });

  test('短回复（仅确认，非全文）不强制重试', () => {
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '写一份演讲稿', fullContent: '好的，我马上为你写。',
    })).toBe(false);
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '写一份演讲稿', fullContent: '正在准备，请稍等。',
    })).toBe(false);
  });

  test('有工具调用不强制重试', () => {
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 2,
      message: '写一份演讲稿', fullContent: '已写入文件 D:/a.md',
    })).toBe(false);
  });

  test('非生成意图（纯聊天）不强制重试', () => {
    const longChat = '今天天气不错，适合出门走走。'.repeat(120);
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '今天天气怎么样', fullContent: longChat,
    })).toBe(false);
  });

  test('depth >= 3 不再重试（防死循环）', () => {
    expect(shouldForceWriteRetry({
      depth: 3, streamTotalToolCalls: 0,
      message: '写一份演讲稿', fullContent: '已生成',
    })).toBe(false);
  });

  test('参数缺失/非字符串安全降级 false', () => {
    expect(shouldForceWriteRetry({ depth: 0, streamTotalToolCalls: 0 })).toBe(false);
    expect(shouldForceWriteRetry({ depth: 0, streamTotalToolCalls: 0, message: null, fullContent: '已生成' })).toBe(false);
    expect(shouldForceWriteRetry({ depth: 0, streamTotalToolCalls: 0, message: '', fullContent: '已生成' })).toBe(false);
  });
});

// ─── 2026-09-06 恢复链路: liveFileGenTask 分支 ───
// 实机：网页生成任务中断 → 用户说"保留当前对话/继续" → 模型把整页 HTML 直吐
// 对话窗口。旧判定要求消息命中 FILEGEN_ACTION_RE（生成/写/做…），"继续/保留"
// 全不命中 → 闸门放行。新增分支：存在未终态生成任务 + 继续类消息 → 同样拦截。
describe('shouldForceWriteRetry 恢复链路分支（2026-09-06）', () => {
  const dumpHtml =
    '# 个人主页\n\n## 关于我\n' + '<div class="hero">内容示例……</div>\n'.repeat(60);

  test('存在活跃生成任务 + 继续类消息 + 文本直出 → 强制重试（旧判定放行的实机场景）', () => {
    for (const msg of ['继续', '继续吧', '继续之前的任务', '接着做完那个网页', '恢复一下刚才的生成']) {
      expect(shouldForceWriteRetry({
        depth: 0, streamTotalToolCalls: 0,
        message: msg, fullContent: dumpHtml, liveFileGenTask: true,
      })).toBe(true);
    }
  });

  test('存在活跃任务 + 继续类消息 + 声称完成 → 强制重试', () => {
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '继续',
      fullContent: '文件已写入 D:/workspace/index.html', liveFileGenTask: true,
    })).toBe(true);
  });

  test('无活跃任务 + 继续类消息 + 文本直出 → 不拦截（维持旧行为）', () => {
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '继续', fullContent: dumpHtml, liveFileGenTask: false,
    })).toBe(false);
    // 未传 liveFileGenTask（旧调用方兼容）
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '继续', fullContent: dumpHtml,
    })).toBe(false);
  });

  test('活跃任务存在但消息非继续类（长消息无任务指代词）→ 不拦截', () => {
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '继续给我讲讲AI资讯，多推荐一些来源', fullContent: dumpHtml, liveFileGenTask: true,
    })).toBe(false);
  });

  test('活跃任务 + 继续类消息 + 无结构无完成词的普通短回复 → 不拦截', () => {
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '继续', fullContent: '好的，我马上接着处理。', liveFileGenTask: true,
    })).toBe(false);
  });

  test('brevityHint 叠加的继续消息照常命中（系统注入剥离后判定）', () => {
    const msg = '继续\n\n[系统提示：当前是语音对话模式，你的回复将被 TTS 朗读——用户在听而不是在读。请默认用 1-2 句口语化的短句回复。避免标题、列表、代码块、URL、括号、破折号等不适合朗读的结构。保持自然简洁。]';
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: msg, fullContent: dumpHtml, liveFileGenTask: true,
    })).toBe(true);
  });
});

// ─── 2026-09-06 追问回答轮: pausedFileGenTask 分支 ───
// 引导词"生成一个网页"→模型追问→paused→用户回答（常无文件词，"做关于智能家居的"）。
// 该轮若模型空口声称"网页已生成"（幻觉）需拦截；普通长回复不得误伤。
describe('shouldForceWriteRetry 追问回答分支（2026-09-06）', () => {
  test('paused 任务 + 回答轮声称完成 → 强制重试（幻觉兜底）', () => {
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '做关于智能家居的', fullContent: '好的，网页已生成，可以直接查看。',
      pausedFileGenTask: true,
    })).toBe(true);
  });

  test('paused 任务 + 回答轮普通长回复（无完成声称）→ 不拦（防误伤正常回答）', () => {
    const normalAnswer =
      '智能家居可以从三个层面来看：\n\n## 现状\n市场规模与主流协议生态简介。\n\n## 趋势\nMatter 统一标准与本地化 AI。'.repeat(4);
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '做关于智能家居的', fullContent: normalAnswer, pausedFileGenTask: true,
    })).toBe(false);
  });

  test('未传 pausedFileGenTask（旧调用方）行为不变', () => {
    expect(shouldForceWriteRetry({
      depth: 0, streamTotalToolCalls: 0,
      message: '做关于智能家居的', fullContent: '好的，网页已生成。',
    })).toBe(false);
  });
});

// ─── 2026-09-06 追问回答 hint 文案回归 ───
describe('fileGenPausedAnswerHintFor（2026-09-06）', () => {
  const { fileGenPausedAnswerHintFor } = require('../core/ai');
  test('包含条件分流关键句（补充需求→继续流程 / 别的事→正常回答）', () => {
    const hint = fileGenPausedAnswerHintFor({ title: '生成一个网页', format: 'html' });
    expect(hint).toContain('生成一个网页');
    expect(hint).toContain('补充');
    expect(hint).toContain('Write');
    expect(hint).toContain('禁止把网页全文直接输出到对话');
    expect(hint).toContain('正常回答');
  });
});
