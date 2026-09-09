/**
 * 提醒工具 - 统一任务体系中的临时任务
 */
const crypto = require("crypto");
const { registry } = require("./registry");
const config = require("../core/config");
const { validateCron, getNextRunTime } = require("../core/scheduler");

function timeToCron(timeStr) {
  const now = new Date();
  const hmMatch = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (hmMatch) {
    const hour = parseInt(hmMatch[1]);
    const minute = parseInt(hmMatch[2]);
    if (now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute)) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return [minute, hour, tomorrow.getDate(), tomorrow.getMonth() + 1, "*"].join(" ");
    }
    return [minute, hour, "*", "*", "*"].join(" ");
  }
  // R3: 自然语言回退（明天上午10点/大后天晚上八点半…）——统一解析器，不再只认 HH:mm
  try {
    const { parseNaturalDateTime } = require("../schedule/utils/natural-datetime");
    const r = parseNaturalDateTime(String(timeStr || "").trim(), now);
    if (!r.ambiguous) {
      const [y, mo, d] = r.date.split("-").map(Number);
      const [h, mi] = r.time.split(":").map(Number);
      const target = new Date(y, mo - 1, d, h, mi);
      if (target.getTime() > now.getTime()) {
        return [mi, h, d, mo, "*"].join(" ");
      }
    }
  } catch (e) {
    console.error("[reminder] 自然语言时间解析失败:", e && e.message ? e.message : e);
  }
  return null;
}

async function sendReminderMessage(channel, targetId, message) {
  const appConfig = config.loadConfig();
  const formattedMessage = "**Reminder**\n\n" + message;
  if (channel === "wecom") {
    try { const wc = require("../channels/wecom").createChannel(appConfig); await wc.send(null, formattedMessage); return true; }
    catch(e) { console.error("[reminder] 企业微信发送失败:", e && e.message ? e.message : e); return false; }
  }
  if (channel === "lark") {
    try { const lc = require("../channels/lark").createChannel(appConfig); await lc.send(null, formattedMessage); return true; }
    catch(e) { console.error("[reminder] 飞书发送失败:", e && e.message ? e.message : e); return false; }
  }
  // P2-4: 无外部通道（none/未识别）→ 本机播报由 server 'reminder' handler 的 proactive.notify 承担
  if (!channel || channel === "none") {
    console.log("[reminder] 无外部消息通道，提醒将仅在本机播报");
  }
  return true;
}

function addReminderToSchedules(reminder) {
  const s = config.loadSchedules();
  if (!s.cron) s.cron = [];
  const idx = s.cron.findIndex(function(t) { return t.id === reminder.id; });
  if (idx !== -1) s.cron[idx] = reminder; else s.cron.push(reminder);
  config.saveSchedules(s);
  // R1: 热重载运行实例——运行中设置的提醒立即生效（此前必须重启）
  try { require("../core/scheduler-bridge").reloadGlobalScheduler(); } catch (e) { console.error("[reminder] 热重载失败:", e && e.message ? e.message : e); }
}

function removeReminderFromSchedules(id) {
  const s = config.loadSchedules();
  if (!s.cron) return false;
  const before = s.cron.length;
  s.cron = s.cron.filter(function(t) { return t.id !== id; });
  if (s.cron.length < before) {
    config.saveSchedules(s);
    try { require("../core/scheduler-bridge").reloadGlobalScheduler(); } catch (e) { console.error("[reminder] 热重载失败:", e && e.message ? e.message : e); }
    return true;
  }
  return false;
}

function cleanupExpiredTemporary() {
  const s = config.loadSchedules();
  if (!s.cron) return 0;
  const now = Date.now(), before = s.cron.length;
  s.cron = s.cron.filter(function(t) {
    return t.type !== "temporary" || !t.expireAt || t.expireAt > now;
  });
  const cleaned = before - s.cron.length;
  if (cleaned > 0) config.saveSchedules(s);
  return cleaned;
}

