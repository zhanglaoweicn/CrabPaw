/**
 * DesktopControl 参数单一事实源 (2026-09-06 契约对齐轮)
 *
 * 消费方:
 *   - src/tools/desktop-tools.js  → registry schema（LLM 视野的参数文档）
 *   - src/core/tool-contract.js   → TOOL_CONTRACTS.DesktopControl.schema（编排层 ajv 校验）
 *
 * 此前静态契约只有 action/app/url/folder/text/key 6 参数且 additionalProperties:false，
 * mouse_click(x,y) 等调用在孤立校验方全被拒，靠 ai.js 启动期 registerIntoRegistry
 * 合并兜底（与 BrowserControl 修复前同款问题）。现在改参数只改本文件。
 */

'use strict';

const DESKTOP_CONTROL_PROPERTIES =   {
    "action": {
      "type": "string",
      "enum": [
        "open_application",
        "open_url",
        "open_folder",
        "search_web",
        "list_running_apps",
        "activate_window",
        "close_window",
        "type_text",
        "press_key",
        "clipboard",
        "screenshot",
        "system_info",
        "mouse_click",
        "mouse_move",
        "scroll",
        "drag",
        "screen_capture",
        "list_windows",
        "resize_window",
        "maximize_window",
        "minimize_window",
        "restore_window",
        "move_window",
        "list_processes",
        "kill_process",
        "start_process",
        "send_notification",
        "get_display_info",
        "lock_screen",
        "sleep_system",
        "volume_control"
      ],
      "description": "要执行的桌面操作类型"
    },
    "app": {
      "type": "string",
      "description": "要打开的应用名称（open_application时使用），仅允许白名单内的应用"
    },
    "arguments": {
      "type": "string",
      "description": "应用启动参数（open_application时可选）"
    },
    "url": {
      "type": "string",
      "description": "要打开的URL（open_url时使用），仅允许http/https协议"
    },
    "browser": {
      "type": "string",
      "description": "指定浏览器打开URL（open_url时可选），仅允许白名单内的浏览器"
    },
    "path": {
      "type": "string",
      "description": "文件夹路径（open_folder时使用）或截图保存路径（screenshot时可选）"
    },
    "query": {
      "type": "string",
      "description": "搜索关键词（search_web时使用）"
    },
    "engine": {
      "type": "string",
      "enum": [
        "bing",
        "baidu",
        "google",
        "sogou",
        "toutiao",
        "360"
      ],
      "description": "搜索引擎（search_web时可选，默认bing）"
    },
    "title": {
      "type": "string",
      "description": "窗口标题关键词（activate_window/close_window时使用）"
    },
    "text": {
      "type": "string",
      "description": "要输入的文本（type_text时使用）或剪贴板设置内容（clipboard set时使用），最大5000/50000字符"
    },
    "delay": {
      "type": "integer",
      "description": "输入延迟（type_text时可选，默认50ms）"
    },
    "key": {
      "type": "string",
      "description": "要按下的键（press_key时使用），仅允许白名单内的按键"
    },
    "modifiers": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "修饰键（press_key时可选），仅允许ctrl/alt/shift/win/cmd"
    },
    "clipboard_action": {
      "type": "string",
      "enum": [
        "copy",
        "paste",
        "set",
        "get"
      ],
      "description": "剪贴板操作类型（clipboard时使用）"
    },
    "region": {
      "type": "string",
      "description": "截图区域（screenshot时可选），格式: x,y,width,height"
    },
    "x": {
      "type": "integer",
      "description": "鼠标X坐标（mouse_click/mouse_move/scroll时使用），0-7680"
    },
    "y": {
      "type": "integer",
      "description": "鼠标Y坐标（mouse_click/mouse_move/scroll时使用），0-4320"
    },
    "button": {
      "type": "string",
      "enum": [
        "left",
        "right"
      ],
      "description": "鼠标按键（mouse_click时可选，默认left）"
    },
    "direction": {
      "type": "string",
      "enum": [
        "up",
        "down"
      ],
      "description": "滚动方向（scroll时使用，默认down）"
    },
    "amount": {
      "type": "integer",
      "description": "滚动量（scroll时可选，1-20，默认3）"
    },
    "fromX": {
      "type": "integer",
      "description": "拖拽起点X坐标（drag时使用）"
    },
    "fromY": {
      "type": "integer",
      "description": "拖拽起点Y坐标（drag时使用）"
    },
    "toX": {
      "type": "integer",
      "description": "拖拽终点X坐标（drag时使用）"
    },
    "toY": {
      "type": "integer",
      "description": "拖拽终点Y坐标（drag时使用）"
    },
    "width": {
      "type": "integer",
      "description": "窗口宽度（resize_window时使用），100-7680"
    },
    "height": {
      "type": "integer",
      "description": "窗口高度（resize_window时使用），100-4320"
    },
    "pid": {
      "type": "integer",
      "description": "进程ID（kill_process时使用）"
    },
    "name": {
      "type": "string",
      "description": "进程名称（kill_process时使用）或应用名称（start_process时使用）"
    },
    "command": {
      "type": "string",
      "description": "要启动的命令/程序路径（start_process时使用）"
    },
    "args": {
      "type": "string",
      "description": "启动参数（start_process时可选）"
    },
    "cwd": {
      "type": "string",
      "description": "工作目录（start_process时可选）"
    },
    "message": {
      "type": "string",
      "description": "通知消息内容（send_notification时使用）"
    },
    "filter": {
      "type": "string",
      "description": "进程名称过滤（list_processes时可选）"
    },
    "level": {
      "type": "integer",
      "description": "音量调节级别（volume_control时可选，1-20）"
    },
    "mode": {
      "type": "string",
      "enum": [
        "som",
        "ax",
        "screenshot"
      ],
      "description": "屏幕捕获模式（screen_capture时可选，默认som）"
    },
    "volume_action": {
      "type": "string",
      "enum": [
        "mute",
        "unmute",
        "up",
        "down"
      ],
      "description": "音量操作（volume_control时使用）：mute静音/unmute取消静音/up增大/down减小"
    }
  };

/**
 * registry（LLM 视野）参数 schema——不做 additionalProperties 限制，保持注册表宽松语义
 */
function buildRegistryParameters() {
  return {
    type: 'object',
    properties: { ...DESKTOP_CONTROL_PROPERTIES },
    required: ['action'],
  };
}

/**
 * 编排层契约 schema——additionalProperties:false，属性集与 registry 同源
 */
function buildContractSchema() {
  return {
    type: 'object',
    properties: { ...DESKTOP_CONTROL_PROPERTIES },
    required: ['action'],
    additionalProperties: false,
  };
}

module.exports = {
  DESKTOP_CONTROL_PROPERTIES,
  buildRegistryParameters,
  buildContractSchema,
};
