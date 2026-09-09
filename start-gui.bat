@echo off
cd /d "%~dp0gui"
echo Starting CrabPaw GUI...
echo.
call npm run dev
echo.
echo CrabPaw exited.
pause
