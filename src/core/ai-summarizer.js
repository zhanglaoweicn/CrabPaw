/**
 * ai-summarizer.js — AI 摘要生成
 *
 * 从 ai.js 中提取的独立摘要功能，无内部状态依赖。
 */

async function summarize(config, keyword, results, customPrompt, deps = {}) {
  const {
    getModelRouter,
    createModelRouter,
    fetchWithRetry,
  } = deps;

  if (!getModelRouter || !createModelRouter || !fetchWithRetry) {
    console.error('[AI Summarizer] 缺少必要依赖');
    return null;
  }

  let router = getModelRouter();
  if (!router) {
    createModelRouter(config);
    router = getModelRouter();
  }

  if (!router) {
    console.error('[AI Summarizer] 路由器初始化失败');
    return null;
  }

  const routeResult = router.route(keyword);
  if (routeResult.error) {
    return null;
  }

  const { model, baseUrl, apiKey, provider } = routeResult;

  const resultsText = results.slice(0, 8).map((r, i) => {
    return `${i + 1}. 标题: ${r.title}\n 描述: ${r.desc || '无描述'}`;
  }).join('\n\n');

  const now = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' });
  
  let prompt;
  if (customPrompt && customPrompt.trim()) {
    prompt = `你是一个专业的资讯编辑，负责将搜索结果整理成一份简洁有力的今日简报。

${customPrompt.trim()}

标题格式：## 🔥 ${keyword} - ${now}

【严格禁止】
- 不要添加搜索结果中没有的信息
- 不要写"根据搜索结果"等废话

【搜索结果】
${resultsText}`;
  } else {
    const { loadPromptFile } = require('./prompts/index');
    const defaultStyleGuide = loadPromptFile('summarizer', 'default-style-guide.txt', {
      keyword,
      date: now,
    }) || `【写作风格】
- 语言自然流畅，像专业人士撰写的朋友圈推文
- 善用短句和分段，信息密度高但不堆砌
- 可以使用"据悉""从XX获悉""值得关注"等新闻式表达
- 适当使用 emoji 增加可读性（每段最多1-2个）

【内容组织】
- 开头用一句话概括今日最值得关注的动态
- 按重要性排列，最重要的资讯放在最前面
- 每个咨询点要具体：谁、做了什么、意义是什么
- 果断剔除重复或价值低的资讯，保留精华

【输出格式】
直接输出Markdown内容，无需任何前言：

## 🔥 ${keyword} - ${now}

[一段话概括今日整体态势，2-3句话]

---

### 头条速递
[最值得关注的1-2条资讯，每条用简洁的条目说明]

### 今日要点
[按类别或热度组织剩余重要资讯，每条1-2句话]

### 快速一览
[其余资讯的极简版本，列表形式即可]

---

【严格禁止】
- 不要添加搜索结果中没有的信息
- 不要写"根据搜索结果"等废话
- 不要输出模糊的"近日""目前"等时间词
- 不要堆砌信息，每条都要有价值`;

    prompt = `你是一个专业的科技资讯编辑，负责将搜索结果整理成一份简洁有力的今日简报。

${defaultStyleGuide}

【搜索结果】
${resultsText}`;
  }

  try {
    console.log(`📝 AI 整理搜索结果，模型: ${model} (${provider}), baseUrl: ${baseUrl}`);

    const resp = await fetchWithRetry(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      })
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(`❌ AI API 错误: ${resp.status} - ${errorText.substring(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    console.log(`📝 AI 整理完成，响应:`, JSON.stringify(data).substring(0, 200));

    if (data.choices && data.choices[0]) {
      return data.choices[0].message.content;
    }
  } catch (e) {
    console.error('❌ AI 整理失败:', e.message);
  }

  return null;
}

module.exports = { summarize };
