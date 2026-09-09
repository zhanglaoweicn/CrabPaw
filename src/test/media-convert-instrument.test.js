/**
 * media-convert-instrument.test.js — POST /api/document/convert 实况实现插桩（2026-08-17 C1）
 *
 * ROUTE_TABLE 将该路由解析到 src/handlers/local-handlers/media.js 的
 * handleDocumentConvert（panel-handler 旧分支为被遮蔽死代码，已删除）。
 * 本测试锁定实况实现的 filegen 广播契约 + 响应形状稳定：
 *   1. 成功路径 start(collect)→phase(converting)→done(file) 按序广播，
 *      done 载荷 format 取 formatFromPath、html 目标带 local:// url；
 *   2. doneFileGen 广播自身抛错 → 仍 200、无 spurious failFileGen（插桩不阻塞主流程）；
 *   3. 生成失败 → 500 + failFileGen；failFileGen 自身抛错不掩盖 500。
 */
jest.mock('../core/filegen-events', () => {
  const actual = jest.requireActual('../core/filegen-events');
  // 2026-08-17: 插桩契约改为 ensureFileGenTask（四步流程——写作流程中复用活跃任务推进
  // ④文档生成；无活跃任务则新建）。mock 返回固定 taskId 供 doneFileGen 断言。
  return {
    ...actual,
    ensureFileGenTask: jest.fn(() => 'filegen-test'),
    startFileGen: jest.fn(), phaseFileGen: jest.fn(), doneFileGen: jest.fn(), failFileGen: jest.fn(),
  };
});
jest.mock('../tools/document-tools', () => ({
  _generateDocx: jest.fn(async () => Buffer.from('fake-docx-content')),
  _generateHtml: jest.fn(() => '<html>fake-html</html>'),
  _generatePdf: jest.fn(async () => Buffer.from('fake-pdf-content')),
}));

const fs = require('fs');
const filegen = require('../core/filegen-events');
const documentTools = require('../tools/document-tools');
const { handleDocumentConvert } = require('../handlers/local-handlers/media');

beforeEach(() => jest.clearAllMocks());

function fakeHttp(body) {
  // 真实 readRequestBody 会 on/removeListener 成对调用——用 EventEmitter 承载
  const { EventEmitter } = require('events');
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/api/document/convert';
  // 下一 tick 触发 data/end——此时 readRequestBody 已同步挂上监听（handleDocumentConvert
  // 首个 await 即 readJsonBody，监听注册先于事件触发）
  process.nextTick(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  const state = { statusCodes: [], bodies: [] };
  const res = {
    writeHead(code) { state.statusCodes.push(code); },
    end(payload) { state.bodies.push(payload); },
  };
  return { req, res, state };
}

describe('POST /api/document/convert（media.js 实况实现）filegen 插桩', () => {
  test('docx 成功 → start/phase/done 按序广播 + 响应形状稳定 {path,ext,size,sizeKB}', async () => {
    const { req, res, state } = fakeHttp(JSON.stringify({ content: '# 标题\n正文', title: '测试文档', target: 'docx' }));
    await handleDocumentConvert(req, res);

    expect(state.statusCodes[0]).toBe(200);
    const json = JSON.parse(state.bodies[0]);
    expect(json.success).toBe(true);
    expect(json.ext).toBe('docx');
    expect(typeof json.size).toBe('number');
    expect(typeof json.sizeKB).toBe('string');
    expect(json.path).toContain('documents');

    expect(filegen.ensureFileGenTask).toHaveBeenCalledTimes(1);
    expect(filegen.ensureFileGenTask.mock.calls[0][0]).toEqual(expect.objectContaining({ title: '测试文档', format: 'docx', phase: 'converting' }));
    expect(filegen.doneFileGen).toHaveBeenCalledTimes(1);
    const file = filegen.doneFileGen.mock.calls[0][1];
    expect(file.format).toBe('docx');
    expect(file.url).toBeNull();
    expect(file.size).toBe(Buffer.from('fake-docx-content').length);
    expect(filegen.failFileGen).not.toHaveBeenCalled();

    try { fs.unlinkSync(json.path); } catch (e) { console.warn('[test] 清理失败:', e.message); }
  });

  test('html 成功 → done 载荷带 local:// 预览 url（DATA_DIR 内）', async () => {
    const { req, res, state } = fakeHttp(JSON.stringify({ content: '# t', title: '预览页', target: 'html' }));
    await handleDocumentConvert(req, res);

    expect(state.statusCodes[0]).toBe(200);
    const file = filegen.doneFileGen.mock.calls[0][1];
    expect(file.format).toBe('html');
    expect(file.url).toBe('local:///' + JSON.parse(state.bodies[0]).path.replace(/\\/g, '/'));
    try { fs.unlinkSync(JSON.parse(state.bodies[0]).path); } catch (e) { console.warn('[test] 清理失败:', e.message); }
  });

  test('doneFileGen 广播抛错 → 仍 200，failFileGen 不被调用（插桩隔离）', async () => {
    filegen.doneFileGen.mockImplementation(() => { throw new Error('bus 爆炸'); });
    const { req, res, state } = fakeHttp(JSON.stringify({ content: '# t', title: 'bus-test', target: 'docx' }));
    await handleDocumentConvert(req, res);

    expect(state.statusCodes[0]).toBe(200);
    expect(filegen.failFileGen).not.toHaveBeenCalled();
    expect(filegen.ensureFileGenTask).toHaveBeenCalledTimes(1);
    expect(filegen.doneFileGen).toHaveBeenCalledTimes(1);
    try { fs.unlinkSync(JSON.parse(state.bodies[0]).path); } catch (e) { console.warn('[test] 清理失败:', e.message); }
  });

  test('生成失败 → 500 + failFileGen；failFileGen 自身抛错不掩盖 500', async () => {
    documentTools._generateDocx.mockRejectedValue(new Error('docx 生成失败'));
    filegen.failFileGen.mockImplementation(() => { throw new Error('bus 爆炸'); });
    const { req, res, state } = fakeHttp(JSON.stringify({ content: '# t', title: 'fail-test', target: 'docx' }));
    await handleDocumentConvert(req, res);

    expect(state.statusCodes[0]).toBe(500);
    expect(JSON.parse(state.bodies[0]).error).toBe('docx 生成失败');
    expect(filegen.failFileGen).toHaveBeenCalledTimes(1);
  });

  test('缺 content → 400，且不触发任何广播', async () => {
    const { req, res, state } = fakeHttp(JSON.stringify({ title: 'x', target: 'docx' }));
    await handleDocumentConvert(req, res);
    expect(state.statusCodes[0]).toBe(400);
    expect(filegen.ensureFileGenTask).not.toHaveBeenCalled();
    expect(filegen.failFileGen).not.toHaveBeenCalled();
  });
});
