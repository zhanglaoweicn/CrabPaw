/**
 * 语音回复进化 API Handler
 */

const voiceEvolution = require('../core/voice-evolution');
const { readJsonBody } = require('./http-utils');

/**
 * 查询缓存提炼结果
 */
async function handleGetCachedRefinement(req, res, _ctx) {
  try {
    const body = await readJsonBody(req);
    const { originalText } = body;

    if (!originalText) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '缺少必要参数' }));
      return;
    }

    const cached = voiceEvolution.getCachedRefinement(originalText);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      cached: !!cached,
      data: cached || null
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

/**
 * 保存提炼结果到缓存
 */
async function handleSaveCachedRefinement(req, res, _ctx) {
  try {
    const body = await readJsonBody(req);
    const { originalText, refinedText, rating } = body;

    if (!originalText || !refinedText) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '缺少必要参数' }));
      return;
    }

    voiceEvolution.saveCachedRefinement(originalText, refinedText, rating || 0);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

/**
 * 自动评估提炼结果
 */
async function handleAutoEvaluate(req, res, _ctx) {
  try {
    const body = await readJsonBody(req);
    const { original, refined } = body;

    if (!original || !refined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '缺少必要参数' }));
      return;
    }

    const rating = voiceEvolution.autoEvaluateRefinement(original, refined);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { rating } }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

/**
 * 触发自动进化
 */
async function handleRunAutoEvolution(req, res, _ctx) {
  try {
    const result = voiceEvolution.runAutoEvolution();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: result }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

/**
 * 获取进化统计信息
 */
async function handleGetVoiceEvolutionStats(req, res, _ctx) {
  try {
    const stats = voiceEvolution.getEvolutionStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: stats
    }));
  } catch (err) {
    console.error('❌ 获取进化统计失败:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: err.message
    }));
  }
}

/**
 * 添加优秀示例
 */
async function handleAddExcellentExample(req, res, _ctx) {
  try {
    const body = await readJsonBody(req);
    const { original, refined, rating, category } = body;
    
    if (!original || !refined || !rating) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: '缺少必要参数'
      }));
      return;
    }
    
    voiceEvolution.addExcellentExample(original, refined, rating, category);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: '优秀示例已添加'
    }));
  } catch (err) {
    console.error('❌ 添加优秀示例失败:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: err.message
    }));
  }
}

/**
 * 添加失败示例
 */
async function handleAddFailedExample(req, res, _ctx) {
  try {
    const body = await readJsonBody(req);
    const { original, refined, reason } = body;
    
    if (!original || !refined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: '缺少必要参数'
      }));
      return;
    }
    
    voiceEvolution.addFailedExample(original, refined, reason);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: '失败示例已添加'
    }));
  } catch (err) {
    console.error('❌ 添加失败示例失败:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: err.message
    }));
  }
}

/**
 * 更新用户偏好
 */
async function handleUpdateUserPreferences(req, res, _ctx) {
  try {
    const preferences = await readJsonBody(req);
    
    voiceEvolution.updateUserPreferences(preferences);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: '用户偏好已更新'
    }));
  } catch (err) {
    console.error('❌ 更新用户偏好失败:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: err.message
    }));
  }
}

/**
 * 获取动态提炼策略
 */
async function handleGetDynamicRefinementStrategy(req, res, _ctx) {
  try {
    const body = await readJsonBody(req);
    const { originalText } = body;
    
    if (!originalText) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: '缺少必要参数'
      }));
      return;
    }
    
    const strategy = voiceEvolution.getDynamicRefinementStrategy(originalText);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: strategy
    }));
  } catch (err) {
    console.error('❌ 获取动态提炼策略失败:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: err.message
    }));
  }
}

/**
 * 清理过期缓存
 */
async function handleCleanVoiceCache(req, res, _ctx) {
  try {
    const cleaned = voiceEvolution.cleanExpiredCache();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: `清理了 ${cleaned} 条过期缓存`
    }));
  } catch (err) {
    console.error('❌ 清理缓存失败:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: err.message
    }));
  }
}

/**
 * 调用 AI 将回复提炼为适合语音播放的文本
 */
async function handleRefineVoice(req, res, ctx) {
  try {
    const body = await readJsonBody(req);
    const { text, prompt } = body;

    if (!text || !prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '缺少必要参数' }));
      return;
    }

    const ai = ctx && ctx.ai;
    if (!ai || typeof ai.chat !== 'function') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'AI 服务不可用' }));
      return;
    }

    const userId = body.userId || 'voice_refine';
    const skills = (ctx.skillsRegistry || ctx.skills);
    const result = await ai.chat(ctx.appConfig, skills, userId, prompt);
    const refined = typeof result === 'string' ? result : (result && (result.reply || result.content)) || '';

    if (!refined) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'AI 未返回提炼结果' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { refined } }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

module.exports = {
  handleGetVoiceEvolutionStats,
  handleAddExcellentExample,
  handleAddFailedExample,
  handleUpdateUserPreferences,
  handleGetDynamicRefinementStrategy,
  handleCleanVoiceCache,
  handleGetCachedRefinement,
  handleSaveCachedRefinement,
  handleAutoEvaluate,
  handleRunAutoEvolution,
  handleRefineVoice
};
