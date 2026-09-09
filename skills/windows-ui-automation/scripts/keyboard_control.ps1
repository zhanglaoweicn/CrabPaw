# keyboard_control.ps1 - Windows 键盘控制脚本
# 用法: powershell -File keyboard_control.ps1 [-Text <文本>] [-Key <按键>] [-Hold <按住键>] [-Key <组合键>]

param (
    [string]$Text,
    [string]$Key,
    [string]$Hold,
    [int]$Delay = 50
)

Add-Type -AssemblyName System.Windows.Forms

# SendKeys 特殊键映射
$keyMap = @{
    'enter'     = '{ENTER}'
    'tab'       = '{TAB}'
    'escape'    = '{ESC}'
    'esc'       = '{ESC}'
    'backspace' = '{BACKSPACE}'
    'delete'    = '{DELETE}'
    'up'        = '{UP}'
    'down'      = '{DOWN}'
    'left'      = '{LEFT}'
    'right'     = '{RIGHT}'
    'home'      = '{HOME}'
    'end'       = '{END}'
    'pageup'    = '{PGUP}'
    'pagedown'  = '{PGDN}'
    'f1'        = '{F1}'
    'f2'        = '{F2}'
    'f3'        = '{F3}'
    'f4'        = '{F4}'
    'f5'        = '{F5}'
    'f6'        = '{F6}'
    'f7'        = '{F7}'
    'f8'        = '{F8}'
    'f9'        = '{F9}'
    'f10'       = '{F10}'
    'f11'       = '{F11}'
    'f12'       = '{F12}'
    'space'     = ' '
    'win'       = '^{ESC}'
}

# 输入文本
if ($Text) {
    Start-Sleep -Milliseconds $Delay
    [System.Windows.Forms.SendKeys]::SendWait($Text)
    Write-Output "输入文本: ${Text}"
}

# 组合键: -Hold Ctrl -Key C
if ($Hold -and $Key) {
    $holdKey = $Hold.ToLower()
    $sendKey = if ($keyMap.ContainsKey($Key.ToLower())) { $keyMap[$Key.ToLower()] } else { $Key }

    # 修饰键映射
    $modifier = switch ($holdKey) {
        'ctrl'  { '^' }
        'alt'   { '%' }
        'shift' { '+' }
        default { '' }
    }

    if ($modifier) {
        Start-Sleep -Milliseconds $Delay
        [System.Windows.Forms.SendKeys]::SendWait("${modifier}${sendKey}")
        Write-Output "组合键: ${Hold}+${Key}"
    } else {
        Write-Output "错误: -Hold 仅支持 Ctrl/Alt/Shift"
    }
}
# 单键
elseif ($Key) {
    $sendKey = if ($keyMap.ContainsKey($Key.ToLower())) { $keyMap[$Key.ToLower()] } else { $Key }
    Start-Sleep -Milliseconds $Delay
    [System.Windows.Forms.SendKeys]::SendWait($sendKey)
    Write-Output "按键: ${Key}"
}
