import json
import os
import platform
import shutil
import subprocess
import sys
from typing import Dict, List, Literal, Set, TypedDict, cast


CheckStatus = Literal['ok', 'warn', 'error']


class CheckItem(TypedDict):
    status: CheckStatus
    name: str
    message: str


class SelfCheckReport(TypedDict):
    host: str
    version: str
    platform: str
    pythonVersion: str
    pythonExecutable: str
    checks: List[CheckItem]
    ok: bool
    errorCount: int
    warnCount: int


class NativeHostManifest(TypedDict, total=False):
    name: str
    path: str
    allowed_origins: List[str]


STATUS_ICON: Dict[CheckStatus, str] = {
    'ok': 'OK',
    'warn': 'WARN',
    'error': 'ERROR',
}



def _get_manifest_candidates(host_name: str) -> List[str]:
    system = platform.system()
    if system == 'Darwin':
        return [
            os.path.expanduser(f'~/Library/Application Support/Google/Chrome/NativeMessagingHosts/{host_name}.json'),
        ]
    if system == 'Windows':
        return [
            os.path.expandvars(rf'%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts\{host_name}.json'),
        ]
    return [
        os.path.expanduser(f'~/.config/google-chrome/NativeMessagingHosts/{host_name}.json'),
    ]



def _get_expected_host_paths(host_script_path: str) -> Set[str]:
    host_dir = os.path.dirname(host_script_path)
    expected: Set[str] = {os.path.realpath(host_script_path)}
    if platform.system() == 'Windows':
        expected.add(os.path.realpath(os.path.join(host_dir, 'run_host.bat')))
    else:
        expected.add(os.path.realpath(os.path.join(host_dir, 'run_host.sh')))
    return expected



def _is_valid_allowed_origin(value: object) -> bool:
    return isinstance(value, str) and value.startswith('chrome-extension://') and value.endswith('/')



def _is_executable_file(path: str) -> bool:
    if platform.system() == 'Windows':
        return os.path.isfile(path)
    return os.path.isfile(path) and os.access(path, os.X_OK)



