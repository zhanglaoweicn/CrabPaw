# window_control.ps1 - Windows 窗口管理脚本
# 用法: powershell -File window_control.ps1 -Action <操作> [-Title <窗口标题>] [-X <坐标>] [-Y <坐标>] [-Width <宽>] [-Height <高>]

param (
    [Parameter(Mandatory=$true)]
    [ValidateSet("activate", "close", "minimize", "maximize", "restore", "resize", "list", "screenshot")]
    [string]$Action,

    [string]$Title,
    [int]$X = -1,
    [int]$Y = -1,
    [int]$Width = -1,
    [int]$Height = -1
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32Window {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }
}
"@ -ErrorAction SilentlyContinue

# ShowWindow 常量
$SW_MINIMIZE   = 6
$SW_MAXIMIZE   = 3
$SW_RESTORE    = 9
$WM_CLOSE      = 0x0010

# 按标题查找窗口
function Find-Window {
    param([string]$title)
    $hwnd = [Win32Window]::FindWindow($null, $title)
    if ($hwnd -eq [IntPtr]::Zero) {
        # 模糊匹配
        $found = [IntPtr]::Zero
        $callback = [Win32Window+EnumWindowsProc]{
            param($hWnd, $lParam)
            $sb = New-Object System.Text.StringBuilder 256
            [Win32Window]::GetWindowText($hWnd, $sb, 256) | Out-Null
            $text = $sb.ToString()
            if ($text -like "*$title*" -and [Win32Window]::IsWindowVisible($hWnd)) {
                $script:found = $hWnd
                return $false
            }
            return $true
        }
        [Win32Window]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
        return $found
    }
    return $hwnd
}

# 列出可见窗口
function List-VisibleWindows {
    $windows = @()
    $callback = [Win32Window+EnumWindowsProc]{
        param($hWnd, $lParam)
        if ([Win32Window]::IsWindowVisible($hWnd)) {
            $sb = New-Object System.Text.StringBuilder 256
            [Win32Window]::GetWindowText($hWnd, $sb, 256) | Out-Null
            $text = $sb.ToString()
            if ($text.Length -gt 0) {
                $script:windows += @{ Handle = $hWnd; Title = $text }
            }
        }
        return $true
    }
    [Win32Window]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
    return $windows
}

switch ($Action) {
    "activate" {
        if (-not $Title) { Write-Output "错误: 需要指定 -Title 参数"; return }
        $hwnd = Find-Window $Title
        if ($hwnd -eq [IntPtr]::Zero) { Write-Output "错误: 未找到窗口 '$Title'"; return }
        [Win32Window]::SetForegroundWindow($hwnd) | Out-Null
        Write-Output "激活窗口: $Title"
    }

    "close" {
        if (-not $Title) { Write-Output "错误: 需要指定 -Title 参数"; return }
        $hwnd = Find-Window $Title
        if ($hwnd -eq [IntPtr]::Zero) { Write-Output "错误: 未找到窗口 '$Title'"; return }
        [Win32Window]::PostMessage($hwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        Write-Output "关闭窗口: $Title"
    }

    "minimize" {
        if (-not $Title) { Write-Output "错误: 需要指定 -Title 参数"; return }
        $hwnd = Find-Window $Title
        if ($hwnd -eq [IntPtr]::Zero) { Write-Output "错误: 未找到窗口 '$Title'"; return }
        [Win32Window]::ShowWindow($hwnd, $SW_MINIMIZE) | Out-Null
        Write-Output "最小化窗口: $Title"
    }

    "maximize" {
        if (-not $Title) { Write-Output "错误: 需要指定 -Title 参数"; return }
        $hwnd = Find-Window $Title
        if ($hwnd -eq [IntPtr]::Zero) { Write-Output "错误: 未找到窗口 '$Title'"; return }
        [Win32Window]::ShowWindow($hwnd, $SW_MAXIMIZE) | Out-Null
        Write-Output "最大化窗口: $Title"
    }

    "restore" {
        if (-not $Title) { Write-Output "错误: 需要指定 -Title 参数"; return }
        $hwnd = Find-Window $Title
        if ($hwnd -eq [IntPtr]::Zero) { Write-Output "错误: 未找到窗口 '$Title'"; return }
        [Win32Window]::ShowWindow($hwnd, $SW_RESTORE) | Out-Null
        Write-Output "还原窗口: $Title"
    }

    "resize" {
        if (-not $Title) { Write-Output "错误: 需要指定 -Title 参数"; return }
        $hwnd = Find-Window $Title
        if ($hwnd -eq [IntPtr]::Zero) { Write-Output "错误: 未找到窗口 '$Title'"; return }
        if ($X -ge 0 -and $Y -ge 0 -and $Width -gt 0 -and $Height -gt 0) {
            [Win32Window]::MoveWindow($hwnd, $X, $Y, $Width, $Height, $true) | Out-Null
            Write-Output "调整窗口: 位置($X,$Y) 大小(${Width}x${Height})"
        } else {
            Write-Output "错误: 需要指定 -X -Y -Width -Height 参数"
        }
    }

    "list" {
        $windows = List-VisibleWindows
        Write-Output "可见窗口列表 (共 $($windows.Count) 个):"
        Write-Output "----------------------------------------"
        foreach ($w in $windows) {
            Write-Output "  $($w.Title)"
        }
    }

    "screenshot" {
        if (-not $Title) { Write-Output "错误: 需要指定 -Title 参数"; return }
        $hwnd = Find-Window $Title
        if ($hwnd -eq [IntPtr]::Zero) { Write-Output "错误: 未找到窗口 '$Title'"; return }
        [Win32Window]::SetForegroundWindow($hwnd) | Out-Null
        Start-Sleep -Milliseconds 300
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $rect = New-Object Win32Window+RECT
        [Win32Window]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
        $w = $rect.Right - $rect.Left
        $h = $rect.Bottom - $rect.Top
        if ($w -le 0 -or $h -le 0) { Write-Output "错误: 无法获取窗口尺寸"; return }
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, [System.Drawing.Size]::new($w, $h))
        $g.Dispose()
        $ts = Get-Date -Format "yyyyMMdd_HHmmss"
        $safeTitle = $Title -replace '[\\/:*?"<>|]', '_'
        $path = "$env:TEMP\screenshot_${safeTitle}_${ts}.png"
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Output "截图已保存: $path"
    }
}
