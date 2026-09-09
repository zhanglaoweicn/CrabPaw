/**
 * 通道群聊链路测试（2026-09-06）:
 *   - send-guard 群白名单文件（approve→窗口内放行→过期拒绝）
 *   - wecom group-router mention 剥离只剥机器人自己（over-strip 回归）
 *   - MessageDeduplicator 键约定（chat-handler 接线依赖）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { approveGroupChat, loadApprovedGroupChats, loadAllowedChatIds, isAllowedChatId } = require('../channels/wecom/send-guard');
const { GroupRouter } = require('../channels/wecom/group-router');

describe('send-guard 群白名单（跨进程文件 + 时间窗口）', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-groups-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test('approve 后窗口内放行，未批准的群拒绝', () => {
    approveGroupChat(tmp, 'wr_group_A');
    const approved = loadApprovedGroupChats(tmp);
    expect(isAllowedChatId('wr_group_A', approved)).toBe(true);
    expect(isAllowedChatId('wr_group_B', approved)).toBe(false);
  });

  test('过窗口的批准失效（fail-closed）', () => {
    approveGroupChat(tmp, 'wr_group_A');
    // 手写一个过期时间戳
    const p = path.join(tmp, 'config', 'wecom-allowed-groups.json');
    const groups = JSON.parse(fs.readFileSync(p, 'utf-8'));
    groups['wr_group_A'] = Date.now() - (11 * 60 * 1000);
    fs.writeFileSync(p, JSON.stringify(groups));
    const approved = loadApprovedGroupChats(tmp);
    expect(isAllowedChatId('wr_group_A', approved)).toBe(false);
  });

  test('用户配置集与群白名单互不影响（并集使用）', () => {
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'config', 'user.json'), JSON.stringify({ wecomUserId: 'boss_user' }));
    approveGroupChat(tmp, 'wr_group_A');
    const userSet = loadAllowedChatIds(tmp);
    const groupSet = loadApprovedGroupChats(tmp);
    expect(isAllowedChatId('boss_user', userSet)).toBe(true);
    expect(isAllowedChatId('wr_group_A', groupSet)).toBe(true);
    expect(isAllowedChatId('wr_group_A', userSet)).toBe(false);
  });
});

describe('wecom group-router mention 剥离（over-strip 回归）', () => {
  test('只剥机器人自己的 @，他人 @ 保留', () => {
    const router = new GroupRouter({ botUserId: 'bot_u1', botName: '小蟹', groupPolicy: 'mention_only' });
    const raw = { content: '@小蟹 帮我查下 @张三 的报销', rawBody: { mention_list: ['bot_u1'] } };
    const result = router.route({ ...raw, chatId: 'wr_g1', chatType: 'group' });
    expect(result.shouldProcess).toBe(true);
    expect(result.extractedContent).toBe('帮我查下 @张三 的报销');
  });

  test('无 botName 时不剥任何 @（保守不猜）', () => {
    const router = new GroupRouter({ botUserId: '', botName: '', groupPolicy: 'mention_only' });
    const raw = { content: '@某人 你好', rawBody: { mention_list: ['x1'] } };
    const result = router.route({ ...raw, chatId: 'wr_g1', chatType: 'group' });
    // 无 botUserId 时 mention_list 非空即视为被提及（兼容配置缺省）
    expect(result.shouldProcess).toBe(true);
    expect(result.extractedContent).toBe('@某人 你好');
  });
});

describe('MessageDeduplicator（chat-handler 接线依赖）', () => {
  test('同 msgId 二次 check 判重；msgId 缺失走分钟桶+内容', () => {
    const { MessageDeduplicator } = require('../channels/wecom/message-dedup');
    const d = new MessageDeduplicator({ ttl: 60000 });
    expect(d.check({ msgId: 'm1', chatId: 'c1', content: 'hi' }).isDuplicate).toBe(false);
    expect(d.check({ msgId: 'm1', chatId: 'c1', content: 'hi' }).isDuplicate).toBe(true);
    const ev = { msgId: '', chatId: 'c1', fromUserId: 'u1', content: 'hello', timestamp: Date.now() };
    expect(d.check(ev).isDuplicate).toBe(false);
    expect(d.check(ev).isDuplicate).toBe(true);
  });
});
