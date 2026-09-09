/**
 * bash-approval-channel.test.js — 发布 P1-2 回归测试
 *
 * 根因：handleBash 在审批路径只读终端 stdin（readUserInput）——GUI 启动的后端
 * stdin 恒无输入 → 100% 30s 超时 → 「审批超时」被记为工具失败
 * （skill-usage.json 实测 Bash 53/53 全失败，命令从未执行）。
 *
 * 修复后非 TTY 环境改走 ApprovalSystem 事件通道（waitForApproval）——
 * GUI 经 /api/security/approval → approval.respond → 'responded' 事件决议。
 *
 * 断言（修复前均失败/挂起）：
 *   1. 拦截的命令进入审批队列（pending 存在），而非阻塞在终端输入；
 *   2. 前端批准后命令真正执行，外层 success:true 且内层 exitCode===0；
 *   3. 前端拒绝后按拒绝返回，不误报「超时」。
 */
const { getApprovalSystem } = require('../core/security/index');
const { registry } = require('../tools/registry');
require('../tools/bash-tools');

const approval = getApprovalSystem();

// 非 TTY 守卫：本测试只验证事件通道分支（TTY 终端输入流程无法在 jest 中自动化）
const nonTty = !process.stdin.isTTY;
const maybe = nonTty ? test : test.skip;

describe('Bash 审批通道（发布 P1-2 双通道修复）', () => {
  // 2026-09-07: 只读命令(echo/cat/dir 等)已免审批直执行(isReadonlySafeCommand)，
  // 本套件验证的是"被拦截命令"的审批通道，须用非只读样本(执行类)。
  maybe('非 TTY：拦截的命令进入审批队列并可被前端批准后真正执行', async () => {
    const execPromise = registry.execute('Bash', { command: 'node -e "process.stdout.write(\'hi\')"' }, { userId: 'test' });

    // 等待进入审批队列（证明走的是审批事件通道而非终端输入）
    let pending = [];
    for (let i = 0; i < 50 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pending = approval.getPendingRequests();
    }
    expect(pending.length).toBe(1);
    expect(pending[0].command).toBe('node -e "process.stdout.write(\'hi\')"');

    // 模拟 GUI：ApprovalHost → POST /api/security/approval → approval.respond
    const respondResult = await approval.respond(pending[0].id, true, 'once');
    expect(respondResult.status).toBe('approved');

    const result = await execPromise;
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data.success).toBe(true);   // 内层 exitCode 0
    expect(result.data.exitCode).toBe(0);
    expect(String(result.data.stdout)).toContain('hi');
  }, 15000);

  maybe('非 TTY：前端拒绝时按拒绝返回（非超时）', async () => {
    const execPromise = registry.execute('Bash', { command: 'node -e "process.stdout.write(\'denied\')"' }, { userId: 'test' });

    let pending = [];
    for (let i = 0; i < 50 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pending = approval.getPendingRequests();
    }
    expect(pending.length).toBe(1);

    await approval.respond(pending[0].id, false, 'once');

    const result = await execPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain('拒绝');
  }, 15000);
});
