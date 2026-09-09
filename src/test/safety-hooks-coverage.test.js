/**
 * safety-hooks-coverage.test.js — 危险命令钩子覆盖面与命令规范化测试
 *
 * 对应 2026-08 P0+P1 安全加固 Task 10:
 * 1. 钩子工具名单必须覆盖全部 shell 类工具（Bash / ShellExec），
 *    漏一个注册名就是漏一个攻击面（ShellExec 此前不在覆盖内）。
 * 2. 黑名单匹配前必须做命令规范化（剥引号 / ${IFS} 展开 / 折叠空白 /
 *    拆分参数形态），否则 `rm -rf '/'` / `rm -rf ${IFS}/` / `rm -r -f /`
 *    均可绕过子串匹配。
 * 3. 黑名单是纵深防御的一层（PathPermission / 审批 / registry 危险标记
 *    仍是主门），本测试不承诺黑名单本身完备。
 */
const { HookManager } = require('../core/harness-hooks');

describe('危险命令钩子覆盖与规范化', () => {
  const hooks = HookManager.createSafetyHooks();

  test.each(['ShellExec', 'Bash', 'bash'])('工具 %s 被危险命令钩子覆盖', async (tool) => {
    const h = hooks[0]; // createSafetyHooks 返回数组，第一个 = 危险命令钩子
    const r = await h(tool, { command: 'rm -rf /' });
    expect(r.allowed).toBe(false);
  });

  test('非 shell 类工具不受危险命令钩子影响', async () => {
    const h = hooks[0];
    const r = await h('Read', { file_path: '/etc/passwd', command: 'rm -rf /' });
    expect(r.allowed).toBe(true);
  });

  test.each([
    'rm   -rf   /',           // 多空白折叠
    'rm -rf ${IFS}/',         // IFS 变量展开
    'rm -rf $IFS/',           // IFS 变量（无花括号形态）
    "rm -rf '/'",             // 引号包裹
    'rm -rf "`/`"',           // 反引号包裹
    'rm -r -f /',             // 参数拆分形态
    'rm -fr /',               // flag 顺序颠倒
    'rm -rf /*',              // 根通配
    'rm -rf ~',               // 家目录
  ])('规范化后仍拦截: %s', async (cmd) => {
    const h = hooks[0];
    const r = await h('Bash', { command: cmd });
    expect(r.allowed).toBe(false);
  });

  test.each([
    'ls -la',
    'echo "rm -rf" file.txt',
    'git status',
    'node scripts/build.js',
  ])('普通命令放行: %s', async (cmd) => {
    const h = hooks[0];
    const r = await h('Bash', { command: cmd });
    expect(r.allowed).toBe(true);
  });

  test('空 command 参数不抛异常并放行', async () => {
    const h = hooks[0];
    const r = await h('Bash', {});
    expect(r.allowed).toBe(true);
  });
});

describe('审查修复轮：长 flag / ~/ 尾斜杠 / $HOME 绕过堵住', () => {
  const hooks = HookManager.createSafetyHooks();

  test.each([
    'rm --recursive --force /',                    // I1: 纯长 flag 形态
    'rm --recursive -f /',                         // I1: 长短混合
    'rm -r --force /',                             // I1: 长短混合（反向）
    'rm --recursive --force --no-preserve-root /', // I1: 长 flag + 保根覆盖
    'rm -r -f ~/',                                 // I2: 家目录尾斜杠
    'rm -rf ~/',                                   // I2: 家目录尾斜杠（合并 flag）
    'rm -rf $HOME',                                // M1: 变量展开家目录
    'rm -rf "$HOME"',                              // M1: 引号包裹变量
    'rm -rf $home/',                               // M1: 变量 + 尾斜杠
  ])('拦截: %s', async (cmd) => {
    const h = hooks[0];
    const r = await h('Bash', { command: cmd });
    expect(r.allowed).toBe(false);
  });

  test.each([
    'rm --recursive --force ./build',   // 长	flag 但目标非根/家目录
    'rm -rf node_modules',              // 普通相对目标
    'rm --force /tmp/f.txt',            // 绝对路径但非根
  ])('非根/家目录目标放行: %s', async (cmd) => {
    const h = hooks[0];
    const r = await h('Bash', { command: cmd });
    expect(r.allowed).toBe(true);
  });
});
