@echo off
chcp 65001 >nul 2>&1
REM Workspace Tags - Native Messaging Host 安装脚本 (Windows)
REM 此脚本将 Native Host 注册到 Chrome 注册表，使扩展能够读取本地文件系统

setlocal enabledelayedexpansion

REM 获取脚本所在目录的绝对路径
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "HOST_PATH=%SCRIPT_DIR%\read_dir.py"
set "HOST_NAME=com.workspace_tags.native_host"

REM 检查 Python 是否可用
where python >nul 2>&1
if %errorlevel% neq 0 (
    where python3 >nul 2>&1
    if %errorlevel% neq 0 (
        echo 错误：未找到 Python。请先安装 Python 3 并确保添加到 PATH。
        pause
        exit /b 1
    )
    set "PYTHON_CMD=python3"
) else (
    set "PYTHON_CMD=python"
)

REM 获取 Python 路径
for /f "tokens=*" %%i in ('where %PYTHON_CMD%') do (
    set "PYTHON_PATH=%%i"
    goto :found_python
)
:found_python

echo ======================================
echo  Workspace Tags - Native Host 安装
echo ======================================
echo.

REM 需要获取扩展 ID
set "EXTENSION_ID=%~1"

if "%EXTENSION_ID%"=="" (
    echo 请先在 Chrome 中加载扩展，然后在 chrome://extensions 页面中
    echo 找到 "Workspace Tags" 扩展的 ID（一串字母数字）。
    echo.
    set /p EXTENSION_ID="请输入扩展 ID: "
)

if "%EXTENSION_ID%"=="" (
    echo 错误：必须提供扩展 ID
    pause
    exit /b 1
)

REM Native Messaging Hosts manifest 目录 (Windows)
set "TARGET_DIR=%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts"
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"

set "MANIFEST_PATH=%TARGET_DIR%\%HOST_NAME%.json"

REM 将路径中的 \ 转义为 \\（JSON 要求）
set "HOST_PATH_ESCAPED=%HOST_PATH:\=\\%"
set "PYTHON_PATH_ESCAPED=%PYTHON_PATH:\=\\%"

REM 生成 Native Messaging manifest（使用 pythonw 作为包装）
REM Windows 下 Native Host 需要通过批处理文件包装 Python 脚本
set "BAT_WRAPPER=%SCRIPT_DIR%\run_host.bat"

REM 创建批处理包装器
(
    echo @echo off
    echo "%PYTHON_PATH%" "%HOST_PATH%" %%*
) > "%BAT_WRAPPER%"

set "BAT_WRAPPER_ESCAPED=%BAT_WRAPPER:\=\\%"

REM 生成 JSON manifest
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

REM 写入注册表
reg add "HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul 2>&1

echo.
echo ✅ 安装成功！
echo.
echo   Host 名称:  %HOST_NAME%
echo   Host 路径:  %HOST_PATH%
echo   Manifest:   %MANIFEST_PATH%
echo   Python:     %PYTHON_PATH%
echo   扩展 ID:    %EXTENSION_ID%
echo.
echo 请重新加载 Chrome 扩展使配置生效。
echo.
pause
