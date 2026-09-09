---
name: windows-ui-automation
version: "1.1.0"
description: "Windows桌面UI自动化技能，用PowerShell控制鼠标、键盘、窗口，实现点击按钮、输入文本、截图、批量重复操作。当用户想自动操作非Web桌面软件时使用。"
metadata:
  crabpaw:
    category: general
    capabilities: [desktop_automation]
    emoji: 🖥️
    category: desktop-automation
    triggers:
      - ui-automation
      - desktop-automation
      - mouse-control
      - keyboard-control
      - window-control
---

# Windows 桌面 UI 自动化

通过 PowerShell 脚本控制 Windows 桌面环境，实现鼠标、键盘和窗口的自动化操作。

## 激活条件

当用户需要自动化桌面应用操作时激活此技能，例如：
- 点击桌面应用的按钮或菜单
- 在非 Web 应用中输入文本
- 管理窗口状态（最小化/最大化/关闭）
- 截取窗口截图
- 批量重复的桌面操作

## 安全边界

> ⚠️ 此技能直接控制用户桌面，必须遵守以下安全规则：

1. **操作前确认** — 涉及点击、输入、关闭窗口等破坏性操作前，先告知用户将要执行的操作
2. **截图验证** — 复杂操作前后截图确认状态
3. **禁止自动点击"确认删除"等危险按钮** — 除非用户明确要求
4. **坐标说明** — 使用坐标点击时，先说明点击位置的含义
5. **禁止输入密码** — 不得在密码框中自动输入敏感信息
6. **操作间隔** — 每步操作间保留延迟，避免操作过快导致不可控

## 核心能力

### 鼠标控制

脚本路径: `scripts/mouse_control.ps1`

| 操作 | 命令 | 说明 |
|------|------|------|
| 移动 | `-Action move -X 500 -Y 300` | 移动鼠标到指定坐标 |
| 左键单击 | `-Action click -X 500 -Y 300` | 可选指定坐标，不指定则在当前位置点击 |
| 右键单击 | `-Action rightclick` | 在当前位置右键点击 |
| 双击 | `-Action doubleclick` | 在当前位置双击 |
| 拖拽 | `-Action drag -X 800 -Y 400` | 从当前位置拖拽到目标位置 |
| 滚轮 | `-Action scroll -Delta 3` | 正数向上，负数向下，3 约等于一屏 |

```powershell
# 示例：移动到 (500, 300) 并点击
powershell -File scripts/mouse_control.ps1 -Action click -X 500 -Y 300

# 示例：向下滚动 3 格
powershell -File scripts/mouse_control.ps1 -Action scroll -Delta -3
```

### 键盘控制

脚本路径: `scripts/keyboard_control.ps1`

| 操作 | 命令 | 说明 |
|------|------|------|
| 输入文本 | `-Text "Hello"` | 输入文本字符串 |
| 按特殊键 | `-Key enter` | 支持 enter/tab/esc/delete/方向键/F1-F12 等 |
| 组合键 | `-Hold ctrl -Key c` | 支持 Ctrl/Alt/Shift + 任意键 |

```powershell
# 示例：输入文本
powershell -File scripts/keyboard_control.ps1 -Text "Hello World"

# 示例：Ctrl+C 复制
powershell -File scripts/keyboard_control.ps1 -Hold ctrl -Key c

# 示例：Alt+F4 关闭
powershell -File scripts/keyboard_control.ps1 -Hold alt -Key f4
```

### 窗口管理

脚本路径: `scripts/window_control.ps1`

| 操作 | 命令 | 说明 |
|------|------|------|
| 激活窗口 | `-Action activate -Title "记事本"` | 按标题查找并激活（支持模糊匹配） |
| 关闭窗口 | `-Action close -Title "记事本"` | 发送 WM_CLOSE 消息 |
| 最小化 | `-Action minimize -Title "记事本"` | 最小化窗口 |
| 最大化 | `-Action maximize -Title "记事本"` | 最大化窗口 |
| 还原 | `-Action restore -Title "记事本"` | 还原窗口大小 |
| 调整大小 | `-Action resize -Title "记事本" -X 0 -Y 0 -Width 800 -Height 600` | 设置窗口位置和大小 |
| 列出窗口 | `-Action list` | 列出所有可见窗口 |
| 截图 | `-Action screenshot -Title "记事本"` | 截取窗口截图，保存到临时目录 |

```powershell
# 示例：激活记事本并输入文本
powershell -File scripts/window_control.ps1 -Action activate -Title "记事本"
Start-Sleep -Milliseconds 300
powershell -File scripts/keyboard_control.ps1 -Text "Hello from CrabPaw"
```

## 常见工作流

### 1. 桌面应用自动化

```
1. 列出窗口 → 找到目标应用
2. 激活窗口 → 确保焦点正确
3. 截图确认 → 验证当前状态
4. 执行操作 → 点击/输入/快捷键
5. 截图验证 → 确认操作结果
```

### 2. 批量重复操作

```
1. 激活目标窗口
2. 循环执行:
   a. 点击目标位置
   b. 等待响应
   c. 输入数据
   d. 确认提交
3. 截图验证最终结果
```

## 注意事项

- 坐标 (0,0) 在主显示器左上角
- 操作期间不要移动鼠标或使用键盘，否则可能干扰自动化
- 部分应用以管理员权限运行时，自动化脚本也需要管理员权限
- UAC 弹窗无法被自动化脚本操作
- 远程桌面断开后，桌面 UI 自动化可能失效

## 限制

- 不支持 Web 页面内的元素定位（Web 自动化请使用 Playwright）
- 不支持 OCR 识别屏幕内容（可配合截图 + AI 视觉分析）
- 部分安全软件可能拦截 SendKeys 输入