async function handleSetReminder(params, context) {
  var message = params.message;
  var time = params.time;
  var pc = params.channel;
  var target_id = params.target_id;
  var repeat = params.repeat;

  const appConfig = config.loadConfig();
  const cr = pc || (context && context.channel) || appConfig.chatChannel || "none";
  const channel = Array.isArray(cr) ? cr : [cr];
  // P2-4: 桌面单机（channel=none）不再拒绝——提醒转本机播报。
  // 触发点在 server.js 'reminder' cron handler：proactive.notify → 前端播报+通知卡。
  const localOnly = channel.includes("none") && channel.length === 1;
  const cronExpr = timeToCron(time);
  if (!cronExpr) return { success: false, error: "无法解析时间: " + time };
  if (!validateCron(cronExpr)) return { success: false, error: "无效cron: " + cronExpr };
  const rid = "reminder_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex").slice(0,8);
  const isOnce = !repeat;
  const nextRun = getNextRunTime(cronExpr);
  const reminder = {
    id: rid, type: "temporary", cron: cronExpr,
    // scheduler.load 要求 name+action 字段，缺一即被跳过（此前提醒保存后永不触发）
    name: "提醒-" + String(message || "").slice(0, 24),
    action: "reminder",
    message: message, channel: channel[0],
    targetId: target_id || (context && context.userId) || "",
    repeat: isOnce ? false : repeat,
    expireAt: isOnce ? (nextRun ? nextRun.getTime() + 86400000 : null) : null,
    meta: { createdBy: "ai", context: (context && context.conversationId) || "", description: message }
  };
  addReminderToSchedules(reminder);
  const ns = nextRun ? nextRun.toLocaleString("zh-CN") : "未知";
  if (localOnly) {
    console.log("[reminder] 无外部消息通道，提醒将于 " + ns + " 在应用内播报: " + message);
    return { success: true, reminderId: rid, cronExpr: cronExpr, nextRun: ns, channel: "none",
      message: "当前未配置消息通道（wecom/lark），提醒将在应用内播报。将于 " + ns + " 触发。" };
  }
  return { success: true, reminderId: rid, cronExpr: cronExpr, nextRun: ns, message: "提醒已创建。将于 " + ns + " 触发。" };
}

async function handleListReminders() {
  const s = config.loadSchedules();
  if (!s.cron || !s.cron.length) return { success: true, reminders: [], message: "暂无提醒" };
  const reminders = s.cron.map(function(r) {
    return {
      id: r.id, type: r.type || "fixed",
      message: r.message || (r.meta && r.meta.description) || "",
      channel: r.channel, cron: r.cron,
      nextRun: (getNextRunTime(r.cron) || { toLocaleString: function() { return "未知"; } }).toLocaleString("zh-CN"),
      repeat: r.once ? "一次性" : "重复"
    };
  });
  return { success: true, reminders: reminders };
}

async function handleRemoveReminder(params) {
  const ok = removeReminderFromSchedules(params.reminder_id);
  if (ok) return { success: true, message: "提醒已删除" };
  return { success: false, error: "未找到提醒: " + params.reminder_id };
}

registry.register({
  name: "SetReminder", category: "reminder", toolset: "reminder",
  description: "设置定时提醒。支持自然语言时间（如 14:30）与可选重复。",
  whenNotToUse: ["不要用于创建持久周期任务，改用 taskflow", "未确认时间表达时不要调用"],
  riskLevel: "low",
  handler: handleSetReminder,
  schema: {
    type: "object",
    properties: {
      message: { type: "string", description: "提醒内容" },
      time: { type: "string", description: "提醒时间，如 14:30 或明天 9 点" },
      channel: { type: "string", description: "推送通道（wecom/lark），缺省用默认通道" },
      repeat: { type: "string", description: "重复规则（cron 片段），缺省为一次性" }
    },
    required: ["message", "time"],
    additionalProperties: false
  }
});

registry.register({
  name: "ListReminders", category: "reminder", toolset: "reminder",
  description: "查看所有提醒。",
  whenNotToUse: ["不要用于删除提醒，改用 RemoveReminder", "不要用于创建提醒，改用 SetReminder"],
  riskLevel: "low",
  handler: handleListReminders,
  schema: { type: "object", properties: {}, required: [], additionalProperties: false }
});

registry.register({
  name: "RemoveReminder", category: "reminder", toolset: "reminder",
  description: "删除指定提醒。",
  whenNotToUse: ["不要用于列出提醒，改用 ListReminders", "未确认提醒 ID 时不要调用"],
  riskLevel: "medium",
  handler: handleRemoveReminder,
  schema: {
    type: "object",
    properties: {
      reminder_id: { type: "string", description: "提醒 ID（从 ListReminders 获取）" }
    },
    required: ["reminder_id"],
    additionalProperties: false
  }
});

module.exports = {
  handleSetReminder: handleSetReminder,
  handleListReminders: handleListReminders,
  handleRemoveReminder: handleRemoveReminder,
  timeToCron: timeToCron,
  sendReminderMessage: sendReminderMessage,
  addReminderToSchedules: addReminderToSchedules,
  removeReminderFromSchedules: removeReminderFromSchedules,
  cleanupExpiredTemporary: cleanupExpiredTemporary,
};
