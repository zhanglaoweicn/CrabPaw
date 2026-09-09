# mouse_control.ps1 - Windows 鼠标控制脚本
# 用法: powershell -File mouse_control.ps1 -Action <操作> [-X <坐标>] [-Y <坐标>] [-Delta <滚动量>]

param (
    [Parameter(Mandatory=$true)]
    [ValidateSet("move", "click", "rightclick", "doubleclick", "drag", "scroll")]
    [string]$Action,

    [int]$X = -1,
    [int]$Y = -1,
    [int]$Delta = 3
)

# 注册 Win32 API（仅注册一次）
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Mouse {
    [DllImport("user32.dll")]
    public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
}
"@ -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.Windows.Forms

# 鼠标事件常量
$MOUSEEVENTF_LEFTDOWN    = 0x02
$MOUSEEVENTF_LEFTUP      = 0x04
$MOUSEEVENTF_RIGHTDOWN   = 0x08
$MOUSEEVENTF_RIGHTUP     = 0x10
$MOUSEEVENTF_MIDDLEDOWN  = 0x20
$MOUSEEVENTF_MIDDLEUP    = 0x40
$MOUSEEVENTF_WHEEL       = 0x800

switch ($Action) {
    "move" {
        if ($X -ge 0 -and $Y -ge 0) {
            [Win32Mouse]::SetCursorPos($X, $Y)
            Write-Output "鼠标移动到 ($X, $Y)"
        } else {
            Write-Output "错误: 移动需要 -X 和 -Y 参数"
        }
    }

    "click" {
        if ($X -ge 0 -and $Y -ge 0) {
            [Win32Mouse]::SetCursorPos($X, $Y)
            Start-Sleep -Milliseconds 50
        }
        [Win32Mouse]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 50
        [Win32Mouse]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        Write-Output "左键单击"
    }

    "rightclick" {
        if ($X -ge 0 -and $Y -ge 0) {
            [Win32Mouse]::SetCursorPos($X, $Y)
            Start-Sleep -Milliseconds 50
        }
        [Win32Mouse]::mouse_event($MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 50
        [Win32Mouse]::mouse_event($MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0)
        Write-Output "右键单击"
    }

    "doubleclick" {
        if ($X -ge 0 -and $Y -ge 0) {
            [Win32Mouse]::SetCursorPos($X, $Y)
            Start-Sleep -Milliseconds 50
        }
        # 第一次点击
        [Win32Mouse]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        [Win32Mouse]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        Start-Sleep -Milliseconds 100
        # 第二次点击
        [Win32Mouse]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        [Win32Mouse]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        Write-Output "双击"
    }

    "drag" {
        if ($X -ge 0 -and $Y -ge 0) {
            # 从当前位置拖拽到目标位置
            [Win32Mouse]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
            Start-Sleep -Milliseconds 100
            [Win32Mouse]::SetCursorPos($X, $Y)
            Start-Sleep -Milliseconds 100
            [Win32Mouse]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
            Write-Output "拖拽到 ($X, $Y)"
        } else {
            Write-Output "错误: 拖拽需要 -X 和 -Y 参数（目标位置）"
        }
    }

    "scroll" {
        # Delta: 正数向上滚，负数向下滚，单位为滚轮刻度（通常 3 = 一屏）
        [Win32Mouse]::mouse_event($MOUSEEVENTF_WHEEL, 0, 0, $Delta * 120, 0)
        $direction = if ($Delta -gt 0) { "上" } elseif ($Delta -lt 0) { "下" } else { "无" }
        Write-Output "滚轮${direction}滚 ${Delta} 格"
    }
}
