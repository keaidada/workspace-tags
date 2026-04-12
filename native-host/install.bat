@echo off
chcp 65001 >nul 2>&1
REM Workspace Tags - Native Messaging Host 安装脚本 (Windows)
REM 此脚本将 Native Host 注册到 Chrome 注册表，使扩展能够读取本地文件系统。

setlocal enableextensions enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "HOST_PATH=%SCRIPT_DIR%\read_dir.py"
set "HOST_NAME=com.workspace_tags.native_host"
set "TARGET_DIR=%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts"

if not exist "%HOST_PATH%" (
    echo 错误：未找到 Host 脚本：%HOST_PATH%
    pause
    exit /b 1
)

where python >nul 2>&1
if %errorlevel% equ 0 (
    set "PYTHON_CMD=python"
) else (
    where python3 >nul 2>&1
    if %errorlevel% neq 0 (
        echo 错误：未找到 Python。请先安装 Python 3 并确保添加到 PATH。
        pause
        exit /b 1
    )
    set "PYTHON_CMD=python3"
)

%PYTHON_CMD% -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
if errorlevel 1 (
    echo 错误：需要 Python 3.8+。当前命令：%PYTHON_CMD%
    pause
    exit /b 1
)

for /f "delims=" %%i in ('%PYTHON_CMD% -c "import os, sys; print(os.path.realpath(sys.executable))"') do (
    set "PYTHON_PATH=%%i"
    goto :found_python
)

:found_python
if "%PYTHON_PATH%"=="" (
    echo 错误：无法解析 Python 可执行文件路径
    pause
    exit /b 1
)

echo ======================================
echo  Workspace Tags - Native Host 安装
echo ======================================
echo.

set "EXTENSION_ID=%~1"
if "%EXTENSION_ID%"=="" (
    echo 请先在 Chrome 中加载扩展，然后在 chrome://extensions 页面中
    echo 找到 "Workspace Tags" 扩展的 ID（一串 32 位字母）。
    echo.
    set /p EXTENSION_ID="请输入扩展 ID: "
)

if "%EXTENSION_ID%"=="" (
    echo 错误：必须提供扩展 ID
    pause
    exit /b 1
)

%PYTHON_CMD% -c "import re, sys; raise SystemExit(0 if re.fullmatch(r'[a-p]{32}', sys.argv[1]) else 1)" "%EXTENSION_ID%" >nul 2>&1
if errorlevel 1 (
    echo 错误：扩展 ID 格式无效，应为 32 位 a-p 小写字母
    pause
    exit /b 1
)

if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
if errorlevel 1 (
    echo 错误：无法创建目录：%TARGET_DIR%
    pause
    exit /b 1
)

set "BAT_WRAPPER=%SCRIPT_DIR%\run_host.bat"
set "MANIFEST_PATH=%TARGET_DIR%\%HOST_NAME%.json"
set "BAT_WRAPPER_ESCAPED=%BAT_WRAPPER:\=\\%"

(
    echo @echo off
    echo "%PYTHON_PATH%" "%HOST_PATH%" %%*
) > "%BAT_WRAPPER%"

(
    echo {
    echo   "name": "%HOST_NAME%",
    echo   "description": "Workspace Tags - 本地文件系统访问",
    echo   "path": "%BAT_WRAPPER_ESCAPED%",
    echo   "type": "stdio",
    echo   "allowed_origins": [
    echo     "chrome-extension://%EXTENSION_ID%/"
    echo   ]
    echo }
) > "%MANIFEST_PATH%"

reg add "HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul 2>&1
if errorlevel 1 (
    echo 错误：写入注册表失败
    pause
    exit /b 1
)

echo.
echo ✅ 安装成功！
echo.
echo   Host 名称:   %HOST_NAME%
echo   Host 脚本:   %HOST_PATH%
echo   启动包装器: %BAT_WRAPPER%
echo   Python:      %PYTHON_PATH%
echo   Manifest:    %MANIFEST_PATH%
echo   扩展 ID:     %EXTENSION_ID%
echo.
echo 正在执行安装后自检...
echo.

%PYTHON_CMD% "%HOST_PATH%" --self-check
if errorlevel 1 (
    echo.
    echo ⚠️ 安装已写入，但自检未通过。请根据上面的检查结果修复后重试。
    echo.
    pause
    exit /b 1
)

echo.
echo 请重新加载 Chrome 扩展使配置生效。
echo.
pause
