#!/usr/bin/env python3
"""
Workspace Tags - Native Messaging Host
用于读取本地目录下的文件列表，通过 Chrome Native Messaging 协议与扩展通信。
"""

import json
import os
import struct
import sys


def read_message():
    """从 stdin 读取 Chrome Native Messaging 格式的消息"""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        sys.exit(0)
    message_length = struct.unpack('=I', raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode('utf-8')
    return json.loads(message)


def send_message(message):
    """向 stdout 写入 Chrome Native Messaging 格式的消息"""
    encoded = json.dumps(message, ensure_ascii=False).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def list_directory(dir_path):
    """
    递归遍历目录，返回所有文件的相对路径列表。
    格式与 webkitRelativePath 一致: "rootDir/subDir/file.txt"
    """
    dir_path = os.path.expanduser(dir_path)
    dir_path = os.path.abspath(dir_path)

    if not os.path.isdir(dir_path):
        return {"error": f"路径不存在或不是目录: {dir_path}"}

    root_name = os.path.basename(dir_path)
    files = []
    
    try:
        for dirpath, dirnames, filenames in os.walk(dir_path):
            # 跳过隐藏目录
            dirnames[:] = [d for d in dirnames if not d.startswith('.')]
            
            for filename in filenames:
                # 跳过隐藏文件
                if filename.startswith('.'):
                    continue
                
                full_path = os.path.join(dirpath, filename)
                # 计算相对于父目录的路径（包含根目录名）
                rel_path = os.path.relpath(full_path, os.path.dirname(dir_path))
                # 统一使用 / 分隔
                rel_path = rel_path.replace(os.sep, '/')
                files.append(rel_path)
    except PermissionError as e:
        return {"error": f"权限不足: {str(e)}"}
    except Exception as e:
        return {"error": f"读取目录出错: {str(e)}"}

    return {"files": files, "rootName": root_name, "totalCount": len(files)}


def list_directory_paged(dir_path, page=0, page_size=5000):
    """
    分页版目录遍历。先完整扫描，然后按页返回文件列表。
    每页最多 page_size 个文件，确保单条消息不超过 Chrome 1MB 限制。
    返回: {files, rootName, totalCount, page, totalPages, absolutePath}
    """
    dir_path = os.path.expanduser(dir_path)
    dir_path = os.path.abspath(dir_path)

    if not os.path.isdir(dir_path):
        return {"error": f"路径不存在或不是目录: {dir_path}"}

    root_name = os.path.basename(dir_path)
    all_files = []

    try:
        for dp, dirnames, filenames in os.walk(dir_path):
            dirnames[:] = [d for d in dirnames if not d.startswith('.')]
            for filename in filenames:
                if filename.startswith('.'):
                    continue
                full_path = os.path.join(dp, filename)
                rel_path = os.path.relpath(full_path, os.path.dirname(dir_path))
                rel_path = rel_path.replace(os.sep, '/')
                all_files.append(rel_path)
    except PermissionError as e:
        return {"error": f"权限不足: {str(e)}"}
    except Exception as e:
        return {"error": f"读取目录出错: {str(e)}"}

    total_count = len(all_files)
    total_pages = max(1, (total_count + page_size - 1) // page_size)
    page = max(0, min(page, total_pages - 1))
    start = page * page_size
    end = min(start + page_size, total_count)

    return {
        "files": all_files[start:end],
        "rootName": root_name,
        "totalCount": total_count,
        "page": page,
        "totalPages": total_pages,
        "absolutePath": dir_path,
    }


def open_file(file_path):
    """用系统默认程序打开文件"""
    import subprocess
    import platform

    file_path = os.path.expanduser(file_path)
    file_path = os.path.abspath(file_path)

    if not os.path.exists(file_path):
        return {"error": f"文件不存在: {file_path}"}

    try:
        system = platform.system()
        if system == 'Darwin':
            subprocess.Popen(['open', file_path])
        elif system == 'Windows':
            os.startfile(file_path)
        else:
            subprocess.Popen(['xdg-open', file_path])
        return {"success": True, "path": file_path}
    except Exception as e:
        return {"error": f"打开文件失败: {str(e)}"}


def is_app_running(app_name):
    """检查指定应用是否正在运行（跨平台）"""
    import subprocess
    import platform

    system = platform.system()

    if system == 'Windows':
        try:
            # Windows: 使用 tasklist 查找进程
            result = subprocess.run(
                ['tasklist', '/FI', f'IMAGENAME eq {app_name}.exe', '/NH'],
                capture_output=True, text=True, timeout=5,
                creationflags=0x08000000  # CREATE_NO_WINDOW
            )
            return app_name.lower() in result.stdout.lower()
        except Exception:
            return False

    elif system == 'Darwin':
        try:
            result = subprocess.run(
                ['pgrep', '-ix', app_name],
                capture_output=True, text=True, timeout=3
            )
            return result.returncode == 0
        except Exception:
            pass
        # pgrep 对带空格的应用名不太好用，用 osascript 兜底
        try:
            result = subprocess.run(
                ['osascript', '-e', f'tell application "System Events" to (name of processes) contains "{app_name}"'],
                capture_output=True, text=True, timeout=5
            )
            return 'true' in result.stdout.strip().lower()
        except Exception:
            return False

    else:
        # Linux
        try:
            result = subprocess.run(
                ['pgrep', '-ix', app_name],
                capture_output=True, text=True, timeout=3
            )
            return result.returncode == 0
        except Exception:
            return False


def open_file_with(file_path, app):
    """用指定程序打开文件，对编辑器类应用做智能窗口处理"""
    import subprocess
    import platform

    file_path = os.path.expanduser(file_path)
    file_path = os.path.abspath(file_path)

    if not os.path.exists(file_path):
        return {"error": f"文件不存在: {file_path}"}

    try:
        system = platform.system()
        if system == 'Darwin':
            app_lower = app.lower()

            # Sublime Text: 已打开则在当前窗口，否则新窗口
            if 'sublime' in app_lower:
                running = is_app_running('Sublime Text')
                subl_path = '/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl'
                if os.path.exists(subl_path):
                    if running:
                        # 已运行：在当前窗口中打开文件（不带 -n）
                        subprocess.Popen([subl_path, file_path])
                    else:
                        # 未运行：启动新窗口打开
                        subprocess.Popen([subl_path, '-n', file_path])
                else:
                    # subl 命令不存在，回退到 open -a
                    subprocess.Popen(['open', '-a', app, file_path])
                return {"success": True, "path": file_path, "app": app, "reused_window": running if os.path.exists(subl_path) else None}

            # VS Code: 已打开则在当前窗口（-r），否则新窗口
            elif 'visual studio code' in app_lower or app_lower == 'code':
                running = is_app_running('Electron') or is_app_running('Code')
                code_path = '/usr/local/bin/code'
                if not os.path.exists(code_path):
                    # 尝试其他可能的路径
                    for p in ['/opt/homebrew/bin/code', os.path.expanduser('~/bin/code')]:
                        if os.path.exists(p):
                            code_path = p
                            break
                if os.path.exists(code_path):
                    if running:
                        subprocess.Popen([code_path, '-r', file_path])
                    else:
                        subprocess.Popen([code_path, file_path])
                else:
                    subprocess.Popen(['open', '-a', app, file_path])
                return {"success": True, "path": file_path, "app": app, "reused_window": running if os.path.exists(code_path) else None}

            # Cursor: 类似 VS Code
            elif 'cursor' in app_lower:
                running = is_app_running('Cursor')
                cursor_path = '/usr/local/bin/cursor'
                if not os.path.exists(cursor_path):
                    for p in ['/opt/homebrew/bin/cursor', os.path.expanduser('~/bin/cursor')]:
                        if os.path.exists(p):
                            cursor_path = p
                            break
                if os.path.exists(cursor_path):
                    if running:
                        subprocess.Popen([cursor_path, '-r', file_path])
                    else:
                        subprocess.Popen([cursor_path, file_path])
                else:
                    subprocess.Popen(['open', '-a', app, file_path])
                return {"success": True, "path": file_path, "app": app, "reused_window": running if os.path.exists(cursor_path) else None}

            else:
                # 其他应用直接用 open -a
                subprocess.Popen(['open', '-a', app, file_path])

        elif system == 'Windows':
            app_lower = app.lower()

            # VS Code: 查找 code.cmd 并支持窗口复用
            if 'visual studio code' in app_lower or app_lower == 'code':
                code_paths = [
                    os.path.expandvars(r'%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd'),
                    os.path.expandvars(r'%ProgramFiles%\Microsoft VS Code\bin\code.cmd'),
                    os.path.expandvars(r'%ProgramFiles(x86)%\Microsoft VS Code\bin\code.cmd'),
                ]
                code_path = None
                for p in code_paths:
                    if os.path.exists(p):
                        code_path = p
                        break
                if code_path:
                    running = is_app_running('Code')
                    if running:
                        subprocess.Popen([code_path, '-r', file_path], shell=True)
                    else:
                        subprocess.Popen([code_path, file_path], shell=True)
                    return {"success": True, "path": file_path, "app": app, "reused_window": running}
                else:
                    # 尝试 code 命令（可能在 PATH 中）
                    try:
                        running = is_app_running('Code')
                        args = ['code']
                        if running:
                            args.append('-r')
                        args.append(file_path)
                        subprocess.Popen(args, shell=True)
                        return {"success": True, "path": file_path, "app": app}
                    except Exception:
                        pass

            # Cursor: 类似 VS Code
            elif 'cursor' in app_lower:
                cursor_paths = [
                    os.path.expandvars(r'%LOCALAPPDATA%\Programs\cursor\resources\app\bin\cursor.cmd'),
                    os.path.expandvars(r'%LOCALAPPDATA%\cursor\cursor.exe'),
                ]
                cursor_path = None
                for p in cursor_paths:
                    if os.path.exists(p):
                        cursor_path = p
                        break
                if cursor_path:
                    running = is_app_running('Cursor')
                    if running:
                        subprocess.Popen([cursor_path, '-r', file_path], shell=True)
                    else:
                        subprocess.Popen([cursor_path, file_path], shell=True)
                    return {"success": True, "path": file_path, "app": app, "reused_window": running}

            # Sublime Text
            elif 'sublime' in app_lower:
                subl_paths = [
                    os.path.expandvars(r'%ProgramFiles%\Sublime Text\subl.exe'),
                    os.path.expandvars(r'%ProgramFiles%\Sublime Text 3\subl.exe'),
                    os.path.expandvars(r'%ProgramFiles(x86)%\Sublime Text\subl.exe'),
                ]
                subl_path = None
                for p in subl_paths:
                    if os.path.exists(p):
                        subl_path = p
                        break
                if subl_path:
                    running = is_app_running('sublime_text')
                    if running:
                        subprocess.Popen([subl_path, file_path])
                    else:
                        subprocess.Popen([subl_path, '-n', file_path])
                    return {"success": True, "path": file_path, "app": app, "reused_window": running}

            # Notepad++
            elif 'notepad++' in app_lower:
                npp_paths = [
                    os.path.expandvars(r'%ProgramFiles%\Notepad++\notepad++.exe'),
                    os.path.expandvars(r'%ProgramFiles(x86)%\Notepad++\notepad++.exe'),
                ]
                npp_path = None
                for p in npp_paths:
                    if os.path.exists(p):
                        npp_path = p
                        break
                if npp_path:
                    subprocess.Popen([npp_path, file_path])
                    return {"success": True, "path": file_path, "app": app}

            # 通用回退: 尝试直接用应用名执行，或使用 os.startfile
            try:
                subprocess.Popen([app, file_path], shell=True)
            except Exception:
                os.startfile(file_path)
        else:
            subprocess.Popen([app, file_path])
        return {"success": True, "path": file_path, "app": app}
    except Exception as e:
        return {"error": f"使用 {app} 打开文件失败: {str(e)}"}


def open_terminal_at(dir_path, app=''):
    """在指定目录打开终端应用"""
    import subprocess
    import platform

    dir_path = os.path.expanduser(dir_path)
    dir_path = os.path.abspath(dir_path)

    if not os.path.exists(dir_path):
        return {"error": f"目录不存在: {dir_path}"}

    # 如果传入的是文件路径，取其所在目录
    if os.path.isfile(dir_path):
        dir_path = os.path.dirname(dir_path)

    system = platform.system()

    # 未指定终端应用时，根据平台选择默认值
    if not app:
        if system == 'Darwin':
            app = 'Terminal'
        elif system == 'Windows':
            app = 'cmd'
        else:
            app = 'x-terminal-emulator'

    try:
        system = platform.system()
        if system == 'Darwin':
            app_lower = app.lower()

            if 'iterm' in app_lower:
                # iTerm2: 使用 AppleScript 在新标签或新窗口中打开
                escaped_path = dir_path.replace('"', '\\"')
                script = f'''
                tell application "iTerm"
                    activate
                    try
                        set w to current window
                        tell w
                            create tab with default profile
                            tell current session of current tab
                                write text "cd {escaped_path}"
                            end tell
                        end tell
                    on error
                        create window with default profile
                        tell current session of current window
                            write text "cd {escaped_path}"
                        end tell
                    end try
                end tell
                '''
                subprocess.Popen(['osascript', '-e', script])
                return {"success": True, "path": dir_path, "app": "iTerm2"}

            elif 'termius' in app_lower:
                # Termius: 直接启动应用（Termius 不支持直接打开本地目录）
                subprocess.Popen(['open', '-a', 'Termius'])
                return {"success": True, "path": dir_path, "app": "Termius", "note": "Termius 不支持直接打开本地目录"}

            elif 'warp' in app_lower:
                # Warp 终端
                subprocess.Popen(['open', '-a', 'Warp', dir_path])
                return {"success": True, "path": dir_path, "app": "Warp"}

            elif 'alacritty' in app_lower:
                # Alacritty
                subprocess.Popen(['open', '-a', 'Alacritty', '--args', '--working-directory', dir_path])
                return {"success": True, "path": dir_path, "app": "Alacritty"}

            elif 'kitty' in app_lower:
                # Kitty
                subprocess.Popen(['open', '-a', 'kitty', '--args', '--directory', dir_path])
                return {"success": True, "path": dir_path, "app": "Kitty"}

            elif 'xterminal' in app_lower or 'x-terminal' in app_lower:
                # XTerminal
                subprocess.Popen(['open', '-a', 'XTerminal'])
                return {"success": True, "path": dir_path, "app": "XTerminal"}

            else:
                # 默认 Terminal.app：使用 AppleScript 在新标签中 cd 到目录
                escaped_path = dir_path.replace('"', '\\"')
                script = f'''
                tell application "Terminal"
                    activate
                    if (count of windows) > 0 then
                        tell application "System Events" to keystroke "t" using command down
                        delay 0.3
                        do script "cd {escaped_path}" in front window
                    else
                        do script "cd {escaped_path}"
                    end if
                end tell
                '''
                subprocess.Popen(['osascript', '-e', script])
                return {"success": True, "path": dir_path, "app": "Terminal"}

        elif system == 'Windows':
            app_lower = app.lower()
            # Windows Terminal
            if 'windows terminal' in app_lower or app_lower == 'wt':
                subprocess.Popen(['wt', '-d', dir_path])
            # PowerShell
            elif 'powershell' in app_lower:
                subprocess.Popen(['powershell', '-NoExit', '-Command', f'cd "{dir_path}"'])
            # Git Bash
            elif 'git bash' in app_lower or 'git-bash' in app_lower:
                git_bash_paths = [
                    os.path.expandvars(r'%ProgramFiles%\Git\git-bash.exe'),
                    os.path.expandvars(r'%ProgramFiles(x86)%\Git\git-bash.exe'),
                ]
                for p in git_bash_paths:
                    if os.path.exists(p):
                        subprocess.Popen([p, f'--cd={dir_path}'])
                        break
                else:
                    subprocess.Popen(['cmd', '/K', f'cd /d "{dir_path}"'])
            # CMD（默认）
            else:
                subprocess.Popen(['cmd', '/K', f'cd /d "{dir_path}"'])
            return {"success": True, "path": dir_path, "app": app}

        else:
            # Linux
            subprocess.Popen(['x-terminal-emulator', '--working-directory', dir_path])
            return {"success": True, "path": dir_path, "app": "terminal"}

    except Exception as e:
        return {"error": f"打开终端失败: {str(e)}"}


def read_text_file(file_path, max_size=1024 * 1024):
    """读取文本文件内容（限制 1MB）"""
    file_path = os.path.expanduser(file_path)
    file_path = os.path.abspath(file_path)

    if not os.path.exists(file_path):
        return {"error": f"文件不存在: {file_path}"}

    if not os.path.isfile(file_path):
        return {"error": f"不是文件: {file_path}"}

    size = os.path.getsize(file_path)
    if size > max_size:
        return {"error": f"文件过大 ({size} bytes)，最大支持 {max_size} bytes", "size": size}

    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
        return {"content": content, "size": size, "path": file_path}
    except Exception as e:
        return {"error": f"读取文件失败: {str(e)}"}


def reveal_in_finder(file_path):
    """在 Finder/文件管理器中打开指定目录（或文件所在目录）"""
    import subprocess
    import platform

    file_path = os.path.expanduser(file_path)
    file_path = os.path.abspath(file_path)

    # 判断路径类型：如果是文件则取其所在目录，如果是目录则直接使用
    if os.path.isfile(file_path):
        dir_path = os.path.dirname(file_path)
    elif os.path.isdir(file_path):
        dir_path = file_path
    else:
        # 路径不存在 —— 直接使用传入的路径（让下面的检查来报错）
        dir_path = file_path

    if not os.path.exists(dir_path):
        return {"error": f"目录不存在: {dir_path}"}

    try:
        system = platform.system()
        if system == 'Darwin':
            subprocess.Popen(['open', dir_path])
        elif system == 'Windows':
            subprocess.Popen(['explorer', dir_path])
        else:
            subprocess.Popen(['xdg-open', dir_path])
        return {"success": True, "path": file_path}
    except Exception as e:
        return {"error": f"打开失败: {str(e)}"}


def choose_directory():
    """
    调用系统原生目录选择对话框，返回用户选择的目录的绝对路径。
    macOS: 先尝试 osascript，再回退到 tkinter 独立进程。
    注意：Native Host 是 Chrome 的无 GUI 子进程，需要特殊处理。
    """
    import subprocess
    import platform
    import tempfile

    system = platform.system()

    try:
        if system == 'Darwin':
            # 方案1: 使用 osascript 弹出目录选择
            try:
                script = 'set chosenFolder to choose folder with prompt "选择要导入的目录"\nreturn POSIX path of chosenFolder'
                result = subprocess.run(
                    ['osascript', '-e', script],
                    capture_output=True, text=True, timeout=120
                )
                if result.returncode == 0:
                    chosen_path = result.stdout.strip()
                    if chosen_path.endswith('/') and len(chosen_path) > 1:
                        chosen_path = chosen_path[:-1]
                    return {"path": chosen_path}
                # 用户取消返回 -128 错误
                if '-128' in result.stderr:
                    return {"cancelled": True}
            except Exception:
                pass

            # 方案2: 使用独立 Python 进程 + tkinter
            try:
                picker_script = '''#!/usr/bin/env python3
import tkinter as tk
from tkinter import filedialog
root = tk.Tk()
root.withdraw()
root.lift()
root.attributes('-topmost', True)
root.after(100, lambda: root.focus_force())
root.update()
path = filedialog.askdirectory(title="选择要导入的目录")
root.destroy()
if path:
    print(path)
else:
    print("__CANCELLED__")
'''
                with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
                    f.write(picker_script)
                    tmp_script = f.name

                os.chmod(tmp_script, 0o755)
                result = subprocess.run(
                    [sys.executable, tmp_script],
                    capture_output=True, text=True, timeout=120
                )
                os.unlink(tmp_script)

                if result.returncode == 0:
                    chosen_path = result.stdout.strip()
                    if not chosen_path or chosen_path == '__CANCELLED__':
                        return {"cancelled": True}
                    if chosen_path.endswith('/') and len(chosen_path) > 1:
                        chosen_path = chosen_path[:-1]
                    return {"path": chosen_path}
            except Exception:
                pass

            # 方案3: 使用 open 命令启动独立 GUI 进程 + 通过临时文件传递结果
            try:
                result_file = tempfile.mktemp(suffix='.txt')
                picker_script = f'''#!/usr/bin/env python3
import tkinter as tk
from tkinter import filedialog
root = tk.Tk()
root.withdraw()
root.lift()
root.attributes('-topmost', True)
root.after(100, lambda: root.focus_force())
root.update()
path = filedialog.askdirectory(title="选择要导入的目录")
root.destroy()
with open("{result_file}", "w") as f:
    f.write(path if path else "__CANCELLED__")
'''
                with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
                    f.write(picker_script)
                    tmp_script = f.name

                os.chmod(tmp_script, 0o755)
                # 使用 open 命令在独立进程中运行（获得 GUI 权限）
                subprocess.run(
                    ['open', '-W', '-a', 'Python Launcher', tmp_script],
                    capture_output=True, timeout=120
                )
                # 如果 Python Launcher 不可用，直接运行
                if not os.path.exists(result_file):
                    subprocess.run(
                        [sys.executable, tmp_script],
                        capture_output=True, timeout=120
                    )

                os.unlink(tmp_script)

                if os.path.exists(result_file):
                    with open(result_file, 'r') as f:
                        chosen_path = f.read().strip()
                    os.unlink(result_file)
                    if not chosen_path or chosen_path == '__CANCELLED__':
                        return {"cancelled": True}
                    if chosen_path.endswith('/') and len(chosen_path) > 1:
                        chosen_path = chosen_path[:-1]
                    return {"path": chosen_path}
            except Exception:
                pass

            return {"error": "无法弹出目录选择对话框，请使用手动输入路径方式"}

        elif system == 'Windows':
            # Windows: 使用独立子进程运行 tkinter（Native Host 是无 GUI 子进程）
            try:
                picker_script = '''import tkinter as tk
from tkinter import filedialog
root = tk.Tk()
root.withdraw()
root.attributes('-topmost', True)
root.update()
path = filedialog.askdirectory(title="选择要导入的目录")
root.destroy()
if path:
    print(path)
else:
    print("__CANCELLED__")
'''
                with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False, encoding='utf-8') as f:
                    f.write(picker_script)
                    tmp_script = f.name

                result = subprocess.run(
                    [sys.executable, tmp_script],
                    capture_output=True, text=True, timeout=120
                )
                os.unlink(tmp_script)

                if result.returncode == 0:
                    chosen_path = result.stdout.strip()
                    if not chosen_path or chosen_path == '__CANCELLED__':
                        return {"cancelled": True}
                    # tkinter 返回的路径是 / 分隔的，转换为原生 Windows 路径
                    chosen_path = chosen_path.replace('/', '\\')
                    if chosen_path.endswith('\\') and len(chosen_path) > 3:
                        chosen_path = chosen_path.rstrip('\\')
                    return {"path": chosen_path}
                else:
                    return {"error": f"目录选择失败: {result.stderr.strip()}"}
            except Exception as e:
                return {"error": f"选择目录失败: {str(e)}"}

        else:
            # Linux: 使用 zenity
            result = subprocess.run(
                ['zenity', '--file-selection', '--directory', '--title=选择目录'],
                capture_output=True, text=True, timeout=120
            )
            if result.returncode != 0:
                return {"cancelled": True}
            chosen_path = result.stdout.strip()
            return {"path": chosen_path}

    except subprocess.TimeoutExpired:
        return {"error": "选择超时"}
    except FileNotFoundError as e:
        return {"error": f"系统对话框不可用: {str(e)}"}
    except Exception as e:
        return {"error": f"选择目录失败: {str(e)}"}


def choose_and_list_directory():
    """
    先弹出系统目录选择对话框让用户选择目录，
    然后读取该目录下的所有文件列表（分页，返回第一页），
    同时返回目录的绝对路径。
    """
    choose_result = choose_directory()
    if 'error' in choose_result or 'cancelled' in choose_result:
        return choose_result

    dir_path = choose_result['path']
    list_result = list_directory_paged(dir_path, page=0)

    if 'error' in list_result:
        return list_result

    return list_result


def get_file_info(file_path):
    """获取单个文件的详细信息（大小、创建时间、修改时间、文件类型等）"""
    import time as _time
    file_path = os.path.expanduser(file_path)
    file_path = os.path.abspath(file_path)

    if not os.path.exists(file_path):
        return {"error": f"文件不存在: {file_path}"}

    try:
        stat = os.stat(file_path)
        is_dir = os.path.isdir(file_path)

        # 文件大小（字节）
        size = stat.st_size

        # 修改时间（Unix 时间戳，毫秒）
        modified_time = int(stat.st_mtime * 1000)

        # 创建时间（macOS 用 st_birthtime，Linux 用 st_ctime）
        try:
            created_time = int(stat.st_birthtime * 1000)
        except AttributeError:
            created_time = int(stat.st_ctime * 1000)

        # 最后访问时间
        accessed_time = int(stat.st_atime * 1000)

        # 文件类型判断
        if is_dir:
            file_type = 'directory'
        else:
            _, ext = os.path.splitext(file_path)
            file_type = ext.lstrip('.').lower() if ext else 'unknown'

        # 文件权限（八进制）
        permissions = oct(stat.st_mode)[-3:]

        return {
            "path": file_path,
            "size": size,
            "createdTime": created_time,
            "modifiedTime": modified_time,
            "accessedTime": accessed_time,
            "fileType": file_type,
            "isDirectory": is_dir,
            "permissions": permissions,
        }
    except Exception as e:
        return {"error": f"获取文件信息失败: {str(e)}", "path": file_path}


def batch_get_file_info(paths):
    """批量获取多个文件的详细信息"""
    results = {}
    for p in paths:
        info = get_file_info(p)
        results[p] = info
    return {"files": results}


def rename_file(old_path, new_name):
    """重命名本地文件（仅修改文件名，不移动目录）"""
    old_path = os.path.expanduser(old_path)
    old_path = os.path.abspath(old_path)

    if not os.path.exists(old_path):
        return {"error": f"文件不存在: {old_path}"}

    # 新文件名不能包含路径分隔符
    if '/' in new_name or '\\' in new_name:
        return {"error": "文件名不能包含路径分隔符"}

    if not new_name or not new_name.strip():
        return {"error": "文件名不能为空"}

    dir_path = os.path.dirname(old_path)
    new_path = os.path.join(dir_path, new_name)

    if os.path.exists(new_path):
        return {"error": f"目标文件已存在: {new_path}"}

    try:
        os.rename(old_path, new_path)
        return {
            "success": True,
            "oldPath": old_path,
            "newPath": new_path,
            "newName": new_name,
        }
    except PermissionError:
        return {"error": f"权限不足，无法重命名: {old_path}"}
    except Exception as e:
        return {"error": f"重命名失败: {str(e)}"}


def list_installed_apps():
    """获取已安装的应用列表（跨平台）"""
    import platform

    system = platform.system()
    apps = []

    if system == 'Darwin':
        # macOS: 扫描 .app 目录
        app_dirs = ['/Applications', '/System/Applications', os.path.expanduser('~/Applications')]
        for app_dir in app_dirs:
            if not os.path.exists(app_dir):
                continue
            try:
                for root, dirs, files in os.walk(app_dir):
                    for d in dirs:
                        if d.endswith('.app'):
                            app_name = d[:-4]  # 去掉 .app 后缀
                            app_path = os.path.join(root, d)
                            apps.append({'name': app_name, 'path': app_path})
                    # 不递归进入 .app 包内部
                    dirs[:] = [d for d in dirs if not d.endswith('.app')]
            except Exception:
                pass

    elif system == 'Windows':
        # Windows: 扫描 Start Menu 快捷方式和 Program Files
        import glob

        # 从开始菜单获取应用
        start_menu_dirs = [
            os.path.expandvars(r'%ProgramData%\Microsoft\Windows\Start Menu\Programs'),
            os.path.expandvars(r'%APPDATA%\Microsoft\Windows\Start Menu\Programs'),
        ]
        for menu_dir in start_menu_dirs:
            if not os.path.exists(menu_dir):
                continue
            try:
                for lnk_file in glob.glob(os.path.join(menu_dir, '**', '*.lnk'), recursive=True):
                    app_name = os.path.splitext(os.path.basename(lnk_file))[0]
                    # 过滤掉卸载程序等
                    if any(kw in app_name.lower() for kw in ['uninstall', '卸载', 'readme', 'help', 'license']):
                        continue
                    apps.append({'name': app_name, 'path': lnk_file})
            except Exception:
                pass

        # 扫描 Program Files 中的 .exe 文件（仅顶层）
        program_dirs = [
            os.path.expandvars(r'%ProgramFiles%'),
            os.path.expandvars(r'%ProgramFiles(x86)%'),
            os.path.expandvars(r'%LOCALAPPDATA%\Programs'),
        ]
        for prog_dir in program_dirs:
            if not os.path.exists(prog_dir):
                continue
            try:
                for d in os.listdir(prog_dir):
                    full_path = os.path.join(prog_dir, d)
                    if os.path.isdir(full_path):
                        # 查找目录下的 .exe 文件（仅第一层）
                        for f in os.listdir(full_path):
                            if f.lower().endswith('.exe') and not any(kw in f.lower() for kw in ['unins', 'update', 'crash']):
                                app_name = os.path.splitext(f)[0]
                                apps.append({'name': app_name, 'path': os.path.join(full_path, f)})
            except Exception:
                pass

    else:
        # Linux: 扫描 .desktop 文件
        desktop_dirs = [
            '/usr/share/applications',
            '/usr/local/share/applications',
            os.path.expanduser('~/.local/share/applications'),
        ]
        for desktop_dir in desktop_dirs:
            if not os.path.exists(desktop_dir):
                continue
            try:
                for f in os.listdir(desktop_dir):
                    if f.endswith('.desktop'):
                        app_name = os.path.splitext(f)[0]
                        app_path = os.path.join(desktop_dir, f)
                        # 尝试从 .desktop 文件读取 Name
                        try:
                            with open(app_path, 'r', encoding='utf-8', errors='replace') as df:
                                for line in df:
                                    if line.startswith('Name='):
                                        app_name = line.strip().split('=', 1)[1]
                                        break
                        except Exception:
                            pass
                        apps.append({'name': app_name, 'path': app_path})
            except Exception:
                pass

    # 去重并按名称排序
    seen = set()
    unique_apps = []
    for app in apps:
        if app['name'] not in seen:
            seen.add(app['name'])
            unique_apps.append(app)
    unique_apps.sort(key=lambda a: a['name'].lower())
    return {'apps': unique_apps}


def main():
    while True:
        try:
            message = read_message()
        except Exception:
            break

        action = message.get('action', '')

        if action == 'listDir':
            dir_path = message.get('path', '')
            result = list_directory(dir_path)
            send_message(result)
        elif action == 'listDirPaged':
            dir_path = message.get('path', '')
            page = message.get('page', 0)
            result = list_directory_paged(dir_path, page=page)
            send_message(result)
        elif action == 'chooseDirectory':
            # 弹出系统原生目录选择对话框
            result = choose_directory()
            send_message(result)
        elif action == 'chooseAndListDir':
            # 弹出目录选择 + 列出文件
            result = choose_and_list_directory()
            send_message(result)
        elif action == 'openFile':
            file_path = message.get('path', '')
            app = message.get('app', '')
            if app:
                result = open_file_with(file_path, app)
            else:
                result = open_file(file_path)
            send_message(result)
        elif action == 'readFile':
            file_path = message.get('path', '')
            result = read_text_file(file_path)
            send_message(result)
        elif action == 'revealInFinder':
            file_path = message.get('path', '')
            result = reveal_in_finder(file_path)
            send_message(result)
        elif action == 'ping':
            send_message({"status": "ok", "version": "1.0.0"})
        elif action == 'listApps':
            result = list_installed_apps()
            send_message(result)
        elif action == 'openTerminal':
            dir_path = message.get('path', '')
            app = message.get('app', 'Terminal')
            result = open_terminal_at(dir_path, app)
            send_message(result)
        elif action == 'getFileInfo':
            file_path = message.get('path', '')
            result = get_file_info(file_path)
            send_message(result)
        elif action == 'batchGetFileInfo':
            paths = message.get('paths', [])
            result = batch_get_file_info(paths)
            send_message(result)
        elif action == 'renameFile':
            old_path = message.get('oldPath', '')
            new_name = message.get('newName', '')
            result = rename_file(old_path, new_name)
            send_message(result)
        else:
            send_message({"error": f"未知操作: {action}"})


if __name__ == '__main__':
    main()
