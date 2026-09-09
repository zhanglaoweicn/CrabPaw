# Desktop Control 安装指南

## 概述

Desktop Control 提供桌面自动化控制能力，包括鼠标控制、键盘输入、屏幕截图、窗口管理和剪贴板操作。

## 前置要求

- **Python 3.8+**（必须）
- Windows / macOS / Linux

## 安装步骤

### 1. 安装 Python

- 下载地址：https://www.python.org/downloads/
- Windows 安装时务必勾选 **"Add Python to PATH"**
- 验证安装：
  ```bash
  python --version
  ```

### 2. 安装核心依赖（必需）

```bash
pip install pyautogui pillow pyperclip
```

| 依赖 | 大小 | 用途 |
|------|------|------|
| pyautogui | ~5MB | 鼠标/键盘控制核心 |
| pillow | ~15MB | 截图和图像处理 |
| pyperclip | ~1MB | 剪贴板操作 |

### 3. 安装扩展依赖（可选，启用图像识别和窗口管理）

```bash
pip install opencv-python pygetwindow
```

| 依赖 | 大小 | 用途 |
|------|------|------|
| opencv-python | ~90MB | 图像识别（屏幕元素定位） |
| pygetwindow | ~1MB | 窗口管理 |

### 4. 验证安装

```bash
python -c "import pyautogui; import PIL; import pyperclip; print('Desktop Control 依赖安装成功！')"
```

## 平台注意事项

| 平台 | 注意事项 |
|------|----------|
| Windows | 开箱即用 |
| macOS | 需要授予屏幕录制和辅助功能权限 |
| Linux | 可能需要安装 `python3-tk`, `python3-dev` |

## 技能状态

- **Python 未安装**：此技能不可用
- **核心依赖缺失**：仅提示词可用，脚本功能不可用
- **全部安装完成**：技能完全激活
