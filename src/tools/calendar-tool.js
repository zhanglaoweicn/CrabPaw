const { registry } = require("./registry");
const { addEvent } = require("../handlers/calendar-handler");
const { parseNaturalDateTime, parseNaturalEvent } = require("../schedule/utils/natural-datetime");

/**
 * Natural language time parsing for calendar events
 * (2026-09-02 R3 薄委托 natural-datetime 统一解析器——三套解析收编, 能力只增不减;
 *  返回形态 {date, time} 为既有契约, 不得增删字段)
 */
function parseEventTime(text) {
  const r = parseNaturalDateTime(String(text || "").trim());
  return r.ambiguous ? null : { date: r.date, time: r.time };
}

/** S2.1: 服务端直接弹日程卡（surface show + panel-state open, 与 SceneSet 链路同源） */
function _pushSchedulePanel() {
  try {
    const { getSceneStore } = require("../core/scene/scene-store");
    getSceneStore().upsertSurface("schedule-panel", { kind: "schedule", data: { action: "show" }, intent: "inform" });
    const { setPanelState } = require("../core/panel-state");
    setPanelState("schedule", "open");
  } catch (e) {
    console.error("[CreateCalendarEvent] 弹日程卡失败:", e && e.message ? e.message : e);
  }
}

/** S2.1: reminders 归一——缺省提前10分钟; [] = 用户明说不用提醒 */
function _normalizeReminders(reminders) {
  if (!Array.isArray(reminders)) return [{ value: 10 }];
  return reminders.map((r) => ({ value: (r && Number(r.value)) || 10 }));
}

/**
 * Extract event title from user message
 */
function _extractTitle(text) {
  // Remove time-related phrases
  let cleaned = text
    .replace(/(今天|明天|后天|今晚|下周\S*)\s*/g, "")
    .replace(/(早上|上午|中午|下午|晚上|夜里)\s*/g, "")
    .replace(/\d{1,2}[:点]\d{0,2}[分]?\s*/g, "")
    .replace(/[一二三四五六七八九十]+[点:]\d{0,2}[分]?\s*/g, "")
    .replace(/(要|帮我|请|我想|我需要|创建|安排|添加|加个|设个|记个)\s*/g, "")
    .replace(/(个|一个|一下)\s*/g, "")
    .replace(/[，。！？,.!?\s]+$/, "")
    .trim();

  if (!cleaned) cleaned = "日程";
  return cleaned;
}

/**
 * Handle calendar event creation
 */
async function handleCreateEvent(params, _context) {
  // 兼容别名：模型按 registry(title/datetime) 传参，DSML/旧上下文可能用 summary/start_time
  const title = params.title || params.summary;
  const datetime = params.datetime || params.start_time;
  const description = params.description || "";
  const duration = params.duration || params.duration_minutes || 60;

  if (!title) {
    return {
      success: false,
      error: "请提供日程标题（title 或 summary 参数）"
    };
  }

  // S2.1 智能分流: 无歧义(日期显式解析)直建; 歧义 → needsClarification + prefill + schedule:form SSE
  const parsed = datetime ? parseNaturalEvent(String(datetime).trim()) : null;
  if (!parsed || parsed.ambiguous) {
    const prefill = {
      title,
      date: parsed && parsed.dateExplicit ? parsed.date : "",
      time: parsed && parsed.timeExplicit ? parsed.time : "",
      duration,
      description,
    };
    _pushSchedulePanel();
    try {
      const { broadcastEvent } = require("../core/sse-broadcast");
      broadcastEvent("schedule:form", { prefill });
    } catch (e) {
      console.error("[CreateCalendarEvent] 歧义分流广播失败:", e && e.message ? e.message : e);
    }
    return {
      success: true,
      created: false,
      needsClarification: (parsed && parsed.reason) || "未能识别出日期",
      message: "时间没听清，我已在日程卡里打开预填表单，请用户确认后保存",
      prefill,
    };
  }
  const timeInfo = { date: parsed.date, time: parsed.time };

  const eventData = {
    title,
    date: timeInfo.date,
    time: timeInfo.time,
    duration,
    description,
    color: "blue",
    reminders: _normalizeReminders(params.reminders),
  };

  try {
    const result = await addEvent(eventData);
    if (result) {
      _pushSchedulePanel();
      return {
        success: true,
        created: true,
        message: `✅ 日程已创建: "${title}" - ${timeInfo.date} ${timeInfo.time} (${eventData.duration}分钟, 提前${eventData.reminders.map((r) => r.value).join("/")}分钟提醒)`,
        event: { id: result.id, title, date: timeInfo.date, time: timeInfo.time, duration: eventData.duration }
      };
    }
    return { success: false, error: "创建日程失败" };
  } catch (e) {
    return { success: false, error: `创建日程失败: ${e.message}` };
  }
}

// Register the tool
registry.register({
  name: "CreateCalendarEvent",
  toolset: "calendar",
  category: "calendar",
  whenNotToUse: [
    "用户只是询问/查看日程而非创建时不要调用",
    "删除、修改已有日程时不要调用（走日历管理界面）",
    "用户提到飞书日程时使用 LarkCreateCalendarEvent 而非本工具"
  ],
  schema: {
    description: "创建日历日程。当用户说【创建日程】【安排会议】【加个提醒】时使用。支持自然语言时间如【明天下午6点】、【后天上午10点半】、【下周一3点】、【2026-08-20 10:30】。",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "日程标题。例如【开会】【与客户洽谈】【生日提醒】。可以从用户消息中提取。"
        },
        datetime: {
          type: "string",
          description: '日程时间，支持自然语言：如"明天下午6点"、"后天上午10点"、"下周一3点"、"今晚8点"、"15:30"、"2026-08-20 10:30"。建议从用户消息中提取。'
        },
        description: {
          type: "string",
          description: "日程描述（可选）"
        },
        duration: {
          type: "number",
          description: "持续时间（分钟），默认60",
          default: 60
        }
      },
      required: ["title", "datetime"]
    }
  },
  handler: handleCreateEvent,
  timeout: 15000,
  isReadOnly: false
});

console.log("✅ 日历工具已注册: CreateCalendarEvent");

module.exports = { parseEventTime, handleCreateEvent };
