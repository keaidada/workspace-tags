@echo off
chcp 65001 >nul 2>&1
REM Workspace Tags - Native Host 自检脚本 (Windows)

setlocal
cd /d "%~dp0"

where python >nul 2>&1
if %errorlevel% equ 0 (
    set "PYTHON_CMD=python"
    goto run_check
)

where python3 >nul 2>&1
if %errorlevel% equ 0 (
    set "PYTHON_CMD=python3"
    goto run_check
)

echo 错误：未找到 Python。请先安装 Python 3.8+ 并确保已加入 PATH。
pause
exit /b 1

:run_check
%PYTHON_CMD% read_dir.py --self-check
set "EXIT_CODE=%errorlevel%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo 自检发现问题，请根据上面的提示修复后重试。
)
pause
exit /b %EXIT_CODE%
