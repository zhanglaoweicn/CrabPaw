@echo off
echo ========================================
echo 强制重启后端服务器
echo ========================================
echo.

echo [1/3] 查找占用端口的进程...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :38767') do (
    set PID=%%a
)

if defined PID (
    echo [2/3] 找到进程 PID: %PID%，正在结束...
    taskkill /F /PID %PID%
    timeout /t 2 /nobreak >nul
) else (
    echo [2/3] 端口未被占用
)

echo [3/3] 请重新启动 Electron 应用
echo.
pause
