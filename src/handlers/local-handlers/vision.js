// vision.js — 视觉校验(界面自检员, 2026-08-25)
// POST /api/vision/verify { image(dataURL/base64), expectation, kind }
// 主模型(多模态)校验界面截图是否符合预期 → { verified, note }; 差异写入日志。
const { readJsonBody, sendJson } = require('../http-utils');

async function handleVisualVerify(req, res) {
  try {
    const body = await readJsonBody(req);
    const image = String(body?.image || '').replace(/^data:image\/[a-z+]+;base64,/, '');
    const expectation = String(body?.expectation || '').slice(0, 300);
    const kind = String(body?.kind || 'unknown').slice(0, 40);
    if (!image || image.length < 128) {
      return sendJson(res, 400, { success: false, error: 'image missing or empty' });
    }
    if (image.length > 6 * 1024 * 1024) {
      return sendJson(res, 400, { success: false, error: 'image too large' });
    }
    const { getAuxiliaryClient } = require('../../core/auxiliary-client');
    const prompt = '你是 UI 自检员。期望界面: ' + expectation +
      '\n检查截图是否符合预期。只输出一行结论:\nVERIFY_OK: <一句描述看到的>\n或 VERIFY_ISSUE: <具体问题, 如卡片未显示/空态/遮挡/错位>。\n注意: 若界面正常但内容微调差异, 仍判 VERIFY_OK 并简述。';
    const aux = getAuxiliaryClient();
    const r = await aux.analyzeImage(image, prompt, { maxTokens: 700, temperature: 0.1, timeout: 45000 });
    const text = String(r?.content || '').slice(0, 600);
    const ok = /VERIFY_OK/i.test(text);
    console.log(`[视觉自检] kind=${kind} → ${ok ? 'OK' : 'ISSUE'} ${text.slice(0, 160)}`);
    return sendJson(res, 200, { success: true, verified: ok, note: text });
  } catch (e) {
    console.error('[vision/verify] 校验失败:', e?.message || e);
    return sendJson(res, 500, { success: false, error: e?.message || 'verify failed' });
  }
}

module.exports = { handleVisualVerify };
