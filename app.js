/**
 * Workspace Tags - 标签管理器核心逻辑
 * 核心概念：标签是一等公民，文件只是关联到标签的映射记录
 * 功能：标签树管理、右键菜单、文件添加（选标签）、标签筛选
 */

// ==========================================
// 数据存储层
// ==========================================

class StorageService {
  static _useChromeStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  static async get(key, defaultVal) {
    if (this._useChromeStorage()) {
      return new Promise((resolve) => {
        chrome.storage.local.get([key], (result) => {
          resolve(result[key] !== undefined ? result[key] : defaultVal);
        });
      });
    }
    try {
      const val = localStorage.getItem('wt_' + key);
      return val !== null ? JSON.parse(val) : defaultVal;
    } catch { return defaultVal; }
  }

  static async set(key, value) {
    if (this._useChromeStorage()) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.set({ [key]: value }, () => {
          if (chrome.runtime.lastError) {
            console.error(`chrome.storage.local.set 失败 (key=${key}):`, chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        });
      });
    }
    localStorage.setItem('wt_' + key, JSON.stringify(value));
  }

  static async getFiles() { return this.get('files', []); }
  static async saveFiles(files) { return this.set('files', files); }
  static async getTags() { return this.get('tags', []); }
  static async saveTags(tags) { return this.set('tags', tags); }
  static async getSortOrder() { return this.get('sortOrder', 'desc'); }
  static async saveSortOrder(v) { return this.set('sortOrder', v); }
}

// ==========================================
// 标签管理器（支持 "/" 分隔的父子层级）
// ==========================================

class TagManager {
  constructor() {
    this.tags = []; // [{name:'Hadoop', color:0}, {name:'Hadoop/配置', color:1}, ...]
  }

  async load() {
    this.tags = await StorageService.getTags();
    this._invalidateChildrenCache();
  }

  async save() {
    await StorageService.saveTags(this.tags);
  }

  /** 添加标签，自动创建所有祖先 */
  async addTag(tagName) {
    const name = tagName.trim();
    if (!name) return null;

    const parts = name.split('/').filter(Boolean);
    let created = null;

    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('/');
      const existing = this.tags.find((t) => t.name === path);
      if (!existing) {
        const tag = { name: path, color: this.tags.length % 8 };
        this.tags.push(tag);
        created = tag;
      } else {
        created = existing;
      }
    }

    await this.save();
    this._invalidateChildrenCache();
    return created;
  }

  /** 批量添加多个标签（只在最后保存一次，适用于大目录导入） */
  async addTagsBatch(tagNames) {
    const existingSet = new Set(this.tags.map((t) => t.name));
    let addedCount = 0;

    for (const tagName of tagNames) {
      const name = tagName.trim();
      if (!name) continue;

      const parts = name.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const path = parts.slice(0, i).join('/');
        if (!existingSet.has(path)) {
          const tag = { name: path, color: this.tags.length % 8 };
          this.tags.push(tag);
          existingSet.add(path);
          addedCount++;
        }
      }
    }

    if (addedCount > 0) {
      await this.save();
      this._invalidateChildrenCache();
    }
    return addedCount;
  }

  /** 删除标签及其所有子标签，返回被删除的标签名列表 */
  async removeTag(tagName) {
    const prefix = tagName + '/';
    const removed = this.tags.filter((t) => t.name === tagName || t.name.startsWith(prefix)).map((t) => t.name);
    this.tags = this.tags.filter((t) => t.name !== tagName && !t.name.startsWith(prefix));
    await this.save();
    this._invalidateChildrenCache();
    return removed;
  }

  /** 重命名标签（及其所有子标签） */
  async renameTag(oldName, newName) {
    const prefix = oldName + '/';
    this.tags.forEach((t) => {
      if (t.name === oldName) {
        t.name = newName;
      } else if (t.name.startsWith(prefix)) {
        t.name = newName + t.name.substring(oldName.length);
      }
    });
    await this.save();
    this._invalidateChildrenCache();
    return { oldName, newName, prefix };
  }

  getTagColor(tagName) {
    if (!this._tagColorMap) {
      this._tagColorMap = new Map();
      for (const t of this.tags) {
        this._tagColorMap.set(t.name, t.color);
      }
    }
    const color = this._tagColorMap.get(tagName);
    return color !== undefined ? color : 0;
  }

  getAllTags() { return this.tags; }

  getRootTags() {
    return this._getCachedChildren('');
  }

  getChildTags(parentName) {
    return this._getCachedChildren(parentName);
  }

  /** 缓存的子标签查找，避免 O(tags²) 的重复遍历 */
  _getCachedChildren(parentName) {
    if (!this._childrenCache) this._buildChildrenCache();
    return this._childrenCache.get(parentName) || [];
  }

  /** 构建子标签缓存（在标签变更时调用 _invalidateChildrenCache 清除） */
  _buildChildrenCache() {
    this._childrenCache = new Map();
    this._childrenCache.set('', []); // root children
    for (const tag of this.tags) {
      const lastSlash = tag.name.lastIndexOf('/');
      const parent = lastSlash === -1 ? '' : tag.name.substring(0, lastSlash);
      if (!this._childrenCache.has(parent)) {
        this._childrenCache.set(parent, []);
      }
      this._childrenCache.get(parent).push(tag);
    }
  }

  /** 标签增删改时清除缓存 */
  _invalidateChildrenCache() {
    this._childrenCache = null;
    this._tagColorMap = null;
  }

  getDisplayName(tagName) {
    const parts = tagName.split('/');
    return parts[parts.length - 1];
  }

  getDepth(tagName) {
    return tagName.split('/').length - 1;
  }

  isDescendantOrSelf(tagName, parentName) {
    return tagName === parentName || tagName.startsWith(parentName + '/');
  }

  exists(tagName) {
    return this.tags.some((t) => t.name === tagName);
  }
}

// ==========================================
// 文件管理器（维护文件与标签的映射关系）
// ==========================================

class FileManager {
  constructor(tagManager) {
    this.files = [];
    this.tagManager = tagManager;
    this._tagFileCountsCache = null;
  }

  /** 文件或标签变更时清除计数缓存 */
  _invalidateCountsCache() {
    this._tagFileCountsCache = null;
  }

  async load() {
    this.files = await StorageService.getFiles();
    this._invalidateCountsCache();
  }

  async save() {
    try {
      await StorageService.saveFiles(this.files);
      this._invalidateCountsCache();
    } catch (err) {
      console.error('保存文件数据失败:', err);
      throw err;
    }
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  static getDateTag() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  /**
   * 添加文件记录（只记录映射关系，不上传真实文件）
   * @param {string} name 文件名
   * @param {string[]} tags 标签列表
   * @returns {object|null}
   */
  async addFileRecord(name, tags, path) {
    // 去重检查：相同文件名 + 完全相同的标签集合 才算重复
    const exists = this.files.some(
      (f) => f.name === name && tags.every((t) => f.tags.includes(t)) && f.tags.length === tags.length
    );
    if (exists) return null;

    const file = {
      id: this.generateId(),
      name,
      addedTime: Date.now(),
      tags: [...tags],
    };
    if (path) file.path = path;

    this.files.push(file);
    await this.save();
    return file;
  }

  /**
   * 批量添加文件记录
   * @param {string[]} names 文件名列表
   * @param {string[]} tags 公共标签列表（每个文件都会附带这些标签）
   */
  async addFileRecords(names, tags) {
    let count = 0;
    for (const name of names) {
      const exists = this.files.some((f) => f.name === name);
      if (exists) continue;

      this.files.push({
        id: this.generateId(),
        name,
        addedTime: Date.now(),
        tags: [...tags],
      });
      count++;
    }
    if (count > 0) await this.save();
    return count;
  }

  /**
   * 批量添加文件记录（每个文件有自己的标签列表）
   * @param {Array<{name: string, tags: string[], path?: string}>} fileEntries [{name, tags, path?}, ...]
   * @param {Function} [onProgress] 进度回调 (processed, total) => void
   */
  async addFileRecordsWithTags(fileEntries, onProgress) {
    // 构建已有文件的快速查找集（优先用 path 去重，其次用 name）
    const existingPaths = new Set();
    const existingNames = new Set();
    for (const f of this.files) {
      if (f.path) {
        existingPaths.add(f.path);
      } else {
        existingNames.add(f.name);
      }
    }

    let count = 0;
    const now = Date.now();
    const total = fileEntries.length;
    const progressInterval = Math.max(1, Math.floor(total / 100)); // 每 1% 回调一次

    for (let i = 0; i < total; i++) {
      const entry = fileEntries[i];
      // 有 path 的用 path 去重（绝对路径唯一）；没有 path 的用 name 去重
      if (entry.path) {
        if (existingPaths.has(entry.path)) continue;
        existingPaths.add(entry.path);
      } else {
        if (existingNames.has(entry.name)) continue;
        existingNames.add(entry.name);
      }

      const file = {
        id: this.generateId(),
        name: entry.name,
        addedTime: now,
        tags: [...entry.tags],
      };
      if (entry.path) file.path = entry.path;

      this.files.push(file);
      count++;

      // 进度回调
      if (onProgress && (i % progressInterval === 0 || i === total - 1)) {
        onProgress(i + 1, total);
      }
    }
    if (count > 0) await this.save();
    return count;
  }

  async removeFile(fileId) {
    this.files = this.files.filter((f) => f.id !== fileId);
    await this.save();
  }

  async addTagToFile(fileId, tagName) {
    const file = this.files.find((f) => f.id === fileId);
    if (!file) return;
    if (!file.tags.includes(tagName)) {
      file.tags.push(tagName);
      await this.save();
    }
  }

  async removeTagFromFile(fileId, tagName) {
    const file = this.files.find((f) => f.id === fileId);
    if (!file) return;
    file.tags = file.tags.filter((t) => t !== tagName);
    await this.save();
  }

  /** 删除标签时从所有文件中移除该标签及其子标签 */
  async removeTagFromAllFiles(tagNames) {
    const nameSet = new Set(tagNames);
    this.files.forEach((file) => {
      file.tags = file.tags.filter((t) => !nameSet.has(t));
    });
    await this.save();
  }

  /** 重命名标签时更新所有文件中的标签名 */
  async renameTagInAllFiles(oldName, newName) {
    const oldPrefix = oldName + '/';
    this.files.forEach((file) => {
      file.tags = file.tags.map((t) => {
        if (t === oldName) return newName;
        if (t.startsWith(oldPrefix)) return newName + t.substring(oldName.length);
        return t;
      });
    });
    await this.save();
  }

  getFilteredFiles(activeTags, filterNoTag, searchQuery, sortOrder, tagDisplayMode, searchTags) {
    let filtered = [...this.files];

    if (filterNoTag) {
      // 根据当前标签显示模式判断"无标签"
      // 自定义模式：没有自定义标签的文件算"无标签"
      // 时间模式：没有时间标签的文件算"无标签"
      const isTimeTag = (t) => /^\d{6,8}$/.test(t.split('/')[0]);
      if (tagDisplayMode === 'time') {
        filtered = filtered.filter((f) => !f.tags || !f.tags.some((t) => isTimeTag(t)));
      } else {
        // custom 模式（默认）
        filtered = filtered.filter((f) => !f.tags || !f.tags.some((t) => !isTimeTag(t)));
      }
    } else if (activeTags && activeTags.size > 0) {
      // 多标签筛选：文件需要匹配任意一个选中的标签（或其子标签）
      filtered = filtered.filter((f) =>
        f.tags.some((t) => {
          for (const tag of activeTags) {
            if (this.tagManager.isDescendantOrSelf(t, tag)) return true;
          }
          return false;
        })
      );
    }

    // 搜索框标签模式筛选（与侧边栏筛选叠加）
    if (searchTags && searchTags.size > 0) {
      filtered = filtered.filter((f) =>
        f.tags.some((t) => {
          for (const tag of searchTags) {
            if (this.tagManager.isDescendantOrSelf(t, tag)) return true;
          }
          return false;
        })
      );
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (f) =>
          f.name.toLowerCase().includes(query) ||
          f.tags.some((t) => t.toLowerCase().includes(query))
      );
    }

    filtered.sort((a, b) => {
      const diff = a.addedTime - b.addedTime;
      return sortOrder === 'asc' ? diff : -diff;
    });

    return filtered;
  }

  getTagFileCounts() {
    if (this._tagFileCountsCache) return this._tagFileCountsCache;
    const counts = new Map();
    // 初始化所有标签计数为 0
    this.tagManager.getAllTags().forEach((tag) => {
      counts.set(tag.name, 0);
    });
    // 单次遍历文件，对每个文件的标签及其所有祖先标签各加 1
    this.files.forEach((f) => {
      if (!f.tags) return;
      // 用 Set 避免同一文件对同一标签重复计数
      const counted = new Set();
      f.tags.forEach((t) => {
        // 对标签本身及所有祖先路径都计数
        const parts = t.split('/');
        for (let i = 1; i <= parts.length; i++) {
          const ancestor = parts.slice(0, i).join('/');
          if (!counted.has(ancestor)) {
            counted.add(ancestor);
            if (counts.has(ancestor)) {
              counts.set(ancestor, counts.get(ancestor) + 1);
            }
          }
        }
      });
    });
    this._tagFileCountsCache = counts;
    return counts;
  }
}

// ==========================================
// UI 控制器
// ==========================================

class UIController {
  constructor() {
    this.tagManager = new TagManager();
    this.fileManager = new FileManager(this.tagManager);
    this.sortOrder = 'desc';
    this.activeTags = new Set(); // 多选标签筛选, 空 = 全部
    this.filterNoTag = false;   // 筛选无标签文件
    this.searchQuery = '';
    this.searchTags = new Set(); // 搜索栏标签筛选（与文件名搜索同时生效）
    this.expandedTags = new Set();

    // 右键菜单上下文
    this.ctxTagName = null;

    // 添加文件弹窗状态
    this.pendingFileNames = [];
    this.selectedTags = new Set();

    // 新建标签弹窗上下文
    this.newTagParent = null; // null = 根标签, 'xxx' = 子标签

    // 重命名
    this.renameTagOld = null;

    // 删除确认
    this.pendingDeleteTag = null;

    // 文件标签管理
    this.editingFileId = null;

    // 文件多选
    this.selectedFiles = new Set();

    // 标签显示模式：'custom' = 自定义标签, 'time' = 时间标签
    this.tagDisplayMode = 'custom';

    // 已安装应用列表缓存（用于模糊搜索）
    this.installedApps = [];

    // 文件详细信息缓存 { path: { size, createdTime, modifiedTime, ... } }
    this.fileInfoCache = {};

    // 分页
    this.currentPage = 1;
    this.pageSize = 500;
  }

  async init() {
    await this.tagManager.load();
    await this.fileManager.load();
    this.sortOrder = await StorageService.getSortOrder();
    this.bindEvents();
    this.render();
    // 异步加载已安装应用列表（不阻塞主流程）
    this.loadInstalledApps();
  }

  /**
   * 异步加载系统已安装应用列表
   */
  async loadInstalledApps() {
    try {
      const result = await this.sendNativeAction('listApps');
      if (result && result.apps) {
        this.installedApps = result.apps;
        console.log(`已加载 ${this.installedApps.length} 个已安装应用`);
      } else {
        console.warn('加载已安装应用列表：返回结果异常', result);
      }
    } catch (err) {
      console.warn('加载已安装应用列表失败:', err);
      // 失败不影响其他功能
    }
  }

