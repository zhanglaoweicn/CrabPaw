<#
.SYNOPSIS
    CrabPaw 免安装 U 盘版一键构建(文件夹形态: 解压后双击 CrabPaw.exe 即用, 数据随盘)
.DESCRIPTION
    设计: docs/superpowers/specs/2026-08-25-crabpaw-portable-usb-design.md
    流程: 前置检查 -> 依赖下载(幂等) -> sherpa-only rebuild -> tsc+vite(->)
          electron-builder dir 目标 -> README/LICENSE 注入 -> 洁净度门禁(目录+zip) -> zip
    注意: 只 rebuild sherpa-onnx-node(Electron 进程内使用);better-sqlite3/sharp
          跑在捆绑 node.exe(Node 24/ABI 127)下, 保持官方 prebuild, 禁止 electron rebuild。
.PARAMETER Check       仅检查前置条件(版本/待下载件), 不执行构建
.PARAMETER UseGhProxy  GitHub 下载走 gh-proxy.com 前缀(Electron/NSIS/CloakBrowser)
.PARAMETER Clean       构建前清理 CrabPaw-Release 产物目录
.PARAMETER SkipDeps    跳过依赖下载(缓存已就绪时提速)
#>
param(
    [switch]$Check,
    [switch]$UseGhProxy,
    [switch]$Clean,
    [switch]$SkipDeps,
    [switch]$WithCloakBinary
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ReleaseDir  = Join-Path $ProjectRoot "CrabPaw-Release"
$UnpackedDir = Join-Path $ReleaseDir "win-unpacked"

function Write-Step { param([string]$Msg) Write-Host "`n=== $Msg ===" -ForegroundColor Cyan }

# ---------- 下载镜像(必须在依赖下载/electron-builder 之前导出) ----------
# electron 下载并非常态走 gh-proxy: eb24 的 Go 下载器拼接 mirror+version+"/"+file,
# 产出无 v 前缀路径(.../download/43.4.0/...)——GitHub 自 2024-09 起不再重定向非 v
# 前缀, 服务 404(实测直连与 gh-proxy 均 404);gh-proxy 无法在 URL 中部注入 v。
# npmmirror 的 electron 镜像布局兼容无 v 路径且 CN 可达, 一律镜像它(尾斜杠必须)。
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
if ($UseGhProxy) {
    # electron-builder-binaries 的 release tag 本身无 v 前缀(如 nsis-3.0.4.1), gh-proxy 可直接镜像
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://gh-proxy.com/https://github.com/electron-userland/electron-builder-binaries/releases/download/"
    $env:CRABPAW_GH_PROXY  = "1"   # scripts/download-portable-deps.js 据此指向 CloakBrowser
    Write-Host "[PROXY] GitHub 下载走 gh-proxy.com 前缀; electron 镜像走 npmmirror" -ForegroundColor Yellow
}

# ---------- 前置检查 ----------
function Check-Prereq {
    $ok = $true
    try { $nv = (& node -v) -replace '^v','' } catch { Write-Host "[FAIL] 未找到 node" -ForegroundColor Red; return $false }
    $major = [int]($nv.Split('.')[0])
    if ($major -ne 24) {
        Write-Host "[FAIL] 开发机 Node 必须为 24.x(当前 $nv)。打包运行时固定 node.exe v24.13.0/ABI 127," -ForegroundColor Red
        Write-Host "       better-sqlite3/sharp 预编译依赖同版本匹配。请在 Node 24 下重试。" -ForegroundColor Red
        $ok = $false
    } else {
        Write-Host "[OK] node $nv"
    }
    if (-not (Test-Path (Join-Path $ProjectRoot "gui\resources\node.exe"))) {
        Write-Host "[WARN] gui\resources\node.exe 缺失 -> 需运行依赖下载(或 -SkipDeps 且自认就绪)" -ForegroundColor Yellow
    } else { Write-Host "[OK] gui\resources\node.exe" }
    if (-not (Test-Path (Join-Path $ProjectRoot "gui\resources\npm\bin\npm-cli.js"))) {
        Write-Host "[WARN] gui\resources\npm 缺失 -> 运行时技能依赖安装不可用, 需运行依赖下载" -ForegroundColor Yellow
    } else { Write-Host "[OK] gui\resources\npm(便携 npm CLI)" }
    if (-not (Test-Path (Join-Path $ProjectRoot "portable\python\python.exe"))) {
        Write-Host "[WARN] portable\python\python.exe 缺失 -> 需运行依赖下载" -ForegroundColor Yellow
    } else { Write-Host "[OK] portable\python" }
    if (-not (Test-Path (Join-Path $ProjectRoot "portable\python\Lib\site-packages\pip"))) {
        Write-Host "[WARN] portable\python 缺 pip -> 技能 pip 依赖安装不可用, 需运行依赖下载" -ForegroundColor Yellow
    } else { Write-Host "[OK] portable\python(含 pip)" }
    if (-not (Test-Path (Join-Path $ProjectRoot "portable\ffmpeg\bin\ffmpeg.exe"))) {
        Write-Host "[WARN] portable\ffmpeg\bin\ffmpeg.exe 缺失 -> 视频工具/TTS 解码不可用, 需运行依赖下载" -ForegroundColor Yellow
    } else { Write-Host "[OK] portable\ffmpeg" }
    if (-not (Test-Path (Join-Path $ProjectRoot "gui\node_modules\electron-builder"))) {
        Write-Host "[FAIL] gui\node_modules 未安装(先 cd gui && npm install)" -ForegroundColor Red
        $ok = $false
    } else { Write-Host "[OK] gui 依赖已安装" }
    # EBUSY 预警: 运行中的 CrabPaw 后端/GUI 会锁定 data 目录文件(CloakBrowser/DB), 打包复制时 EBUSY 失败
    $portBusy = netstat -ano | Select-String ":38767\s.*LISTENING" -Quiet
    if ($portBusy) {
        Write-Host "[WARN] 端口 38767 有运行中的 CrabPaw 实例——会锁定 data 目录文件(CloakBrowser/sqlite)," -ForegroundColor Yellow
        Write-Host "       electron-builder 复制 resources\data 时可能 EBUSY 失败; 请先停止后端/GUI 再构建" -ForegroundColor Yellow
    } else { Write-Host "[OK] 端口 38767 空闲(无运行实例抢占数据文件)" }
    return $ok
}

try {
    if (-not (Check-Prereq)) { exit 1 }
    if ($Check) { Write-Host "`n[CHECK] 前置条件通过, -Check 模式结束"; exit 0 }

    if ($Clean -and (Test-Path $ReleaseDir)) {
        Write-Step "清理旧产物"
        Remove-Item $ReleaseDir -Recurse -Force
    }

    # 1/7 依赖下载(幂等)
    if (-not $SkipDeps) {
        Write-Step "1/7 依赖下载(CloakBrowser/Python/node.exe)"
        Push-Location $ProjectRoot
        node scripts/download-portable-deps.js
        if ($LASTEXITCODE -ne 0) { throw "依赖下载失败 (exit $LASTEXITCODE)" }
        Pop-Location
    } else {
        Write-Step "1/7 依赖下载(跳过: -SkipDeps)"
    }

    # 2/7 原生模块: 仅 sherpa-onnx-node(Electron 进程内)
    Write-Step "2/7 rebuild sherpa-onnx-node(electron ABI)"
    Push-Location (Join-Path $ProjectRoot "gui")
    npx @electron/rebuild -f -w sherpa-onnx-node
    if ($LASTEXITCODE -ne 0) { throw "sherpa-onnx-node rebuild 失败 (exit $LASTEXITCODE)" }
    Pop-Location

    # 3/7 前端 + 主进程构建(tsc && vite build)
    Write-Step "3/7 tsc + vite build"
    Push-Location (Join-Path $ProjectRoot "gui")
    npm run build:vite
    if ($LASTEXITCODE -ne 0) { throw "前端构建失败 (exit $LASTEXITCODE)" }
    Pop-Location

    # 4/7 electron-builder: 仅文件夹版(dir 目标)
    Write-Step "4/7 electron-builder --config.win.target=dir"
    Push-Location (Join-Path $ProjectRoot "gui")
    # EBUSY 重试(2026-08-26 实测): 400MB CloakBrowser 捆绑复制时被杀毒实时扫描/索引器瞬时锁定
    # (chrome.dll/pa.pak.info 均实测命中), 重试 3 次消解瞬时锁; 若为运行实例长期持有则预警已提示
    $ebAttempts = 0
    do {
        $ebAttempts++
        npx electron-builder --config.win.target=dir --config.directories.output=../CrabPaw-Release --x64
        $ebOk = ($LASTEXITCODE -eq 0)
        if (-not $ebOk -and $ebAttempts -lt 3) {
            Write-Host "[WARN] electron-builder 失败(exit $LASTEXITCODE)——疑似杀毒/索引器瞬时锁文件, 10s 后第 $($ebAttempts+1)/3 次重试..." -ForegroundColor Yellow
            Start-Sleep -Seconds 10
        }
    } while (-not $ebOk -and $ebAttempts -lt 3)
    if (-not $ebOk) { throw "electron-builder 打包失败 (exit $LASTEXITCODE)" }
    Pop-Location
    if (-not (Test-Path (Join-Path $UnpackedDir "CrabPaw.exe"))) {
        throw "win-unpacked 产出缺失: $UnpackedDir\CrabPaw.exe"
    }

    # 4b/7 CloakBrowser 二进制可选入包(默认不入, -WithCloakBinary 显式开启)
    # 许可边界(BINARY-LICENSE.md): 自用/公司内部部署=免费商用允许; 对外分发/交付第三方
    # =禁止再分发(捆绑需 OEM 授权, info@cloakbrowser.dev)。运行时缓存解析三级:
    # CrabPaw-Data 副本 → resources 副本(此处放置, 首启排除清单已跳过它不重复拷贝)
    # → 都不存在时首启下载落 CrabPaw-Data。
    if ($WithCloakBinary) {
        Write-Step "4b/7 CloakBrowser 二进制入包(-WithCloakBinary, 仅限自用/内部部署)"
        $cbSrc  = Join-Path $ProjectRoot "data\cloakbrowser"
        $cbDest = Join-Path $UnpackedDir "resources\data\cloakbrowser"
        if (-not (Test-Path $cbSrc)) { throw "data\cloakbrowser 不存在——先运行 npm run download:deps 预下载二进制" }
        New-Item -ItemType Directory -Force -Path (Split-Path $cbDest) | Out-Null
        robocopy $cbSrc $cbDest /E /XF "*.zip" /R:2 /W:2 /NFL /NDL /NP /NJH | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "CloakBrowser 复制失败 (robocopy exit $LASTEXITCODE)" }
        $cbCount = (Get-ChildItem -Recurse -File $cbDest -ErrorAction SilentlyContinue).Count
        Write-Host "[OK] 包内含 CloakBrowser 二进制($cbCount 文件)——客户机免首启下载" -ForegroundColor Green
        Write-Host "[WARN] 对外分发含此二进制违反 BINARY-LICENSE.md(再分发禁止); 商用授权联系 info@cloakbrowser.dev" -ForegroundColor Yellow
    } else {
        Write-Step "4b/7 CloakBrowser 二进制不入包(默认合规)"
        Write-Host "[OK] 客户机首启经官方/国内镜像渠道后台下载(browser-control/cloak-installer), 期间回退系统 Chrome/Edge"
    }

    # 5/7 注入 README.txt + LICENSE(洁净度: README/License 是官方产物, 在门禁之后白名单内)
    Write-Step "5/7 注入 README.txt / LICENSE"
    Copy-Item (Join-Path $ProjectRoot "LICENSE") $UnpackedDir -Force
    $ver = (Get-Content (Join-Path $ProjectRoot "gui\package.json") -Raw | ConvertFrom-Json).version
    $readme = @"
CrabPaw $ver 免安装版(U 盘随身版)
=====================================
使用说明:
  1. 推荐解压到 U 盘根目录(如 E:\CrabPaw), 不要放在多层文件夹里
  2. 双击 CrabPaw.exe 启动(首次启动需播种默认数据, 稍慢属正常)
  3. 首次使用: 进入「设置」页面填入所选模型的 API Key(至少填一个模型服务商)
  4. 所有数据(配置/记忆/上传文件/生成文档/日志)都在 exe 同级的 CrabPaw-Data 文件夹,
     把 exe 整个文件夹拷贝到别处即完成数据迁移
  5. 首次使用浏览器/搜索功能时, 会自动联网下载隐身浏览器组件(约 500MB, 仅一次,
     国内网络自动走镜像渠道), 缓存在 CrabPaw-Data/cloakbrowser; 下载完成前部分
     浏览器任务回退到系统 Edge/Chrome。
   完全无网环境: 先在有网的电脑上插 U 盘完成一次浏览器任务(或从其他已初始化
   机器拷贝 CrabPaw-Data/cloakbrowser 文件夹), 之后该 U 盘离线也有隐身能力。

【退出应用】点击窗口右上角 × 即完全退出(后端一并停止)。关闭后等 10 秒再弹出 U 盘。
若提示"设备在使用中": 双击 U 盘根目录的「安全退出.bat」强制结束全部相关进程,
再弹出即可。

【非常重要】拔除 U 盘前, 必须先在系统托盘点击「安全弹出硬件」!
数据写入过程中直接拔盘会导致数据库损坏、记录丢失。

若启动日志出现「数据目录不可写, 已切换到 userData」: 说明 U 盘只读/空间已满/被杀毒锁定,
此时数据保存在本机磁盘, 不会跟随 U 盘; 请解除只读或清理空间后重启。
"@
    Set-Content -Path (Join-Path $UnpackedDir "README.txt") -Value $readme -Encoding UTF8

    # 5b/7 安全退出脚本: 一键结束从本 U 盘启动的全部 CrabPaw 进程(主程序/后端/残留)
    # U 盘场景必备: 用户关闭窗口后若仍有进程占用(隐藏托盘/孤儿后端/杀软延迟释放),
    # 无法安全弹出时双击本脚本强制清理, 之后即可正常弹出
    $exitBat = @'
@echo off
chcp 65001 >nul
echo 正在结束本 U 盘上的 CrabPaw 全部相关进程...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '%~d0\*' } | ForEach-Object { Write-Host ('结束: ' + $_.Name + ' PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 3 /nobreak >nul
echo 完成! 现在可以在系统托盘安全弹出 U 盘了。
pause
'@
    [IO.File]::WriteAllText((Join-Path $UnpackedDir "安全退出.bat"), $exitBat, [Text.UTF8Encoding]::new($false))

    # 5c/7 包内文档清扫(2026-09-09): 发行包只保留产品提示词/技能定义/许可证/README.txt
    # 使用说明, 第三方 README/CHANGELOG/npm docs 等全部删除——用户不应接触任何系统说明文档
    Write-Step "5c/7 包内文档清扫"
    node (Join-Path $ProjectRoot "scripts\clean-package-docs.js") $UnpackedDir
    if ($LASTEXITCODE -ne 0) { throw "包内文档清扫失败" }

    # 6/7 洁净度门禁(目录 -> zip -> zip 清单), 任一命中即失败
    Write-Step "6/7 洁净度门禁"
    node (Join-Path $ProjectRoot "scripts\verify-portable-clean.js") $UnpackedDir
    if ($LASTEXITCODE -ne 0) { throw "目录门禁未通过" }

    Write-Step "7/7 压缩 zip"
    $ZipPath = Join-Path $ReleaseDir "CrabPaw-$ver-win64-Portable.zip"
    if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
    if (Get-Command 7z -ErrorAction SilentlyContinue) {
        Push-Location $UnpackedDir
        7z a -tzip $ZipPath * | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "7z 压缩失败 (exit $LASTEXITCODE)" }
        Pop-Location
    } else {
        $items = Get-ChildItem $UnpackedDir
        Compress-Archive -Path $items.FullName -DestinationPath $ZipPath -CompressionLevel Optimal
    }
    node (Join-Path $ProjectRoot "scripts\verify-portable-clean.js") --zip $ZipPath
    if ($LASTEXITCODE -ne 0) { throw "zip 清单门禁未通过" }

    Write-Host "`n[SUCCESS] 免安装版构建完成:" -ForegroundColor Green
    Write-Host "  $ZipPath" -ForegroundColor Yellow
    Write-Host "  zip 体积: $('{0:N1} MB' -f ((Get-Item $ZipPath).Length / 1MB))"
    Write-Host "  解压即用: 拷到 U 盘根目录 -> 双击 CrabPaw.exe" -ForegroundColor Green
} catch {
    Write-Host "`n[FAIL] 构建失败: $_" -ForegroundColor Red
    exit 1
}
