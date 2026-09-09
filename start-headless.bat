@echo off
cd /d "%~dp0"
setlocal enabledelayedexpansion

set MAX_RETRIES=10
set RETRY_DELAY=5

echo ========================================
echo  CrabPaw Headless Mode (Auto-Restart)
echo  Max retries: %MAX_RETRIES%
echo ========================================
echo.

echo Starting main service (auto-restart)...
set RETRY_COUNT=0
:LoopServer
if !RETRY_COUNT! geq %MAX_RETRIES% (
  echo [%date% %time%] Server failed !RETRY_COUNT! times consecutively — giving up.
  echo Check the logs for details.
  goto :EndLoopServer
)
node src\cli\index.js start
if !ERRORLEVEL! neq 0 (
  set /a RETRY_COUNT+=1
  echo [%date% %time%] Server exited with code !ERRORLEVEL!, restarting in %RETRY_DELAY%s... (attempt !RETRY_COUNT!/%MAX_RETRIES%)
) else (
  set RETRY_COUNT=0
  echo [%date% %time%] Server exited normally, restarting in %RETRY_DELAY%s...
)
timeout /t %RETRY_DELAY% /nobreak >nul
goto LoopServer
:EndLoopServer
echo.

echo Starting Lark bridge (auto-restart)...
set RETRY_COUNT=0
:LoopLark
if !RETRY_COUNT! geq %MAX_RETRIES% (
  echo [%date% %time%] Lark bridge failed !RETRY_COUNT! times — giving up.
  goto :EndLoopLark
)
node src\channels\lark\event-bridge.js
if !ERRORLEVEL! neq 0 (
  set /a RETRY_COUNT+=1
  echo [%date% %time%] Lark bridge exited with code !ERRORLEVEL!, restarting in %RETRY_DELAY%s... (attempt !RETRY_COUNT!/%MAX_RETRIES%)
) else (
  set RETRY_COUNT=0
  echo [%date% %time%] Lark bridge exited normally, restarting in %RETRY_DELAY%s...
)
timeout /t %RETRY_DELAY% /nobreak >nul
goto LoopLark
:EndLoopLark
echo.

echo Starting WeCom bridge (auto-restart)...
set RETRY_COUNT=0
:LoopWecom
if !RETRY_COUNT! geq %MAX_RETRIES% (
  echo [%date% %time%] WeCom bridge failed !RETRY_COUNT! times — giving up.
  goto :EndLoopWecom
)
node src\channels\wecom\event-bridge.js
if !ERRORLEVEL! neq 0 (
  set /a RETRY_COUNT+=1
  echo [%date% %time%] WeCom bridge exited with code !ERRORLEVEL!, restarting in %RETRY_DELAY%s... (attempt !RETRY_COUNT!/%MAX_RETRIES%)
) else (
  set RETRY_COUNT=0
  echo [%date% %time%] WeCom bridge exited normally, restarting in %RETRY_DELAY%s...
)
timeout /t %RETRY_DELAY% /nobreak >nul
goto LoopWecom
:EndLoopWecom

echo ========================================
echo  Some services have stopped.
echo  Check the logs for details.
echo ========================================
pause
