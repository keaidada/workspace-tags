# Workspace Tags - 文件标签管理器

一个 Chrome 浏览器插件，**替换新标签页为全屏文件管理界面**，支持标签分类、时间排序和筛选功能。

## 📸 界面预览

![Workspace Tags 界面预览](screenshots/preview.png)

## ✨ 功能特性

- 📁 **文件管理**：添加文件引用，支持拖拽添加
- 🏷️ **标签系统**：为文件添加自定义标签（如 Hadoop、HBase、TE）
- 📅 **时间排序**：按文件添加时间排序，支持正序/倒序一键切换
- 🔍 **搜索过滤**：支持按文件名、路径、标签搜索
- 🎯 **标签筛选**：左侧边栏标签导航，点击快速筛选
- 📊 **日期分组**：文件按日期自动分组显示（今天、昨天、具体日期）
- ⌨️ **快捷键**：`Ctrl+N` 添加文件，`Ctrl+F` 聚焦搜索
- 💾 **数据持久化**：所有数据保存在 Chrome 本地存储中

## 📦 安装方式

1. 打开 Chrome 浏览器，访问 `chrome://extensions/`
2. 开启右上角的 **"开发者模式"**
3. 点击 **"加载已解压的扩展程序"**
4. 选择本项目文件夹 `workspace-tags`
5. 打开一个新标签页，即可看到全屏的文件标签管理器

### 🔧 安装 Native Host（可选，用于手动输入路径读取目录）

如果需要通过**手动输入路径**来导入目录文件（而不是通过文件选择器），需要安装 Native Messaging Host：

1. 确保已安装 **Python 3.8+**
2. 在 `chrome://extensions/` 页面找到 **Workspace Tags** 扩展的 **ID**（一串字母数字字符串）
3. 运行安装脚本：

   **macOS / Linux：**
   ```bash
   cd workspace-tags/native-host
   bash install.sh <你的扩展ID>
   ```

   **Windows（以管理员身份运行 CMD）：**
   ```cmd
   cd workspace-tags\native-host
   install.bat <你的扩展ID>
   ```

   > Windows 安装脚本会自动完成以下操作：
   > - 查找 Python 路径并生成 `run_host.bat` 启动包装器
   > - 生成 Native Messaging Host 的 JSON manifest 文件到 `%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts\`
   > - 写入注册表 `HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\`

4. 安装完成后建议先执行自检：

   **macOS / Linux：**
   ```bash
   cd workspace-tags/native-host
   bash check.sh
   ```

   **Windows：**
   ```cmd
   cd workspace-tags\native-host
   check.bat
   ```

   如果你想直接走命令行，也可以执行：`python3 read_dir.py --self-check`（Windows 用 `python`）。

5. 重新加载 Chrome 扩展

> **注意**：支持 macOS、Windows 和 Linux。Native Host 用于让扩展能够读取指定路径下的文件列表、打开文件、在终端中打开目录、重命名文件等。
>
> **调试日志**：如需查看 Host 详细执行日志，可临时设置环境变量 `WORKSPACE_TAGS_HOST_DEBUG=1` 后再运行 Chrome / 安装流程。

### 🩺 Native Host 排障

- **先跑自检**：`python3 native-host/read_dir.py --self-check`（Windows 用 `python`）
- **看是否已注册**：自检里会检查 Chrome Native Host manifest 是否存在、是否指向当前仓库里的 `read_dir.py` / `run_host.bat`
- **Linux 无法弹系统选择框**：通常是缺少 `zenity`
- **macOS 无法弹系统选择框**：优先检查 `osascript` 是否可用，再尝试手动输入路径模式
- **Windows 无法弹选择框**：通常与 `tkinter` 不可用或 Python 安装不完整有关
- **扩展提示 Native Host 未安装**：重新执行 `install.sh` / `install.bat` 后，再刷新扩展页面

## 🚀 使用指南

### 添加文件
- 点击顶部工具栏 **"添加文件"** 按钮（或 `Ctrl+N`）
- 输入文件名、路径、标签后确认
- 也可以直接拖拽文件到主内容区域

### 管理标签
- 左侧边栏显示所有标签，点击可筛选
- 点击侧边栏 "管理" 旁的 "+" 按钮创建/删除标签
- 文件卡片悬停时，点击标签图标为文件添加/移除标签

### 排序切换
- 工具栏排序按钮可在 "最新优先" 和 "最早优先" 之间切换

## 🏗️ 项目结构

```
workspace-tags/
├── manifest.json      # Chrome 插件配置（MV3 新标签页覆盖为空白页）
├── blank.html         # 空白新标签页
├── newtab.html        # 文件标签管理器主界面
├── app.js             # 核心逻辑
├── styles.css         # 全屏响应式样式
├── background.js      # 后台脚本（Native Messaging 通信）
├── native-host/       # Native Messaging Host（本地文件读取）
│   ├── read_dir.py    # Host 入口脚本
│   ├── host_common.py # Native Messaging 协议、日志与参数校验
│   ├── host_self_check.py # 自检与环境检查
│   ├── run_host.sh    # 启动包装器 - macOS/Linux（固定 Python 路径）
│   ├── install.sh     # 安装脚本 - macOS/Linux（注册 Native Host）
│   ├── install.bat    # 安装脚本 - Windows（注册 Native Host）
│   ├── check.sh       # 自检脚本 - macOS/Linux
│   └── check.bat      # 自检脚本 - Windows
├── icons/             # 插件图标
└── README.md
```

## ⚙️ 技术栈

- Chrome Extension Manifest V3（`chrome_url_overrides.newtab` 指向空白页）
- 原生 JavaScript（零依赖）
- Chrome Storage API
- CSS Grid / Flexbox 响应式布局

## 📄 License

MIT
