@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo   作业人员姿态识别与安全追踪系统
echo   正在启动本地服务 http://localhost:8123/
echo   关闭本窗口即可停止服务
echo ================================================
start "" http://localhost:8123/
python serve.py 2>nul || py serve.py
echo.
echo 未能启动本地服务，请安装 Python 3 后重试。
pause
