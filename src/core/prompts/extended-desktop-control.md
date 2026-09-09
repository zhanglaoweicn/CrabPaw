### 🖥️ 桌面控制快捷操作指引 【重要 - 优先使用 DesktopControl 工具】
当用户要求控制电脑时，**必须优先使用 DesktopControl 工具**，不要走 SkillsList → SkillView → Bash 长链路！

**⚠️ 重要：浏览网页请用 BrowserControl，不要用 DesktopControl！**
- 用户要求「打开浏览器并搜索/浏览/读取网页内容」→ 用 BrowserControl（start → navigate → snapshot → 操作）
- DesktopControl 的 open_url/search_web 只能打开浏览器窗口，**无法读取网页内容、点击网页元素**
- 只有用户要求「仅打开浏览器/应用」且不需要操作网页内容时，才用 DesktopControl

**常见操作速查：**
- 打开应用（不需要操作网页） → `DesktopControl(action="open_application", app="chrome")`
- 打开文件夹 → `DesktopControl(action="open_folder", path="C:\\Users\\xxx\\Documents")`
- 打开应用 → `DesktopControl(action="open_application", app="notepad")` 或 app="wechat" 等
- 查看运行中的应用 → `DesktopControl(action="list_running_apps")`
- 激活窗口 → `DesktopControl(action="activate_window", title="窗口标题关键词")`
- 关闭窗口 → `DesktopControl(action="close_window", title="窗口标题关键词")`
- 输入文本 → `DesktopControl(action="type_text", text="要输入的内容")`
- 按键 → `DesktopControl(action="press_key", key="enter")` 或 key="tab" 等
- 快捷键 → `DesktopControl(action="press_key", key="s", modifiers=["ctrl"])` (Ctrl+S)
- 剪贴板复制 → `DesktopControl(action="clipboard", clipboard_action="copy")`
- 剪贴板粘贴 → `DesktopControl(action="clipboard", clipboard_action="paste")`
- 剪贴板设置 → `DesktopControl(action="clipboard", clipboard_action="set", text="内容")`
- 截图 → `DesktopControl(action="screenshot")`
- 系统信息 → `DesktopControl(action="system_info")`
- 屏幕捕获(含UI元素) → `DesktopControl(action="screen_capture", mode="som")` — 返回屏幕分辨率和UI元素列表

**⚠️ 鼠标点击的正确流程（重要）：**
1. **先获取屏幕信息** → `DesktopControl(action="screen_capture", mode="som")` 或 `DesktopControl(action="system_info")`
2. **获取屏幕分辨率** — screen_capture 返回 width/height，或 system_info 返回 screenWidth/screenHeight
3. **计算正确坐标** — 基于实际分辨率计算，不要假设坐标！
 - 开始菜单：**推荐使用 Win 键** → `DesktopControl(action="press_key", key="win")`，比鼠标点击更可靠
 - 屏幕中心：(screenWidth / 2, screenHeight / 2)
 - 右下角通知区：(screenWidth - 50, screenHeight - 20)
 - 左下角开始按钮（如果必须用鼠标）：约 (screenWidth * 0.05, screenHeight - 40)
4. **执行点击** → `DesktopControl(action="mouse_click", x=计算后的坐标, y=计算后的坐标)`

**❌ 错误做法：直接假设坐标如 (0, 1080)** — 这个坐标在屏幕底部边缘之外，会导致点击失败！
**✅ 正确做法：打开开始菜单使用 `press_key(key="win")`，这是最可靠的方式**
