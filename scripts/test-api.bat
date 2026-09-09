@echo off
echo ========================================
echo 测试后端 API 连接
echo ========================================
echo.

echo [1/3] 测试健康检查端点...
curl -s http://localhost:38767/health
echo.
echo.

echo [2/3] 测试任务列表端点...
curl -s http://localhost:38767/schedules
echo.
echo.

echo [3/3] 测试触发任务端点...
curl -s -X POST http://localhost:38767/schedules/trigger?id=test -H "Content-Type: application/json" -d "{}"
echo.
echo.

echo ========================================
echo 测试完成
echo ========================================
pause
