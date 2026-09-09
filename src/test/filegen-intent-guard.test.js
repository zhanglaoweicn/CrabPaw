/**
 * 文件生成意图判定回归测试（2026-08-17）
 *
 * 实机 bug：查"大华股份"（股票查询）却弹出 FileGenPanel 文章编写卡。
 * 根因链：auto-dream 记忆提取走 chat(silent=true)，提取 prompt 含"创建/文件"
 * 类词 → isFileGenIntent 误判 true → chat() 无条件调 maybeStartFileGenTask
 * → filegen:start 广播 → 面板误弹（与用户请求并发）。
 *
 * 修复：chat() 加 silent 守卫（silent 内部任务绝不触发 UI 面板），
 * 与 unifiedAddMessage 同构；isFileGenIntent 导出供回归保护。
 */

const { isFileGenIntent } = require('../core/ai');

describe('isFileGenIntent 判定', () => {
  test('股票查询不触发（回归：查询 大华股份）', () => {
    expect(isFileGenIntent('查询 大华股份')).toBe(false);
    expect(isFileGenIntent('查一下贵州茅台的股价')).toBe(false);
    expect(isFileGenIntent('上证指数现在多少')).toBe(false);
  });

  test('纯闲聊/日常对话不触发', () => {
    expect(isFileGenIntent('你好')).toBe(false);
    expect(isFileGenIntent('播放周杰伦的歌')).toBe(false);
    expect(isFileGenIntent('今天天气怎么样')).toBe(false);
  });

  test('真实文件生成意图触发', () => {
    expect(isFileGenIntent('帮我生成一份关于大华股份的分析报告')).toBe(true);
    expect(isFileGenIntent('创建一个 word 文档')).toBe(true);
    expect(isFileGenIntent('把这段内容导出成 pdf 文件')).toBe(true);
    expect(isFileGenIntent('写一份项目总结文档')).toBe(true);
  });

  test('文章类生成意图触发（2026-08-22 词表扩展——用户场景: 写介绍性文章要弹面板）', () => {
    expect(isFileGenIntent('写一篇关于 harness 的介绍性文章')).toBe(true);
    expect(isFileGenIntent('帮我写个讲稿')).toBe(true);
    expect(isFileGenIntent('写一份项目总结报告')).toBe(true);
    expect(isFileGenIntent('帮我写一篇关于智能体的介绍文')).toBe(true);
    expect(isFileGenIntent('写一份技术汇报')).toBe(true);
  });

  test('「做」类生成意图触发（2026-08-23 实机修复——做一份PPT/表格此前零事件）', () => {
    expect(isFileGenIntent('做一份关于人工智能发展的PPT演示文稿')).toBe(true);
    expect(isFileGenIntent('帮我做一个 Excel 表格')).toBe(true);
    expect(isFileGenIntent('做一份产品介绍 PPT')).toBe(true);
    // 完成/评价语境负向环视：不触发
    expect(isFileGenIntent('这个PPT做得不错')).toBe(false);
    expect(isFileGenIntent('做好了发给我')).toBe(false);
  });

  // ─── 2026-09-07 实机修复：过去式/回溯引用与查找意图不触发 ───
  // 企微实测："之前已经生成了一个html报告，你能找到吗"（生成+html 双命中）
  // 误开新 filegen 任务弹卡——用户只是想找到既有产物并发送。
  describe('回溯引用/查找意图不触发（2026-09-07）', () => {
    test('过去式引用已有产物不触发（企微实测原句）', () => {
      expect(isFileGenIntent('之前已经生成了一个html报告，你能找到吗')).toBe(false);
      expect(isFileGenIntent('刚才生成的看板在哪里')).toBe(false);
      expect(isFileGenIntent('之前做的那个文档还在吗')).toBe(false);
    });

    test('查找/定位意图不触发', () => {
      expect(isFileGenIntent('帮我找一下销售明细文件')).toBe(false);
      expect(isFileGenIntent('报告在哪')).toBe(false);
    });

    test('再生成祈使词仍然触发（不被回溯标记误杀）', () => {
      expect(isFileGenIntent('之前生成的报告不好，重新生成一份网页')).toBe(true);
      expect(isFileGenIntent('刚才那个表格数据不对，帮我重新做一个 Excel')).toBe(true);
    });

    test('发送类请求不触发（文件卡/企微发送场景）', () => {
      expect(isFileGenIntent('你能把销售明细分析看板的html发送到这个企业微信对话中嘛')).toBe(false);
      expect(isFileGenIntent('把报告发到企微')).toBe(false);
    });
  });

  test('文章类近义但不含生成动作/文件词不触发', () => {
    expect(isFileGenIntent('写一首歌的歌词')).toBe(false); // 歌词不在词表
    expect(isFileGenIntent('帮我介绍这篇文章')).toBe(false); // 「介绍」非生成动作词
    expect(isFileGenIntent('把文章发给我')).toBe(false); // 无生成动作词
    expect(isFileGenIntent('这篇文章写得不错')).toBe(false); // 无动作词
  });

  test('auto-dream 式提取 prompt 会被误判（证明需要 silent 守卫）', () => {
    // 提取 prompt 含"创建/文件"类词（task-mode 实测：搜索, 创建, create）
    const extractPrompt =
      '请提取以下对话中的关键信息并创建记忆文件。\n\nUser messages:\n' +
      '查询 大华股份\n帮我搜索一下这支股票的行情';
    expect(isFileGenIntent(extractPrompt)).toBe(true);
  });

  test('单组词不触发（仅"创建"或仅"文档"）', () => {
    expect(isFileGenIntent('帮我创建这个')).toBe(false); // 创建 ✓ 但无文件类词
    expect(isFileGenIntent('这个文档不错')).toBe(false); // 文档 ✓ 但无动作词
    expect(isFileGenIntent('')).toBe(false);
    expect(isFileGenIntent(null)).toBe(false);
    expect(isFileGenIntent(undefined)).toBe(false);
  });

  test('系统注入片段不误判（实机根因：上传 .docx + 分析该文档 → 工作流建议注入"创建"）', () => {
    // 2026-08-20 实机：intentAnalyzer 误判 complex_workflow → chat-handler 注入
    // "[系统提示: 此任务可能需要创建工作流…]"（含"创建"）+ 附件说明（含"文件"）
    // → 与用户消息"分析该文档"（含"文档"）双命中 → FileGenPanel 误弹。
    const workflowInjected =
      '分析该文档\n\n' +
      '[用户上传了以下文件: ]\n' +
      '文件路径:\n' +
      'D:/bossagent/data/.crabpaw/workspace/uploads/1787162572636_OpenClaw___________.docx\n\n' +
      '你可以使用 DocRead 工具读取这些文件的内容（参数 path 传入文件路径）。\n\n' +
      '[系统提示: 此任务可能需要创建工作流来协调完成。你可以使用 taskflow 工具的 create 操作来创建工作流。 推荐模板: "数据分析"]';
    expect(isFileGenIntent(workflowInjected)).toBe(false);
    // 语音模式 brevityHint（中文冒号变体）同样剥离
    expect(isFileGenIntent('分析该文档\n\n[系统提示：当前是语音对话模式，你的回复将被 TTS 朗读]')).toBe(false);
    // 纯用户消息本就不触发
    expect(isFileGenIntent('分析该文档')).toBe(false);
  });

  test('真实生成意图叠加系统提示仍触发', () => {
    const voiceHint = '\n\n[系统提示：当前是语音对话模式，你的回复将被 TTS 朗读]';
    expect(isFileGenIntent('帮我生成一份关于大华股份的分析报告' + voiceHint)).toBe(true);
    expect(isFileGenIntent('创建一个 word 文档\n\n[用户上传了以下文件: a.docx]\n文件路径:\nD:/tmp/a.docx')).toBe(true);
  });
});
