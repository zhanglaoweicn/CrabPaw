---
name: desktop-control
version: "1.0.0"
description: "桌面自动化控制，提供鼠标、键盘、屏幕截图、窗口管理、剪贴板与图像识别，支持像素级精准定位。当用户需要控制本地电脑——点鼠标、模拟按键、截屏、操作窗口时使用。"
metadata:
  crabpaw:
    emoji: 🖱️
    category: automation
    capabilities: [desktop_automation]
    requires:
    priority: 4
    tags: [system, desktop, automation]
      core:
        - pyautogui
        - pillow
        - pyperclip
      optional:
        - opencv-python
        - pygetwindow
    portable: true
---

# Desktop Control

桌面自动化控制技能，提供完整的鼠标、键盘、屏幕、窗口和剪贴板操作能力。

## ⚠️ 依赖要求

### 核心依赖（必需，~22MB）

```bash
pip install pyautogui pillow pyperclip
```

| 依赖 | 大小 | 用途 |
|------|------|------|
| pyautogui | ~5MB | 鼠标/键盘控制核心 |
| pillow | ~15MB | 截图和图像处理 |
| pyperclip | ~1MB | 剪贴板操作 |

### 扩展依赖（可选，~92MB）

```bash
pip install opencv-python pygetwindow
```

| 依赖 | 大小 | 用途 |
|------|------|------|
| opencv-python | ~90MB | 图像识别（find_on_screen） |
| pygetwindow | ~1MB | 窗口管理 |

---

## 🎯 核心能力

```
┌─────────────────────────────────────────────────────┐
│              Desktop Control 能力矩阵                │
├─────────────────────────────────────────────────────┤
│  🖱️ 鼠标控制                                        │
│  ├── 绝对定位移动                                    │
│  ├── 相对移动                                        │
│  ├── 平滑移动（贝塞尔曲线）                           │
│  ├── 点击（左/右/中键，单/双/三击）                   │
│  ├── 拖拽                                            │
│  ├── 滚动（垂直/水平）                               │
│  └── 位置追踪                                        │
│                                                     │
│  ⌨️ 键盘控制                                        │
│  ├── 文本输入（可调速度）                            │
│  ├── 快捷键（Ctrl+C, Win+R 等）                     │
│  ├── 特殊键（Enter, Tab, F1-F24）                   │
│  ├── 组合键                                          │
│  └── 按住/释放                                       │
│                                                     │
│  📸 屏幕操作                                        │
│  ├── 截图（全屏/区域）                               │
│  ├── 图像识别（需 opencv）                          │
│  ├── 像素颜色检测                                    │
│  └── 多显示器支持                                    │
│                                                     │
│  🪟 窗口管理（需 pygetwindow）                      │
│  ├── 获取窗口列表                                    │
│  ├── 激活窗口                                        │
│  └── 窗口信息                                        │
│                                                     │
│  📋 剪贴板                                          │
│  ├── 复制文本                                        │
│  └── 读取文本                                        │
└─────────────────────────────────────────────────────┘
```

---

## 🚀 快速开始

### 基础使用

```python
import pyautogui
import pyperclip
from PIL import ImageGrab

# 鼠标操作
pyautogui.moveTo(500, 300, duration=0.5)  # 移动
pyautogui.click()                          # 点击
pyautogui.drag(100, 100, 500, 500)         # 拖拽
pyautogui.scroll(-5)                       # 滚动

# 键盘操作
pyautogui.write("Hello World", interval=0.05)
pyautogui.hotkey('ctrl', 'c')
pyautogui.press('enter')

# 截图
screenshot = ImageGrab.grab()
screenshot.save("screen.png")

# 剪贴板
pyperclip.copy("Hello!")
text = pyperclip.paste()
```

---

## 📋 完整 API 参考

### 鼠标控制

#### 移动鼠标

```python
import pyautogui

# 绝对定位
pyautogui.moveTo(x=500, y=300, duration=0.5)  # 0.5秒平滑移动
pyautogui.moveTo(500, 300)                     # 瞬间移动

# 相对移动
pyautogui.move(100, 50)   # 从当前位置移动 100px 右, 50px 下
pyautogui.move(-50, -30)  # 左移 50px, 上移 30px

# 获取当前位置
x, y = pyautogui.position()
print(f"鼠标位置: {x}, {y}")
```

#### 点击

```python
# 左键点击
pyautogui.click()                    # 当前位置
pyautogui.click(x=500, y=300)        # 指定位置
pyautogui.click(500, 300)            # 简写

# 右键点击
pyautogui.rightClick()
pyautogui.click(button='right')

# 中键点击
pyautogui.middleClick()
pyautogui.click(button='middle')

# 双击/三击
pyautogui.doubleClick()
pyautogui.tripleClick()
pyautogui.click(clicks=2)            # 双击
pyautogui.click(clicks=3, interval=0.1)  # 三击，间隔0.1秒
```

