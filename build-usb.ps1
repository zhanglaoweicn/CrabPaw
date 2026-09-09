<#
.SYNOPSIS
    CrabPaw USB Portable Full Build — one script to rule them all.
.DESCRIPTION
    1. Install production npm deps
    2. Download CloakBrowser binary + Python embeddable
    3. Rebuild native modules for Electron
    4. Build Vite frontend
    5. Package into portable EXE via electron-builder
#>

param(
    [switch]$Clean,
    [string]$OutputDir = "CrabPaw-USB"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step { param([string]$Msg) Write-Host "`n=== $Msg ===" -ForegroundColor Cyan }

try {
    if ($Clean -and (Test-Path "$ProjectRoot\CrabPaw-Release")) {
        Remove-Item "$ProjectRoot\CrabPaw-Release" -Recurse -Force
    }

    Write-Step "1/5 Installing production dependencies"
    Push-Location $ProjectRoot
    npm install --production --ignore-scripts
    Pop-Location

    Write-Step "2/5 Downloading CloakBrowser + Python"
    Push-Location $ProjectRoot
    node scripts/download-portable-deps.js
    Pop-Location

    Write-Step "3/5 Building GUI (Vite + Electron)"
    Push-Location "$ProjectRoot\gui"
    npm install --production --ignore-scripts

    Write-Step "4/5 Rebuilding native modules for Electron"
    npx @electron/rebuild -f -w better-sqlite3,sharp

    Write-Step "5/5 Packaging portable EXE"
    npm run build:vite

    npx electron-builder --config.win.target=portable --x64

    Pop-Location

    $ReleaseDir = "$ProjectRoot\CrabPaw-Release"
    if (Test-Path $ReleaseDir) {
        $PortableExe = Get-ChildItem $ReleaseDir -Filter "*Portable*" | Select-Object -First 1
        if ($PortableExe) {
            Write-Host "`n[SUCCESS] USB portable build ready:" -ForegroundColor Green
            Write-Host "  $($PortableExe.FullName)" -ForegroundColor Yellow
            Write-Host "  Size: $('{0:N1} MB' -f ($PortableExe.Length / 1MB))" -ForegroundColor Yellow
        }
    }
} catch {
    Write-Error "Build failed: $_"
    exit 1
}
