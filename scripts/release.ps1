# release.ps1 — 标准发版编排（一条命令发新版）
# 用法:
#   .\scripts\release.ps1 -Notes "修复了XXX；新增YYY"
#   .\scripts\release.ps1 -Notes "..." -Version 2.3.0     # 指定版本(默认 patch+1)
#   .\scripts\release.ps1 -Notes "..." -DryRun            # 只演练不发布
#   .\scripts\release.ps1 -Notes "..." -SkipBuild -ZipPath <已有zip>   # 跳过构建
# 流程: bump 版本号 → build-portable(构建+洁净度门禁+zip) → 提交+tag+推 gitee
#       → git archive 同步公开快照仓(linker-publish) → 创建 GitHub Release+上传资产
#       → 核对清单
# 注意: 必须先停 dev 双进程与 watchdog(build-portable 内有端口检测提示)。
param(
  [Parameter(Mandatory=$true)][string]$Notes,
  [string]$Version = "",
  [string]$ZipPath = "",
  [switch]$SkipBuild,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
# Node 子进程(中文日志)与终端的编码统一——无此行 GBK 终端显示 mjs 的 UTF-8 输出为乱码
chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProjectRoot = Split-Path -Parent $PSScriptRoot

Write-Host "`n=== CrabPaw 标准发版 ===" -ForegroundColor Cyan

# ── 0. 前置检查 ──
Push-Location $ProjectRoot
$gitStatus = git status --porcelain | Where-Object { $_ -notmatch '^\?\?' }
if ($gitStatus) {
  Write-Host "[WARN] 工作区有未提交修改(发的是 HEAD 提交树, 未提交内容不进版):" -ForegroundColor Yellow
  $gitStatus | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkYellow }
}

# ── 1. 计算版本号 ──
Write-Host "`n[1/6] 版本号" -ForegroundColor Cyan
$ver = if ($Version) { node scripts/bump-version.js $Version --dry-run } else { node scripts/bump-version.js --dry-run }
if (-not $ver -or $LASTEXITCODE -ne 0) { throw "版本号计算失败" }
Write-Host "目标版本: $ver"

# ── 2. 构建 ──
if ($DryRun) {
  Write-Host "`n[2/6] 演练模式: 跳过构建" -ForegroundColor Yellow
} elseif (-not $SkipBuild) {
  Write-Host "`n[2/6] 构建(sherpa rebuild + vite + electron-builder + 洁净度门禁 + zip)" -ForegroundColor Cyan
  # bump 真实写盘(构建产物名依赖版本号)
  if ($Version) { node scripts/bump-version.js $Version | Out-Null } else { node scripts/bump-version.js | Out-Null }
  $bumped = (Get-Content "gui\package.json" -Raw | ConvertFrom-Json).version
  Write-Host "package.json version → $bumped"
  & (Join-Path $PSScriptRoot "build-portable.ps1")
  if (-not (Test-Path (Join-Path $ProjectRoot "CrabPaw-Release\CrabPaw-$bumped-win64-Portable.zip"))) { throw "构建产物缺失" }
} else {
  Write-Host "`n[2/6] 跳过构建(-SkipBuild)" -ForegroundColor Yellow
  if (-not $ZipPath) { throw "-SkipBuild 需同时传 -ZipPath 指向已有 zip" }
  if ($Version) { node scripts/bump-version.js $Version | Out-Null } else { node scripts/bump-version.js | Out-Null }
}
$zip = if ($ZipPath) { $ZipPath } else { Join-Path $ProjectRoot "CrabPaw-Release\CrabPaw-$ver-win64-Portable.zip" }
if (-not (Test-Path $zip)) {
  if ($DryRun) { Write-Host "[DRY-RUN] 产物尚未构建: $zip" -ForegroundColor Yellow } else { throw "构建产物不存在: $zip" }
}
Write-Host "产物: $zip ($('{0:N1} MB' -f ((Get-Item $zip).Length / 1MB)))"

# ── 3. notes 临时文件 ──
$notesFile = Join-Path $env:TEMP "crabpaw-release-notes-$ver.md"
Set-Content -Path $notesFile -Value $Notes -Encoding UTF8

if ($DryRun) {
  Write-Host "`n[DRY-RUN] 后续将执行: 提交版本号+tag v$ver → 推 gitee → 同步快照仓 → 创建 GitHub Release" -ForegroundColor Yellow
  node scripts/create-github-release.mjs $ver $notesFile $zip --dry-run
  Pop-Location
  return
}

# ── 4. 提交版本号 + tag + 推 gitee ──
Write-Host "`n[3/6] 提交版本号 + tag v$ver + 推 gitee" -ForegroundColor Cyan
git add gui/package.json
git commit -m "chore(release): v$ver"
git tag "v$ver"
git push gitee codex/biz-cards-foundation
git push gitee "refs/tags/v$ver"

# ── 5. 同步公开快照仓(linker-publish) ──
# git archive 导出 HEAD 提交树(未提交内容不进版), 临时 tar 中转(PS 管道会文本化二进制流)
Write-Host "`n[4/6] 同步公开快照仓(linker-publish)" -ForegroundColor Cyan
$LP = "D:\linker-publish"
if (Test-Path $LP) {
  $tarTmp = Join-Path $env:TEMP "crabpaw-release-tree.tar"
  git archive --format=tar -o $tarTmp HEAD
  tar -xf $tarTmp -C $LP
  Remove-Item $tarTmp -Force
  Push-Location $LP
  git add -A
  $hasChanges = git status --porcelain
  if ($hasChanges) {
    git commit -m "release: v$ver"
    git push origin main
  } else {
    Write-Host "  快照仓无差异, 跳过提交"
  }
  Pop-Location
} else {
  Write-Host "[WARN] 未找到 $LP——跳过快照仓同步" -ForegroundColor Yellow
}

# ── 6. 创建 GitHub Release + 上传资产 ──
Write-Host "`n[5/6] 创建 GitHub Release + 上传资产" -ForegroundColor Cyan
node scripts/create-github-release.mjs $ver $notesFile $zip
if ($LASTEXITCODE -ne 0) { throw "GitHub Release 创建/上传失败" }

# ── 核对清单 ──
Write-Host "`n[6/6] 发版核对清单" -ForegroundColor Green
Write-Host "  [ok] 版本: v$ver (gui/package.json 已 bump 并提交)"
Write-Host "  [ok] 产物: $zip"
Write-Host "  [ok] tag:  v$ver → gitee 已推送"
Write-Host "  [ok] 快照仓 linker-publish main 已同步(应用内更新读 GitHub Releases)"
Write-Host "  [ok] GitHub Release + 资产已上传"
Write-Host "`n  剩余人工动作:" -ForegroundColor Yellow
Write-Host "  1. 售后群发更新公告(可附新版 zip, 按《版本更新指引》)"
Write-Host "  2. 抖音/朋友圈等渠道按需宣传"
Pop-Location
Write-Host "`n=== 发版完成 ===" -ForegroundColor Green