def build_self_check_report(host_name: str, host_version: str, host_script_path: str) -> SelfCheckReport:
    report: SelfCheckReport = {
        'host': host_name,
        'version': host_version,
        'platform': platform.platform(),
        'pythonVersion': sys.version.split()[0],
        'pythonExecutable': sys.executable,
        'checks': [],
        'ok': False,
        'errorCount': 0,
        'warnCount': 0,
    }

    def add_check(status: CheckStatus, name: str, message: str) -> None:
        report['checks'].append({
            'status': status,
            'name': name,
            'message': message,
        })

    if sys.version_info >= (3, 8):
        add_check('ok', 'Python 版本', sys.version.split()[0])
    else:
        add_check('error', 'Python 版本', f'当前为 {sys.version.split()[0]}，建议升级到 3.8+')

    if os.path.exists(sys.executable):
        add_check('ok', 'Python 可执行文件', sys.executable)
    else:
        add_check('error', 'Python 可执行文件', f'不存在：{sys.executable}')

    host_script = os.path.realpath(host_script_path)
    if os.path.exists(host_script):
        add_check('ok', 'Host 脚本', host_script)
    else:
        add_check('error', 'Host 脚本', f'不存在：{host_script}')

    wrapper_name = 'run_host.bat' if platform.system() == 'Windows' else 'run_host.sh'
    wrapper_path = os.path.realpath(os.path.join(os.path.dirname(host_script_path), wrapper_name))
    if os.path.exists(wrapper_path):
        add_check('ok', 'Host 启动包装器', wrapper_path)
    else:
        add_check('warn', 'Host 启动包装器', f'不存在：{wrapper_path}')

    manifest_candidates = _get_manifest_candidates(host_name)
    expected_paths = _get_expected_host_paths(host_script_path)
    manifest_found = False

    for manifest_path in manifest_candidates:
        if not os.path.exists(manifest_path):
            continue

        manifest_found = True
        try:
            with open(manifest_path, 'r', encoding='utf-8') as f:
                manifest = cast(NativeHostManifest, json.load(f))
        except Exception as exc:
            add_check('error', 'Chrome Native Host Manifest', f'读取失败：{manifest_path} ({exc})')
            continue

        manifest_name = manifest.get('name', '')
        manifest_host_path = manifest.get('path', '')
        manifest_allowed_origins = manifest.get('allowed_origins', [])

        if not manifest_name:
            add_check('error', 'Chrome Native Host Manifest', f'缺少 name 字段：{manifest_path}')
            continue

        if manifest_name != host_name:
            add_check('warn', 'Chrome Native Host Manifest', f'name 不匹配：{manifest_name}（文件：{manifest_path}）')
            continue

        if not manifest_host_path:
            add_check('error', 'Chrome Native Host Manifest', f'缺少 path 字段：{manifest_path}')
            continue

        if not isinstance(manifest_allowed_origins, list) or not manifest_allowed_origins:
            add_check('error', 'Chrome Native Host Manifest', f'allowed_origins 缺失或为空：{manifest_path}')
            continue

        invalid_origins = [origin for origin in manifest_allowed_origins if not _is_valid_allowed_origin(origin)]
        if invalid_origins:
            add_check('warn', 'Chrome Native Host Manifest', f'allowed_origins 含无效项：{invalid_origins[0]}')

        real_manifest_host_path = os.path.realpath(os.path.expanduser(manifest_host_path))
        if not os.path.exists(real_manifest_host_path):
            add_check('error', 'Chrome Native Host Manifest', f'指向的 Host 不存在：{manifest_host_path}')
            continue

        if real_manifest_host_path not in expected_paths:
            add_check('warn', 'Chrome Native Host Manifest', f'已注册但路径不是当前仓库里的 Host：{manifest_host_path}')
            continue

        if not _is_executable_file(real_manifest_host_path):
            add_check('error', 'Chrome Native Host Manifest', f'指向的 Host 不可执行：{manifest_host_path}')
            continue

        if platform.system() != 'Windows' and real_manifest_host_path == host_script:
            add_check('warn', 'Chrome Native Host Manifest', f'已注册：{manifest_path}（当前仍直接指向 read_dir.py，建议重新执行 install.sh 生成固定 Python 路径的 run_host.sh）')
            continue

        add_check('ok', 'Chrome Native Host Manifest', f'已注册：{manifest_path}（allowed_origins: {len(manifest_allowed_origins)} 项）')

    if not manifest_found:
        add_check('warn', 'Chrome Native Host Manifest', f'未找到注册文件，已检查：{", ".join(manifest_candidates)}')

    system = platform.system()
    if system == 'Darwin':
        for command in ('osascript', 'open', 'pgrep'):
            command_path = shutil.which(command)
            if command_path:
                add_check('ok', f'系统命令 {command}', command_path)
            else:
                add_check('warn', f'系统命令 {command}', '未找到，部分系统能力可能不可用')
    elif system == 'Windows':
        try:
            import tkinter as _tkinter
            add_check('ok', 'tkinter', f'可用（{_tkinter.__name__}）')
        except Exception as exc:
            add_check('warn', 'tkinter', f'不可用：{exc}')

        try:
            result = subprocess.run(
                ['reg', 'query', rf'HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\{host_name}', '/ve'],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                add_check('ok', 'Windows 注册表', '已找到 Native Host 注册表项')
            else:
                add_check('warn', 'Windows 注册表', '未找到 Native Host 注册表项')
        except Exception as exc:
            add_check('warn', 'Windows 注册表', f'检查失败：{exc}')
    else:
        for command, friendly_name in (
            ('zenity', '系统文件选择对话框'),
            ('xdg-open', '系统默认打开命令'),
            ('x-terminal-emulator', '终端启动命令'),
            ('pgrep', '进程检测命令'),
        ):
            command_path = shutil.which(command)
            if command_path:
                add_check('ok', friendly_name, command_path)
            else:
                add_check('warn', friendly_name, f'未找到命令 {command}')

    error_count = sum(1 for item in report['checks'] if item['status'] == 'error')
    warn_count = sum(1 for item in report['checks'] if item['status'] == 'warn')
    report['ok'] = error_count == 0
    report['errorCount'] = error_count
    report['warnCount'] = warn_count
    return report



def print_self_check_report(report: SelfCheckReport) -> None:
    print('Workspace Tags Native Host self-check')
    print(f"- Host: {report['host']}")
    print(f"- Version: {report['version']}")
    print(f"- Platform: {report['platform']}")
    print(f"- Python: {report['pythonVersion']} ({report['pythonExecutable']})")
    print('')

    for item in report['checks']:
        print(f"[{STATUS_ICON[item['status']]}] {item['name']}: {item['message']}")

    print('')
    print(f"Summary: {len(report['checks'])} checks, {report['warnCount']} warning(s), {report['errorCount']} error(s)")
