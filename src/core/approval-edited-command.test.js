/**
 * 审批 approve-with-edits 测试(P1-7, ag-ui Interrupt 借鉴)
 *
 * 背景(2026-08-13): 用户批准时可编辑命令参数——编辑后强制 scope=once
 * (不参与 session/always 记忆,防提权),命令以 finalCommand 传播给等待方;
 * 执行方(exec-approval)对编辑后命令重新安全检查,失败则 fail closed。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

describe('ApprovalSystem respond 编辑命令', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-approval-test-'));
  let ApprovalSystem;
  let sys;

  beforeAll(() => {
    process.env.CRABPAW_DATA_DIR = tmpDir;
    jest.resetModules();
    ApprovalSystem = require('./security/approval').ApprovalSystem;
  });

  beforeEach(() => {
    sys = new ApprovalSystem();
  });

  afterAll(() => {
    delete process.env.CRABPAW_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('无编辑命令时行为不变', async () => {
    const req = await sys.request('rm -rf /tmp/x', { source: 'test' });
    const result = await sys.respond(req.requestId, true, 'once');
    expect(result.success).toBe(true);
    expect(result.command).toBe('rm -rf /tmp/x');
    expect(result.edited).toBe(false);
  });

  test('编辑命令后返回 finalCommand 且 scope 强制 once', async () => {
    const req = await sys.request('rm -rf /tmp/x', { source: 'test' });
    const result = await sys.respond(req.requestId, true, 'always', { editedCommand: 'rm -rf /tmp/y' });
    expect(result.success).toBe(true);
    expect(result.command).toBe('rm -rf /tmp/y');
    expect(result.edited).toBe(true);
    expect(result.scope).toBe('once'); // 编辑后强制 once
    // 不写入 always 决策缓存(防提权)
    expect(sys._decisions.size).toBe(0);
  });

  test('编辑命令不进入 session 记忆', async () => {
    const req = await sys.request('rm -rf /tmp/a', { source: 'test' });
    await sys.respond(req.requestId, true, 'session', { editedCommand: 'rm -rf /tmp/b' });
    expect(sys._sessionApprovals.size).toBe(0);
  });

  test('编辑后 waitForApproval resolve 携带编辑命令', async () => {
    const req = await sys.request('echo hi', { source: 'test' });
    const waitPromise = sys.waitForApproval(req.requestId, 5000);
    setTimeout(() => {
      void sys.respond(req.requestId, true, 'once', { editedCommand: 'echo edited' });
    }, 10);
    const decision = await waitPromise;
    expect(decision.approved).toBe(true);
    expect(decision.command).toBe('echo edited');
  });

  test('空/超长编辑命令被忽略', async () => {
    const req = await sys.request('echo hi', { source: 'test' });
    const empty = await sys.respond(req.requestId, true, 'once', { editedCommand: '   ' });
    expect(empty.edited).toBe(false);
    expect(empty.command).toBe('echo hi');

    const req2 = await sys.request('echo hi2', { source: 'test' });
    const tooLong = await sys.respond(req2.requestId, true, 'once', { editedCommand: 'x'.repeat(4001) });
    expect(tooLong.edited).toBe(false);
    expect(tooLong.command).toBe('echo hi2');
  });

  test('拒绝时编辑命令不生效(不传播)', async () => {
    const req = await sys.request('echo hi', { source: 'test' });
    const result = await sys.respond(req.requestId, false, 'once', { editedCommand: 'rm -rf /' });
    expect(result.success).toBe(true);
    expect(result.status).toBe('denied');
    expect(result.command).toBe('echo hi'); // 拒绝时保持原命令
  });
});

describe('ExecApproval evaluateWithApproval 编辑重检(fail closed)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-exec-approval-test-'));
  let ApprovalSystem;
  let ExecApproval;
  let sys;

  beforeAll(() => {
    process.env.CRABPAW_DATA_DIR = tmpDir;
    jest.resetModules();
    ApprovalSystem = require('./security/approval').ApprovalSystem;
    ExecApproval = require('./exec-approval').ExecApproval;
  });

  beforeEach(() => {
    sys = new ApprovalSystem();
  });

  afterAll(() => {
    delete process.env.CRABPAW_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('安全编辑后的命令放行并传播', async () => {
    const ea = new ExecApproval({ approvalSystem: sys, mode: 'interactive' });
    // rm -rf 触发审批(medium+ risk);批准时编辑成安全命令(echo)——重检通过后放行
    const promise = ea.evaluateWithApproval('rm -rf /tmp/x', {});
    // 等待审批请求挂出
    await new Promise((r) => setTimeout(r, 30));
    const pending = sys.getPendingRequests();
    expect(pending.length).toBe(1);
    const req = pending[0];
    await sys.respond(req.id, true, 'once', { editedCommand: 'echo edited-ok' });
    const result = await promise;
    expect(result.edited).toBe(true);
    expect(result.command).toBe('echo edited-ok');
    expect(result.allowed).toBe(true);
  });

  test('编辑成危险命令 fail closed', async () => {
    const ea = new ExecApproval({ approvalSystem: sys, mode: 'interactive' });
    const promise = ea.evaluateWithApproval('rm -rf /tmp/x', {});
    await new Promise((r) => setTimeout(r, 30));
    const pending = sys.getPendingRequests();
    expect(pending.length).toBe(1);
    const req = pending[0];
    await sys.respond(req.id, true, 'once', { editedCommand: 'rm -rf /' });
    const result = await promise;
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('未通过安全检查');
  });
});
