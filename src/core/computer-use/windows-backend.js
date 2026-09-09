const { ComputerUseBackend, CaptureResult } = require('./backend');
const { exec, execFileSync } = require('child_process');





const CAPTURE_PS = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())
$g.Dispose()
$bmp.Dispose()`;

const LIST_APPS_PS = `Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json`;

const FOCUS_APP_PS = `(New-Object -ComObject WScript.Shell).AppActivate('{APP_NAME}')`;

const CLICK_PS = `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point({X}, {Y})
Start-Sleep -Milliseconds 50
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name U32 -Namespace W
[W.U32]::mouse_event(2, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[W.U32]::mouse_event(4, 0, 0, 0, 0)`;

const TYPE_TEXT_PS = `Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('{TEXT}')`;

// P1 修复(2026-09-06): 此前模板把映射值硬包在花括号里 SendWait('{^c}')——
// SendKeys 语法中花括号是转义符, '{^c}' 会打字面文本 "^c" 而非按 Ctrl+C。
// 现由 composeSendKeys 生成完整正确的 SendKeys 串(组合用 ^+% 前缀, 命名键自带花括号),
// 此处直接单引号包裹。
const KEY_PS = `Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('__KEYS__')`;

// 命名键 → SendKeys 花括号名(.NET SendKeys 规范)
const NAMED_SEND_KEYS = {
  enter: 'ENTER', tab: 'TAB', escape: 'ESC', backspace: 'BS', delete: 'DEL',
  up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT',
  home: 'HOME', end: 'END', pageup: 'PGUP', pagedown: 'PGDN',
};

// SendKeys 修饰键前缀(不支持 Win——Win 组合走 keybd_event 序列)
const MODIFIER_SYMBOLS = { ctrl: '^', shift: '+', alt: '%' };

const SEND_KEYS_MAP = {
  'enter': '{ENTER}',
  'tab': '{TAB}',
  'escape': '{ESC}',
  'backspace': '{BS}',
  'delete': '{DEL}',
  'up': '{UP}',
  'down': '{DOWN}',
  'left': '{LEFT}',
  'right': '{RIGHT}',
  'home': '{HOME}',
  'end': '{END}',
  'pageup': '{PGUP}',
  'pagedown': '{PGDN}',
  'ctrl+a': '^a',
  'ctrl+c': '^c',
  'ctrl+v': '^v',
  'ctrl+x': '^x',
  'ctrl+z': '^z',
  'ctrl+s': '^s',
  'ctrl+f': '^f',
  'alt+f4': '%{F4}',
  'alt+tab': '%{TAB}',
};

/**
 * 把 "ctrl+shift+s" 形式的按键组合合成为正确的 .NET SendKeys 语法(纯函数, 供单测)。
 * 规则: 修饰键前缀 ^ ctrl / + shift / % alt; 命名键用 {ENTER} 等; 单字符字面发送。
 * @param {string} combo - 形如 'ctrl+c' / 'enter' / 'f5' 的小写组合
 * @returns {string} SendKeys 语法串, 如 '^c' / '{ENTER}' / '{F5}'
 * @throws {Error} 不支持的修饰键(如 win)或无法识别的按键
 */
function composeSendKeys(combo) {
  const parts = String(combo || '').toLowerCase().split('+').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('按键组合为空');
  const base = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  for (const m of mods) {
    if (!MODIFIER_SYMBOLS[m]) {
      throw new Error(`SendKeys 不支持修饰键: ${m}(Win 组合请走 keybd_event 序列)`);
    }
  }
  let baseSyntax;
  if (NAMED_SEND_KEYS[base]) {
    baseSyntax = `{${NAMED_SEND_KEYS[base]}}`;
  } else if (/^f\d{1,2}$/.test(base)) {
    baseSyntax = `{${base.toUpperCase()}}`;
  } else if (base.length === 1) {
    baseSyntax = base;
  } else {
    throw new Error(`无法识别的按键: ${base}`);
  }
  return mods.map(m => MODIFIER_SYMBOLS[m]).join('') + baseSyntax;
}

// Virtual-Key 码: Win 组合键/裸修饰键走 keybd_event(SendKeys 不支持 Win 修饰键,
// 也无法单独按压修饰键)
const VK_MAP = (() => {
  const vk = { enter: 0x0D, esc: 0x1B, escape: 0x1B, tab: 0x09, space: 0x20,
    backspace: 0x08, delete: 0x2E,
    left: 0x25, up: 0x26, right: 0x27, down: 0x28 };
  for (let i = 0; i < 26; i++) vk[String.fromCharCode(97 + i)] = 0x41 + i; // a-z
  for (let i = 0; i < 10; i++) vk[String(i)] = 0x30 + i;                   // 0-9
  return vk;
})();

const VK_MODIFIERS = { ctrl: 0x11, shift: 0x10, alt: 0x12, win: 0x5B };

function _keybdEventPs(sequence) {
  // sequence: [{vk, down}] → 一次 PowerShell 内完成整段按压序列
  const body = sequence.map(({ vk, down }) =>
    `[W.U32]::keybd_event(0x${vk.toString(16)}, 0, ${down ? 0 : 2}, 0)`).join('\n');
  return `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);' -Name U32 -Namespace W\n${body}`;
}