#### 拖拽

```python
# 拖拽到绝对位置
pyautogui.dragTo(500, 300, duration=1.0)

# 相对拖拽
pyautogui.drag(100, 50, duration=0.5)

# 指定按钮拖拽
pyautogui.dragTo(500, 300, button='right')
```

#### 滚动

```python
# 垂直滚动（正数向上，负数向下）
pyautogui.scroll(10)    # 向上滚 10 格
pyautogui.scroll(-10)   # 向下滚 10 格

# 水平滚动（需支持）
pyautogui.hscroll(5)    # 右滚
pyautogui.hscroll(-5)   # 左滚
```

---

### 键盘控制

#### 输入文本

```python
# 即时输入
pyautogui.write("Hello World")

# 模拟人类打字速度
pyautogui.write("Hello World", interval=0.1)  # 每字符间隔 0.1 秒

# 中文输入（需要输入法支持）
pyautogui.write("你好")  # 可能需要切换输入法
```

#### 按键

```python
# 单键
pyautogui.press('enter')
pyautogui.press('tab')
pyautogui.press('escape')
pyautogui.press('space')

# 多次按键
pyautogui.press('backspace', presses=5)

# 方向键
pyautogui.press('up')
pyautogui.press('down')
pyautogui.press('left')
pyautogui.press('right')

# 功能键
pyautogui.press('f1')
pyautogui.press('f5')
pyautogui.press('f12')
```

#### 快捷键

```python
# 复制粘贴
pyautogui.hotkey('ctrl', 'c')  # 复制
pyautogui.hotkey('ctrl', 'v')  # 粘贴
pyautogui.hotkey('ctrl', 'x')  # 剪切
pyautogui.hotkey('ctrl', 'a')  # 全选
pyautogui.hotkey('ctrl', 's')  # 保存
pyautogui.hotkey('ctrl', 'z')  # 撤销

# Windows 快捷键
pyautogui.hotkey('win', 'r')        # 运行
pyautogui.hotkey('win', 'e')        # 资源管理器
pyautogui.hotkey('win', 'd')        # 显示桌面
pyautogui.hotkey('alt', 'tab')      # 切换窗口
pyautogui.hotkey('alt', 'f4')       # 关闭窗口
pyautogui.hotkey('ctrl', 'alt', 'delete')  # 任务管理器

# Mac 快捷键
pyautogui.hotkey('command', 'c')    # 复制
pyautogui.hotkey('command', 'v')    # 粘贴
```

#### 按住/释放

```python
# 按住 Shift 输入大写
pyautogui.keyDown('shift')
pyautogui.write('hello')  # 输出 HELLO
pyautogui.keyUp('shift')

# 按住 Ctrl 多选
pyautogui.keyDown('ctrl')
pyautogui.click(100, 200)
pyautogui.click(100, 250)
pyautogui.keyUp('ctrl')
```

---

### 屏幕操作

#### 截图

```python
from PIL import ImageGrab

# 全屏截图
screenshot = ImageGrab.grab()
screenshot.save("screenshot.png")

# 区域截图 (left, top, right, bottom)
region = ImageGrab.grab(bbox=(100, 100, 500, 400))
region.save("region.png")

# 使用 pyautogui
screenshot = pyautogui.screenshot()
screenshot.save("screen.png")

# 区域截图
screenshot = pyautogui.screenshot(region=(0, 0, 500, 300))
```

#### 像素颜色

```python
import pyautogui

# 获取像素颜色
color = pyautogui.pixel(500, 300)
print(f"RGB: {color}")  # (R, G, B)

# 检查颜色匹配
if pyautogui.pixelMatchesColor(500, 300, (255, 0, 0)):
    print("该位置是红色")
```

#### 图像识别（需 opencv）

```python
import pyautogui

# 在屏幕上查找图像
location = pyautogui.locateOnScreen('button.png')
if location:
    print(f"找到位置: {location}")
    # 点击中心
    center = pyautogui.center(location)
    pyautogui.click(center)

# 带置信度
location = pyautogui.locateOnScreen('button.png', confidence=0.9)

# 查找所有匹配
locations = pyautogui.locateAllOnScreen('button.png')
for loc in locations:
    print(loc)
```

#### 屏幕尺寸

```python
width, height = pyautogui.size()
print(f"屏幕分辨率: {width}x{height}")
```

---

### 窗口管理（需 pygetwindow）

```python
import pygetwindow as gw

# 获取所有窗口
windows = gw.getAllTitles()
for title in windows:
    print(title)

# 获取活动窗口
active = gw.getActiveWindow()
print(f"活动窗口: {active.title}")

# 按标题查找窗口
window = gw.getWindowsWithTitle('Chrome')
if window:
    window[0].activate()  # 激活窗口

# 窗口操作
win = gw.getActiveWindow()
win.activate()      # 激活
win.minimize()      # 最小化
win.maximize()      # 最大化
win.restore()       # 还原
win.close()         # 关闭
```

