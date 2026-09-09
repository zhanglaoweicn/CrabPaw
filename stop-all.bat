@echo off
echo Stopping CrabPaw services...

rem Kill by window title (set in start-headless.bat)
taskkill /FI "WINDOWTITLE eq CrabPaw-Server*" /F 2>nul
taskkill /FI "WINDOWTITLE eq CrabPaw-Lark*" /F 2>nul
taskkill /FI "WINDOWTITLE eq CrabPaw-WeCom*" /F 2>nul

rem Fallback: kill CrabPaw processes by command line (safer than killing ALL node.exe)
for /f "tokens=2" %%i in ('tasklist /FI "IMAGENAME eq node.exe" /FO TABLE ^| findstr /C:"node.exe"') do (
  wmic process where "ProcessId=%%i" get CommandLine 2>nul | findstr /C:"crabpaw" >nul && taskkill /PID %%i /F 2>nul
)

echo CrabPaw services stopped.