  /**
   * 批量获取文件详细信息并更新到 DOM
   */
  async loadFileInfoForVisibleCards() {
    const cards = document.querySelectorAll('.file-card[data-filepath]');
    const pathsToFetch = [];
    cards.forEach((card) => {
      const fp = card.getAttribute('data-filepath');
      if (fp && fp !== '' && !this.fileInfoCache[fp]) {
        pathsToFetch.push(fp);
      }
    });

    if (pathsToFetch.length === 0) {
      // 所有文件已有缓存，直接更新 DOM
      this.updateFileInfoDOM();
      return;
    }

    try {
      const result = await chrome.runtime.sendMessage({
        action: 'batchGetFileInfo',
        paths: pathsToFetch
      });
      if (result && result.files) {
        for (const [path, info] of Object.entries(result.files)) {
          if (!info.error) {
            this.fileInfoCache[path] = info;
          }
        }
      }
    } catch (err) {
      console.warn('批量获取文件信息失败:', err);
    }

    this.updateFileInfoDOM();
  }

  /**
   * 将缓存的文件信息更新到 DOM 中
   */
  updateFileInfoDOM() {
    const cards = document.querySelectorAll('.file-card[data-filepath]');
    cards.forEach((card) => {
      const fp = card.getAttribute('data-filepath');
      const info = this.fileInfoCache[fp];
      const detailEl = card.querySelector('.file-details');
      if (!info || !detailEl) return;

      detailEl.innerHTML = `
        <span class="file-detail-item" title="文件大小">
          <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z"/></svg>
          ${this.formatFileSize(info.size)}
        </span>
        <span class="file-detail-item" title="创建时间: ${this.formatFullDateTime(info.createdTime)}">
          <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>
          创建: ${this.formatShortDateTime(info.createdTime)}
        </span>
        <span class="file-detail-item" title="修改时间: ${this.formatFullDateTime(info.modifiedTime)}">
          <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          修改: ${this.formatShortDateTime(info.modifiedTime)}
        </span>
        <span class="file-detail-item" title="文件类型">
          <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z"/></svg>
          ${info.fileType.toUpperCase()}
        </span>
        ${info.permissions ? `
        <span class="file-detail-item" title="文件权限">
          <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
          ${info.permissions}
        </span>` : ''}
      `;
    });
  }