const WIN_KEY_PS = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);' -Name U32 -Namespace W
[W.U32]::keybd_event(0x5B, 0, 0, 0)
Start-Sleep -Milliseconds 100
[W.U32]::keybd_event(0x5B, 0, 2, 0)`;

class WindowsBackend extends ComputerUseBackend {
  constructor(config = {}) {
    super(config);
    this._psPath = config.powershellPath || 'powershell';
  }

  async initialize() {
    try {
      execFileSync(this._psPath, ['-Command', 'echo test'], { timeout: 5000, windowsHide: true });
      return true;
    } catch (e) {
      throw new Error('PowerShell not available: ' + e.message);
    }
  }

  async shutdown() {
    this._activePid = null;
    this._activeWindowTitle = null;
  }

  async capture(mode = 'som', app = null) {
    if (app) {
      await this.focusApp(app);
      await this.wait(0.5);
    }

    const screenshot = await this._runPs(CAPTURE_PS);

    let elements = [];
    let axTree = null;

    if (mode === 'som' || mode === 'ax') {
      try {
        const uiTree = await this._captureUITree();
        if (mode === 'som') {
          elements = this._parseUIElements(uiTree);
        }
        if (mode === 'ax') {
          axTree = this._formatAXTree(uiTree);
        }
      } catch (e) {
        console.warn('[WindowsBackend] UI tree capture failed:', e.message);
      }
    }

    const screenInfo = await this._getScreenInfo();

    return new CaptureResult({
      screenshot: `data:image/png;base64,${screenshot.trim()}`,
      elements,
      axTree,
      mode,
      width: screenInfo.width,
      height: screenInfo.height,
    });
  }

  async click(params) {
    // eslint-disable-next-line no-unused-vars
    const { element, x, y, button = 'left', modifiers = [] } = params;

    let clickX = x;
    let clickY = y;

    if (element !== undefined && this._lastElements) {
      const el = this._lastElements[element];
      if (el) {
        clickX = el.x;
        clickY = el.y;
      }
    }

    if (clickX === undefined || clickY === undefined) {
      throw new Error('Must provide either (x, y) or element index');
    }

    let script = CLICK_PS.replace('{X}', clickX).replace('{Y}', clickY);

    if (button === 'right') {
      script = script.replace('mouse_event(2,', 'mouse_event(8,')
                     .replace('mouse_event(4,', 'mouse_event(16,');
    }

    await this._runPs(script);
    this.emit('action', { type: 'click', x: clickX, y: clickY, button });
  }

  async typeText(text) {
    // 安全转义：SendKeys特殊字符 + PowerShell特殊字符
    // SendKeys: + ^ % ~ { } ( ) 需要用 {} 包裹
    // PowerShell: ` $ 需要转义
    const escaped = text
      .replace(/[+^%~{}()]/g, '{$&}')
      .replace(/`/g, '{`}')
      .replace(/\$/g, '{$}');
    const script = TYPE_TEXT_PS.replace('{TEXT}', escaped);
    await this._runPs(script);
    this.emit('action', { type: 'type', text });
  }

  async key(keys) {
    const keyLower = String(keys || '').toLowerCase().trim();

    // 裸修饰键单独按压(SendKeys 无法做到) → keybd_event 按下+抬起
    if (VK_MODIFIERS[keyLower]) {
      await this._runPs(_keybdEventPs([
        { vk: VK_MODIFIERS[keyLower], down: true },
        { vk: VK_MODIFIERS[keyLower], down: false },
      ]));
      this.emit('action', { type: 'key', keys });
      return;
    }

    // Win 单键(历史路径保留)与 Win+X 组合: SendKeys 不支持 Win 修饰键 → keybd_event
    if (keyLower === 'win') {
      await this._runPs(WIN_KEY_PS);
      this.emit('action', { type: 'key', keys: 'win' });
      return;
    }
    if (/^win\+/.test(keyLower)) {
      const base = keyLower.split('+').pop();
      const vk = VK_MAP[base];
      if (!vk) throw new Error(`Win+${base} 组合不受支持`);
      await this._runPs(_keybdEventPs([
        { vk: 0x5B, down: true },
        { vk, down: true },
        { vk, down: false },
        { vk: 0x5B, down: false },
      ]));
      this.emit('action', { type: 'key', keys });
      return;
    }

    // 2026-09-06: 优先查历史映射表, 未命中走通用合成器(任意 ctrl/shift/alt 组合)
    const mapped = SEND_KEYS_MAP[keyLower] || composeSendKeys(keyLower);
    // string.replace 的替换串里 $ 有特殊含义, 用函数形式保证字面替换
    const script = KEY_PS.replace('__KEYS__', () => mapped);
    await this._runPs(script);
    this.emit('action', { type: 'key', keys });
  }

  /**
   * 移动鼠标到绝对坐标(2026-09-06 P2: 此前 desktop-tools 的 mouse_move 绕过后端
   * 直接拼 PowerShell, 丢失后端 emit('action') 事件流。现统一走本方法。)
   */
  async move(x, y) {
    const script = `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${parseInt(x, 10)}, ${parseInt(y, 10)})`;
    await this._runPs(script);
    this.emit('action', { type: 'move', x, y });
  }

  async scroll(params) {
    const { direction = 'down', amount = 3, x, y } = params;
    const scrollX = x || 0;
    const scrollY = y || 0;
    const delta = direction === 'down' ? -120 * amount : 120 * amount;

    const script = `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${scrollX}, ${scrollY})
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern int SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);' -Name U32 -Namespace W
$hwnd = [W.U32]::SendMessage([System.Diagnostics.Process]::GetCurrentProcess().MainWindowHandle, 0x020A, [IntPtr]::new(${delta}), [IntPtr]::Zero)`;
    await this._runPs(script);
    this.emit('action', { type: 'scroll', direction, amount });
  }

  async drag(params) {
    const { fromX, fromY, toX, toY } = params;
    const script = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);' -Name U32 -Namespace W
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${fromX}, ${fromY})
Start-Sleep -Milliseconds 100
[W.U32]::mouse_event(2, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
$steps = 10
for ($i = 1; $i -le $steps; $i++) {
  $x = [int](${fromX} + (${toX} - ${fromX}) * $i / $steps)
  $y = [int](${fromY} + (${toY} - ${fromY}) * $i / $steps)
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
  Start-Sleep -Milliseconds 20
}
[W.U32]::mouse_event(4, 0, 0, 0, 0)`;
    await this._runPs(script);
    this.emit('action', { type: 'drag', fromX, fromY, toX, toY });
  }

  async listApps() {
    const output = await this._runPs(LIST_APPS_PS);
    try {
      const apps = JSON.parse(output);
      const list = Array.isArray(apps) ? apps : [apps];
      return list.map(a => ({
        pid: a.Id,
        name: a.ProcessName,
        title: a.MainWindowTitle,
      }));
    } catch {
      return [];
    }
  }

  async focusApp(appName) {
    const safeName = appName.replace(/'/g, "''");
    const script = FOCUS_APP_PS.replace('{APP_NAME}', safeName);
    await this._runPs(script);
    this._activeWindowTitle = appName;
    this.emit('action', { type: 'focus', app: appName });
  }

  async _runPs(script) {
    return new Promise((resolve, reject) => {
      const cmd = `${this._psPath} -NoProfile -Command "${script.replace(/"/g, '\\"')}"`;
      exec(cmd, { timeout: 15000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`PowerShell error: ${err.message}\n${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  async _getScreenInfo() {
    try {
      const output = await this._runPs(`Add-Type -AssemblyName System.Windows.Forms; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($b.Width),$($b.Height)"`);
      const [width, height] = output.trim().split(',').map(Number);
      return { width, height };
    } catch {
      return { width: 1920, height: 1080 };
    }
  }

  async _captureUITree() {
    const script = `Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = [System.Windows.Automation.Condition]::TrueCondition
$children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$results = @()
foreach ($child in $children) {
  $rect = $child.Current.BoundingRectangle
  $results += @{
    Name = $child.Current.Name
    ClassName = $child.Current.ClassName
    ControlType = $child.Current.ControlType.ProgrammaticName
    X = [int]$rect.X
    Y = [int]$rect.Y
    Width = [int]$rect.Width
    Height = [int]$rect.Height
    IsEnabled = $child.Current.IsEnabled
  }
}
$results | ConvertTo-Json -Depth 3`;
    const output = await this._runPs(script);
    try {
      return JSON.parse(output);
    } catch {
      return [];
    }
  }

  _parseUIElements(uiTree) {
    const elements = [];
    const items = Array.isArray(uiTree) ? uiTree : [uiTree];
    for (const item of items) {
      if (!item || !item.Name && !item.ClassName) continue;
      elements.push({
        index: elements.length,
        role: item.ControlType || 'unknown',
        name: item.Name || '',
        text: item.Name || '',
        x: Math.round((item.X || 0) + (item.Width || 0) / 2),
        y: Math.round((item.Y || 0) + (item.Height || 0) / 2),
        bounds: {
          x: item.X || 0,
          y: item.Y || 0,
          width: item.Width || 0,
          height: item.Height || 0,
        },
        enabled: item.IsEnabled !== false,
      });
    }
    this._lastElements = elements;
    return elements;
  }

  _formatAXTree(uiTree) {
    const items = Array.isArray(uiTree) ? uiTree : [uiTree];
    return items.map((item, i) => {
      const type = item.ControlType || 'unknown';
      const name = item.Name || '';
      const cls = item.ClassName || '';
      const x = item.X || 0;
      const y = item.Y || 0;
      return `[${i}] ${type} "${name}" class="${cls}" at (${x},${y})`;
    }).join('\n');
  }
}

module.exports = { WindowsBackend, composeSendKeys, SEND_KEYS_MAP, NAMED_SEND_KEYS };
