/**
 * R4: 提醒/日程/开会三意图消歧——hint 互斥指引的契约锁定
 * 背景：「记得提醒我明天上午10点开会」对 intents.js 的 日程(:37)/提醒(:41)/开会(:45)
 * 三命中并发注入，无消歧 → 双调/错调。本测试锁定三条 hint 的互斥指引文案。
 */
const source = require('fs').readFileSync(require('path').join(__dirname, '../core/ai/intents.js'), 'utf8');

describe('intents 消歧契约（R4）', () => {
  test('日程 hint 含「默认带提醒，无需再调 SetReminder」', () => {
    const line = source.split('\n').find(l => l.includes('CreateCalendarEvent'));
    expect(line).toContain('无需再调 SetReminder');
  });
  test('提醒 hint 含「带具体时间的会议/日程 → CreateCalendarEvent」', () => {
    const line = source.split('\n').find(l => l.includes('SetReminder'));
    expect(line).toContain('CreateCalendarEvent');
  });
  test('开会 hint 限定企微在线会议语义', () => {
    const line = source.split('\n').find(l => l.includes('WeComCreateMeeting'));
    expect(line).toContain('企微');
  });
});