  /**
   * 格式化文件大小
   */
  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes === undefined || bytes === null) return '--';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1);
    return `${size} ${units[i]}`;
  }

  /**
   * 格式化短日期时间（用于显示）
   */
  formatShortDateTime(timestamp) {
    if (!timestamp) return '--';
    const d = new Date(timestamp);
    const now = new Date();
    const isThisYear = d.getFullYear() === now.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hour = String(d.getHours()).padStart(2, '0');
    const minute = String(d.getMinutes()).padStart(2, '0');
    if (isThisYear) {
      return `${month}-${day} ${hour}:${minute}`;
    }
    return `${d.getFullYear()}-${month}-${day} ${hour}:${minute}`;
  }

  /**
   * 格式化完整日期时间（用于 tooltip）
   */
  formatFullDateTime(timestamp) {
    if (!timestamp) return '--';
    const d = new Date(timestamp);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  /**
   * 模糊搜索应用（同时搜索预设列表和系统已安装列表）
   */
  fuzzySearchApps(query) {
    if (!query) return [];
    const q = query.toLowerCase();
    const results = new Map(); // name -> {name, label, source}

    // 从已安装应用中搜索
    for (const app of this.installedApps) {
      const nameLower = app.name.toLowerCase();
      if (nameLower.includes(q)) {
        results.set(app.name, { name: app.name, label: app.name, source: 'installed' });
      }
    }

    // 限制返回数量
    const arr = Array.from(results.values());
    // 精确前缀匹配优先排序
    arr.sort((a, b) => {
      const aStartsWith = a.name.toLowerCase().startsWith(q);
      const bStartsWith = b.name.toLowerCase().startsWith(q);
      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;
      return a.name.localeCompare(b.name);
    });
    return arr.slice(0, 12);
  }

  /**
   * 高亮文本中匹配查询词的部分
   */
  highlightMatch(text, query) {
    if (!query) return this.escapeHtml(text);
    const escaped = this.escapeHtml(text);
    const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${q})`, 'gi');
    return escaped.replace(regex, '<strong>$1</strong>');
  }

  // ==========================================
  // 事件绑定
  // ==========================================

  bindEvents() {
    // 全局点击关闭所有下拉菜单
    document.addEventListener('click', () => {
      document.querySelectorAll('.copy-dropdown, .batch-copy-dropdown, .open-with-dropdown, .batch-open-with-dropdown, .terminal-dropdown, .batch-terminal-dropdown').forEach((d) => d.style.display = 'none');
      document.querySelectorAll('.open-with-search-results').forEach((d) => { d.innerHTML = ''; d.style.display = 'none'; });
      document.querySelectorAll('.terminal-search-results').forEach((d) => { d.innerHTML = ''; d.style.display = 'none'; });
    });

    // 排序
    document.getElementById('btn-sort').addEventListener('click', () => this.toggleSort());

    // 新建根标签
    document.getElementById('btn-add-root-tag').addEventListener('click', () => {
      this.showNewTagModal(null);
    });

    // 顶部"添加文件"按钮
    document.getElementById('btn-add-files').addEventListener('click', () => {
      this.showAddFilesModal();
    });

    // 搜索 - 文件名输入（带防抖）
    this._searchDebounceTimer = null;
    document.getElementById('search-input').addEventListener('input', (e) => {
      this.searchQuery = e.target.value;
      this.currentPage = 1;
      clearTimeout(this._searchDebounceTimer);
      this._searchDebounceTimer = setTimeout(() => {
        this.renderFileList();
      }, 200);
    });

    // --- 标签筛选按钮 ---
    document.getElementById('search-tag-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleSearchTagDropdown();
    });

    // 标签过滤输入（带防抖）
    this._tagFilterDebounceTimer = null;
    document.getElementById('search-tag-filter-input').addEventListener('input', (e) => {
      clearTimeout(this._tagFilterDebounceTimer);
      this._tagFilterDebounceTimer = setTimeout(() => {
        this._renderSearchTagList(e.target.value.trim().toLowerCase());
      }, 150);
    });
    document.getElementById('search-tag-filter-input').addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // 点击外部关闭标签下拉
    document.addEventListener('click', (e) => {
      const dropdown = document.getElementById('search-tag-dropdown');
      if (dropdown.style.display !== 'none' && !e.target.closest('.search-tag-dropdown') && !e.target.closest('.search-tag-toggle')) {
        dropdown.style.display = 'none';
        document.getElementById('search-tag-toggle').classList.remove('active');
      }
    });

    // --- 右键菜单 ---
    document.addEventListener('click', () => this.hideContextMenu());
    document.addEventListener('contextmenu', (e) => {
      // 如果不是在标签上右键，隐藏菜单
      if (!e.target.closest('.tag-nav-item[data-tag]') || e.target.closest('[data-tag="__all__"]')) {
        this.hideContextMenu();
      }
    });

    const ctxMenu = document.getElementById('context-menu');
    ctxMenu.querySelector('[data-action="add-child"]').addEventListener('click', () => {
      this.hideContextMenu();
      this.showNewTagModal(this.ctxTagName);
    });
    ctxMenu.querySelector('[data-action="upload-files"]').addEventListener('click', () => {
      this.hideContextMenu();
      this.showAddFilesModalForTag(this.ctxTagName);
    });
    ctxMenu.querySelector('[data-action="upload-dir"]').addEventListener('click', () => {
      this.hideContextMenu();
      this.uploadDirForTag(this.ctxTagName);
    });
    ctxMenu.querySelector('[data-action="rename"]').addEventListener('click', () => {
      this.hideContextMenu();
      this.showRenameTagModal(this.ctxTagName);
    });
    ctxMenu.querySelector('[data-action="delete"]').addEventListener('click', () => {
      this.hideContextMenu();
      this.showDeleteTagConfirm(this.ctxTagName);
    });

    // --- 新建标签弹窗 ---
    document.getElementById('btn-confirm-new-tag').addEventListener('click', () => this.confirmNewTag());
    document.getElementById('new-tag-name-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirmNewTag();
    });

    // --- 重命名弹窗 ---
    document.getElementById('btn-confirm-rename').addEventListener('click', () => this.confirmRename());
    document.getElementById('rename-tag-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirmRename();
    });

    // --- 删除确认弹窗 ---
    document.getElementById('btn-confirm-delete').addEventListener('click', () => this.confirmDeleteTag());

    // --- 添加文件弹窗 ---
    document.getElementById('btn-modal-add-tag').addEventListener('click', () => this.addTagInModal());
    document.getElementById('modal-new-tag-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.addTagInModal();
    });
    document.getElementById('btn-confirm-add-files').addEventListener('click', () => this.confirmAddFiles());

    // 上传区域点击
    document.getElementById('upload-area').addEventListener('click', () => {
      document.getElementById('file-picker').click();
    });

    // 上传区域拖拽
    const uploadArea = document.getElementById('upload-area');
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('drag-over');
    });
    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('drag-over');
    });
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('drag-over');
      this.handleUploadDrop(e);
    });

    // 文件选择回调
    document.getElementById('file-picker').addEventListener('change', (e) => {
      this.handleFileSelect(e.target.files);
      e.target.value = '';
    });

    // 目录选择回调
    document.getElementById('dir-picker').addEventListener('change', (e) => {
      this.handleDirSelectForTag(e.target.files);
      e.target.value = '';
    });

    // --- 手动输入路径 ---
    document.getElementById('manual-path-toggle').addEventListener('click', () => {
      const body = document.getElementById('manual-path-body');
      const header = document.getElementById('manual-path-toggle');
      if (body.style.display === 'none') {
        body.style.display = 'block';
        header.classList.add('expanded');
      } else {
        body.style.display = 'none';
        header.classList.remove('expanded');
      }
    });
    document.getElementById('btn-add-manual-paths').addEventListener('click', () => {
      this.handleManualPathInput();
    });

    // --- 添加目录弹窗 ---
    document.getElementById('btn-dir-browse').addEventListener('click', () => {
      this.closeModal('modal-add-dir');
      // 使用 Native Host 弹出系统原生目录选择对话框（可以获取绝对路径）
      this.handleNativeDirSelect();
    });
    document.getElementById('btn-dir-manual-confirm').addEventListener('click', () => {
      this.handleManualDirInput();
    });
    document.getElementById('dir-manual-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleManualDirInput();
    });

    // --- 关闭弹窗 ---
    document.querySelectorAll('.modal-close, [data-close]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const modalId = btn.getAttribute('data-close');
        if (modalId) this.closeModal(modalId);
      });
    });

    document.querySelectorAll('.modal-overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.style.display = 'none';
      });
    });

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        document.getElementById('search-input').focus();
      }
      // Ctrl/Cmd + A 全选文件
      if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !e.target.closest('input, textarea')) {
        e.preventDefault();
        this.selectAllFiles();
      }
      // Esc 取消选择
      if (e.key === 'Escape' && this.selectedFiles.size > 0) {
        this.selectedFiles.clear();
        this.renderFileList();
      }
    });

    // --- 批量操作栏 ---
    document.getElementById('btn-batch-select-all')?.addEventListener('click', () => this.selectAllFiles());
    document.getElementById('btn-batch-open')?.addEventListener('click', () => this.batchOpenFiles());
    document.getElementById('btn-batch-reveal')?.addEventListener('click', () => this.batchRevealFiles());
    // 批量"在终端中打开"按钮下拉
    document.getElementById('btn-batch-terminal')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('batch-terminal-dropdown');
      if (dropdown) {
        dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
      }
    });
    document.querySelectorAll('.batch-terminal-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const termApp = item.getAttribute('data-terminal');
        document.getElementById('batch-terminal-dropdown').style.display = 'none';
        this.batchOpenTerminal(termApp);
      });
    });
    // 批量终端搜索输入框
    const batchTermInput = document.getElementById('batch-terminal-search-input');
    const batchTermResults = document.getElementById('batch-terminal-search-results');
    batchTermInput?.addEventListener('input', (e) => {
      e.stopPropagation();
      const query = batchTermInput.value.trim();
      if (!query) {
        if (batchTermResults) { batchTermResults.innerHTML = ''; batchTermResults.style.display = 'none'; }
        return;
      }
      const matches = this.fuzzySearchApps(query);
      if (matches.length === 0) {
        batchTermResults.innerHTML = `<button class="terminal-search-item" data-terminal="${this.escapeHtml(query)}">用 "${this.escapeHtml(query)}" 打开</button>`;
      } else {
        batchTermResults.innerHTML = matches.map(m =>
          `<button class="terminal-search-item" data-terminal="${this.escapeHtml(m.name)}">${this.highlightMatch(m.label, query)}</button>`
        ).join('');
        const exactMatch = matches.some(m => m.name.toLowerCase() === query.toLowerCase());
        if (!exactMatch) {
          batchTermResults.innerHTML += `<button class="terminal-search-item terminal-search-custom" data-terminal="${this.escapeHtml(query)}">用 "${this.escapeHtml(query)}" 打开</button>`;
        }
      }
      batchTermResults.style.display = 'block';
      batchTermResults.querySelectorAll('.terminal-search-item').forEach((item) => {
        item.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const termApp = item.getAttribute('data-terminal');
          document.getElementById('batch-terminal-dropdown').style.display = 'none';
          batchTermInput.value = '';
          batchTermResults.innerHTML = '';
          batchTermResults.style.display = 'none';
          this.batchOpenTerminal(termApp);
        });
      });
    });
    batchTermInput?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const appName = e.target.value.trim();
        if (!appName) return;
        document.getElementById('batch-terminal-dropdown').style.display = 'none';
        batchTermInput.value = '';
        if (batchTermResults) { batchTermResults.innerHTML = ''; batchTermResults.style.display = 'none'; }
        this.batchOpenTerminal(appName);
      }
    });
    batchTermInput?.addEventListener('click', (e) => e.stopPropagation());
    // 批量"选择打开方式"下拉
    document.getElementById('btn-batch-open-with')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('batch-open-with-dropdown');
      if (dropdown) {
        dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
      }
    });
    document.querySelectorAll('.batch-open-with-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const app = item.getAttribute('data-app');
        document.getElementById('batch-open-with-dropdown').style.display = 'none';
        this.batchOpenFiles(app);
      });
    });
    // 批量"搜索应用"输入框
    const batchOpenInput = document.getElementById('batch-open-with-input');
    const batchSearchResults = document.getElementById('batch-open-with-search-results');
    batchOpenInput?.addEventListener('input', (e) => {
      e.stopPropagation();
      const query = batchOpenInput.value.trim();
      if (!query || !batchSearchResults) {
        if (batchSearchResults) { batchSearchResults.innerHTML = ''; batchSearchResults.style.display = 'none'; }
        return;
      }
      const matches = this.fuzzySearchApps(query);
      if (matches.length === 0) {
        batchSearchResults.innerHTML = `<button class="open-with-search-item" data-app="${this.escapeHtml(query)}">用 "${this.escapeHtml(query)}" 打开</button>`;
      } else {
        batchSearchResults.innerHTML = matches.map(m =>
          `<button class="open-with-search-item" data-app="${this.escapeHtml(m.name)}">${this.highlightMatch(m.label, query)}</button>`
        ).join('');
        const exactMatch = matches.some(m => m.name.toLowerCase() === query.toLowerCase());
        if (!exactMatch) {
          batchSearchResults.innerHTML += `<button class="open-with-search-item open-with-search-custom" data-app="${this.escapeHtml(query)}">用 "${this.escapeHtml(query)}" 打开</button>`;
        }
      }
      batchSearchResults.style.display = 'block';
      batchSearchResults.querySelectorAll('.open-with-search-item').forEach((item) => {
        item.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const app = item.getAttribute('data-app');
          document.getElementById('batch-open-with-dropdown').style.display = 'none';
          batchOpenInput.value = '';
          batchSearchResults.innerHTML = '';
          batchSearchResults.style.display = 'none';
          this.batchOpenFiles(app);
        });
      });
    });
    batchOpenInput?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const appName = e.target.value.trim();
        if (!appName) return;
        document.getElementById('batch-open-with-dropdown').style.display = 'none';
        batchOpenInput.value = '';
        if (batchSearchResults) { batchSearchResults.innerHTML = ''; batchSearchResults.style.display = 'none'; }
        this.batchOpenFiles(appName);
      }
    });
    batchOpenInput?.addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('btn-batch-copy-path')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('batch-copy-dropdown');
      if (dropdown) {
        dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
      }
    });
    // 批量复制下拉菜单项
    document.querySelectorAll('.batch-copy-dropdown-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const copyType = item.getAttribute('data-copy-type');
        this.batchCopyByType(copyType);
        document.getElementById('batch-copy-dropdown').style.display = 'none';
      });
    });
    document.getElementById('btn-batch-add-tag')?.addEventListener('click', () => this.showBatchAddTagModal());
    document.getElementById('btn-batch-remove-tag')?.addEventListener('click', () => this.showBatchRemoveTagModal());
    document.getElementById('btn-batch-delete')?.addEventListener('click', () => this.batchRemoveFiles());
    document.getElementById('btn-batch-cancel')?.addEventListener('click', () => {
      this.selectedFiles.clear();
      this.renderFileList();
    });

    // --- 批量标签弹窗 ---
    document.getElementById('btn-confirm-batch-tag')?.addEventListener('click', () => this.confirmBatchTag());

    // --- 文件标签管理弹窗确认按钮 ---
    document.getElementById('btn-save-file-tags')?.addEventListener('click', () => this._saveFileTagsSelection());

    // --- 侧边栏拖拽分割线 ---
    this._initSidebarResizer();

    // --- 标签模式切换 ---
    document.querySelectorAll('.tag-mode-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tag-mode-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        this.tagDisplayMode = tab.getAttribute('data-mode');
        this.renderSidebar();
      });
    });
  }

  // ==========================================
  // 侧边栏拖拽分割线
  // ==========================================

  _initSidebarResizer() {
    const resizer = document.getElementById('sidebar-resizer');
    const sidebar = document.querySelector('.sidebar');
    if (!resizer || !sidebar) return;

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    resizer.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;
      resizer.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const diff = e.clientX - startX;
      const newWidth = Math.min(Math.max(startWidth + diff, 200), 500);
      sidebar.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      resizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ==========================================
  // 右键菜单
  // ==========================================

  showContextMenu(e, tagName) {
    e.preventDefault();
    e.stopPropagation();
    this.ctxTagName = tagName;

    const menu = document.getElementById('context-menu');

    // 判断是否为时间标签（根级部分为 6~8 位纯数字）
    const root = tagName.split('/')[0];
    const isTime = /^\d{6,8}$/.test(root);

    // 时间标签不允许删除和重命名
    const deleteBtn = menu.querySelector('[data-action="delete"]');
    const renameBtn = menu.querySelector('[data-action="rename"]');
    const divider = menu.querySelector('.ctx-divider');

    if (isTime) {
      deleteBtn.style.display = 'none';
      renameBtn.style.display = 'none';
      divider.style.display = 'none';
    } else {
      deleteBtn.style.display = '';
      renameBtn.style.display = '';
      divider.style.display = '';
    }

    menu.style.display = 'block';
    menu.style.left = e.pageX + 'px';
    menu.style.top = e.pageY + 'px';

    // 确保不超出屏幕
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = (e.pageX - rect.width) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = (e.pageY - rect.height) + 'px';
    }
  }

  hideContextMenu() {
    document.getElementById('context-menu').style.display = 'none';
  }

  // ==========================================
  // 新建标签
  // ==========================================

  showNewTagModal(parentTag) {
    this.newTagParent = parentTag;
    const title = parentTag ? `新建子标签 (${parentTag})` : '新建标签';
    const hint = parentTag ? `将在 "${parentTag}" 下创建子标签` : '创建一个根级标签';

    document.getElementById('modal-new-tag-title').textContent = title;
    document.getElementById('modal-new-tag-hint').textContent = hint;
    document.getElementById('new-tag-name-input').value = '';

    this.openModal('modal-new-tag');
    setTimeout(() => document.getElementById('new-tag-name-input').focus(), 100);
  }

  async confirmNewTag() {
    const input = document.getElementById('new-tag-name-input');
    const name = input.value.trim();
    if (!name) return;

    const fullName = this.newTagParent ? `${this.newTagParent}/${name}` : name;

    if (this.tagManager.exists(fullName)) {
      this.showToast(`标签 "${fullName}" 已存在`, 'error');
      return;
    }

    await this.tagManager.addTag(fullName);
    this.expandedTags.add(this.newTagParent || '');

    // 展开祖先
    if (this.newTagParent) {
      const parts = this.newTagParent.split('/');
      for (let i = 1; i <= parts.length; i++) {
        this.expandedTags.add(parts.slice(0, i).join('/'));
      }
    }

    this.closeModal('modal-new-tag');
    this.showToast(`标签 "${fullName}" 已创建`, 'success');
    this.render();
  }

  // ==========================================
  // 重命名标签
  // ==========================================

  showRenameTagModal(tagName) {
    this.renameTagOld = tagName;
    const displayName = this.tagManager.getDisplayName(tagName);

    document.getElementById('rename-tag-hint').textContent = `当前标签：${tagName}`;
    document.getElementById('rename-tag-input').value = displayName;

    this.openModal('modal-rename-tag');
    setTimeout(() => {
      const input = document.getElementById('rename-tag-input');
      input.focus();
      input.select();
    }, 100);
  }

  async confirmRename() {
    const input = document.getElementById('rename-tag-input');
    const newDisplayName = input.value.trim();
    if (!newDisplayName) return;

    const oldName = this.renameTagOld;
    const parts = oldName.split('/');
    parts[parts.length - 1] = newDisplayName;
    const newName = parts.join('/');

    if (newName === oldName) {
      this.closeModal('modal-rename-tag');
      return;
    }

    if (this.tagManager.exists(newName)) {
      this.showToast(`标签 "${newName}" 已存在`, 'error');
      return;
    }

    await this.tagManager.renameTag(oldName, newName);
    await this.fileManager.renameTagInAllFiles(oldName, newName);

    if (this.activeTags.has(oldName)) {
      this.activeTags.delete(oldName);
      this.activeTags.add(newName);
    }
    // 更新子标签引用
    for (const t of [...this.activeTags]) {
      if (t.startsWith(oldName + '/')) {
        this.activeTags.delete(t);
        this.activeTags.add(newName + t.substring(oldName.length));
      }
    }

    this.closeModal('modal-rename-tag');
    this.showToast(`标签已重命名为 "${newName}"`, 'success');
    this.render();
  }

  // ==========================================
  // 删除标签
  // ==========================================

  showDeleteTagConfirm(tagName) {
    // 时间标签不允许删除
    const root = tagName.split('/')[0];
    if (/^\d{6,8}$/.test(root)) {
      this.showToast('时间标签不允许删除', 'error');
      return;
    }

    this.pendingDeleteTag = tagName;
    const children = this.tagManager.getChildTags(tagName);
    const msg = children.length > 0
      ? `确定要删除标签 "${tagName}" 及其所有子标签吗？\n文件记录中的该标签也会被移除。`
      : `确定要删除标签 "${tagName}" 吗？\n文件记录中的该标签也会被移除。`;

    document.getElementById('confirm-message').textContent = msg;
    this.openModal('modal-confirm');
  }

  async confirmDeleteTag() {
    if (!this.pendingDeleteTag) return;

    const removedNames = await this.tagManager.removeTag(this.pendingDeleteTag);
    await this.fileManager.removeTagFromAllFiles(removedNames);

    // 从选中的筛选标签中移除已删除的标签
    for (const t of [...this.activeTags]) {
      if (t === this.pendingDeleteTag || this.tagManager.isDescendantOrSelf(t, this.pendingDeleteTag)) {
        this.activeTags.delete(t);
      }
    }

    this.closeModal('modal-confirm');
    this.showToast(`标签 "${this.pendingDeleteTag}" 已删除`, 'info');
    this.pendingDeleteTag = null;
    this.render();
  }

  // ==========================================
  // 添加文件弹窗（选择标签 + 选文件）
  // ==========================================

  showAddFilesModal(preSelectedTag) {
    this.pendingFileNames = [];
    this.selectedTags = new Set();
    if (preSelectedTag) {
      this.selectedTags.add(preSelectedTag);
    }

    // 自动加上日期标签
    const dateTag = FileManager.getDateTag();
    if (!this.tagManager.exists(dateTag)) {
      // 先不创建，等确认时再创建
    }
    this.selectedTags.add(dateTag);

    this.renderModalTagSelect();
    document.getElementById('pending-files-list').innerHTML = '';
    document.getElementById('modal-new-tag-input').value = '';
    // 重置手动输入路径区域
    document.getElementById('manual-path-input').value = '';
    document.getElementById('manual-path-body').style.display = 'none';
    document.getElementById('manual-path-toggle').classList.remove('expanded');

    this.openModal('modal-add-files');
  }

  showAddFilesModalForTag(tagName) {
    this.showAddFilesModal(tagName);
  }

  renderModalTagSelect() {
    const container = document.getElementById('modal-tag-select');
    const allTags = this.tagManager.getAllTags();
    const dateTag = FileManager.getDateTag();

    // 合并：已有标签 + 日期标签（可能不在已有标签中）
    const tagNames = new Set(allTags.map((t) => t.name));
    tagNames.add(dateTag);

    const sortedNames = Array.from(tagNames).sort((a, b) => a.localeCompare(b));

    if (sortedNames.length === 0) {
      container.innerHTML = '<p class="no-tags-hint">还没有标签，请先新建</p>';
      return;
    }

    container.innerHTML = sortedNames.map((name) => {
      const checked = this.selectedTags.has(name) ? 'checked' : '';
      const depth = (name.match(/\//g) || []).length;
      return `
        <label class="tag-select-item" style="padding-left: ${8 + depth * 16}px;">
          <input type="checkbox" value="${this.escapeHtml(name)}" ${checked}>
          <span>${this.escapeHtml(name)}</span>
        </label>
      `;
    }).join('');

    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) {
          this.selectedTags.add(cb.value);
        } else {
          this.selectedTags.delete(cb.value);
        }
      });
    });
  }

  async addTagInModal() {
    const input = document.getElementById('modal-new-tag-input');
    const name = input.value.trim();
    if (!name) return;

    await this.tagManager.addTag(name);
    this.selectedTags.add(name);
    input.value = '';
    this.renderModalTagSelect();
    this.renderSidebar();
  }

  handleFileSelect(fileList) {
    if (!fileList || fileList.length === 0) return;
    for (const file of fileList) {
      const name = file.name;
      if (!this.pendingFileNames.some((f) => f.fullPath === name)) {
        this.pendingFileNames.push({ name, dirPath: '', fullPath: name });
      }
    }
    this.renderPendingFiles();
  }

  handleUploadDrop(e) {
    const items = e.dataTransfer.items;
    if (!items) return;

    const readEntry = (entry, path) => {
      return new Promise((resolve) => {
        if (entry.isFile) {
          entry.file((file) => {
            const dirPath = path || '';
            const name = file.name;
            const fullPath = dirPath ? dirPath + '/' + name : name;
            if (!this.pendingFileNames.some((f) => f.fullPath === fullPath)) {
              this.pendingFileNames.push({ name, dirPath, fullPath });
            }
            resolve();
          });
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const readAll = (entries) => {
            reader.readEntries(async (batch) => {
              if (batch.length === 0) {
                const promises = entries.map((e) =>
                  readEntry(e, path ? path + '/' + entry.name : entry.name)
                );
                await Promise.all(promises);
                resolve();
              } else {
                readAll([...entries, ...batch]);
              }
            });
          };
          readAll([]);
        } else {
          resolve();
        }
      });
    };

    const promises = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (entry) {
        promises.push(readEntry(entry, ''));
      }
    }

    Promise.all(promises).then(() => {
      this.renderPendingFiles();
    });
  }

  renderPendingFiles() {
    const container = document.getElementById('pending-files-list');
    if (this.pendingFileNames.length === 0) {
      container.innerHTML = '';
      return;
    }

    // 统计涉及的目录数
    const dirs = new Set();
    this.pendingFileNames.forEach((f) => {
      if (f.dirPath) {
        const parts = f.dirPath.split('/');
        for (let i = 1; i <= parts.length; i++) {
          dirs.add(parts.slice(0, i).join('/'));
        }
      }
    });

    const dirInfo = dirs.size > 0 ? `<p class="pending-dir-info">📁 将自动创建 ${dirs.size} 个目录标签</p>` : '';

    container.innerHTML = `
      <h4>${this.pendingFileNames.length} 个文件待添加：</h4>
      ${dirInfo}
      <div class="pending-files-wrap">
        ${this.pendingFileNames.map((f, idx) => `
          <div class="pending-file-item">
            <span class="pending-file-name" title="${this.escapeHtml(f.fullPath)}">
              ${f.dirPath ? `<span class="pending-file-dir">${this.escapeHtml(f.dirPath)}/</span>` : ''}${this.escapeHtml(f.name)}
            </span>
            <button class="pending-file-remove" data-idx="${idx}">&times;</button>
          </div>
        `).join('')}
      </div>
    `;

    container.querySelectorAll('.pending-file-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx'));
        this.pendingFileNames.splice(idx, 1);
        this.renderPendingFiles();
      });
    });
  }

  async confirmAddFiles() {
    if (this.pendingFileNames.length === 0) {
      this.showToast('请先选择文件', 'error');
      return;
    }

    if (this.selectedTags.size === 0) {
      this.showToast('请至少选择一个标签', 'error');
      return;
    }

    const baseTags = Array.from(this.selectedTags);

    // 确保所有基础标签都已创建
    for (const tag of baseTags) {
      if (!this.tagManager.exists(tag)) {
        await this.tagManager.addTag(tag);
      }
    }

    // 收集所有目录路径并创建对应标签
    const dirSet = new Set();
    this.pendingFileNames.forEach((f) => {
      if (f.dirPath) {
        const parts = f.dirPath.split('/');
        for (let i = 1; i <= parts.length; i++) {
          dirSet.add(parts.slice(0, i).join('/'));
        }
      }
    });

    // 为每个已选标签下创建目录子标签
    const sortedDirs = Array.from(dirSet).sort();
    for (const baseTag of baseTags) {
      // 日期标签下不创建目录子标签
      if (/^\d{8}$/.test(baseTag)) continue;

      for (const dir of sortedDirs) {
        const fullTagName = `${baseTag}/${dir}`;
        if (!this.tagManager.exists(fullTagName)) {
          await this.tagManager.addTag(fullTagName);
        }
      }
      // 只展开一级标签，不展开所有子目录
      this.expandedTags.add(baseTag);
    }

    // 构建文件条目，每个文件关联到对应目录的标签
    const fileEntries = this.pendingFileNames.map((f) => {
      const fileTags = [];
      for (const baseTag of baseTags) {
        if (/^\d{8}$/.test(baseTag)) {
          // 日期标签直接关联
          fileTags.push(baseTag);
        } else if (f.dirPath) {
          // 有目录路径的，关联到最深层的目录标签
          fileTags.push(`${baseTag}/${f.dirPath}`);
        } else {
          // 无目录路径，直接关联到基础标签
          fileTags.push(baseTag);
        }
      }
      const entry = { name: f.name, tags: fileTags };
      // 如果有完整路径，记录为文件的真实绝对路径
      if (f.fullPath && f.fullPath.startsWith('/')) {
        entry.path = f.fullPath;
      }
      return entry;
    });

    const count = await this.fileManager.addFileRecordsWithTags(fileEntries);

    this.closeModal('modal-add-files');

    if (count > 0) {
      const dirMsg = sortedDirs.length > 0 ? `，自动创建 ${sortedDirs.length} 个目录标签` : '';
      this.showToast(`已添加 ${count} 个文件${dirMsg}`, 'success');
    } else {
      this.showToast('文件已存在', 'error');
    }

    this.render();
  }

  // ==========================================
  // 右键菜单：添加目录到标签
  // ==========================================

  _dirTagTarget = null;

  uploadDirForTag(tagName) {
    this._dirTagTarget = tagName;
    // 弹出目录添加弹窗
    const displayName = this.tagManager.getDisplayName(tagName);
    document.getElementById('add-dir-hint').textContent = `目标标签：${displayName}`;
    document.getElementById('dir-manual-input').value = '';
    this.openModal('modal-add-dir');
  }

  /**
   * 通过 Native Host 弹出系统原生目录选择对话框
   * 可以获取目录的绝对路径，然后读取文件列表并导入
   */
  async handleNativeDirSelect() {
    const tagName = this._dirTagTarget;
    if (!tagName) return;

    try {
      this.showToast('正在打开目录选择对话框...', 'info');

      // 调用 Native Host 弹出系统原生目录选择 + 列出文件（分页返回第一页）
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: 'chooseAndListDir' },
          (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(resp);
            }
          }
        );
      });

      // 用户取消了选择
      if (response.cancelled) {
        this._dirTagTarget = null;
        return;
      }

      if (response.error) {
        // Native Host 不支持或无法弹出对话框，回退到浏览器选择
        if (response.error.includes('未知操作') || response.error.includes('无法弹出')) {
          this.showToast('系统目录选择不可用，已切换到浏览器选择方式', 'info');
          document.getElementById('dir-picker').click();
          return;
        }
        throw new Error(response.error);
      }

      if (!response.files || response.files.length === 0) {
        this.showToast('目录为空或无可读文件', 'error');
        this._dirTagTarget = null;
        return;
      }

      // 如果有分页，继续加载后续页
      let allFiles = [...response.files];
      const totalPages = response.totalPages || 1;
      const absolutePath = response.absolutePath;

      if (totalPages > 1) {
        this.showToast(`正在加载文件列表... (共 ${response.totalCount} 个文件, 第 1/${totalPages} 页)`, 'info');
        for (let page = 1; page < totalPages; page++) {
          try {
            const pageResp = await this.sendNativeAction('listDirPaged', { path: absolutePath, page });
            if (pageResp && pageResp.files) {
              allFiles = allFiles.concat(pageResp.files);
            }
            this.showToast(`正在加载文件列表... (第 ${page + 1}/${totalPages} 页)`, 'info');
          } catch (err) {
            console.warn(`加载第 ${page + 1}/${totalPages} 页失败:`, err);
          }
        }
      }

      this.showToast(`正在处理 ${allFiles.length} 个文件 (0%)...`, 'info');
      const dateTag = FileManager.getDateTag();

      // 收集目录和文件
      const dirSet = new Set();
      const fileEntries = [];

      for (const relPath of allFiles) {
        // relPath 格式: "rootDir/subDir/file.txt"
        const parts = relPath.split('/');
        const fileName = parts[parts.length - 1];

        // 收集所有目录层级
        for (let i = 1; i < parts.length; i++) {
          dirSet.add(parts.slice(0, i).join('/'));
        }

        // 文件所在目录
        const dirPath = parts.length > 1 ? parts.slice(0, parts.length - 1).join('/') : '';
        const fileDirTag = dirPath ? `${tagName}/${dirPath}` : tagName;

        // 拼出文件的真实绝对路径
        const fileAbsPath = `${absolutePath}/${parts.slice(1).join('/')}`;

        fileEntries.push({
          name: fileName,
          tags: [fileDirTag, dateTag],
          path: fileAbsPath,
        });
      }

      // 批量创建所有目录标签（只 save 一次）
      const sortedDirs = Array.from(dirSet).sort();
      const allTagNames = sortedDirs.map((dir) => `${tagName}/${dir}`);
      allTagNames.push(dateTag, tagName);
      await this.tagManager.addTagsBatch(allTagNames);

      const count = await this.fileManager.addFileRecordsWithTags(fileEntries, (processed, total) => {
        const pct = Math.round((processed / total) * 100);
        this.showToast(`正在处理 ${allFiles.length} 个文件 (${pct}%)...`, 'info');
      });

      // 只展开一级标签，不展开所有子目录
      this.expandedTags.add(tagName);

      if (count > 0) {
        this.showToast(`已添加 ${count} 个文件（路径: ${absolutePath}），创建 ${sortedDirs.length} 个目录标签`, 'success');
      } else {
        this.showToast('文件已存在', 'error');
      }
    } catch (err) {
      console.error('选择目录失败:', err);
      this.showToast(`选择目录失败: ${err.message}`, 'error');
    }

    this._dirTagTarget = null;
    this.render();
  }

  /**
   * 通过浏览器 input[webkitdirectory] 选择目录（回退方案，无法获取绝对路径）
   */
  async handleDirSelectForTag(fileList) {
    if (!fileList || fileList.length === 0) return;

    const tagName = this._dirTagTarget;
    if (!tagName) return;

    const dateTag = FileManager.getDateTag();

    // 收集所有目录路径（用于创建标签）和文件条目
    const dirSet = new Set();
    const fileEntries = [];

    for (const file of fileList) {
      const rp = file.webkitRelativePath || file.name;
      const parts = rp.split('/');
      const fileName = parts[parts.length - 1];

      for (let i = 1; i < parts.length; i++) {
        dirSet.add(parts.slice(0, i).join('/'));
      }

      const dirPath = parts.length > 1 ? parts.slice(0, parts.length - 1).join('/') : '';
      const fileDirTag = dirPath ? `${tagName}/${dirPath}` : tagName;

      fileEntries.push({
        name: fileName,
        tags: [fileDirTag, dateTag],
        // 注意：浏览器无法提供绝对路径，所以 path 为空
      });
    }

    const sortedDirs = Array.from(dirSet).sort();
    for (const dir of sortedDirs) {
      const fullTagName = `${tagName}/${dir}`;
      if (!this.tagManager.exists(fullTagName)) {
        await this.tagManager.addTag(fullTagName);
      }
    }

    if (!this.tagManager.exists(dateTag)) {
      await this.tagManager.addTag(dateTag);
    }
    if (!this.tagManager.exists(tagName)) {
      await this.tagManager.addTag(tagName);
    }

    const count = await this.fileManager.addFileRecordsWithTags(fileEntries);

    // 只展开一级标签，不展开所有子目录
    this.expandedTags.add(tagName);

    if (count > 0) {
      this.showToast(`已添加 ${count} 个文件，创建 ${sortedDirs.length} 个目录标签（⚠️ 未记录绝对路径）`, 'success');
    } else {
      this.showToast('文件已存在', 'error');
    }

    this._dirTagTarget = null;
    this.render();
  }

  // 手动输入文件路径处理（添加文件弹窗中）
  // 支持输入文件路径（直接添加）或目录路径（通过 Native Host 读取目录内容）
  async handleManualPathInput() {
    const textarea = document.getElementById('manual-path-input');
    const rawText = textarea.value.trim();
    if (!rawText) {
      this.showToast('请输入路径', 'error');
      return;
    }

    const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let addedCount = 0;
    let dirReadCount = 0;

    for (const line of lines) {
      const cleanPath = line.replace(/\/+$/, '');
      if (!cleanPath) continue;

      // 尝试判断是否为目录路径（以 / 结尾的或不含扩展名的路径），通过 Native Host 读取
      const isLikelyDir = line.endsWith('/');

      if (isLikelyDir && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        // 目录路径 → 通过 Native Host 读取内容
        try {
          const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
              { action: 'listDir', path: cleanPath },
              (resp) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                } else if (resp && resp.error) {
                  reject(new Error(resp.error));
                } else {
                  resolve(resp);
                }
              }
            );
          });

          if (response.files && response.files.length > 0) {
            for (const relPath of response.files) {
              const parts = relPath.split('/');
              const fileName = parts[parts.length - 1];
              const dirPath = parts.length > 1 ? parts.slice(0, parts.length - 1).join('/') : '';
              const fullPath = `${cleanPath}/${relPath}`;

              if (!this.pendingFileNames.some((f) => f.fullPath === fullPath)) {
                this.pendingFileNames.push({ name: fileName, dirPath, fullPath });
                addedCount++;
              }
            }
            dirReadCount++;
          }
        } catch (err) {
          console.warn('读取目录失败，作为普通路径添加:', err.message);
          // 回退：作为普通路径添加
          this._addSinglePath(cleanPath) && addedCount++;
        }
      } else {
        // 文件路径 → 直接添加
        this._addSinglePath(cleanPath) && addedCount++;
      }
    }

    if (addedCount > 0) {
      textarea.value = '';
      this.renderPendingFiles();
      const msg = dirReadCount > 0
        ? `已读取 ${dirReadCount} 个目录，共添加 ${addedCount} 个文件`
        : `已添加 ${addedCount} 个路径`;
      this.showToast(msg, 'success');
    } else {
      this.showToast('路径已存在或无效', 'error');
    }
  }

  /** 添加单个文件路径到待处理列表 */
  _addSinglePath(cleanPath) {
    const parts = cleanPath.split('/');
    const fileName = parts[parts.length - 1];
    const dirPath = parts.length > 1 ? parts.slice(0, parts.length - 1).join('/') : '';
    const fullPath = cleanPath;

    if (!this.pendingFileNames.some((f) => f.fullPath === fullPath)) {
      this.pendingFileNames.push({ name: fileName, dirPath, fullPath });
      return true;
    }
    return false;
  }

  // 手动输入目录路径处理（添加目录弹窗中）
  // 通过 Native Messaging 读取本地目录内容，逻辑与 handleDirSelectForTag 一致
  async handleManualDirInput() {
    const input = document.getElementById('dir-manual-input');
    const rawPath = input.value.trim();
    if (!rawPath) {
      this.showToast('请输入目录路径', 'error');
      return;
    }

    const tagName = this._dirTagTarget;
    if (!tagName) return;

    // 先检查 Native Host 是否可用
    const canUseNative = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;
    if (!canUseNative) {
      this.showToast('当前环境不支持读取本地目录', 'error');
      return;
    }

    this.closeModal('modal-add-dir');
    this.showToast('正在读取目录...', 'success');

    try {
      // 通过 background.js → Native Host 分页读取目录
      const firstPage = await this.sendNativeAction('listDirPaged', { path: rawPath, page: 0 });

      if (!firstPage.files || firstPage.files.length === 0) {
        this.showToast('目录为空或无可读文件', 'error');
        this._dirTagTarget = null;
        return;
      }

      // 如果有分页，继续加载后续页
      let allFiles = [...firstPage.files];
      const totalPages = firstPage.totalPages || 1;

      if (totalPages > 1) {
        this.showToast(`正在加载文件列表... (共 ${firstPage.totalCount} 个文件, 第 1/${totalPages} 页)`, 'info');
        for (let page = 1; page < totalPages; page++) {
          try {
            const pageResp = await this.sendNativeAction('listDirPaged', { path: rawPath, page });
            if (pageResp && pageResp.files) {
              allFiles = allFiles.concat(pageResp.files);
            }
            this.showToast(`正在加载文件列表... (第 ${page + 1}/${totalPages} 页)`, 'info');
          } catch (err) {
            console.warn(`加载第 ${page + 1}/${totalPages} 页失败:`, err);
          }
        }
      }

      this.showToast(`正在处理 ${allFiles.length} 个文件 (0%)...`, 'info');

      // 以下逻辑与 handleDirSelectForTag 完全一致
      const dateTag = FileManager.getDateTag();
      const dirSet = new Set();
      const fileEntries = [];

      for (const relPath of allFiles) {
        // relPath 格式: "rootDir/subDir/file.txt" （与 webkitRelativePath 一致）
        const parts = relPath.split('/');
        const fileName = parts[parts.length - 1];

        // 收集所有目录层级（不含文件名）
        for (let i = 1; i < parts.length; i++) {
          dirSet.add(parts.slice(0, i).join('/'));
        }

        // 文件所在目录
        const dirPath = parts.length > 1 ? parts.slice(0, parts.length - 1).join('/') : '';

        // 构建文件的标签列表：父标签/目录路径 + 日期标签
        const fileDirTag = dirPath ? `${tagName}/${dirPath}` : tagName;

        // 真实绝对路径 = 用户输入的目录路径 + / + 相对路径
        const cleanBase = rawPath.replace(/\/+$/, '');
        const absolutePath = `${cleanBase}/${relPath}`;

        fileEntries.push({
          name: fileName,
          tags: [fileDirTag, dateTag],
          path: absolutePath,
        });
      }

      // 批量创建所有目录标签（只 save 一次）
      const sortedDirs = Array.from(dirSet).sort();
      const allTagNames = sortedDirs.map((dir) => `${tagName}/${dir}`);
      allTagNames.push(dateTag, tagName);
      await this.tagManager.addTagsBatch(allTagNames);

      const count = await this.fileManager.addFileRecordsWithTags(fileEntries, (processed, total) => {
        const pct = Math.round((processed / total) * 100);
        this.showToast(`正在处理 ${allFiles.length} 个文件 (${pct}%)...`, 'info');
      });

      // 只展开一级标签，不展开所有子目录
      this.expandedTags.add(tagName);

      if (count > 0) {
        this.showToast(`已添加 ${count} 个文件，自动创建 ${sortedDirs.length} 个目录标签`, 'success');
      } else {
        this.showToast('文件已存在', 'error');
      }

    } catch (err) {
      console.error('读取目录失败:', err);
      this.showToast(`读取目录失败: ${err.message}`, 'error');
    }

    this._dirTagTarget = null;
    this.render();
  }

  // ==========================================
  // 排序
  // ==========================================

  async toggleSort() {
    this.sortOrder = this.sortOrder === 'desc' ? 'asc' : 'desc';
    await StorageService.saveSortOrder(this.sortOrder);
    this.updateSortButton();
    this.currentPage = 1;
    this.renderFileList();
  }

  updateSortButton() {
    const label = document.querySelector('.sort-label');
    label.textContent = this.sortOrder === 'desc' ? '最新优先' : '最早优先';
  }

  // ==========================================
  // 标签筛选
  // ==========================================

  setTagFilter(tag, isCtrlClick = false) {
    this.selectedFiles.clear();

    if (tag === '__all__') {
      // 点击"全部文件"：清空所有筛选
      this.activeTags.clear();
      this.filterNoTag = false;
      document.getElementById('current-view-title').textContent = '全部文件';
      document.getElementById('tag-breadcrumb').style.display = 'none';
    } else if (tag === '__no_tag__') {
      // 点击"无标签"：切换无标签筛选
      if (this.filterNoTag) {
        this.filterNoTag = false;
        this.activeTags.clear();
      } else {
        this.filterNoTag = true;
        this.activeTags.clear();
      }
      this._updateFilterTitle();
    } else if (isCtrlClick) {
      // Ctrl/Cmd + 点击：多选切换
      this.filterNoTag = false;
      if (this.activeTags.has(tag)) {
        this.activeTags.delete(tag);
      } else {
        this.activeTags.add(tag);
      }
      this._updateFilterTitle();
    } else {
      // 普通点击：单选
      this.filterNoTag = false;
      if (this.activeTags.size === 1 && this.activeTags.has(tag)) {
        // 再次点击当前选中的标签，取消选中
        this.activeTags.clear();
        document.getElementById('current-view-title').textContent = '全部文件';
        document.getElementById('tag-breadcrumb').style.display = 'none';
      } else {
        this.activeTags.clear();
        this.activeTags.add(tag);
        this._updateFilterTitle();
      }
    }

    this.currentPage = 1;
    this.renderSidebar();
    this.renderFileList();
  }

  _updateFilterTitle() {
    const titleEl = document.getElementById('current-view-title');
    const breadcrumb = document.getElementById('tag-breadcrumb');

    if (this.filterNoTag) {
      titleEl.textContent = '无标签文件';
      breadcrumb.style.display = 'none';
    } else if (this.activeTags.size === 0) {
      titleEl.textContent = '全部文件';
      breadcrumb.style.display = 'none';
    } else if (this.activeTags.size === 1) {
      titleEl.textContent = '';
      this.renderBreadcrumb([...this.activeTags][0]);
    } else {
      titleEl.textContent = `已选 ${this.activeTags.size} 个标签`;
      breadcrumb.style.display = 'none';
    }
  }

  renderBreadcrumb(tag) {
    const breadcrumb = document.getElementById('tag-breadcrumb');
    breadcrumb.style.display = 'flex';

    const parts = tag.split('/');
    let html = `<button class="breadcrumb-item" data-tag="__all__">全部</button>`;

    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/');
      const isLast = i === parts.length - 1;
      html += `<span class="breadcrumb-sep">/</span>`;
      html += `<button class="breadcrumb-item ${isLast ? 'active' : ''}" data-tag="${this.escapeHtml(path)}">${this.escapeHtml(parts[i])}</button>`;
    }

    breadcrumb.innerHTML = html;
    document.getElementById('current-view-title').textContent = '';

    breadcrumb.querySelectorAll('.breadcrumb-item').forEach((item) => {
      item.addEventListener('click', () => {
        this.setTagFilter(item.getAttribute('data-tag'));
      });
    });
  }

  // ==========================================
  // 搜索栏标签筛选
  // ==========================================

  _toggleSearchTagDropdown() {
    const dropdown = document.getElementById('search-tag-dropdown');
    const toggle = document.getElementById('search-tag-toggle');
    const filterInput = document.getElementById('search-tag-filter-input');

    if (dropdown.style.display !== 'none') {
      dropdown.style.display = 'none';
      toggle.classList.remove('active');
    } else {
      dropdown.style.display = 'flex';
      toggle.classList.add('active');
      filterInput.value = '';
      filterInput.focus();
      this._renderSearchTagList('');
    }
  }

  _renderSearchTagList(filterText) {
    const container = document.getElementById('search-tag-list');
    const allTags = this.tagManager.getAllTags();
    const counts = this.fileManager.getTagFileCounts();

    const tagColors = [
      '#3b82f6', '#10b981', '#f59e0b', '#ec4899',
      '#6366f1', '#a855f7', '#ef4444', '#14b8a6',
    ];

    // 按层级排序
    const sorted = [...allTags].sort((a, b) => a.name.localeCompare(b.name));

    // 过滤
    const filtered = filterText
      ? sorted.filter((t) => t.name.toLowerCase().includes(filterText))
      : sorted;

    if (filtered.length === 0) {
      container.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px;">没有匹配的标签</div>';
      return;
    }

    container.innerHTML = filtered.map((tag) => {
      const isSelected = this.searchTags.has(tag.name);
      const count = counts.get(tag.name) || 0;
      const depth = (tag.name.match(/\//g) || []).length;
      const displayName = this.tagManager.getDisplayName(tag.name);

      return `
        <div class="search-tag-option ${isSelected ? 'selected' : ''}" data-tag="${this.escapeHtml(tag.name)}" style="padding-left: ${12 + depth * 16}px;">
          <span class="tag-opt-check">
            ${isSelected ? '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="white" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>' : ''}
          </span>
          <span class="tag-opt-dot" style="background: ${tagColors[tag.color % 8]}"></span>
          <span class="tag-opt-name" title="${this.escapeHtml(tag.name)}">${this.escapeHtml(displayName)}</span>
          <span class="tag-opt-count">${count}</span>
        </div>
      `;
    }).join('');

    // 绑定点击事件
    container.querySelectorAll('.search-tag-option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const tagName = opt.getAttribute('data-tag');
        if (this.searchTags.has(tagName)) {
          this.searchTags.delete(tagName);
        } else {
          this.searchTags.add(tagName);
        }
        // 重新渲染列表更新选中状态
        const filterInput = document.getElementById('search-tag-filter-input');
        this._renderSearchTagList(filterInput.value.trim().toLowerCase());
        this._updateSearchTagChips();
        this.currentPage = 1;
        this.renderFileList();
      });
    });
  }

  _updateSearchTagChips() {
    const chipsContainer = document.getElementById('search-tag-chips');

    if (this.searchTags.size === 0) {
      chipsContainer.style.display = 'none';
      chipsContainer.innerHTML = '';
      return;
    }

    chipsContainer.style.display = 'flex';

    const tagColors = [
      '#3b82f6', '#10b981', '#f59e0b', '#ec4899',
      '#6366f1', '#a855f7', '#ef4444', '#14b8a6',
    ];

    let html = [...this.searchTags].map((tagName) => {
      const displayName = this.tagManager.getDisplayName(tagName);
      const tag = this.tagManager.getAllTags().find((t) => t.name === tagName);
      const color = tag ? tagColors[tag.color % 8] : tagColors[0];
      return `<span class="search-tag-chip" data-tag="${this.escapeHtml(tagName)}" style="border-left: 3px solid ${color};">
        <span class="chip-name">${this.escapeHtml(displayName)}</span>
        <span class="chip-remove" data-tag="${this.escapeHtml(tagName)}">&times;</span>
      </span>`;
    }).join('');

    // 添加清除全部按钮
    html += '<button class="search-tag-clear-all">清除</button>';

    chipsContainer.innerHTML = html;

    // 绑定移除单个标签
    chipsContainer.querySelectorAll('.chip-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tagName = btn.getAttribute('data-tag');
        this.searchTags.delete(tagName);
        this._updateSearchTagChips();
        // 如果下拉面板打开，更新选中状态
        const dropdown = document.getElementById('search-tag-dropdown');
        if (dropdown.style.display !== 'none') {
          const filterInput = document.getElementById('search-tag-filter-input');
          this._renderSearchTagList(filterInput.value.trim().toLowerCase());
        }
        this.currentPage = 1;
        this.renderFileList();
      });
    });

    // 绑定清除全部
    chipsContainer.querySelector('.search-tag-clear-all')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.searchTags.clear();
      this._updateSearchTagChips();
      const dropdown = document.getElementById('search-tag-dropdown');
      if (dropdown.style.display !== 'none') {
        const filterInput = document.getElementById('search-tag-filter-input');
        this._renderSearchTagList(filterInput.value.trim().toLowerCase());
      }
      this.currentPage = 1;
      this.renderFileList();
    });
  }

  // ==========================================
  // 文件标签管理弹窗
  // ==========================================

  showFileTagsModal(fileId) {
    this.editingFileId = fileId;
    const file = this.fileManager.files.find((f) => f.id === fileId);
    if (!file) return;

    // 记录树形展开状态（弹窗级别）—— 默认只展开文件已关联标签的祖先路径
    this._fileTagsExpanded = new Set();
    // 暂存选中的标签（用于确认时一次性保存）
    this._fileTagsSelected = new Set(file.tags);

    // 将已关联标签的所有祖先节点加入展开集合
    for (const tag of file.tags) {
      const parts = tag.split('/');
      for (let i = 1; i < parts.length; i++) {
        this._fileTagsExpanded.add(parts.slice(0, i).join('/'));
      }
    }

    document.getElementById('modal-file-tags-filename').textContent = file.name;
    this._renderFileTagsTree();
    this.openModal('modal-file-tags');
  }

  _renderFileTagsTree() {
    const container = document.getElementById('file-tags-tree');
    const selected = this._fileTagsSelected;

    const tagColors = [
      '#3b82f6', '#10b981', '#f59e0b', '#ec4899',
      '#6366f1', '#a855f7', '#ef4444', '#14b8a6',
    ];

    let html = '';

    const renderTree = (parentName, depth) => {
      const children = parentName
        ? this.tagManager.getChildTags(parentName)
        : this.tagManager.getRootTags();

      children.forEach((tag) => {
        const hasChildren = this.tagManager.getChildTags(tag.name).length > 0;
        const isExpanded = this._fileTagsExpanded.has(tag.name);
        const isChecked = selected.has(tag.name);
        const displayName = this.tagManager.getDisplayName(tag.name);

        html += `
          <div class="tag-tree-check-item ${isChecked ? 'checked' : ''}" style="padding-left: ${12 + depth * 20}px;" data-tag="${this.escapeHtml(tag.name)}">
            ${hasChildren
              ? `<span class="tag-tree-check-toggle ${isExpanded ? 'expanded' : ''}" data-toggle="${this.escapeHtml(tag.name)}">
                  <svg viewBox="0 0 24 24" width="14" height="14">
                    <path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
                  </svg>
                </span>`
              : `<span class="tag-tree-check-placeholder"></span>`
            }
            <span class="tag-tree-checkbox ${isChecked ? 'checked' : ''}">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path fill="white" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
              </svg>
            </span>
            <span class="tag-tree-check-label">${this.escapeHtml(displayName)}</span>
          </div>
        `;

        if (hasChildren && isExpanded) {
          renderTree(tag.name, depth + 1);
        }
      });
    };

    renderTree(null, 0);

    if (!html) {
      html = '<p class="no-tags-hint">暂无标签，请先创建标签</p>';
    }

    container.innerHTML = html;

    // 绑定展开/折叠事件
    container.querySelectorAll('.tag-tree-check-toggle').forEach((toggle) => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const tagName = toggle.getAttribute('data-toggle');
        if (this._fileTagsExpanded.has(tagName)) {
          this._fileTagsExpanded.delete(tagName);
        } else {
          this._fileTagsExpanded.add(tagName);
        }
        this._renderFileTagsTree();
      });
    });

    // 绑定选中/取消选中事件
    container.querySelectorAll('.tag-tree-check-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        // 如果点击的是展开按钮，不处理
        if (e.target.closest('.tag-tree-check-toggle')) return;
        const tagName = item.getAttribute('data-tag');
        if (this._fileTagsSelected.has(tagName)) {
          this._fileTagsSelected.delete(tagName);
        } else {
          this._fileTagsSelected.add(tagName);
        }
        this._renderFileTagsTree();
      });
    });
  }

  async _saveFileTagsSelection() {
    const file = this.fileManager.files.find((f) => f.id === this.editingFileId);
    if (!file) return;

    // 直接在内存中更新标签，然后保存一次
    file.tags = Array.from(this._fileTagsSelected);
    await this.fileManager.save();

    this.closeModal('modal-file-tags');
    this.showToast('标签已更新', 'success');
    this.render();
  }

  // ==========================================
  // 渲染
  // ==========================================

  render() {
    this.currentPage = 1;
    this.fileManager._invalidateCountsCache();
    this.updateSortButton();
    this.renderSidebar();
    this.renderFileList();
    this.renderFooter();
  }

  renderSidebar() {
    const container = document.getElementById('tag-filter-list');
    const counts = this.fileManager.getTagFileCounts();

    const tagColors = [
      '#3b82f6', '#10b981', '#f59e0b', '#ec4899',
      '#6366f1', '#a855f7', '#ef4444', '#14b8a6',
    ];

    // 判断一个标签名是否为时间标签（根级部分匹配 YYYYMMDD 或 YYYYMM 格式）
    const isTimeTag = (tagName) => {
      const root = tagName.split('/')[0];
      return /^\d{6,8}$/.test(root);
    };

    const isAllActive = this.activeTags.size === 0 && !this.filterNoTag;

    // 统计无标签文件数（根据当前标签显示模式）
    let noTagCount;
    if (this.tagDisplayMode === 'time') {
      // 时间模式下，没有时间标签的文件算"无标签"
      noTagCount = this.fileManager.files.filter((f) => !f.tags || !f.tags.some((t) => isTimeTag(t))).length;
    } else {
      // 自定义模式下，没有自定义标签的文件算"无标签"
      noTagCount = this.fileManager.files.filter((f) => !f.tags || !f.tags.some((t) => !isTimeTag(t))).length;
    }

    let html = `
      <button class="tag-nav-item ${isAllActive ? 'active' : ''}" data-tag="__all__">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path fill="currentColor" d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/>
        </svg>
        <span class="tag-nav-text">全部文件</span>
        <span class="tag-nav-count">${this.fileManager.files.length}</span>
      </button>
      <button class="tag-nav-item ${this.filterNoTag ? 'active' : ''}" data-tag="__no_tag__">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path fill="currentColor" d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z" opacity="0.4"/>
          <path fill="currentColor" d="M2.1 4.93l1.56 1.56C3.24 7.08 3 7.77 3 8.5c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.26 0 .51-.05.75-.15l1.56 1.56 1.41-1.41L3.51 3.51 2.1 4.93z" opacity="0.6"/>
        </svg>
        <span class="tag-nav-text">无标签</span>
        <span class="tag-nav-count">${noTagCount}</span>
      </button>
    `;

    const renderTagTree = (parentName, depth) => {
      const children = parentName
        ? this.tagManager.getChildTags(parentName)
        : this.tagManager.getRootTags();

      // 根据当前模式过滤根级标签
      const filteredChildren = (!parentName && this.tagDisplayMode !== 'all')
        ? children.filter((tag) => {
            const isTime = isTimeTag(tag.name);
            return this.tagDisplayMode === 'time' ? isTime : !isTime;
          })
        : children;

      filteredChildren.forEach((tag) => {
        const count = counts.get(tag.name) || 0;
        const displayName = this.tagManager.getDisplayName(tag.name);
        const hasChildren = this.tagManager.getChildTags(tag.name).length > 0;
        const isExpanded = this.expandedTags.has(tag.name);
        const isActive = this.activeTags.has(tag.name);

        html += `
          <div class="tag-tree-item" style="padding-left: ${depth * 16}px;">
            <button class="tag-nav-item ${isActive ? 'active' : ''}" data-tag="${this.escapeHtml(tag.name)}">
              ${hasChildren
                ? `<span class="tag-toggle ${isExpanded ? 'expanded' : ''}" data-toggle="${this.escapeHtml(tag.name)}">
                    <svg viewBox="0 0 24 24" width="14" height="14">
                      <path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
                    </svg>
                  </span>`
                : `<span class="tag-toggle-placeholder"></span>`
              }
              <span class="tag-nav-dot" style="background: ${tagColors[tag.color % 8]}"></span>
              <span class="tag-nav-text">${this.escapeHtml(displayName)}</span>
              <span class="tag-nav-count">${count}</span>
            </button>
          </div>
        `;

        if (hasChildren && isExpanded) {
          renderTagTree(tag.name, depth + 1);
        }
      });
    };

    renderTagTree(null, 0);
    container.innerHTML = html;

    // 绑定左键筛选（支持 Ctrl/Cmd 多选）
    container.querySelectorAll('.tag-nav-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.tag-toggle')) {
          e.stopPropagation();
          return;
        }
        const tag = item.getAttribute('data-tag');
        const isCtrl = e.ctrlKey || e.metaKey;
        // "全部文件"和"无标签"不支持 Ctrl 多选
        if (tag === '__all__' || tag === '__no_tag__') {
          this.setTagFilter(tag);
        } else {
          this.setTagFilter(tag, isCtrl);
        }
      });

      // 绑定右键菜单（除了"全部文件"和"无标签"）
      const tag = item.getAttribute('data-tag');
      if (tag && tag !== '__all__' && tag !== '__no_tag__') {
        item.addEventListener('contextmenu', (e) => {
          this.showContextMenu(e, tag);
        });
      }
    });

    // 绑定展开/收起
    container.querySelectorAll('.tag-toggle').forEach((toggle) => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const tagName = toggle.getAttribute('data-toggle');
        if (this.expandedTags.has(tagName)) {
          this.expandedTags.delete(tagName);
        } else {
          this.expandedTags.add(tagName);
        }
        this.renderSidebar();
      });
    });
  }

  renderFileList() {
    const container = document.getElementById('file-list');
    const allFilteredFiles = this.fileManager.getFilteredFiles(this.activeTags, this.filterNoTag, this.searchQuery, this.sortOrder, this.tagDisplayMode, this.searchTags);
    const currentIds = new Set(allFilteredFiles.map((f) => f.id));
    for (const id of this.selectedFiles) {
      if (!currentIds.has(id)) this.selectedFiles.delete(id);
    }

    if (allFilteredFiles.length === 0 && this.fileManager.files.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" width="64" height="64">
            <path fill="currentColor" opacity="0.2" d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z"/>
          </svg>
          <h3>还没有任何标签和文件</h3>
          <p>在左侧栏点击 "+" 新建标签</p>
          <p>右键标签可以新建子标签、添加文件</p>
          <p>也可以点击右上角 "添加文件" 并选择标签</p>
        </div>
      `;
      this.renderBatchBar(0, 0);
      this.renderPagination(0, 0);
      return;
    }

    if (allFilteredFiles.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" width="48" height="48">
            <path fill="currentColor" opacity="0.2" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
          </svg>
          <h3>没有找到匹配的文件</h3>
          <p>尝试更改筛选条件或搜索关键词</p>
        </div>
      `;
      this.renderBatchBar(0, 0);
      this.renderPagination(0, 0);
      return;
    }

    // 分页计算
    const totalFiles = allFilteredFiles.length;
    const totalPages = Math.ceil(totalFiles / this.pageSize);
    // 确保 currentPage 合法
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    if (this.currentPage < 1) this.currentPage = 1;

    const startIdx = (this.currentPage - 1) * this.pageSize;
    const endIdx = Math.min(startIdx + this.pageSize, totalFiles);
    const files = allFilteredFiles.slice(startIdx, endIdx);

    const groups = this.groupFilesByDate(files);
    let html = '';

    groups.forEach((group) => {
      html += `<div class="date-group-header">${group.label}</div>`;
      group.files.forEach((file) => {
        html += this.renderFileCard(file);
      });
    });

    container.innerHTML = html;

    // 绑定复选框
    container.querySelectorAll('.file-checkbox').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const fileId = cb.getAttribute('data-id');
        if (cb.checked) {
          this.selectedFiles.add(fileId);
        } else {
          this.selectedFiles.delete(fileId);
        }
        // 更新卡片选中样式
        const card = cb.closest('.file-card');
        if (card) card.classList.toggle('selected', cb.checked);
        this.renderBatchBar(this.selectedFiles.size, files.length);
      });
    });

    // 绑定卡片点击选中（点击卡片空白区域也能切换选中）
    container.querySelectorAll('.file-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        // 如果点击的是按钮或链接，不处理
        if (e.target.closest('.file-action-btn') || e.target.closest('.file-checkbox')) return;
        const cb = card.querySelector('.file-checkbox');
        if (cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        }
      });
    });

    // 绑定管理标签按钮
    container.querySelectorAll('.file-action-btn[data-action="tag"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showFileTagsModal(btn.getAttribute('data-id'));
      });
    });

    // 绑定打开文件按钮
    container.querySelectorAll('.file-action-btn[data-action="open"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fileId = btn.getAttribute('data-id');
        this.openFileById(fileId);
      });
    });

    // 绑定"选择打开方式"下拉箭头
    container.querySelectorAll('.file-action-btn[data-action="open-with-menu"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // 先关闭其他所有下拉菜单
        document.querySelectorAll('.open-with-dropdown').forEach((d) => d.style.display = 'none');
        document.querySelectorAll('.copy-dropdown').forEach((d) => d.style.display = 'none');
        const dropdown = btn.parentElement.querySelector('.open-with-dropdown');
        if (dropdown) {
          dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
        }
      });
    });

    // 绑定"选择打开方式"下拉菜单项
    container.querySelectorAll('.open-with-dropdown-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const app = item.getAttribute('data-app');
        const wrapper = item.closest('.open-dropdown-wrapper');
        const fileId = wrapper.querySelector('[data-action="open"]').getAttribute('data-id');
        item.closest('.open-with-dropdown').style.display = 'none';
        this.openFileById(fileId, app);
      });
    });

    // 绑定自定义应用搜索输入框
    container.querySelectorAll('.open-with-input').forEach((input) => {
      // 输入时触发模糊搜索
      input.addEventListener('input', (e) => {
        e.stopPropagation();
        const query = input.value.trim();
        const resultsDiv = input.closest('.open-with-search-wrap').querySelector('.open-with-search-results');
        if (!query) {
          resultsDiv.innerHTML = '';
          resultsDiv.style.display = 'none';
          return;
        }
        const matches = this.fuzzySearchApps(query);
        if (matches.length === 0) {
          // 没匹配到也显示一个"用 xxx 打开"的选项
          resultsDiv.innerHTML = `<button class="open-with-search-item" data-app="${this.escapeHtml(query)}">用 "${this.escapeHtml(query)}" 打开</button>`;
        } else {
          resultsDiv.innerHTML = matches.map(m =>
            `<button class="open-with-search-item" data-app="${this.escapeHtml(m.name)}">${this.highlightMatch(m.label, query)}</button>`
          ).join('');
          // 如果输入的不完全匹配任何结果，追加一个直接使用输入名的选项
          const exactMatch = matches.some(m => m.name.toLowerCase() === query.toLowerCase());
          if (!exactMatch) {
            resultsDiv.innerHTML += `<button class="open-with-search-item open-with-search-custom" data-app="${this.escapeHtml(query)}">用 "${this.escapeHtml(query)}" 打开</button>`;
          }
        }
        resultsDiv.style.display = 'block';
        // 绑定搜索结果点击
        resultsDiv.querySelectorAll('.open-with-search-item').forEach((item) => {
          item.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const app = item.getAttribute('data-app');
            const wrapper = item.closest('.open-dropdown-wrapper');
            const fileId = wrapper.querySelector('[data-action="open"]').getAttribute('data-id');
            item.closest('.open-with-dropdown').style.display = 'none';
            input.value = '';
            resultsDiv.innerHTML = '';
            resultsDiv.style.display = 'none';
            this.openFileById(fileId, app);
          });
        });
      });
      // 回车直接用输入的应用名打开
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const appName = input.value.trim();
          if (!appName) return;
          const wrapper = input.closest('.open-dropdown-wrapper');
          const fileId = wrapper.querySelector('[data-action="open"]').getAttribute('data-id');
          input.closest('.open-with-dropdown').style.display = 'none';
          const resultsDiv = input.closest('.open-with-search-wrap').querySelector('.open-with-search-results');
          input.value = '';
          resultsDiv.innerHTML = '';
          resultsDiv.style.display = 'none';
          this.openFileById(fileId, appName);
        }
      });
      // 阻止事件冒泡，防止输入时触发其他快捷键
      input.addEventListener('click', (e) => e.stopPropagation());
    });

    // 绑定在 Finder 中显示按钮
    container.querySelectorAll('.file-action-btn[data-action="reveal"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fileId = btn.getAttribute('data-id');
        this.revealFileById(fileId);
      });
    });

    // 绑定在终端中打开按钮（默认终端）
    container.querySelectorAll('.file-action-btn[data-action="terminal"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fileId = btn.getAttribute('data-id');
        this.openTerminalById(fileId);
      });
    });

    // 绑定终端下拉箭头
    container.querySelectorAll('.file-action-btn[data-action="terminal-menu"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // 先关闭其他所有下拉菜单
        document.querySelectorAll('.terminal-dropdown').forEach((d) => d.style.display = 'none');
        document.querySelectorAll('.open-with-dropdown').forEach((d) => d.style.display = 'none');
        document.querySelectorAll('.copy-dropdown').forEach((d) => d.style.display = 'none');
        const dropdown = btn.parentElement.querySelector('.terminal-dropdown');
        if (dropdown) {
          dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
        }
      });
    });

    // 绑定终端下拉菜单项（默认选项）
    container.querySelectorAll('.terminal-dropdown-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const termApp = item.getAttribute('data-terminal');
        const wrapper = item.closest('.terminal-dropdown-wrapper');
        const fileId = wrapper.querySelector('[data-action="terminal"]').getAttribute('data-id');
        item.closest('.terminal-dropdown').style.display = 'none';
        this.openTerminalById(fileId, termApp);
      });
    });

    // 绑定终端搜索输入框
    container.querySelectorAll('.terminal-search-input').forEach((input) => {
      input.addEventListener('input', (e) => {
        e.stopPropagation();
        const query = input.value.trim();
        const resultsDiv = input.closest('.terminal-search-wrap').querySelector('.terminal-search-results');
        if (!query) {
          resultsDiv.innerHTML = '';
          resultsDiv.style.display = 'none';
          return;
        }
        const matches = this.fuzzySearchApps(query);
        if (matches.length === 0) {
          resultsDiv.innerHTML = `<button class="terminal-search-item" data-terminal="${this.escapeHtml(query)}">用 "${this.escapeHtml(query)}" 打开</button>`;
        } else {
          resultsDiv.innerHTML = matches.map(m =>
            `<button class="terminal-search-item" data-terminal="${this.escapeHtml(m.name)}">${this.highlightMatch(m.label, query)}</button>`
          ).join('');
          const exactMatch = matches.some(m => m.name.toLowerCase() === query.toLowerCase());
          if (!exactMatch) {
            resultsDiv.innerHTML += `<button class="terminal-search-item terminal-search-custom" data-terminal="${this.escapeHtml(query)}">用 "${this.escapeHtml(query)}" 打开</button>`;
          }
        }
        resultsDiv.style.display = 'block';
        resultsDiv.querySelectorAll('.terminal-search-item').forEach((item) => {
          item.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const termApp = item.getAttribute('data-terminal');
            const wrapper = item.closest('.terminal-dropdown-wrapper');
            const fileId = wrapper.querySelector('[data-action="terminal"]').getAttribute('data-id');
            item.closest('.terminal-dropdown').style.display = 'none';
            input.value = '';
            resultsDiv.innerHTML = '';
            resultsDiv.style.display = 'none';
            this.openTerminalById(fileId, termApp);
          });
        });
      });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const appName = input.value.trim();
          if (!appName) return;
          const wrapper = input.closest('.terminal-dropdown-wrapper');
          const fileId = wrapper.querySelector('[data-action="terminal"]').getAttribute('data-id');
          input.closest('.terminal-dropdown').style.display = 'none';
          const resultsDiv = input.closest('.terminal-search-wrap').querySelector('.terminal-search-results');
          input.value = '';
          resultsDiv.innerHTML = '';
          resultsDiv.style.display = 'none';
          this.openTerminalById(fileId, appName);
        }
      });
      input.addEventListener('click', (e) => e.stopPropagation());
    });

    // 绑定复制下拉菜单
    container.querySelectorAll('.file-action-btn[data-action="copy-menu"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // 先关闭其他所有下拉菜单
        document.querySelectorAll('.copy-dropdown').forEach((d) => d.style.display = 'none');
        const dropdown = btn.parentElement.querySelector('.copy-dropdown');
        if (dropdown) {
          dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
        }
      });
    });

    // 绑定复制下拉菜单项
    container.querySelectorAll('.copy-dropdown-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = item.closest('.file-card');
        const copyType = item.getAttribute('data-copy-type');
        let text = '';
        if (copyType === 'fullpath') {
          text = card?.getAttribute('data-filepath') || '';
        } else if (copyType === 'dirpath') {
          text = card?.getAttribute('data-dirpath') || '';
        } else if (copyType === 'filename') {
          text = card?.getAttribute('data-filename') || '';
        }
        if (text) {
          navigator.clipboard.writeText(text).then(() => {
            const labels = { fullpath: '全路径', dirpath: '目录路径', filename: '文件名' };
            this.showToast(`已复制${labels[copyType] || ''}`, 'success');
          });
        } else {
          this.showToast('无法获取路径信息', 'error');
        }
        // 关闭下拉菜单
        item.closest('.copy-dropdown').style.display = 'none';
      });
    });

    // 绑定移除文件按钮
    container.querySelectorAll('.file-action-btn[data-action="remove"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const fileId = btn.getAttribute('data-id');
        await this.fileManager.removeFile(fileId);
        this.selectedFiles.delete(fileId);
        this.showToast('文件记录已移除', 'info');
        this.render();
      });
    });

    this.renderBatchBar(this.selectedFiles.size, totalFiles);

    // 渲染分页控件
    this.renderPagination(totalFiles, totalPages);

    // 异步加载文件详细信息（大小、创建时间等）
    this.loadFileInfoForVisibleCards();
  }

  // ==========================================
  // 批量操作栏
  // ==========================================

  renderBatchBar(selectedCount, totalCount) {
    const bar = document.getElementById('batch-bar');
    if (!bar) return;

    if (selectedCount === 0) {
      bar.style.display = 'none';
      return;
    }

    bar.style.display = 'flex';
    document.getElementById('batch-selected-count').textContent = `已选择 ${selectedCount} 个文件`;

    const isAllSelected = selectedCount === totalCount && totalCount > 0;
    const selectAllBtn = document.getElementById('btn-batch-select-all');
    if (selectAllBtn) {
      selectAllBtn.textContent = isAllSelected ? '取消全选' : '全选';
    }
  }

  // ==========================================
  // 文件路径推算与操作
  // ==========================================

  /**
   * 获取文件的绝对路径（用于显示）
   * 优先使用文件记录中存储的真实 path，没有时从标签推算（仅供显示参考，不可靠）
   */
  getFilePath(file) {
    if (!file) return '';

    // 优先使用文件记录中存储的真实绝对路径
    if (file.path) return file.path;

    // 回退：从标签推算路径（仅供显示参考）
    if (!file.tags) return file.name;

    // 找到非日期标签中最长的路径标签（它最能表达文件的目录位置）
    const isDateTag = (t) => /^\d{6,8}$/.test(t.split('/')[0]);
    const dirTags = file.tags.filter((t) => !isDateTag(t));

    if (dirTags.length === 0) return file.name;

    // 找最深层的目录标签
    let bestTag = '';
    let bestDepth = -1;
    for (const tag of dirTags) {
      const depth = (tag.match(/\//g) || []).length;
      if (depth > bestDepth) {
        bestDepth = depth;
        bestTag = tag;
      }
    }

    // 标签路径就是目录路径，加上文件名
    if (bestTag) {
      return '/' + bestTag + '/' + file.name;
    }

    return file.name;
  }

  /**
   * 获取选中文件的路径列表
   */
  getSelectedFilePaths() {
    const paths = [];
    for (const fileId of this.selectedFiles) {
      const file = this.fileManager.files.find((f) => f.id === fileId);
      if (file) {
        paths.push(this.getFilePath(file));
      }
    }
    return paths;
  }

  /**
   * 获取选中文件的名称列表
   */
  getSelectedFileNames() {
    const names = [];
    for (const fileId of this.selectedFiles) {
      const file = this.fileManager.files.find((f) => f.id === fileId);
      if (file) {
        names.push(file.name);
      }
    }
    return names;
  }

  /**
   * 发送 Native Messaging 消息（通过 background.js 中转）
   */
  sendNativeAction(action, data = {}) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        reject(new Error('当前环境不支持 Native Messaging'));
        return;
      }
      chrome.runtime.sendMessage(
        { action, ...data },
        (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (resp && resp.error) {
            reject(new Error(resp.error));
          } else {
            resolve(resp);
          }
        }
      );
    });
  }

  /**
   * 用默认程序或指定应用打开文件
   * @param {string} fileId 文件ID
   * @param {string} [app] 可选，指定打开的应用名称
   */
  async openFileById(fileId, app) {
    const file = this.fileManager.files.find((f) => f.id === fileId);
    if (!file) return;

    const filePath = this.getFilePath(file);
    if (!filePath || filePath === file.name) {
      this.showToast('无法确定文件的完整路径', 'error');
      return;
    }

    // 没有真实路径（只有标签推算路径），提示用户
    if (!file.path) {
      this.showToast('未记录真实路径（旧数据），请重新导入该目录以记录路径', 'error');
      return;
    }

    try {
      const data = { path: filePath };
      if (app) data.app = app;
      await this.sendNativeAction('openFile', data);
      const appHint = app ? ` (${app})` : '';
      this.showToast(`已打开: ${file.name}${appHint}`, 'success');
    } catch (err) {
      console.error('打开文件失败:', err);
      if (err.message && err.message.includes('不存在')) {
        this.showToast(`文件已不存在: ${filePath}（可能已被移动或删除）`, 'error');
      } else {
        this.showToast(`打开失败: ${err.message}`, 'error');
      }
    }
  }

  /**
   * 获取文件所在目录路径（不含文件名）
   * 仅在有真实 path 时才返回，没有 path 时返回空（标签推算路径不可靠）
   */
  getFileDirPath(file) {
    if (!file) return '';

    // 只有真实路径才可靠
    if (file.path) {
      const lastSlash = file.path.lastIndexOf('/');
      return lastSlash > 0 ? file.path.substring(0, lastSlash) : '/';
    }

    return '';
  }

  /**
   * 在 Finder 中打开文件所在目录
   * 如果目录不存在，则逐级向上找到最近的存在的父目录并打开
   */
  async revealFileById(fileId) {
    const file = this.fileManager.files.find((f) => f.id === fileId);
    if (!file) return;

    const dirPath = this.getFileDirPath(file);
    if (!dirPath) {
      this.showToast('未记录真实路径（旧数据），请重新导入该目录以记录路径', 'error');
      return;
    }

    try {
      // 先尝试打开精确目录，如果失败，逐级向上找存在的父目录
      await this.sendNativeAction('revealInFinder', { path: dirPath });
      this.showToast(`已打开目录: ${dirPath}`, 'success');
    } catch (err) {
      console.error('打开目录失败:', err);
      // 目录不存在时，尝试逐级向上找到存在的父目录
      const parentDir = await this._findExistingParentDir(dirPath);
      if (parentDir) {
        try {
          await this.sendNativeAction('revealInFinder', { path: parentDir });
          this.showToast(`原目录已不存在，已打开上级目录: ${parentDir}`, 'info');
          return;
        } catch (e) {
          // 上级也打不开，报错
        }
      }
      this.showToast(`目录不存在: ${dirPath}（文件可能已被移动或删除）`, 'error');
    }
  }

  /**
   * 逐级向上查找存在的父目录
   */
  async _findExistingParentDir(dirPath) {
    let current = dirPath;
    // 最多往上找 10 级，防止死循环
    for (let i = 0; i < 10; i++) {
      const lastSlash = current.lastIndexOf('/');
      if (lastSlash <= 0) return null; // 到根目录了
      current = current.substring(0, lastSlash);
      if (!current) return null;
      try {
        // 用 listDir 来检测目录是否存在
        const resp = await this.sendNativeAction('listDir', { path: current });
        if (resp && !resp.error) {
          return current;
        }
      } catch (e) {
        // 这一级也不存在，继续往上
        continue;
      }
    }
    return null;
  }

  /**
   * 在文件所在目录打开终端
   * @param {string} fileId 文件ID
   * @param {string} [termApp='Terminal'] 终端应用名
   */
  async openTerminalById(fileId, termApp = 'Terminal') {
    const file = this.fileManager.files.find((f) => f.id === fileId);
    if (!file) return;

    const dirPath = this.getFileDirPath(file);
    if (!dirPath) {
      this.showToast('未记录真实路径（旧数据），请重新导入该目录以记录路径', 'error');
      return;
    }

    try {
      await this.sendNativeAction('openTerminal', { path: dirPath, app: termApp });
      this.showToast(`已在 ${termApp} 中打开: ${dirPath}`, 'success');
    } catch (err) {
      console.error('打开终端失败:', err);
      this.showToast(`打开终端失败: ${err.message}`, 'error');
    }
  }

  /**
   * 批量在终端中打开选中文件的目录
   * 自动去重（多个文件在同一目录只打开一次）
   * @param {string} [termApp='Terminal'] 终端应用名
   */
  async batchOpenTerminal(termApp = 'Terminal') {
    if (this.selectedFiles.size === 0) return;

    // 收集所有目录路径并去重
    const dirPaths = new Set();
    let noPathCount = 0;
    for (const fileId of this.selectedFiles) {
      const file = this.fileManager.files.find((f) => f.id === fileId);
      if (!file) continue;
      if (!file.path) { noPathCount++; continue; }
      const dirPath = this.getFileDirPath(file);
      if (dirPath) dirPaths.add(dirPath);
    }

    if (dirPaths.size === 0) {
      if (noPathCount > 0) {
        this.showToast(`${noPathCount} 个文件未记录真实路径，请重新导入`, 'error');
      } else {
        this.showToast('没有可打开的目录', 'error');
      }
      return;
    }

    if (dirPaths.size > 5) {
      if (!confirm(`将在 ${termApp} 中打开 ${dirPaths.size} 个不同的目录，确定继续？`)) return;
    }

    let successCount = 0;
    for (const dirPath of dirPaths) {
      try {
        await this.sendNativeAction('openTerminal', { path: dirPath, app: termApp });
        successCount++;
      } catch (err) {
        console.warn('打开终端失败:', err);
      }
    }

    if (successCount > 0) {
      let msg = `已在 ${termApp} 中打开 ${successCount} 个目录`;
      if (noPathCount > 0) msg += `，${noPathCount} 个文件未记录路径`;
      this.showToast(msg, 'success');
    } else {
      this.showToast('打开终端失败', 'error');
    }
  }

  /**
   * 批量打开选中的文件
   * @param {string} [app] 可选，指定打开的应用名称
   */
  async batchOpenFiles(app) {
    if (this.selectedFiles.size === 0) return;

    if (this.selectedFiles.size > 10) {
      if (!confirm(`确定要打开 ${this.selectedFiles.size} 个文件吗？`)) return;
    }

    let successCount = 0;
    let noPathCount = 0;
    for (const fileId of this.selectedFiles) {
      try {
        const file = this.fileManager.files.find((f) => f.id === fileId);
        if (!file) continue;
        if (!file.path) { noPathCount++; continue; }
        const data = { path: file.path };
        if (app) data.app = app;
        await this.sendNativeAction('openFile', data);
        successCount++;
      } catch (err) {
        console.warn('打开文件失败:', err);
      }
    }

    if (successCount > 0) {
      const appHint = app ? ` (${app})` : '';
      let msg = `已打开 ${successCount} 个文件${appHint}`;
      if (noPathCount > 0) msg += `，${noPathCount} 个文件未记录路径`;
      this.showToast(msg, 'success');
    } else if (noPathCount > 0) {
      this.showToast(`${noPathCount} 个文件未记录真实路径，请重新导入`, 'error');
    } else {
      this.showToast('没有可以打开的文件', 'error');
    }
  }

  /**
   * 批量在 Finder 中显示
   */
  async batchRevealFiles() {
    if (this.selectedFiles.size === 0) return;

    // 只显示第一个文件（多个文件逐个打开 Finder 体验不好）
    const firstId = this.selectedFiles.values().next().value;
    await this.revealFileById(firstId);
  }

  /**
   * 批量复制（根据类型）
   */
  batchCopyByType(copyType) {
    if (this.selectedFiles.size === 0) return;
    let items = [];
    const labels = { fullpath: '全路径', dirpath: '目录路径', filename: '文件名' };
    for (const fileId of this.selectedFiles) {
      const file = this.fileManager.files.find((f) => f.id === fileId);
      if (!file) continue;
      if (copyType === 'fullpath') {
        items.push(this.getFilePath(file));
      } else if (copyType === 'dirpath') {
        items.push(this.getFileDirPath(file));
      } else if (copyType === 'filename') {
        items.push(file.name);
      }
    }
    items = items.filter(Boolean);
    if (items.length === 0) {
      this.showToast('无法获取路径信息', 'error');
      return;
    }
    // 去重（目录路径可能重复）
    if (copyType === 'dirpath') {
      items = [...new Set(items)];
    }
    navigator.clipboard.writeText(items.join('\n')).then(() => {
      this.showToast(`已复制 ${items.length} 条${labels[copyType] || ''}`, 'success');
    });
  }

  /**
   * 批量复制文件路径（保留兼容）
   */
  batchCopyPaths() {
    this.batchCopyByType('fullpath');
  }

  /**
   * 批量复制文件名（保留兼容）
   */
  batchCopyNames() {
    this.batchCopyByType('filename');
  }

  selectAllFiles() {
    const allFilteredFiles = this.fileManager.getFilteredFiles(this.activeTags, this.filterNoTag, this.searchQuery, this.sortOrder, this.tagDisplayMode, this.searchTags);
    // 只选当前页的文件
    const startIdx = (this.currentPage - 1) * this.pageSize;
    const endIdx = Math.min(startIdx + this.pageSize, allFilteredFiles.length);
    const pageFiles = allFilteredFiles.slice(startIdx, endIdx);

    const pageIds = new Set(pageFiles.map((f) => f.id));
    const allSelected = pageFiles.length > 0 && pageFiles.every((f) => this.selectedFiles.has(f.id));

    if (allSelected) {
      // 取消当前页全选
      for (const id of pageIds) {
        this.selectedFiles.delete(id);
      }
    } else {
      // 全选当前页
      pageFiles.forEach((f) => this.selectedFiles.add(f.id));
    }

    // 刷新复选框和卡片样式
    document.querySelectorAll('.file-card').forEach((card) => {
      const id = card.getAttribute('data-id');
      const cb = card.querySelector('.file-checkbox');
      const isSelected = this.selectedFiles.has(id);
      if (cb) cb.checked = isSelected;
      card.classList.toggle('selected', isSelected);
    });

    this.renderBatchBar(this.selectedFiles.size, files.length);
  }

  async batchRemoveFiles() {
    if (this.selectedFiles.size === 0) return;

    const count = this.selectedFiles.size;
    for (const fileId of this.selectedFiles) {
      await this.fileManager.removeFile(fileId);
    }
    this.selectedFiles.clear();
    this.showToast(`已移除 ${count} 个文件记录`, 'info');
    this.render();
  }

  showBatchAddTagModal() {
    if (this.selectedFiles.size === 0) return;
    this._batchAction = 'add';
    this.renderBatchTagSelect();
    document.getElementById('batch-tag-modal-title').textContent = `批量添加标签（${this.selectedFiles.size} 个文件）`;
    this.openModal('modal-batch-tag');
  }

  showBatchRemoveTagModal() {
    if (this.selectedFiles.size === 0) return;
    this._batchAction = 'remove';
    this.renderBatchTagSelect();
    document.getElementById('batch-tag-modal-title').textContent = `批量移除标签（${this.selectedFiles.size} 个文件）`;
    this.openModal('modal-batch-tag');
  }

  renderBatchTagSelect() {
    const container = document.getElementById('batch-tag-select');
    const allTags = this.tagManager.getAllTags();
    const isRemoveMode = this._batchAction === 'remove';

    if (allTags.length === 0) {
      container.innerHTML = '<p class="no-tags-hint">还没有标签</p>';
      return;
    }

    // 移除模式下添加提示区域
    const warningHtml = isRemoveMode
      ? `<div id="batch-tag-warning" class="batch-tag-warning" style="display:none;">
           <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
           <span id="batch-tag-warning-text"></span>
         </div>`
      : '';

    container.innerHTML = warningHtml + allTags.map((t) => {
      const depth = (t.name.match(/\//g) || []).length;
      return `
        <label class="tag-select-item" style="padding-left: ${8 + depth * 16}px;">
          <input type="checkbox" value="${this.escapeHtml(t.name)}">
          <span>${this.escapeHtml(t.name)}</span>
        </label>
      `;
    }).join('');

    // 移除模式：勾选父标签时自动勾选所有子标签并提示
    if (isRemoveMode) {
      container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const tagName = cb.value;
          const prefix = tagName + '/';

          if (cb.checked) {
            // 找到所有子标签并自动勾选
            const childCbs = [];
            container.querySelectorAll('input[type="checkbox"]').forEach((otherCb) => {
              if (otherCb.value.startsWith(prefix)) {
                otherCb.checked = true;
                otherCb.disabled = true;
                otherCb.closest('.tag-select-item')?.classList.add('auto-checked');
                childCbs.push(otherCb);
              }
            });

            // 显示子标签数量提示
            this._updateBatchTagWarning(container);
          } else {
            // 取消勾选时，解除所有子标签的自动勾选状态
            container.querySelectorAll('input[type="checkbox"]').forEach((otherCb) => {
              if (otherCb.value.startsWith(prefix)) {
                // 检查是否还有其他父标签选中了它
                const stillLocked = this._isLockedByAnotherParent(container, otherCb.value, tagName);
                if (!stillLocked) {
                  otherCb.checked = false;
                  otherCb.disabled = false;
                  otherCb.closest('.tag-select-item')?.classList.remove('auto-checked');
                }
              }
            });

            this._updateBatchTagWarning(container);
          }
        });
      });
    }
  }

  /** 检查子标签是否被其他已选中的父标签锁定 */
  _isLockedByAnotherParent(container, childTag, excludeParent) {
    const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
    for (const cb of checkboxes) {
      if (cb.value === excludeParent) continue;
      if (cb.disabled) continue; // 被锁定的不算
      if (childTag.startsWith(cb.value + '/')) return true;
    }
    return false;
  }

  /** 更新移除标签的警告提示 */
  _updateBatchTagWarning(container) {
    const warning = document.getElementById('batch-tag-warning');
    const warningText = document.getElementById('batch-tag-warning-text');
    if (!warning || !warningText) return;

    // 统计被自动勾选（因为父标签选中）的子标签数量
    const autoChecked = container.querySelectorAll('.tag-select-item.auto-checked');
    if (autoChecked.length > 0) {
      const parentTags = [];
      container.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)').forEach((cb) => {
        // 找有子标签被自动选中的父标签
        const hasAutoChild = container.querySelector(`.tag-select-item.auto-checked input[value^="${CSS.escape(cb.value + '/')}"]`);
        if (hasAutoChild) {
          parentTags.push(this.tagManager.getDisplayName(cb.value));
        }
      });

      warningText.textContent = `移除父标签时，其下 ${autoChecked.length} 个子标签也会被一并移除`;
      warning.style.display = 'flex';
    } else {
      warning.style.display = 'none';
    }
  }

  async confirmBatchTag() {
    const container = document.getElementById('batch-tag-select');
    // 获取所有被选中的标签（包括自动勾选的子标签）
    const checked = Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value);

    if (checked.length === 0) {
      this.showToast('请至少选择一个标签', 'error');
      return;
    }

    const action = this._batchAction;
    const checkedSet = new Set(checked);
    let count = 0;

    // 在内存中批量修改，避免每次都写入存储
    for (const fileId of this.selectedFiles) {
      const file = this.fileManager.files.find((f) => f.id === fileId);
      if (!file) continue;

      if (action === 'add') {
        for (const tagName of checked) {
          if (!file.tags.includes(tagName)) {
            file.tags.push(tagName);
          }
        }
      } else {
        file.tags = file.tags.filter((t) => !checkedSet.has(t));
      }
      count++;
    }

    // 只保存一次到存储
    await this.fileManager.save();

    this.closeModal('modal-batch-tag');
    const actionText = action === 'add' ? '添加' : '移除';
    // 统计手动选择的和自动附带的
    const manualCount = Array.from(container.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)')).length;
    const autoCount = checked.length - manualCount;
    let tagMsg = checked.length <= 3 ? checked.join('、') : `${manualCount} 个标签`;
    if (autoCount > 0 && action === 'remove') {
      tagMsg += `（含 ${autoCount} 个子标签）`;
    }
    this.showToast(`已为 ${count} 个文件${actionText}${tagMsg}`, 'success');
    this.selectedFiles.clear();
    this.render();
  }

  renderFileCard(file) {
    const ext = this.getFileExtension(file.name);
    const iconClass = this.getIconClass(ext);
    const time = this.formatTime(file.addedTime);
    const isSelected = this.selectedFiles.has(file.id);
    const tagsHtml = file.tags.map((tag) => {
      const color = this.tagManager.getTagColor(tag);
      return `<span class="file-tag color-${color}">${this.escapeHtml(tag)}</span>`;
    }).join('');

    // 推算文件的完整路径（从标签中获取目录信息，仅供显示）
    const filePath = this.getFilePath(file);
    // 真实目录路径（只在有 file.path 时才有值）
    const dirPath = this.getFileDirPath(file);

    return `
      <div class="file-card ${isSelected ? 'selected' : ''}" data-id="${file.id}" data-filepath="${this.escapeHtml(filePath)}" data-dirpath="${this.escapeHtml(dirPath)}" data-filename="${this.escapeHtml(file.name)}">
        <input type="checkbox" class="file-checkbox" data-id="${file.id}" ${isSelected ? 'checked' : ''} />
        <div class="file-icon ${iconClass}">
          ${this.getFileEmoji(ext)}
        </div>
        <div class="file-info">
          <div class="file-name" title="${this.escapeHtml(filePath || file.name)}">${this.escapeHtml(file.name)}</div>
          <div class="file-meta">
            <span class="file-time">${time}</span>
            ${filePath ? `<span class="file-path-hint" title="${this.escapeHtml(filePath)}">${this.escapeHtml(filePath)}</span>` : ''}
          </div>
          <div class="file-details">${this.fileInfoCache[filePath] ? '' : '<span class="file-detail-loading">加载文件信息…</span>'}</div>
          ${tagsHtml ? `<div class="file-tags">${tagsHtml}</div>` : ''}
        </div>
        <div class="file-actions">
          <div class="open-dropdown-wrapper">
            <button class="file-action-btn" data-action="open" data-id="${file.id}" title="打开文件">
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path fill="currentColor" d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/>
              </svg>
            </button>
            <button class="file-action-btn open-with-arrow" data-action="open-with-menu" data-id="${file.id}" title="选择打开方式">
              <svg viewBox="0 0 24 24" width="10" height="10">
                <path fill="currentColor" d="M7 10l5 5 5-5z"/>
              </svg>
            </button>
            <div class="open-with-dropdown" style="display:none;">
              <div class="open-with-dropdown-label">打开方式</div>
              ${this.getOpenWithApps(ext).map(a => `<button class="open-with-dropdown-item" data-app="${a.app}">${this.escapeHtml(a.label)}</button>`).join('')}
              <div class="open-with-divider"></div>
              <div class="open-with-search-wrap">
                <input type="text" class="open-with-input" placeholder="搜索应用…" />
                <div class="open-with-search-results"></div>
              </div>
            </div>
          </div>
          <button class="file-action-btn" data-action="reveal" data-id="${file.id}" title="打开所在目录">
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/>
            </svg>
          </button>
          <div class="terminal-dropdown-wrapper">
            <button class="file-action-btn" data-action="terminal" data-id="${file.id}" title="在终端中打开">
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10zm-8-2h6v-2h-6v2zM7.5 17l1.41-1.41L6.33 13l2.59-2.59L7.51 9l-4 4 3.99 4z"/>
              </svg>
            </button>
            <button class="file-action-btn terminal-arrow" data-action="terminal-menu" data-id="${file.id}" title="选择应用">
              <svg viewBox="0 0 24 24" width="10" height="10">
                <path fill="currentColor" d="M7 10l5 5 5-5z"/>
              </svg>
            </button>
            <div class="terminal-dropdown" style="display:none;">
              <div class="terminal-dropdown-label">应用</div>
              <button class="terminal-dropdown-item" data-terminal="Terminal">终端 (Terminal)</button>
              <div class="open-with-divider"></div>
              <div class="terminal-search-wrap">
                <input type="text" class="terminal-search-input" placeholder="搜索应用…" />
                <div class="terminal-search-results"></div>
              </div>
            </div>
          </div>
          <div class="copy-dropdown-wrapper">
            <button class="file-action-btn" data-action="copy-menu" data-id="${file.id}" title="复制">
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
              </svg>
            </button>
            <div class="copy-dropdown" style="display:none;">
              <button class="copy-dropdown-item" data-copy-type="fullpath">复制全路径</button>
              <button class="copy-dropdown-item" data-copy-type="dirpath">复制目录路径</button>
              <button class="copy-dropdown-item" data-copy-type="filename">复制文件名</button>
            </div>
          </div>
          <button class="file-action-btn" data-action="tag" data-id="${file.id}" title="管理标签">
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path fill="currentColor" d="M17.63 5.84C17.27 5.33 16.67 5 16 5L5 5.01C3.9 5.01 3 5.9 3 7v10c0 1.1.9 1.99 2 1.99L16 19c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z"/>
            </svg>
          </button>
          <button class="file-action-btn danger" data-action="remove" data-id="${file.id}" title="移除文件记录">
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  }

  renderPagination(totalFiles, totalPages) {
    const bar = document.getElementById('pagination-bar');
    if (!bar) return;

    if (totalPages <= 1) {
      bar.style.display = 'none';
      return;
    }

    bar.style.display = 'flex';

    const startIdx = (this.currentPage - 1) * this.pageSize + 1;
    const endIdx = Math.min(this.currentPage * this.pageSize, totalFiles);

    // 生成页码按钮（最多显示 7 个页码）
    let pageButtons = '';
    const maxVisible = 7;
    let startPage = Math.max(1, this.currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) {
      startPage = Math.max(1, endPage - maxVisible + 1);
    }

    if (startPage > 1) {
      pageButtons += `<button class="page-btn" data-page="1">1</button>`;
      if (startPage > 2) pageButtons += `<span class="page-ellipsis">...</span>`;
    }

    for (let i = startPage; i <= endPage; i++) {
      const active = i === this.currentPage ? ' active' : '';
      pageButtons += `<button class="page-btn${active}" data-page="${i}">${i}</button>`;
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) pageButtons += `<span class="page-ellipsis">...</span>`;
      pageButtons += `<button class="page-btn" data-page="${totalPages}">${totalPages}</button>`;
    }

    bar.innerHTML = `
      <span class="pagination-info">显示 ${startIdx}-${endIdx} / 共 ${totalFiles} 个文件</span>
      <div class="pagination-controls">
        <button class="page-btn page-nav" data-page="${this.currentPage - 1}" ${this.currentPage <= 1 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
        </button>
        ${pageButtons}
        <button class="page-btn page-nav" data-page="${this.currentPage + 1}" ${this.currentPage >= totalPages ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
        </button>
      </div>
      <div class="pagination-jump">
        <span>每页</span>
        <select class="page-size-select">
          <option value="100" ${this.pageSize === 100 ? 'selected' : ''}>100</option>
          <option value="200" ${this.pageSize === 200 ? 'selected' : ''}>200</option>
          <option value="500" ${this.pageSize === 500 ? 'selected' : ''}>500</option>
          <option value="1000" ${this.pageSize === 1000 ? 'selected' : ''}>1000</option>
        </select>
        <span>条</span>
      </div>
    `;

    // 绑定页码按钮
    bar.querySelectorAll('.page-btn[data-page]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const page = parseInt(btn.getAttribute('data-page'));
        if (page >= 1 && page <= totalPages && page !== this.currentPage) {
          this.goToPage(page);
        }
      });
    });

    // 绑定每页条数选择
    bar.querySelector('.page-size-select')?.addEventListener('change', (e) => {
      this.pageSize = parseInt(e.target.value);
      this.currentPage = 1;
      this.renderFileList();
      // 滚动到顶部
      document.getElementById('file-grid-container')?.scrollTo(0, 0);
    });
  }

  goToPage(page) {
    this.currentPage = page;
    this.renderFileList();
    // 滚动到顶部
    document.getElementById('file-grid-container')?.scrollTo(0, 0);
  }

  renderFooter() {
    document.getElementById('file-count').textContent = `${this.fileManager.files.length} 个文件`;
    document.getElementById('tag-count').textContent = `${this.tagManager.getAllTags().length} 个标签`;
  }

  // ==========================================
  // 工具方法
  // ==========================================

  groupFilesByDate(files) {
    const groups = new Map();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    files.forEach((file) => {
      const date = new Date(file.addedTime);
      date.setHours(0, 0, 0, 0);

      let label;
      if (date.getTime() === today.getTime()) {
        label = '今天';
      } else if (date.getTime() === yesterday.getTime()) {
        label = '昨天';
      } else {
        label = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      }

      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(file);
    });

    return Array.from(groups.entries()).map(([label, groupFiles]) => ({
      label,
      files: groupFiles,
    }));
  }

  /**
   * 根据文件扩展名返回推荐的打开应用列表
   */
  getOpenWithApps(ext) {
    // 通用编辑器
    const editors = [
      { app: 'Visual Studio Code', label: 'VS Code' },
      { app: 'Cursor', label: 'Cursor' },
      { app: 'Sublime Text', label: 'Sublime Text' },
    ];
    const textEdit = { app: 'TextEdit', label: '文本编辑' };
    const terminal = { app: 'Terminal', label: '终端' };
    const iterm = { app: 'iTerm', label: 'iTerm2' };
    const preview = { app: 'Preview', label: '预览' };
    const chrome = { app: 'Google Chrome', label: 'Chrome' };
    const safari = { app: 'Safari', label: 'Safari' };
    const finder = { app: 'Finder', label: 'Finder' };
    const numbers = { app: 'Numbers', label: 'Numbers' };
    const pages = { app: 'Pages', label: 'Pages' };
    const keynote = { app: 'Keynote', label: 'Keynote' };

    const extLower = (ext || '').toLowerCase();

    // Shell/脚本类
    if (['sh', 'bash', 'zsh', 'command', 'tool'].includes(extLower)) {
      return [terminal, iterm, ...editors, textEdit];
    }
    // Python
    if (['py', 'pyw'].includes(extLower)) {
      return [terminal, iterm, ...editors, textEdit];
    }
    // Web 文件
    if (['html', 'htm', 'xhtml'].includes(extLower)) {
      return [chrome, safari, ...editors, textEdit];
    }
    // CSS / JS / TS 等前端代码
    if (['css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'vue', 'svelte'].includes(extLower)) {
      return [...editors, textEdit, chrome];
    }
    // Markdown / 文本
    if (['md', 'markdown', 'txt', 'log', 'ini', 'cfg', 'conf', 'yaml', 'yml', 'toml'].includes(extLower)) {
      return [...editors, textEdit, chrome];
    }
    // JSON / XML
    if (['json', 'xml', 'plist', 'csv'].includes(extLower)) {
      return [...editors, textEdit, chrome];
    }
    // 图片
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp', 'ico', 'svg'].includes(extLower)) {
      return [preview, chrome, { app: 'Photos', label: '照片' }, ...editors];
    }
    // PDF
    if (extLower === 'pdf') {
      return [preview, chrome, safari];
    }
    // Excel / 表格
    if (['xlsx', 'xls', 'numbers'].includes(extLower)) {
      return [numbers, { app: 'Microsoft Excel', label: 'Excel' }, ...editors];
    }
    // Word / 文档
    if (['doc', 'docx', 'pages'].includes(extLower)) {
      return [pages, { app: 'Microsoft Word', label: 'Word' }, textEdit, preview];
    }
    // PPT / 演示文稿
    if (['ppt', 'pptx', 'key'].includes(extLower)) {
      return [keynote, { app: 'Microsoft PowerPoint', label: 'PowerPoint' }, preview];
    }
    // 音频
    if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'].includes(extLower)) {
      return [{ app: 'Music', label: '音乐' }, { app: 'QuickTime Player', label: 'QuickTime' }, { app: 'VLC', label: 'VLC' }];
    }
    // 视频
    if (['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm'].includes(extLower)) {
      return [{ app: 'QuickTime Player', label: 'QuickTime' }, { app: 'IINA', label: 'IINA' }, { app: 'VLC', label: 'VLC' }];
    }
    // 压缩包
    if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'tgz'].includes(extLower)) {
      return [{ app: 'Archive Utility', label: '归档实用工具' }, { app: 'The Unarchiver', label: 'The Unarchiver' }, finder];
    }
    // 默认：编辑器 + 文本编辑
    return [...editors, textEdit, preview, chrome];
  }

  getFileExtension(filename) {
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }

  getIconClass(ext) {
    const knownExts = ['md', 'txt', 'js', 'ts', 'py', 'json', 'html', 'css', 'xlsx', 'pdf', 'jpg', 'png', 'gif', 'svg'];
    return knownExts.includes(ext) ? ext : 'default';
  }

  getFileEmoji(ext) {
    const emojiMap = {
      md: '📝', txt: '📄', js: 'JS', ts: 'TS', py: '🐍', json: '{}',
      html: '🌐', css: '🎨', xlsx: '📊', xls: '📊', pdf: '📕',
      jpg: '🖼', png: '🖼', gif: '🖼', svg: '🖼',
      doc: '📘', docx: '📘', ppt: '📙', pptx: '📙',
      zip: '📦', rar: '📦', mp3: '🎵', mp4: '🎬',
      java: '☕', go: 'Go', rs: '🦀', cpp: 'C+', c: 'C', sh: '💻',
    };
    return emojiMap[ext] || '📄';
  }

  formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);

    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin} 分钟前`;
    if (diffHour < 24) return `${diffHour} 小时前`;

    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  openModal(modalId) {
    document.getElementById(modalId).style.display = 'flex';
  }

  closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
  }

  showToast(message, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 2500);
  }
}

// ==========================================
// 初始化
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
  const app = new UIController();
  app.init();
});