---

### 剪贴板

```python
import pyperclip

# 复制到剪贴板
pyperclip.copy("Hello from CrabPaw!")

# 从剪贴板读取
text = pyperclip.paste()
print(f"剪贴板内容: {text}")
```

---

## ⌨️ 按键名称参考

### 字母和数字
`'a'` - `'z'`, `'0'` - `'9'`

### 功能键
`'f1'` - `'f24'`

### 特殊键
| 按键 | 名称 |
|------|------|
| Enter | `'enter'` 或 `'return'` |
| Escape | `'esc'` 或 `'escape'` |
| 空格 | `'space'` |
| Tab | `'tab'` |
| 退格 | `'backspace'` |
| 删除 | `'delete'` 或 `'del'` |
| 插入 | `'insert'` |
| Home | `'home'` |
| End | `'end'` |
| Page Up | `'pageup'` 或 `'pgup'` |
| Page Down | `'pagedown'` 或 `'pgdn'` |

### 方向键
`'up'`, `'down'`, `'left'`, `'right'`

### 修饰键
| 按键 | 名称 |
|------|------|
| Ctrl | `'ctrl'` 或 `'control'` |
| Shift | `'shift'` |
| Alt | `'alt'` |
| Win | `'win'` 或 `'winleft'` / `'winright'` |
| Command (Mac) | `'command'` 或 `'cmd'` |

---

## 🛡️ 安全特性

### Failsafe 模式

```python
# 启用安全模式（默认启用）
pyautogui.FAILSAFE = True

# 紧急停止：将鼠标移到屏幕任意角落
# 会抛出 pyautogui.FailSafeException
```

### 暂停控制

```python
# 设置每个动作后的暂停时间
pyautogui.PAUSE = 0.1  # 每个动作后暂停 0.1 秒

# 手动暂停
import time
time.sleep(2)  # 暂停 2 秒
```

### 安全检查

```python
# 检查鼠标是否在屏幕内
width, height = pyautogui.size()
x, y = pyautogui.position()
if 0 <= x < width and 0 <= y < height:
    print("鼠标在屏幕内")
```

---

## 🎨 实用示例

### 自动填表

```python
import pyautogui
import time

# 点击姓名字段
pyautogui.click(300, 200)
pyautogui.write("张三", interval=0.05)

# Tab 到下一个字段
pyautogui.press('tab')
pyautogui.write("zhang@example.com")

# Tab 到密码字段
pyautogui.press('tab')
pyautogui.write("Password123")

# 提交
pyautogui.press('enter')
```

### 批量文件操作

```python
import pyautogui

# 按住 Ctrl 多选
pyautogui.keyDown('ctrl')
pyautogui.click(100, 200)  # 第一个文件
pyautogui.click(100, 250)  # 第二个文件
pyautogui.click(100, 300)  # 第三个文件
pyautogui.keyUp('ctrl')

# 复制
pyautogui.hotkey('ctrl', 'c')
```

### 定时截图

```python
import pyautogui
import time
from datetime import datetime

for i in range(10):
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    pyautogui.screenshot(f"capture_{timestamp}.png")
    time.sleep(60)  # 每分钟截图
```

### 查找并点击按钮

```python
import pyautogui

# 查找按钮
button = pyautogui.locateOnScreen('button.png', confidence=0.8)
if button:
    center = pyautogui.center(button)
    pyautogui.click(center)
    print("按钮已点击")
else:
    print("未找到按钮")
```

---

## ⚡ 性能优化

| 技巧 | 说明 |
|------|------|
| `duration=0` | 瞬间移动，最快 |
| `interval=0` | 瞬间输入，最快 |
| `PAUSE=0` | 取消动作间暂停 |
| `FAILSAFE=False` | 禁用安全检查（谨慎使用） |

---

## ⚠️ 注意事项

1. **坐标系统**：左上角为 (0, 0)，向右为 X 正方向，向下为 Y 正方向
2. **DPI 缩放**：Windows 高 DPI 可能影响坐标准确性
3. **多显示器**：副显示器可能有负坐标
4. **权限问题**：某些应用需要管理员权限才能操作
5. **输入法**：中文输入需要切换到对应输入法

---

## 🔧 故障排除

### 鼠标移动不正确
- 检查 Windows DPI 设置
- 使用 `pyautogui.size()` 确认屏幕尺寸
- 使用 `pyautogui.position()` 验证坐标

### 键盘输入无效
- 确保目标应用有焦点
- 某些应用阻止自动化输入
- 尝试增加 `interval` 参数

### Failsafe 误触发
- 操作时避开屏幕角落
- 或临时禁用：`pyautogui.FAILSAFE = False`

---

**让桌面自动化变得简单可靠 🖱️**
