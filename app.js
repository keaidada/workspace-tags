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
          if (chrome.runtime.lastError) {
            console.error(`chrome.storage.local.get 失败 (key=${key}):`, chrome.runtime.lastError.message);
            resolve(defaultVal);
          } else {
            resolve(result[key] !== undefined ? result[key] : defaultVal);
          }
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
  static async getSortOrder() { return this.get('sortOrder', 'asc'); }
  static async saveSortOrder(v) { return this.set('sortOrder', v); }
  static async getSortField() { return this.get('sortField', 'depth'); }
  static async saveSortField(v) { return this.set('sortField', v); }
  static async getTrash() { return this.get('trash', []); }
  static async saveTrash(trash) { return this.set('trash', trash); }
  /** 目录同步映射：{ tagName: dirPath } */
  static async getSyncDirMappings() { return this.get('syncDirMappings', {}); }
  static async saveSyncDirMappings(mappings) { return this.set('syncDirMappings', mappings); }
}

// ==========================================
// 自然排序比较函数（数字按数值排序）
// ==========================================
function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const aParts = a.match(re) || [];
  const bParts = b.match(re) || [];
  const len = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const aIsNum = /^\d+$/.test(aParts[i]);
    const bIsNum = /^\d+$/.test(bParts[i]);
    if (aIsNum && bIsNum) {
      const diff = parseInt(aParts[i], 10) - parseInt(bParts[i], 10);
      if (diff !== 0) return diff;
      // 数值相同时按字符串长度排（前导零少的靠前）
      if (aParts[i].length !== bParts[i].length) return aParts[i].length - bParts[i].length;
    } else {
      const cmp = aParts[i].localeCompare(bParts[i]);
      if (cmp !== 0) return cmp;
    }
  }
  return aParts.length - bParts.length;
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

  /** 添加标签，自动创建所有祖先
   *  @param {string} tagName 标签路径
   *  @param {object} [opts] 可选配置 { source: 'auto' } 表示由目录同步自动创建
   */
  async addTag(tagName, opts) {
    const name = tagName.trim();
    if (!name) return null;

    const parts = name.split('/').filter(Boolean);
    let created = null;

    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('/');
      const existing = this.tags.find((t) => t.name === path);
      if (!existing) {
        const tag = { name: path, color: this.tags.length % 8 };
        if (opts && opts.source) tag.source = opts.source;
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

  /** 批量添加多个标签（只在最后保存一次，适用于大目录导入）
   *  @param {string[]} tagNames 标签路径列表
   *  @param {object} [opts] 可选配置 { source: 'auto' } 表示由目录同步自动创建
   */
  async addTagsBatch(tagNames, opts) {
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
          if (opts && opts.source) tag.source = opts.source;
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

  /** 判断标签是否由目录同步自动创建 */
  isAutoTag(tagName) {
    const tag = this.tags.find((t) => t.name === tagName);
    return tag && tag.source === 'auto';
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
    // 对每个层级的子标签按自然排序
    for (const [, children] of this._childrenCache) {
      children.sort((a, b) => naturalCompare(this.getDisplayName(a.name), this.getDisplayName(b.name)));
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
    this.trash = []; // 回收站：[{...fileRecord, deletedTime: timestamp}]
    this.tagManager = tagManager;
    this._tagFileCountsCache = null;
    this._filesById = new Map();
  }

  /** 文件或标签变更时清除计数缓存 */
  _invalidateCountsCache() {
    this._tagFileCountsCache = null;
  }

  _normalizeFileRecord(file) {
    return {
      ...file,
      tags: Array.isArray(file?.tags) ? file.tags : [],
    };
  }

  _rebuildFileIndexes() {
    this._filesById = new Map(this.files.map((file) => [file.id, file]));
  }

  getFileById(fileId) {
    return this._filesById.get(fileId) || null;
  }

  async load() {
    this.files = (await StorageService.getFiles()).map((file) => this._normalizeFileRecord(file));
    this.trash = (await StorageService.getTrash()).map((file) => this._normalizeFileRecord(file));
    this._rebuildFileIndexes();
    this._invalidateCountsCache();
  }

  async save() {
    try {
      this._rebuildFileIndexes();
      await StorageService.saveFiles(this.files);
      this._invalidateCountsCache();
    } catch (err) {
      console.error('保存文件数据失败:', err);
      throw err;
    }
  }

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
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
    // 构建已有文件的快速查找（优先用 path，其次用 name）
    const existingByPath = new Map(); // path -> file record
    const existingByName = new Map(); // name -> file record
    for (const f of this.files) {
      if (f.path) {
        existingByPath.set(f.path, f);
      } else {
        existingByName.set(f.name, f);
      }
    }

    let newCount = 0;
    let mergedCount = 0;
    const now = Date.now();
    const total = fileEntries.length;
    const progressInterval = Math.max(1, Math.floor(total / 100)); // 每 1% 回调一次

    for (let i = 0; i < total; i++) {
      const entry = fileEntries[i];

      // 检查是否已有相同 path/name 的文件
      let existing = null;
      if (entry.path) {
        existing = existingByPath.get(entry.path);
      } else {
        existing = existingByName.get(entry.name);
      }

      if (existing) {
        // 已存在的文件：将新标签合并进去（不创建重复记录）
        let merged = false;
        for (const tag of entry.tags) {
          if (!existing.tags.includes(tag)) {
            existing.tags.push(tag);
            merged = true;
          }
        }
        if (merged) mergedCount++;
      } else {
        // 新文件：创建新记录
        const file = {
          id: this.generateId(),
          name: entry.name,
          addedTime: now,
          tags: [...entry.tags],
        };
        if (entry.path) file.path = entry.path;

        this.files.push(file);
        newCount++;

        // 更新查找表，防止同批次内重复
        if (entry.path) {
          existingByPath.set(entry.path, file);
        } else {
          existingByName.set(entry.name, file);
        }
      }

      // 进度回调
      if (onProgress && (i % progressInterval === 0 || i === total - 1)) {
        onProgress(i + 1, total);
      }
    }
    if (newCount > 0 || mergedCount > 0) await this.save();
    return newCount + mergedCount;
  }

  async removeFile(fileId) {
    await this.moveToTrash(fileId);
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

  /** 删除标签时从所有文件中移除该标签及其子标签，并将无标签孤儿文件移入回收站 */
  async removeTagFromAllFiles(tagNames) {
    const nameSet = new Set(tagNames);
    const now = Date.now();
    const orphans = [];

    this.files.forEach((file) => {
      file.tags = file.tags.filter((t) => !nameSet.has(t));
      if (file.tags.length === 0) {
        orphans.push(file);
      }
    });

    // 将无标签孤儿文件移入回收站
    if (orphans.length > 0) {
      const orphanIds = new Set(orphans.map((f) => f.id));
      orphans.forEach((f) => {
        f.deletedTime = now;
        this.trash.push(f);
      });
      this.files = this.files.filter((f) => !orphanIds.has(f.id));
      await Promise.all([this.save(), this.saveTrash()]);
    } else {
      await this.save();
    }

    return orphans.length;
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

  /** 重命名文件记录（更新 name 和 path） */
  async renameFileRecord(fileId, newName, newPath) {
    const file = this.files.find((f) => f.id === fileId);
    if (!file) return null;
    file.name = newName;
    if (newPath) file.path = newPath;
    await this.save();
    return file;
  }

  getFilteredFiles(activeTags, filterNoTag, searchQuery, sortOrder, tagDisplayMode, searchTags, sortField, fileInfoCache, depthFilter) {
    let filtered = [...this.files];

    if (filterNoTag) {
      const isTimeTag = (t) => /^\d{6,8}$/.test(t.split('/')[0]);
      if (tagDisplayMode === 'time') {
        filtered = filtered.filter((f) => !f.tags || !f.tags.some((t) => isTimeTag(t)));
      } else {
        filtered = filtered.filter((f) => !f.tags || !f.tags.some((t) => !isTimeTag(t)));
      }
    } else if (activeTags && activeTags.size > 0) {
      // 多标签筛选：文件需要匹配任意一个选中的标签（或其子标签）
      // 层级定义：当前标签直属文件=1级，子级=2级，孙级=3级...
      const df = depthFilter || { op: 'all', level: 1 };
      filtered = filtered.filter((f) =>
        f.tags.some((t) => {
          for (const tag of activeTags) {
            if (!this.tagManager.isDescendantOrSelf(t, tag)) continue;
            if (df.op !== 'all') {
              // 当前标签自身=1级，子标签=2级，孙标签=3级...
              const relDepth = t === tag ? 1 : t.substring(tag.length + 1).split('/').length + 1;
              if (df.op === '=' && relDepth !== df.level) continue;
              if (df.op === '<=' && relDepth > df.level) continue;
              if (df.op === '>=' && relDepth < df.level) continue;
            }
            return true;
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

    // 层级计算辅助函数（用于排序）
    const calcMinDepth = (file) => {
      if (!activeTags || activeTags.size === 0) return 0;
      let min = Infinity;
      for (const t of file.tags) {
        for (const tag of activeTags) {
          if (t === tag) { min = Math.min(min, 1); }
          else if (t.startsWith(tag + '/')) {
            min = Math.min(min, t.substring(tag.length + 1).split('/').length + 1);
          }
        }
      }
      return min === Infinity ? 9999 : min;
    };

    filtered.sort((a, b) => {
      const field = sortField || 'depth';
      const cache = fileInfoCache || {};
      let diff = 0;

      if (field === 'depth') {
        diff = calcMinDepth(a) - calcMinDepth(b);
      } else if (field === 'addedTime') {
        diff = (a.addedTime || 0) - (b.addedTime || 0);
      } else if (field === 'name') {
        diff = naturalCompare(a.name.toLowerCase(), b.name.toLowerCase());
      } else if (field === 'size') {
        const aInfo = cache[a.path] || {};
        const bInfo = cache[b.path] || {};
        diff = (aInfo.size || 0) - (bInfo.size || 0);
      } else if (field === 'createdTime') {
        const aInfo = cache[a.path] || {};
        const bInfo = cache[b.path] || {};
        const aTime = aInfo.createdTime ? new Date(aInfo.createdTime).getTime() : 0;
        const bTime = bInfo.createdTime ? new Date(bInfo.createdTime).getTime() : 0;
        diff = aTime - bTime;
      } else if (field === 'modifiedTime') {
        const aInfo = cache[a.path] || {};
        const bInfo = cache[b.path] || {};
        const aTime = aInfo.modifiedTime ? new Date(aInfo.modifiedTime).getTime() : 0;
        const bTime = bInfo.modifiedTime ? new Date(bInfo.modifiedTime).getTime() : 0;
        diff = aTime - bTime;
      } else if (field === 'fileType') {
        const aInfo = cache[a.path] || {};
        const bInfo = cache[b.path] || {};
        const aType = (aInfo.fileType || '').toLowerCase();
        const bType = (bInfo.fileType || '').toLowerCase();
        diff = aType.localeCompare(bType);
      }

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

  // ==========================================
  // 回收站相关方法
  // ==========================================

  async saveTrash() {
    try {
      await StorageService.saveTrash(this.trash);
    } catch (err) {
      console.error('保存回收站数据失败:', err);
      throw err;
    }
  }

  /** 将文件移入回收站（保留所有原始信息 + 删除时间） */
  async moveToTrash(fileId) {
    const idx = this.files.findIndex((f) => f.id === fileId);
    if (idx === -1) return;
    const file = this.files[idx];
    this.trash.push({ ...file, deletedTime: Date.now() });
    this.files.splice(idx, 1);
    await Promise.all([this.save(), this.saveTrash()]);
  }

  /** 批量移入回收站 */
  async moveToTrashBatch(fileIds) {
    const idSet = new Set(fileIds);
    const now = Date.now();
    const toRemove = this.files.filter((f) => idSet.has(f.id));
    toRemove.forEach((f) => this.trash.push({ ...f, deletedTime: now }));
    this.files = this.files.filter((f) => !idSet.has(f.id));
    if (toRemove.length > 0) {
      await Promise.all([this.save(), this.saveTrash()]);
    }
    return toRemove.length;
  }

  /** 从回收站恢复单个文件 */
  async restoreFromTrash(fileId) {
    const idx = this.trash.findIndex((f) => f.id === fileId);
    if (idx === -1) return;
    const file = { ...this.trash[idx] };
    delete file.deletedTime;
    this.files.push(file);
    this.trash.splice(idx, 1);
    await Promise.all([this.save(), this.saveTrash()]);
  }

  /** 从回收站恢复全部 */
  async restoreAllFromTrash() {
    if (this.trash.length === 0) return;
    this.trash.forEach((f) => {
      const file = { ...f };
      delete file.deletedTime;
      this.files.push(file);
    });
    this.trash = [];
    await Promise.all([this.save(), this.saveTrash()]);
  }

  /** 从回收站永久删除单个 */
  async deleteFromTrash(fileId) {
    this.trash = this.trash.filter((f) => f.id !== fileId);
    await this.saveTrash();
  }

  /** 清空回收站（真正永久删除所有数据关系） */
  async emptyTrash() {
    const count = this.trash.length;
    this.trash = [];
    await this.saveTrash();
    return count;
  }

  /** 获取回收站列表 */
  getTrashFiles() {
    return this.trash.sort((a, b) => (b.deletedTime || 0) - (a.deletedTime || 0));
  }
}

// ==========================================
// UI 控制器
// ==========================================

class UIController {
  constructor() {
    this.tagManager = new TagManager();
    this.fileManager = new FileManager(this.tagManager);
    this.sortOrder = 'asc';
    this.sortField = 'depth'; // depth, addedTime, name, size, createdTime, modifiedTime, fileType
    this.depthFilter = { op: 'all', level: 1 }; // op: 'all'|'='|'<='|'>=', level: 1-5
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

    // 平台检测: 'mac', 'win', 'linux'
    this.platform = this._detectPlatform();

    // 文件详细信息缓存 { path: { size, createdTime, modifiedTime, ... } }
    this.fileInfoCache = {};

    // 分页
    this.currentPage = 1;
    this.pageSize = 500;

    // 回收站分页
    this.trashCurrentPage = 1;
    this.trashPageSize = 50;

    // 回收站搜索
    this.trashSearchQuery = '';
    this.trashSearchTags = new Set();

    // 目录同步映射 { tagName: dirPath }
    this.syncDirMappings = {};
  }

  async init() {
    await this.tagManager.load();
    await this.fileManager.load();
    this.sortOrder = await StorageService.getSortOrder();
    this.sortField = await StorageService.getSortField();
    this.syncDirMappings = await StorageService.getSyncDirMappings();
    this.bindEvents();
    this.render();
    // 异步加载已安装应用列表（不阻塞主流程）
    this.loadInstalledApps();
    // 根据平台更新 UI 文本
    this._applyPlatformUI();
    this._scheduleAdaptiveLayout();
  }

  /**
   * 检测当前操作系统平台
   * @returns {'mac'|'win'|'linux'}
   */
  _detectPlatform() {
    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) return 'win';
    if (/Mac/i.test(ua)) return 'mac';
    return 'linux';
  }

  /**
   * 根据平台动态更新 UI 元素
   */
  _applyPlatformUI() {
    // 更新批量打开方式下拉中的应用名
    const batchOpenWithDropdown = document.getElementById('batch-open-with-dropdown');
    if (batchOpenWithDropdown && this.platform === 'win') {
      // 替换 macOS 专属应用选项
      const items = batchOpenWithDropdown.querySelectorAll('.batch-open-with-item');
      items.forEach((item) => {
        const app = item.getAttribute('data-app');
        if (app === 'Terminal') { item.textContent = '命令提示符'; item.setAttribute('data-app', 'cmd'); }
        else if (app === 'iTerm') { item.textContent = 'PowerShell'; item.setAttribute('data-app', 'PowerShell'); }
        else if (app === 'TextEdit') { item.textContent = '记事本'; item.setAttribute('data-app', 'notepad'); }
        else if (app === 'Preview') { item.textContent = '照片查看器'; item.setAttribute('data-app', 'mspaint'); }
      });
    }

    // 更新终端下拉
    const batchTerminalDropdown = document.getElementById('batch-terminal-dropdown');
    if (batchTerminalDropdown && this.platform === 'win') {
      const defaultItem = batchTerminalDropdown.querySelector('.batch-terminal-item');
      if (defaultItem) {
        defaultItem.textContent = '命令提示符 (CMD)';
        defaultItem.setAttribute('data-terminal', 'cmd');
      }
    }

    // 更新手动路径输入框的 placeholder
    const manualPathInput = document.getElementById('manual-path-input');
    if (manualPathInput && this.platform === 'win') {
      manualPathInput.placeholder = '输入文件路径，每行一个\n例如：\nC:\\Users\\xxx\\documents\\file1.pdf\nC:\\Users\\xxx\\documents\\file2.txt\n\n也支持输入目录路径，例如：\nC:\\Users\\xxx\\documents\\myFolder\\';
    }

    // 更新目录路径输入框的 placeholder
    const dirManualInput = document.getElementById('dir-manual-input');
    if (dirManualInput && this.platform === 'win') {
      dirManualInput.placeholder = '输入目录路径，如 C:\\Users\\xxx\\documents\\';
    }
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
    // 清理不再存在于文件列表中的缓存条目，防止内存泄漏
    const activePaths = new Set(this.fileManager.files.map((f) => f.path).filter(Boolean));
    for (const path of Object.keys(this.fileInfoCache)) {
      if (!activePaths.has(path)) {
        delete this.fileInfoCache[path];
      }
    }

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
      const result = await this.sendNativeAction('batchGetFileInfo', { paths: pathsToFetch });
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
          ${this.escapeHtml(info.fileType ? info.fileType.toUpperCase() : '--')}
        </span>
        ${info.permissions ? `
        <span class="file-detail-item" title="文件权限">
          <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
          ${this.escapeHtml(info.permissions)}
        </span>` : ''}
      `;
    });
  }

  /**
   * 格式化文件大小
   */
  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return '--';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
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
      document.getElementById('sort-dropdown').style.display = 'none';
      document.getElementById('depth-dropdown').style.display = 'none';
    });

    // 排序
    document.getElementById('btn-sort').addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('depth-dropdown').style.display = 'none';
      this.toggleSort();
    });
    document.getElementById('sort-dropdown').addEventListener('click', (e) => {
      e.stopPropagation();
      const item = e.target.closest('.sort-dropdown-item');
      if (item && item.getAttribute('data-field')) {
        this.setSortOption(item.getAttribute('data-field'), item.getAttribute('data-dir'));
      }
    });

    // 层级范围
    document.getElementById('btn-depth').addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('sort-dropdown').style.display = 'none';
      this.toggleDepthDropdown();
    });
    document.getElementById('depth-dropdown').addEventListener('click', (e) => {
      e.stopPropagation();
    });
    document.getElementById('depth-op-select').addEventListener('change', (e) => {
      const op = e.target.value;
      document.getElementById('depth-level-input').disabled = op === 'all';
      this.depthFilter.op = op;
      this._updateDepthHint();
      this.updateDepthButton();
      this.currentPage = 1;
      this.renderFileList();
    });
    document.getElementById('depth-level-input').addEventListener('input', (e) => {
      let val = parseInt(e.target.value, 10);
      if (isNaN(val) || val < 1) val = 1;
      if (val > 100) val = 100;
      this.depthFilter.level = val;
      this._updateDepthHint();
      this.updateDepthButton();
      this.currentPage = 1;
      this.renderFileList();
    });

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
    ctxMenu.querySelector('[data-action="sync-dir"]').addEventListener('click', () => {
      this.hideContextMenu();
      this.syncDirFilesForTag(this.ctxTagName);
    });
    ctxMenu.querySelector('[data-action="create-dir-structure"]').addEventListener('click', () => {
      this.hideContextMenu();
      this.showCreateDirModal(this.ctxTagName);
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

    // 上传区域点击 - 使用 Native Host 选择文件以获取真实路径
    document.getElementById('upload-area').addEventListener('click', async (e) => {
      console.log('[upload-area] clicked, calling native chooseFiles');
      try {
        this.showToast('正在打开文件选择对话框...', 'info');
        const response = await this.sendNativeAction('chooseFiles', {}, 120000);
        console.log('[upload-area] chooseFiles response:', response);
        
        if (response.cancelled) {
          console.log('[upload-area] user cancelled');
          return;
        }
        
        if (response.error) {
          this.showToast(`选择文件失败: ${response.error}`, 'error');
          return;
        }
        
        if (response.files && response.files.length > 0) {
          // 将选中的文件添加到待处理列表
          for (const filePath of response.files) {
            const fileName = filePath.split('/').pop().split('\\').pop(); // 兼容 Windows 和 macOS
            if (!this.pendingFileNames.some((f) => f.fullPath === filePath)) {
              this.pendingFileNames.push({ name: fileName, dirPath: '', fullPath: filePath });
            }
          }
          console.log('[upload-area] pendingFileNames now:', this.pendingFileNames.length);
          this.renderPendingFiles();
        }
      } catch (err) {
        console.error('[upload-area] chooseFiles error:', err);
        this.showToast(`选择文件失败: ${err.message}`, 'error');
      }
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

    // 文件选择回调（弹窗内的文件选择器）
    document.getElementById('file-picker-modal').addEventListener('change', (e) => {
      console.log('[file-picker-modal] change event fired, files:', e.target.files);
      this.handleFileSelect(e.target.files);
      e.target.value = '';
    });

    // 文件选择回调（全局的文件选择器，保留兼容性）
    document.getElementById('file-picker').addEventListener('change', (e) => {
      console.log('[file-picker] change event fired, files:', e.target.files);
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
    window.addEventListener('resize', () => this._scheduleAdaptiveLayout());

    // --- 标签模式切换 ---
    document.querySelectorAll('.tag-mode-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tag-mode-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        this.tagDisplayMode = tab.getAttribute('data-mode');
        this.renderSidebar();
      });
    });

    // --- 清理失效文件 & 回收站 ---
    document.getElementById('btn-cleanup-files')?.addEventListener('click', () => this.showCleanupModal());
    document.getElementById('btn-open-trash')?.addEventListener('click', () => this.showTrashModal());
    document.getElementById('trash-count')?.addEventListener('click', () => this.showTrashModal());
    document.getElementById('btn-cleanup-select-all')?.addEventListener('click', () => this.toggleCleanupSelectAll());
    document.getElementById('btn-confirm-cleanup')?.addEventListener('click', () => this.confirmCleanup());
    document.getElementById('btn-empty-trash')?.addEventListener('click', () => this.emptyTrash());
    document.getElementById('btn-restore-all')?.addEventListener('click', () => this.restoreAllFromTrash());

    // --- 生成目录结构弹窗 ---
    document.getElementById('btn-create-dir-browse')?.addEventListener('click', () => this._createDirBrowse());
    document.getElementById('btn-create-dir-confirm')?.addEventListener('click', () => this._createDirFromManual());
    document.getElementById('create-dir-manual-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._createDirFromManual();
    });

    this._bindDynamicFileListEvents();
  }

  _getCurrentFilteredFiles() {
    return this.fileManager.getFilteredFiles(
      this.activeTags,
      this.filterNoTag,
      this.searchQuery,
      this.sortOrder,
      this.tagDisplayMode,
      this.searchTags,
      this.sortField,
      this.fileInfoCache,
      this.depthFilter
    );
  }

  _getCurrentPageFiles(allFilteredFiles = this._getCurrentFilteredFiles()) {
    const totalFiles = allFilteredFiles.length;
    const totalPages = Math.max(1, Math.ceil(totalFiles / this.pageSize));
    const safePage = Math.min(Math.max(this.currentPage, 1), totalPages);
    const startIdx = (safePage - 1) * this.pageSize;
    const endIdx = Math.min(startIdx + this.pageSize, totalFiles);
    return allFilteredFiles.slice(startIdx, endIdx);
  }

  _clampSidebarWidth(width) {
    return Math.min(Math.max(Math.round(width), 200), 500);
  }

  _measureTextWidth(text, sampleEl) {
    if (!text) return 0;
    if (!this._textMeasureCanvas) {
      this._textMeasureCanvas = document.createElement('canvas');
      this._textMeasureContext = this._textMeasureCanvas.getContext('2d');
    }
    const ctx = this._textMeasureContext;
    if (!ctx) return text.length * 14;

    const computed = sampleEl ? window.getComputedStyle(sampleEl) : null;
    const font = computed
      ? `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`
      : '600 14px sans-serif';
    ctx.font = font;
    return ctx.measureText(text).width;
  }

  _getSidebarRowWidth(item) {
    if (!item) return 0;

    const textEl = item.querySelector('.tag-nav-text');
    const rowEl = item.closest('.tag-tree-item');
    const itemStyle = window.getComputedStyle(item);
    const rowStyle = rowEl ? window.getComputedStyle(rowEl) : null;
    const paddingLeft = parseFloat(itemStyle.paddingLeft || '0');
    const paddingRight = parseFloat(itemStyle.paddingRight || '0');
    const indentWidth = parseFloat(rowStyle?.paddingLeft || '0');
    const gap = parseFloat(itemStyle.columnGap || itemStyle.gap || '0');

    const visibleChildren = [...item.children].filter((child) => {
      const style = window.getComputedStyle(child);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });

    const extraWidth = visibleChildren.reduce((sum, child) => {
      if (child === textEl) return sum;
      return sum + child.getBoundingClientRect().width;
    }, 0);

    const textWidth = this._measureTextWidth(textEl?.textContent?.trim() || '', textEl);
    const gapWidth = Math.max(visibleChildren.length - 1, 0) * gap;
    return indentWidth + paddingLeft + paddingRight + extraWidth + textWidth + gapWidth;
  }

  _getSidebarContentWidth() {
    const navItems = [...document.querySelectorAll('.tag-nav-item')];
    if (!navItems.length) return 200;

    const widestRow = navItems.reduce(
      (max, item) => Math.max(max, this._getSidebarRowWidth(item)),
      0,
    );

    return this._clampSidebarWidth(widestRow + 28);
  }

  _getAdaptiveSidebarBaseWidth() {
    const viewportDrivenWidth = this._clampSidebarWidth(window.innerWidth * 0.26);
    const contentDrivenWidth = this._getSidebarContentWidth();
    return Math.max(viewportDrivenWidth, contentDrivenWidth);
  }

  _getDesiredFileNameWidth() {
    const pageFiles = this._getCurrentPageFiles();
    const sampleNameEl = document.querySelector('.file-name');
    const longestNameWidth = pageFiles.reduce(
      (max, file) => Math.max(max, this._measureTextWidth(file?.name || '', sampleNameEl)),
      0,
    );

    const minWidth = 220;
    const maxWidth = Math.max(320, Math.min(720, Math.floor(window.innerWidth * 0.46)));
    if (longestNameWidth <= 0) return minWidth;
    return Math.min(Math.max(Math.ceil(longestNameWidth * 2 / 3), minWidth), maxWidth);
  }

  _applyAdaptiveLayout() {
    const sidebar = document.querySelector('.sidebar');
    const fileNameEl = document.querySelector('.file-name');
    if (!sidebar) return;

    const desiredFileNameWidth = this._getDesiredFileNameWidth();
    document.documentElement.style.setProperty('--file-name-max-width', `${desiredFileNameWidth}px`);

    const contentDrivenWidth = this._getSidebarContentWidth();
    const baseSidebarWidth = this._clampSidebarWidth(
      Math.max(this._sidebarPreferredWidth ?? this._getAdaptiveSidebarBaseWidth(), contentDrivenWidth),
    );

    let targetSidebarWidth = baseSidebarWidth;
    if (fileNameEl) {
      const currentNameWidth = Math.ceil(fileNameEl.getBoundingClientRect().width);
      const extraNeeded = Math.max(0, desiredFileNameWidth - currentNameWidth);
      targetSidebarWidth = Math.max(
        contentDrivenWidth,
        this._clampSidebarWidth(baseSidebarWidth - extraNeeded),
      );
    }

    sidebar.style.width = `${targetSidebarWidth}px`;
    document.documentElement.style.setProperty('--sidebar-width', `${targetSidebarWidth}px`);
  }

  _scheduleAdaptiveLayout() {
    if (this._layoutFrame) {
      cancelAnimationFrame(this._layoutFrame);
    }
    this._layoutFrame = requestAnimationFrame(() => {
      this._layoutFrame = null;
      this._applyAdaptiveLayout();
    });
  }

  _updateFileCardSelection(card, checked) {
    const fileId = card?.getAttribute('data-id');
    if (!fileId) return;

    if (checked) {
      this.selectedFiles.add(fileId);
    } else {
      this.selectedFiles.delete(fileId);
    }

    const checkbox = card.querySelector('.file-checkbox');
    if (checkbox) checkbox.checked = checked;
    card.classList.toggle('selected', checked);
    this.renderBatchBar(this.selectedFiles.size, this._getCurrentPageFiles().length);
  }

  _hideFileActionDropdowns() {
    document.querySelectorAll('.copy-dropdown, .open-with-dropdown, .terminal-dropdown').forEach((d) => {
      d.style.display = 'none';
    });
    document.querySelectorAll('.open-with-search-results, .terminal-search-results').forEach((d) => {
      d.innerHTML = '';
      d.style.display = 'none';
    });
  }

  _renderOpenWithSearchResults(input) {
    const query = input.value.trim();
    const resultsDiv = input.closest('.open-with-search-wrap')?.querySelector('.open-with-search-results');
    if (!resultsDiv) return;

    if (!query) {
      resultsDiv.innerHTML = '';
      resultsDiv.style.display = 'none';
      return;
    }

    const matches = this.fuzzySearchApps(query);
    if (matches.length === 0) {
      resultsDiv.innerHTML = `<button class="open-with-search-item" data-app="${this.escapeHtml(query)}">用 "${this.escapeHtml(query)}" 打开</button>`;
    } else {
      resultsDiv.innerHTML = matches.map((m) =>
        `<button class="open-with-search-item" data-app="${this.escapeHtml(m.name)}">${this.highlightMatch(m.label, query)}</button>`
      ).join('');
      const exactMatch = matches.some((m) => m.name.toLowerCase() === query.toLowerCase());
      if (!exactMatch) {
        resultsDiv.innerHTML += `<button class="open-with-search-item open-with-search-custom" data-app="${this.escapeHtml(query)}">用 "${this.escapeHtml(query)}" 打开</button>`;
      }
    }

    resultsDiv.style.display = 'block';
  }

  _renderTerminalSearchResults(input) {
    const query = input.value.trim();
    const resultsDiv = input.closest('.terminal-search-wrap')?.querySelector('.terminal-search-results');
    if (!resultsDiv) return;

    if (!query) {
      resultsDiv.innerHTML = '';
      resultsDiv.style.display = 'none';
      return;
    }

    const matches = this.fuzzySearchApps(query);
    if (matches.length === 0) {
      resultsDiv.innerHTML = `<button class="terminal-search-item" data-terminal="${this.escapeHtml(query)}">用 "${this.escapeHtml(query)}" 打开</button>`;
    } else {
      resultsDiv.innerHTML = matches.map((m) =>
        `<button class="terminal-search-item" data-terminal="${this.escapeHtml(m.name)}">${this.highlightMatch(m.label, query)}</button>`
      ).join('');
      const exactMatch = matches.some((m) => m.name.toLowerCase() === query.toLowerCase());
      if (!exactMatch) {
        resultsDiv.innerHTML += `<button class="terminal-search-item terminal-search-custom" data-terminal="${this.escapeHtml(query)}">用 "${this.escapeHtml(query)}" 打开</button>`;
      }
    }

    resultsDiv.style.display = 'block';
  }

  _bindDynamicFileListEvents() {
    const fileList = document.getElementById('file-list');
    const paginationBar = document.getElementById('pagination-bar');
    if (!fileList || !paginationBar) return;

    fileList.addEventListener('change', (e) => {
      const checkbox = e.target.closest('.file-checkbox');
      if (!checkbox) return;
      e.stopPropagation();
      const card = checkbox.closest('.file-card');
      if (!card) return;
      this._updateFileCardSelection(card, checkbox.checked);
    });

    fileList.addEventListener('dblclick', (e) => {
      const nameEl = e.target.closest('.file-name-editable');
      if (!nameEl) return;
      e.stopPropagation();
      e.preventDefault();
      const fileId = nameEl.getAttribute('data-file-id');
      this.startEditFileName(fileId, nameEl);
    });

    fileList.addEventListener('input', (e) => {
      const openWithInput = e.target.closest('.open-with-input');
      if (openWithInput) {
        e.stopPropagation();
        this._renderOpenWithSearchResults(openWithInput);
        return;
      }

      const terminalInput = e.target.closest('.terminal-search-input');
      if (terminalInput) {
        e.stopPropagation();
        this._renderTerminalSearchResults(terminalInput);
      }
    });

    fileList.addEventListener('keydown', (e) => {
      const openWithInput = e.target.closest('.open-with-input');
      if (openWithInput) {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const appName = openWithInput.value.trim();
          if (!appName) return;
          const wrapper = openWithInput.closest('.open-dropdown-wrapper');
          const fileId = wrapper?.querySelector('[data-action="open"]')?.getAttribute('data-id');
          openWithInput.closest('.open-with-dropdown').style.display = 'none';
          openWithInput.value = '';
          this._renderOpenWithSearchResults(openWithInput);
          this.openFileById(fileId, appName);
        }
        return;
      }

      const terminalInput = e.target.closest('.terminal-search-input');
      if (!terminalInput) return;
      e.stopPropagation();
      if (e.key === 'Enter') {
        const appName = terminalInput.value.trim();
        if (!appName) return;
        const wrapper = terminalInput.closest('.terminal-dropdown-wrapper');
        const fileId = wrapper?.querySelector('[data-action="terminal"]')?.getAttribute('data-id');
        terminalInput.closest('.terminal-dropdown').style.display = 'none';
        terminalInput.value = '';
        this._renderTerminalSearchResults(terminalInput);
        this.openTerminalById(fileId, appName);
      }
    });

    fileList.addEventListener('click', async (e) => {
      const openSearchInput = e.target.closest('.open-with-input');
      const terminalSearchInput = e.target.closest('.terminal-search-input');
      if (openSearchInput || terminalSearchInput) {
        e.stopPropagation();
        return;
      }

      const openSearchItem = e.target.closest('.open-with-search-item');
      if (openSearchItem) {
        e.stopPropagation();
        const wrapper = openSearchItem.closest('.open-dropdown-wrapper');
        const input = wrapper?.querySelector('.open-with-input');
        const fileId = wrapper?.querySelector('[data-action="open"]')?.getAttribute('data-id');
        openSearchItem.closest('.open-with-dropdown').style.display = 'none';
        if (input) {
          input.value = '';
          this._renderOpenWithSearchResults(input);
        }
        this.openFileById(fileId, openSearchItem.getAttribute('data-app'));
        return;
      }

      const terminalSearchItem = e.target.closest('.terminal-search-item');
      if (terminalSearchItem) {
        e.stopPropagation();
        const wrapper = terminalSearchItem.closest('.terminal-dropdown-wrapper');
        const input = wrapper?.querySelector('.terminal-search-input');
        const fileId = wrapper?.querySelector('[data-action="terminal"]')?.getAttribute('data-id');
        terminalSearchItem.closest('.terminal-dropdown').style.display = 'none';
        if (input) {
          input.value = '';
          this._renderTerminalSearchResults(input);
        }
        this.openTerminalById(fileId, terminalSearchItem.getAttribute('data-terminal'));
        return;
      }

      const openItem = e.target.closest('.open-with-dropdown-item');
      if (openItem) {
        e.stopPropagation();
        const wrapper = openItem.closest('.open-dropdown-wrapper');
        const fileId = wrapper?.querySelector('[data-action="open"]')?.getAttribute('data-id');
        openItem.closest('.open-with-dropdown').style.display = 'none';
        this.openFileById(fileId, openItem.getAttribute('data-app'));
        return;
      }

      const terminalItem = e.target.closest('.terminal-dropdown-item');
      if (terminalItem) {
        e.stopPropagation();
        const wrapper = terminalItem.closest('.terminal-dropdown-wrapper');
        const fileId = wrapper?.querySelector('[data-action="terminal"]')?.getAttribute('data-id');
        terminalItem.closest('.terminal-dropdown').style.display = 'none';
        this.openTerminalById(fileId, terminalItem.getAttribute('data-terminal'));
        return;
      }

      const copyItem = e.target.closest('.copy-dropdown-item');
      if (copyItem) {
        e.stopPropagation();
        const card = copyItem.closest('.file-card');
        const copyType = copyItem.getAttribute('data-copy-type');
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
          }).catch(() => {
            this.showToast('复制失败，请检查剪贴板权限', 'error');
          });
        } else {
          this.showToast('无法获取路径信息', 'error');
        }
        copyItem.closest('.copy-dropdown').style.display = 'none';
        return;
      }

      const actionBtn = e.target.closest('.file-action-btn');
      if (actionBtn) {
        e.stopPropagation();
        const action = actionBtn.getAttribute('data-action');
        const fileId = actionBtn.getAttribute('data-id');

        if (action === 'tag') {
          this.showFileTagsModal(fileId);
          return;
        }
        if (action === 'open') {
          this.openFileById(fileId);
          return;
        }
        if (action === 'reveal') {
          this.revealFileById(fileId);
          return;
        }
        if (action === 'terminal') {
          this.openTerminalById(fileId);
          return;
        }
        if (action === 'remove') {
          await this.fileManager.removeFile(fileId);
          this.selectedFiles.delete(fileId);
          this.showToast('已移入回收站', 'info');
          this.render();
          return;
        }

        if (action === 'open-with-menu' || action === 'terminal-menu' || action === 'copy-menu') {
          const selector = action === 'open-with-menu'
            ? '.open-with-dropdown'
            : action === 'terminal-menu'
              ? '.terminal-dropdown'
              : '.copy-dropdown';
          const dropdown = actionBtn.parentElement?.querySelector(selector);
          const willShow = dropdown && dropdown.style.display === 'none';
          this._hideFileActionDropdowns();
          if (dropdown) {
            dropdown.style.display = willShow ? 'block' : 'none';
          }
        }
          return;
      }

      const card = e.target.closest('.file-card');
      if (!card) return;
      if (
        e.target.closest('.file-checkbox') ||
        e.target.closest('.file-name-editing') ||
        e.target.closest('.file-name-editable') ||
        e.target.closest('.open-with-dropdown') ||
        e.target.closest('.terminal-dropdown') ||
        e.target.closest('.copy-dropdown')
      ) {
        return;
      }

      const checkbox = card.querySelector('.file-checkbox');
      if (!checkbox) return;
      this._updateFileCardSelection(card, !checkbox.checked);
    });

    paginationBar.addEventListener('click', (e) => {
      const pageBtn = e.target.closest('.page-btn[data-page]');
      if (!pageBtn) return;
      const totalPages = Math.max(1, Math.ceil(this._getCurrentFilteredFiles().length / this.pageSize));
      const page = parseInt(pageBtn.getAttribute('data-page'), 10);
      if (page >= 1 && page <= totalPages && page !== this.currentPage) {
        this.goToPage(page);
      }
    });

    paginationBar.addEventListener('change', (e) => {
      if (!e.target.matches('.page-size-select')) return;
      this.pageSize = parseInt(e.target.value, 10);
      this.currentPage = 1;
      this.renderFileList();
      document.getElementById('file-grid-container')?.scrollTo(0, 0);
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
      const newWidth = this._clampSidebarWidth(startWidth + diff);
      this._sidebarPreferredWidth = newWidth;
      sidebar.style.width = `${newWidth}px`;
      document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      resizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      this._scheduleAdaptiveLayout();
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

    // 同步目录按钮：查找当前标签或其祖先标签是否关联了同步目录
    const syncDirBtn = menu.querySelector('[data-action="sync-dir"]');
    const hasSyncDir = this._findSyncDirForTag(tagName) !== null;
    syncDirBtn.style.display = hasSyncDir ? '' : 'none';

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

    // 标签名验证：不允许连续斜杠、前后斜杠、空白段
    if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
      this.showToast('标签名不能以 / 开头或结尾，也不能包含连续 /', 'error');
      return;
    }
    // 不允许标签名段为空白
    const segments = name.split('/');
    if (segments.some((s) => !s.trim())) {
      this.showToast('标签名的每一层都不能为空', 'error');
      return;
    }
    // 标签名长度限制
    if (name.length > 100) {
      this.showToast('标签名过长，最多 100 个字符', 'error');
      return;
    }

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

    // 标签名验证：不允许连续斜杠、前后斜杠、空白段
    if (newDisplayName.startsWith('/') || newDisplayName.endsWith('/') || newDisplayName.includes('//')) {
      this.showToast('标签名不能以 / 开头或结尾，也不能包含连续 /', 'error');
      return;
    }
    const segments = newDisplayName.split('/');
    if (segments.some((s) => !s.trim())) {
      this.showToast('标签名的每一层都不能为空', 'error');
      return;
    }
    if (newDisplayName.length > 100) {
      this.showToast('标签名过长，最多 100 个字符', 'error');
      return;
    }

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

    // 更新 expandedTags 中的引用
    if (this.expandedTags.has(oldName)) {
      this.expandedTags.delete(oldName);
      this.expandedTags.add(newName);
    }
    for (const t of [...this.expandedTags]) {
      if (t.startsWith(oldName + '/')) {
        this.expandedTags.delete(t);
        this.expandedTags.add(newName + t.substring(oldName.length));
      }
    }

    // 更新同步目录映射中的标签名
    let syncDirChanged = false;
    const newMappings = {};
    for (const [key, val] of Object.entries(this.syncDirMappings)) {
      if (key === oldName) {
        newMappings[newName] = val;
        syncDirChanged = true;
      } else if (key.startsWith(oldName + '/')) {
        newMappings[newName + key.substring(oldName.length)] = val;
        syncDirChanged = true;
      } else {
        newMappings[key] = val;
      }
    }
    if (syncDirChanged) {
      this.syncDirMappings = newMappings;
      await StorageService.saveSyncDirMappings(this.syncDirMappings);
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

    // 先收集要删除标签的同步目录映射，用于后续清理文件
    const syncDirPaths = [];
    for (const [key, val] of Object.entries(this.syncDirMappings)) {
      if (key === this.pendingDeleteTag || key.startsWith(this.pendingDeleteTag + '/')) {
        syncDirPaths.push(val);
      }
    }

    const removedNames = await this.tagManager.removeTag(this.pendingDeleteTag);
    const orphanCount = await this.fileManager.removeTagFromAllFiles(removedNames);

    // 如果有同步目录映射，清理该目录路径下的文件记录
    let syncFileCleanCount = 0;
    if (syncDirPaths.length > 0) {
      const now = Date.now();
      const cleanPaths = syncDirPaths.map(p => p.replace(/\/+$/, ''));
      const filesToRemove = [];

      this.fileManager.files.forEach((file) => {
        if (!file.path) return;
        // 检查文件路径是否属于被删除的同步目录
        for (const dirPath of cleanPaths) {
          if (file.path === dirPath || file.path.startsWith(dirPath + '/')) {
            filesToRemove.push(file);
            break;
          }
        }
      });

      if (filesToRemove.length > 0) {
        const removeIds = new Set(filesToRemove.map(f => f.id));
        filesToRemove.forEach(f => {
          f.deletedTime = now;
          this.fileManager.trash.push(f);
        });
        this.fileManager.files = this.fileManager.files.filter(f => !removeIds.has(f.id));
        syncFileCleanCount = filesToRemove.length;
        await Promise.all([this.fileManager.save(), this.fileManager.saveTrash()]);
      }
    }

    // 从选中的筛选标签中移除已删除的标签
    for (const t of [...this.activeTags]) {
      if (t === this.pendingDeleteTag || this.tagManager.isDescendantOrSelf(t, this.pendingDeleteTag)) {
        this.activeTags.delete(t);
      }
    }

    // 清理同步目录映射：删除被删除标签及其子标签的映射
    let syncDirChanged = false;
    for (const key of Object.keys(this.syncDirMappings)) {
      if (key === this.pendingDeleteTag || key.startsWith(this.pendingDeleteTag + '/')) {
        delete this.syncDirMappings[key];
        syncDirChanged = true;
      }
    }
    if (syncDirChanged) {
      await StorageService.saveSyncDirMappings(this.syncDirMappings);
    }

    this.closeModal('modal-confirm');
    let msg = `标签 "${this.pendingDeleteTag}" 已删除`;
    if (syncFileCleanCount > 0) {
      msg += `，${syncFileCleanCount} 个同步目录文件已移入回收站`;
    } else if (orphanCount > 0) {
      msg += `，${orphanCount} 个无标签文件已移入回收站`;
    }
    this.showToast(msg, 'info');
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

  /**
   * 渲染标签选择树（带折叠功能）
   * 默认只展开与 selectedTags 相关的路径
   */
  renderModalTagSelect() {
    const container = document.getElementById('modal-tag-select');
    const allTags = this.tagManager.getAllTags();
    const dateTag = FileManager.getDateTag();

    // 合并：已有标签 + 日期标签（可能不在已有标签中）
    const tagNames = new Set(allTags.map((t) => t.name));
    tagNames.add(dateTag);

    const sortedNames = Array.from(tagNames).sort((a, b) => naturalCompare(a, b));

    if (sortedNames.length === 0) {
      container.innerHTML = '<p class="no-tags-hint">还没有标签，请先新建</p>';
      return;
    }

    // 构建树形结构
    const tree = this.buildTagTree(sortedNames);

    // 确定需要展开的路径（包含 selectedTags 的路径）
    const expandedPaths = new Set();
    for (const tag of this.selectedTags) {
      // 展开该标签及其所有祖先路径
      const parts = tag.split('/');
      let path = '';
      for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        expandedPaths.add(path);
      }
    }

    // 渲染树
    container.innerHTML = this.renderTagTreeNodes(tree, '', expandedPaths);

    // 绑定事件
    this.bindTagTreeEvents(container, expandedPaths);
  }

  /**
   * 构建标签树结构
   */
  buildTagTree(tagNames) {
    const tree = {};
    for (const fullName of tagNames) {
      const parts = fullName.split('/');
      let current = tree;
      let path = '';
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        path = path ? `${path}/${part}` : part;
        if (!current[part]) {
          current[part] = { __fullPath: path, __children: {} };
        }
        current = current[part].__children;
      }
    }
    return tree;
  }

  /**
   * 渲染标签树节点
   */
  renderTagTreeNodes(tree, parentPath, expandedPaths) {
    const keys = Object.keys(tree).sort((a, b) => naturalCompare(a, b));
    if (keys.length === 0) return '';

    return keys.map((key) => {
      const node = tree[key];
      const fullPath = node.__fullPath;
      const children = node.__children;
      const hasChildren = Object.keys(children).length > 0;
      const isExpanded = expandedPaths.has(fullPath);
      const isSelected = this.selectedTags.has(fullPath);

      // 只显示当前层级的名称（不显示完整路径）
      const displayName = key;

      return `
        <div class="tag-tree-node" data-path="${this.escapeHtml(fullPath)}">
          <div class="tag-tree-node-header${isSelected ? ' selected' : ''}">
            <span class="tag-tree-node-toggle${hasChildren ? (isExpanded ? ' expanded' : '') : ' hidden'}">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            </span>
            <input type="checkbox" class="tag-tree-node-checkbox" value="${this.escapeHtml(fullPath)}" ${isSelected ? 'checked' : ''}>
            <span class="tag-tree-node-label">${this.escapeHtml(displayName)}</span>
          </div>
          ${hasChildren ? `<div class="tag-tree-children${isExpanded ? ' expanded' : ''}">${this.renderTagTreeNodes(children, fullPath, expandedPaths)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  /**
   * 绑定标签树事件
   */
  bindTagTreeEvents(container, expandedPaths) {
    // 折叠/展开事件
    container.querySelectorAll('.tag-tree-node-toggle:not(.hidden)').forEach((toggle) => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const node = toggle.closest('.tag-tree-node');
        const children = node.querySelector('.tag-tree-children');
        if (children) {
          const isExpanded = children.classList.contains('expanded');
          children.classList.toggle('expanded', !isExpanded);
          toggle.classList.toggle('expanded', !isExpanded);
        }
      });
    });

    // checkbox 事件
    container.querySelectorAll('.tag-tree-node-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        const header = cb.closest('.tag-tree-node-header');
        if (cb.checked) {
          this.selectedTags.add(cb.value);
          header.classList.add('selected');
        } else {
          this.selectedTags.delete(cb.value);
          header.classList.remove('selected');
        }
      });
    });

    // 点击整行也可以切换选中（除了 toggle 按钮）
    container.querySelectorAll('.tag-tree-node-header').forEach((header) => {
      header.addEventListener('click', (e) => {
        // 如果点击的是 toggle 或 checkbox，不处理
        if (e.target.closest('.tag-tree-node-toggle') || e.target.classList.contains('tag-tree-node-checkbox')) {
          return;
        }
        const cb = header.querySelector('.tag-tree-node-checkbox');
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
    });
  }

  async addTagInModal() {
    const input = document.getElementById('modal-new-tag-input');
    const name = input.value.trim();
    if (!name) return;

    // 标签名验证：不允许连续斜杠、前后斜杠、空白段
    if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
      this.showToast('标签名不能以 / 开头或结尾，也不能包含连续 /', 'error');
      return;
    }
    const segments = name.split('/');
    if (segments.some((s) => !s.trim())) {
      this.showToast('标签名的每一层都不能为空', 'error');
      return;
    }
    // 标签名长度限制
    if (name.length > 100) {
      this.showToast('标签名过长，最多 100 个字符', 'error');
      return;
    }

    await this.tagManager.addTag(name);
    this.selectedTags.add(name);
    input.value = '';
    this.renderModalTagSelect();
    this.renderSidebar();
  }

  handleFileSelect(fileList) {
    console.log('[handleFileSelect] called, fileList:', fileList, 'length:', fileList?.length);
    if (!fileList || fileList.length === 0) {
      console.log('[handleFileSelect] empty fileList, returning');
      return;
    }
    for (const file of fileList) {
      const name = file.name;
      console.log('[handleFileSelect] adding file:', name);
      if (!this.pendingFileNames.some((f) => f.fullPath === name)) {
        this.pendingFileNames.push({ name, dirPath: '', fullPath: name });
      }
    }
    console.log('[handleFileSelect] pendingFileNames now:', this.pendingFileNames.length);
    try {
      this.renderPendingFiles();
      console.log('[handleFileSelect] renderPendingFiles() completed');
    } catch (err) {
      console.error('[handleFileSelect] renderPendingFiles() error:', err);
    }
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
    }).catch(() => {
      this.showToast('部分文件读取失败', 'error');
      this.renderPendingFiles();
    });
  }

  renderPendingFiles() {
    console.log('[renderPendingFiles] called, pendingFileNames:', this.pendingFileNames.length);
    const container = document.getElementById('pending-files-list');
    console.log('[renderPendingFiles] container element:', container);
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

    const html = `
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
    console.log('[renderPendingFiles] setting innerHTML');
    container.innerHTML = html;
    console.log('[renderPendingFiles] container innerHTML set, container now:', container.innerHTML.substring(0, 100));

    container.querySelectorAll('.pending-file-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx'));
        this.pendingFileNames.splice(idx, 1);
        this.renderPendingFiles();
      });
    });
  }

  async confirmAddFiles() {
    if (this._confirmAddFilesRunning) return;
    this._confirmAddFilesRunning = true;
    try {
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
      // 支持 macOS/Linux（以 / 开头）和 Windows（以盘符如 C:\ 开头）
      if (f.fullPath && (f.fullPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(f.fullPath))) {
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
    } finally {
      this._confirmAddFilesRunning = false;
    }
  }
  // ==========================================

  _dirTagTarget = null;
  _createDirTagTarget = null;

  /**
   * 显示"生成目录结构"弹窗
   * 根据当前标签及其子标签的层级，预览将在本地生成的目录结构
   */
  showCreateDirModal(tagName) {
    this._createDirTagTarget = tagName;

    // 收集该标签及其所有子标签的路径
    const allTags = this.tagManager.getAllTags();
    const prefix = tagName + '/';
    const childTags = allTags
      .filter((t) => t.name === tagName || t.name.startsWith(prefix))
      .map((t) => t.name);

    // 统计将移动的文件数（与 _doCreateDir 中的匹配策略一致：isDescendantOrSelf）
    let fileCount = 0;
    for (const file of this.fileManager.files) {
      if (!file.path || !file.tags) continue;
      if (file.tags.some((ft) => this.tagManager.isDescendantOrSelf(ft, tagName))) {
        fileCount++;
      }
    }

    // 生成预览：标签名中的 / 对应目录层级
    const displayName = this.tagManager.getDisplayName(tagName);
    const subTagCount = childTags.length > 1 ? childTags.length - 1 : 0;
    let hintText = `标签 "${displayName}" 及 ${subTagCount} 个子标签`;
    if (fileCount > 0) {
      hintText += `，关联 ${fileCount} 个文件将同步到对应目录`;
    }
    document.getElementById('create-dir-hint').textContent = hintText;

    // 根据是否有文件可移动来显示/隐藏"保留源文件"选项
    const keepSourceLabel = document.querySelector('.create-dir-keep-source');
    const keepSourceCheckbox = document.getElementById('create-dir-keep-source');
    if (keepSourceLabel) {
      keepSourceLabel.style.display = fileCount > 0 ? 'flex' : 'none';
    }
    if (keepSourceCheckbox) {
      keepSourceCheckbox.checked = true; // 默认勾选（即默认复制，保留源文件）
    }

    // 渲染预览目录树（最多显示 30 个）
    const preview = document.getElementById('create-dir-preview');
    const maxPreview = 30;
    const previewTags = childTags.slice(0, maxPreview);
    const treeHtml = previewTags.map((t) => {
      const depth = t.split('/').length - tagName.split('/').length;
      const name = t.split('/').pop();
      // 统计该标签下直接关联的文件数
      const tagFileCount = this.fileManager.files.filter(
        (f) => f.path && f.tags && f.tags.includes(t)
      ).length;
      const countBadge = tagFileCount > 0
        ? `<span style="color: var(--text-muted); font-size: 12px; margin-left: 4px;">(${tagFileCount} 个文件)</span>`
        : '';
      return `<div class="create-dir-tree-item" style="padding-left: ${8 + depth * 16}px;">
        <svg viewBox="0 0 24 24" width="14" height="14" style="opacity:0.5;vertical-align:-2px;margin-right:4px;"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></svg>
        ${this.escapeHtml(name)}${countBadge}
      </div>`;
    }).join('');
    const moreHtml = childTags.length > maxPreview
      ? `<div class="create-dir-tree-item" style="padding-left: 8px; color: var(--text-muted);">...还有 ${childTags.length - maxPreview} 个</div>`
      : '';
    preview.innerHTML = treeHtml + moreHtml;

    // 重置输入
    document.getElementById('create-dir-manual-input').value = '';
    this._createDirBasePath = null;

    this.openModal('modal-create-dir');
  }

  /**
   * 通过系统目录选择对话框选择基础路径
   */
  async _createDirBrowse() {
    try {
      this.showToast('正在打开目录选择对话框...', 'info');
      const response = await this.sendNativeAction('chooseDirectory', {}, 120000);

      if (response.cancelled) return;

      if (response.path) {
        this._createDirBasePath = response.path;
        document.getElementById('create-dir-manual-input').value = response.path;
        // 直接执行
        await this._doCreateDir(response.path);
      }
    } catch (err) {
      this.showToast(`选择目录失败: ${err.message}`, 'error');
    }
  }

  /**
   * 手动输入基础路径后生成目录
   */
  async _createDirFromManual() {
    const input = document.getElementById('create-dir-manual-input');
    if (!input) {
      console.error('找不到 create-dir-manual-input');
      return;
    }
    const basePath = input.value.trim();
    if (!basePath) {
      this.showToast('请输入基础路径', 'error');
      return;
    }
    console.log('[createDir] 手动输入路径:', basePath);
    await this._doCreateDir(basePath);
  }

  /**
   * 执行创建目录结构
   */
  async _doCreateDir(basePath) {
    const tagName = this._createDirTagTarget;
    if (!tagName) {
      console.error('[createDir] _createDirTagTarget 为空');
      return;
    }

    // 收集该标签及其所有子标签的完整路径
    const allTags = this.tagManager.getAllTags();
    const prefix = tagName + '/';
    const fullTagPaths = allTags
      .filter((t) => t.name === tagName || t.name.startsWith(prefix))
      .map((t) => t.name);

    if (fullTagPaths.length === 0) {
      this.showToast('没有可生成的标签', 'error');
      return;
    }

    // 将完整标签路径转为相对于当前标签的路径
    // 例如：tagName = "项目/项目/tmp"
    //   "项目/项目/tmp"      → "tmp"（当前标签自身，取最后一段）
    //   "项目/项目/tmp/子目录" → "tmp/子目录"（去掉父级前缀）
    const tagNameParts = tagName.split('/');
    const parentPrefix = tagNameParts.slice(0, -1).join('/'); // "项目/项目"
    const stripPrefix = parentPrefix ? parentPrefix + '/' : ''; // "项目/项目/"

    const tagPaths = fullTagPaths.map((t) => {
      if (stripPrefix && t.startsWith(stripPrefix)) {
        return t.substring(stripPrefix.length); // "项目/项目/tmp" → "tmp"
      }
      return t;
    });

    // 建立完整路径 → 相对路径的映射，供文件移动使用
    const fullToRelMap = new Map();
    for (let i = 0; i < fullTagPaths.length; i++) {
      fullToRelMap.set(fullTagPaths[i], tagPaths[i]);
    }
    const fullTagPathSet = new Set(fullTagPaths);

    // 收集需要移动的文件
    // 匹配策略：与侧边栏视图一致，使用 isDescendantOrSelf 匹配
    // 目标目录：使用去掉父层前缀后的相对路径
    const fileMoves = [];
    const fileMovesMap = new Map(); // fileId -> {src, destDir, tagName}

    for (const file of this.fileManager.files) {
      if (!file.path || !file.tags) continue;

      let bestMatch = null;
      let bestRelPath = null;
      let bestDepth = -1;

      for (const ft of file.tags) {
        // 检查该文件标签是否属于目标标签树（与侧边栏筛选逻辑一致）
        if (this.tagManager.isDescendantOrSelf(ft, tagName)) {
          const depth = ft.split('/').length;
          if (depth > bestDepth) {
            bestDepth = depth;
            bestMatch = ft;
            // 使用映射得到相对路径，如果没有映射则手动去掉前缀
            if (fullToRelMap.has(ft)) {
              bestRelPath = fullToRelMap.get(ft);
            } else if (stripPrefix && ft.startsWith(stripPrefix)) {
              bestRelPath = ft.substring(stripPrefix.length);
            } else {
              bestRelPath = ft;
            }
          }
        }
      }

      if (bestMatch && bestRelPath) {
        fileMoves.push({ src: file.path, destDir: bestRelPath });
        fileMovesMap.set(file.id, { src: file.path, destDir: bestRelPath });
      }
    }

    // 读取"保留源文件"选项
    const keepSourceCheckbox = document.getElementById('create-dir-keep-source');
    const keepSource = keepSourceCheckbox ? keepSourceCheckbox.checked : false;

    console.log('[createDir] basePath:', basePath, 'tagPaths:', JSON.stringify(tagPaths), 'fileMoves count:', fileMoves.length, 'keepSource:', keepSource);
    console.log('[createDir] fileMoves detail:', JSON.stringify(fileMoves.slice(0, 10)));
    if (fileMoves.length > 10) console.log('[createDir] ... and', fileMoves.length - 10, 'more');

    try {
      this.showToast(keepSource ? '正在创建目录结构并复制文件...' : '正在创建目录结构并移动文件...', 'info');

      let response;
      try {
        // 使用较长超时（120秒），因为移动大量文件可能需要较长时间
        response = await new Promise((resolve, reject) => {
          if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
            reject(new Error('当前环境不支持 Native Messaging'));
            return;
          }
          let settled = false;
          const timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              reject(new Error('Native Host 响应超时 (createDirStructure, 120s)'));
            }
          }, 120000);
          chrome.runtime.sendMessage(
            { action: 'createDirStructure', basePath, tagPaths, fileMoves, keepSource },
            (resp) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              console.log('[createDir] 收到响应:', resp);
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(resp);
              }
            }
          );
        });
      } catch (err) {
        console.error('[createDir] Native Host 调用失败:', err);
        this.showToast(`操作失败: ${err.message}`, 'error');
        return;
      }

      // 响应为空（Native Host 可能崩溃了）
      if (!response) {
        console.error('[createDir] 收到空响应，Native Host 可能崩溃');
        this.showToast('操作失败：Native Host 未返回结果，请检查控制台', 'error');
        return;
      }

      if (response.error) {
        this.showToast(response.error, 'error');
        return;
      }

      // 更新已移动/复制文件的路径记录
      const movedFiles = (response && response.movedFiles) || [];
      let pathUpdated = 0;
      for (const moved of movedFiles) {
        // 找到所有匹配的文件记录（同一路径可能有多条记录），全部更新 path
        const matchedFiles = this.fileManager.files.filter((f) => f.path === moved.src);
        for (const file of matchedFiles) {
          if (moved.dest) {
            // 清除旧缓存
            delete this.fileInfoCache[file.path];
            file.path = moved.dest;
            pathUpdated++;
          }
        }
        // 如果按路径没找到，尝试通过 fileMovesMap 按 id 查找
        // （应对前端路径与 native 返回路径格式略有差异的情况）
        if (matchedFiles.length === 0 && moved.dest) {
          for (const [fileId, moveInfo] of fileMovesMap) {
            if (moveInfo.src === moved.src || moved.src.endsWith(moveInfo.src.replace(/^\//, '')) || moveInfo.src.endsWith(moved.src.replace(/^\//, ''))) {
              const file = this.fileManager.getFileById(fileId);
              if (file && file.path !== moved.dest) {
                delete this.fileInfoCache[file.path];
                file.path = moved.dest;
                pathUpdated++;
              }
            }
          }
        }
      }
      if (pathUpdated > 0) {
        await this.fileManager.save();
      }

      this.closeModal('modal-create-dir');

      const created = (response && response.created) || [];
      const skipped = (response && response.skipped) || [];
      const errors = (response && response.errors) || [];
      const moveErrors = (response && response.moveErrors) || [];
      const actionWord = keepSource ? '复制' : '移动';

      // 统计降级复制的文件数
      const fallbackCopyCount = movedFiles.filter((m) => m.fallback_copy).length;
      const normalMovedCount = movedFiles.length - fallbackCopyCount;

      let msg = `已在 ${basePath} 下`;
      if (created.length > 0) msg += ` 创建 ${created.length} 个目录`;
      if (skipped.length > 0) msg += `，${skipped.length} 个目录已存在`;
      if (normalMovedCount > 0) msg += `，${actionWord} ${normalMovedCount} 个文件`;
      if (fallbackCopyCount > 0) msg += `，${fallbackCopyCount} 个文件因权限不足已复制(未删除源文件)`;
      if (errors.length > 0) msg += `，${errors.length} 个目录失败`;
      if (moveErrors.length > 0) msg += `，${moveErrors.length} 个文件${actionWord}失败`;

      const hasErrors = errors.length > 0 || moveErrors.length > 0;
      const hasFallback = fallbackCopyCount > 0;
      this.showToast(msg, (hasErrors || hasFallback) ? 'warning' : 'success');

      if (errors.length > 0) console.warn('创建目录失败:', errors);
      if (moveErrors.length > 0) console.warn('移动文件失败:', moveErrors);

      // 有失败或降级复制时，弹窗显示详情
      if (moveErrors.length > 0 || fallbackCopyCount > 0 || errors.length > 0) {
        this._showMoveErrorsModal(actionWord, moveErrors, movedFiles.filter((m) => m.fallback_copy), errors);
      }

      // 刷新文件列表UI
      if (pathUpdated > 0) {
        this.render();
      }
    } catch (err) {
      console.error('[createDir] 错误:', err);
      this.showToast(`操作失败: ${err.message}`, 'error');
    }

    this._createDirTagTarget = null;
  }

  /**
   * 弹窗显示文件移动/复制的失败详情
   * @param {string} actionWord "移动" 或 "复制"
   * @param {Array} moveErrors 完全失败的文件 [{src, error}, ...]
   * @param {Array} fallbackFiles 降级复制的文件 [{src, dest, fallback_copy}, ...]
   * @param {Array} dirErrors 目录创建失败 [{path, error}, ...]
   */
  _showMoveErrorsModal(actionWord, moveErrors, fallbackFiles, dirErrors) {
    const titleEl = document.getElementById('move-errors-title');
    const summaryEl = document.getElementById('move-errors-summary');
    const listEl = document.getElementById('move-errors-list');

    const totalIssues = moveErrors.length + fallbackFiles.length + dirErrors.length;
    titleEl.textContent = `${totalIssues} 个问题需要关注`;

    const parts = [];
    if (moveErrors.length > 0) parts.push(`${moveErrors.length} 个文件${actionWord}失败`);
    if (fallbackFiles.length > 0) parts.push(`${fallbackFiles.length} 个文件因权限不足降级为复制（源文件未删除）`);
    if (dirErrors.length > 0) parts.push(`${dirErrors.length} 个目录创建失败`);
    summaryEl.textContent = parts.join('；');

    let html = '';

    // 移动失败的文件
    for (const e of moveErrors) {
      const fileName = (e.src || '').split('/').pop() || e.src || '未知文件';
      const filePath = e.src || '';
      const reason = e.error || '未知错误';
      html += `
        <div class="move-error-item">
          <svg class="error-icon" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd"/>
          </svg>
          <div class="error-info">
            <div class="error-filename">${this.escapeHtml(fileName)}</div>
            <div class="error-path">${this.escapeHtml(filePath)}</div>
            <div class="error-reason">${actionWord}失败：${this.escapeHtml(reason)}</div>
          </div>
        </div>`;
    }

    // 降级复制的文件
    for (const f of fallbackFiles) {
      const fileName = (f.src || '').split('/').pop() || f.src || '未知文件';
      const filePath = f.src || '';
      html += `
        <div class="move-error-item">
          <svg class="error-icon warn" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd"/>
          </svg>
          <div class="error-info">
            <div class="error-filename">${this.escapeHtml(fileName)}</div>
            <div class="error-path">${this.escapeHtml(filePath)}</div>
            <div class="error-reason" style="color: #f59e0b;">权限不足无法移动，已降级为复制（源文件未删除）</div>
          </div>
        </div>`;
    }

    // 目录创建失败
    for (const e of dirErrors) {
      const dirPath = e.path || '未知目录';
      const reason = e.error || '未知错误';
      html += `
        <div class="move-error-item">
          <svg class="error-icon" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd"/>
          </svg>
          <div class="error-info">
            <div class="error-filename">📁 ${this.escapeHtml(dirPath)}</div>
            <div class="error-reason">目录创建失败：${this.escapeHtml(reason)}</div>
          </div>
        </div>`;
    }

    listEl.innerHTML = html;
    this.openModal('modal-move-errors');
  }

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
      // 超时设为 120 秒，因为需要等待用户在对话框中选择目录
      const response = await this.sendNativeAction('chooseAndListDir', {}, 120000);

      // 用户取消了选择
      if (response.cancelled) {
        this._dirTagTarget = null;
        return;
      }

      if (!response.files || response.files.length === 0) {
        this.showToast('目录为空或无可读文件', 'error');
        this._dirTagTarget = null;
        return;
      }

      // 如果有分页，继续加载后续页
      let allFiles = [...response.files];
      // dirs 只在第一页返回，包含所有子目录（包括空目录）
      const allDirs = response.dirs || [];
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

      // 从 dirs 列表中收集所有子目录（包括空目录）
      for (const relDir of allDirs) {
        // relDir 格式: "rootDir/subDir1/subDir2"
        const parts = relDir.split('/');
        for (let i = 1; i <= parts.length; i++) {
          dirSet.add(parts.slice(0, i).join('/'));
        }
      }

      for (const relPath of allFiles) {
        // relPath 格式: "rootDir/subDir/file.txt"
        const parts = relPath.split('/');
        const fileName = parts[parts.length - 1];

        // 收集文件所在的所有目录层级
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

      // 批量创建所有目录标签（只 save 一次），标记为自动创建
      const sortedDirs = Array.from(dirSet).sort();
      const allTagNames = sortedDirs.map((dir) => `${tagName}/${dir}`);
      allTagNames.push(dateTag, tagName);
      await this.tagManager.addTagsBatch(allTagNames, { source: 'auto' });

      const count = await this.fileManager.addFileRecordsWithTags(fileEntries, (processed, total) => {
        const pct = Math.round((processed / total) * 100);
        this.showToast(`正在处理 ${allFiles.length} 个文件 (${pct}%)...`, 'info');
      });

      // 记录同步目录映射
      this.syncDirMappings[tagName] = absolutePath;
      await StorageService.saveSyncDirMappings(this.syncDirMappings);

      // 只展开一级标签，不展开所有子目录
      this.expandedTags.add(tagName);

      if (count > 0) {
        this.showToast(`已添加 ${count} 个文件（路径: ${absolutePath}），创建 ${sortedDirs.length} 个目录标签`, 'success');
      } else {
        this.showToast('文件已存在', 'error');
      }
    } catch (err) {
      console.error('选择目录失败:', err);
      // Native Host 不支持或无法弹出对话框，回退到浏览器选择
      if (err.message && (err.message.includes('未知操作') || err.message.includes('无法弹出'))) {
        this.showToast('系统目录选择不可用，已切换到浏览器选择方式', 'info');
        document.getElementById('dir-picker').click();
      } else {
        this.showToast(`选择目录失败: ${err.message}`, 'error');
      }
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
          const response = await this.sendNativeAction('listDir', { path: cleanPath });

          if (response.files && response.files.length > 0) {
            for (const relPath of response.files) {
              const parts = relPath.split('/');
              const fileName = parts[parts.length - 1];
              const dirPath = parts.length > 1 ? parts.slice(0, parts.length - 1).join('/') : '';
              // parts[0] 是根目录名（与 cleanPath 末段重复），用 slice(1) 去掉
              const fullPath = `${cleanPath}/${parts.slice(1).join('/') || fileName}`;

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
    // 统一路径分隔符为 /（用于标签解析），但保留原始路径
    const normalizedPath = cleanPath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
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
      // createIfNotExists: true 表示目录不存在时自动创建
      const firstPage = await this.sendNativeAction('listDirPaged', { path: rawPath, page: 0, createIfNotExists: true });

      // 如果是新创建的空目录，显示相应提示
      if (firstPage.created) {
        this.showToast(`目录 ${rawPath} 不存在，已自动创建`, 'info');
      }

      if ((!firstPage.files || firstPage.files.length === 0) &&
          (!firstPage.dirs || firstPage.dirs.length === 0)) {
        // 空目录（可能是新创建的），仍然需要建立关联
        // 创建根标签并记录同步目录映射
        const dateTag = FileManager.getDateTag();
        const cleanBase = rawPath.replace(/\/+$/, '');

        // 批量创建标签（只 save 一次）
        await this.tagManager.addTagsBatch([dateTag, tagName], { source: 'auto' });

        // 记录同步目录映射
        this.syncDirMappings[tagName] = cleanBase;
        await StorageService.saveSyncDirMappings(this.syncDirMappings);

        // 展开标签
        this.expandedTags.add(tagName);

        const msg = firstPage.created
          ? `已创建空目录 ${rawPath} 并关联到标签 "${tagName}"，后续可使用同步功能`
          : `目录为空，已关联到标签 "${tagName}"，后续可使用同步功能`;
        this.showToast(msg, 'success');
        this._dirTagTarget = null;
        this.render();
        return;
      }

      // 如果有分页，继续加载后续页
      let allFiles = [...(firstPage.files || [])];
      // dirs 只在第一页返回，包含所有子目录（包括空目录）
      const allDirs = firstPage.dirs || [];
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

      // 从 dirs 列表中收集所有子目录（包括空目录）
      for (const relDir of allDirs) {
        // relDir 格式: "rootDir/subDir1/subDir2"
        const parts = relDir.split('/');
        for (let i = 1; i <= parts.length; i++) {
          dirSet.add(parts.slice(0, i).join('/'));
        }
      }

      for (const relPath of allFiles) {
        // relPath 格式: "rootDir/subDir/file.txt" （与 webkitRelativePath 一致）
        const parts = relPath.split('/');
        const fileName = parts[parts.length - 1];

        // 收集文件所在的所有目录层级（不含文件名）
        for (let i = 1; i < parts.length; i++) {
          dirSet.add(parts.slice(0, i).join('/'));
        }

        // 文件所在目录
        const dirPath = parts.length > 1 ? parts.slice(0, parts.length - 1).join('/') : '';

        // 构建文件的标签列表：父标签/目录路径 + 日期标签
        const fileDirTag = dirPath ? `${tagName}/${dirPath}` : tagName;

        // 真实绝对路径 = 用户输入的目录路径 + / + 去掉根目录名后的相对路径
        // relPath 格式是 "rootDir/subDir/file.txt"，parts[0] 就是根目录名，需要跳过
        const cleanBase = rawPath.replace(/\/+$/, '');
        const absolutePath = `${cleanBase}/${parts.slice(1).join('/') || fileName}`;

        fileEntries.push({
          name: fileName,
          tags: [fileDirTag, dateTag],
          path: absolutePath,
        });
      }

      // 批量创建所有目录标签（只 save 一次），标记为自动创建
      const sortedDirs = Array.from(dirSet).sort();
      const allTagNames = sortedDirs.map((dir) => `${tagName}/${dir}`);
      allTagNames.push(dateTag, tagName);
      await this.tagManager.addTagsBatch(allTagNames, { source: 'auto' });

      const count = await this.fileManager.addFileRecordsWithTags(fileEntries, (processed, total) => {
        const pct = Math.round((processed / total) * 100);
        this.showToast(`正在处理 ${allFiles.length} 个文件 (${pct}%)...`, 'info');
      });

      // 记录同步目录映射
      this.syncDirMappings[tagName] = rawPath.replace(/\/+$/, '');
      await StorageService.saveSyncDirMappings(this.syncDirMappings);

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
  // 目录文件同步
  // ==========================================

  /**
   * 查找标签（或其祖先标签）关联的同步目录
   * 例如标签 "项目/tmp/子目录" 会依次检查:
   *   "项目/tmp/子目录" -> "项目/tmp" -> "项目"
   * @returns {{ tagName: string, dirPath: string, subPath: string } | null}
   */
  _findSyncDirForTag(tagName) {
    // 精确匹配当前标签
    if (this.syncDirMappings[tagName]) {
      return { tagName, dirPath: this.syncDirMappings[tagName], subPath: '' };
    }
    // 向上查找祖先标签
    const parts = tagName.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const ancestor = parts.slice(0, i).join('/');
      if (this.syncDirMappings[ancestor]) {
        const subPath = parts.slice(i).join('/');
        return { tagName: ancestor, dirPath: this.syncDirMappings[ancestor], subPath };
      }
    }
    return null;
  }

  /**
   * 同步目录文件到标签
   * 扫描关联的目录，对比已有文件记录，增量同步新文件和新文件夹（包括空目录）
   */
  async syncDirFilesForTag(tagName) {
    const syncInfo = this._findSyncDirForTag(tagName);
    if (!syncInfo) {
      this.showToast('该标签未关联同步目录，请先通过"添加目录到此标签"导入目录', 'error');
      return;
    }

    const { tagName: rootTagName, dirPath: rootDirPath, subPath } = syncInfo;
    console.log('[syncDirFiles] tagName:', tagName, 'rootTagName:', rootTagName, 'rootDirPath:', rootDirPath, 'subPath:', subPath);

    // 如果是子标签触发的同步，自动转为根标签同步
    if (subPath) {
      const displayRootTag = this.tagManager.getDisplayName(rootTagName);
      this.showToast(`正在通过根标签「${displayRootTag}」同步整个目录...`, 'info');
    } else {
      this.showToast('正在同步目录文件...', 'info');
    }

    try {
      // 1. 通过 Native Host 分页读取目录
      const firstPage = await this.sendNativeAction('listDirPaged', { path: rootDirPath, page: 0 }, 60000);
      console.log('[syncDirFiles] firstPage:', firstPage);

      if (!firstPage || ((!firstPage.files || firstPage.files.length === 0) &&
          (!firstPage.dirs || firstPage.dirs.length === 0))) {
        this.showToast('目录为空或无可读文件', 'error');
        return;
      }

      let allFiles = [...(firstPage.files || [])];
      // dirs 只在第一页返回，包含所有子目录
      const allDirs = firstPage.dirs || [];
      const totalPages = firstPage.totalPages || 1;

      if (totalPages > 1) {
        this.showToast(`正在扫描目录... (共 ${firstPage.totalCount} 个文件, 第 1/${totalPages} 页)`, 'info');
        for (let page = 1; page < totalPages; page++) {
          try {
            const pageResp = await this.sendNativeAction('listDirPaged', { path: rootDirPath, page }, 60000);
            if (pageResp && pageResp.files) {
              allFiles = allFiles.concat(pageResp.files);
            }
            this.showToast(`正在扫描目录... (第 ${page + 1}/${totalPages} 页)`, 'info');
          } catch (err) {
            console.warn(`加载第 ${page + 1}/${totalPages} 页失败:`, err);
          }
        }
      }

      // 2. 构建当前已有文件的路径→文件对象映射（用于快速对比和补标签）
      const existingFileMap = new Map();
      for (const f of this.fileManager.files) {
        if (f.path) existingFileMap.set(f.path, f);
      }

      // 3. 构建当前已有标签集合（用于发现新增目录）
      const existingTagNames = new Set(this.tagManager.tags.map((t) => t.name));

      // 4. 收集新增文件、需补标签的文件、新增目录标签
      const dateTag = FileManager.getDateTag();
      const newDirSet = new Set();
      const newFileEntries = [];
      const tagFixEntries = []; // 已存在但缺少目录标签的文件
      const cleanBase = rootDirPath.replace(/\/+$/, '');

      console.log('[syncDirFiles] cleanBase:', cleanBase, 'rootTagName:', rootTagName);
      console.log('[syncDirFiles] allFiles count:', allFiles.length, 'allDirs count:', allDirs.length);

      // 4a. 从 dirs 列表中发现新增目录（包括空目录）
      for (const relDir of allDirs) {
        // relDir 格式: "rootName/sub1/sub2"
        const parts = relDir.split('/');
        // 构建所有层级的标签名
        for (let i = 1; i <= parts.length; i++) {
          const subDirPath = parts.slice(0, i).join('/');
          const fullTagName = `${rootTagName}/${subDirPath}`;
          if (!existingTagNames.has(fullTagName)) {
            newDirSet.add(subDirPath);
          }
        }
      }

      // 4b. 从文件列表中收集新增文件和需要补标签的文件
      for (const relPath of allFiles) {
        const parts = relPath.split('/');
        const fileName = parts[parts.length - 1];

        // 拼出绝对路径
        const absolutePath = `${cleanBase}/${parts.slice(1).join('/') || fileName}`;

        // 文件所在目录标签
        const dirSubPath = parts.length > 1 ? parts.slice(0, parts.length - 1).join('/') : '';
        const fileDirTag = dirSubPath ? `${rootTagName}/${dirSubPath}` : rootTagName;

        // 检查文件是否已存在
        const existingFile = existingFileMap.get(absolutePath);
        if (existingFile) {
          // 文件已存在，检查是否缺少目录标签
          if (!existingFile.tags || !existingFile.tags.includes(fileDirTag)) {
            tagFixEntries.push({ file: existingFile, tag: fileDirTag });
          }
          continue;
        }

        // 收集文件所在的所有目录层级
        for (let i = 1; i < parts.length; i++) {
          const subDirPath = parts.slice(0, i).join('/');
          const fullTagName = `${rootTagName}/${subDirPath}`;
          if (!existingTagNames.has(fullTagName)) {
            newDirSet.add(subDirPath);
          }
        }

        newFileEntries.push({
          name: fileName,
          tags: [fileDirTag, dateTag],
          path: absolutePath,
        });
      }

      console.log('[syncDirFiles] newFiles:', newFileEntries.length, 'tagFixes:', tagFixEntries.length, 'newDirs:', newDirSet.size);

      if (newFileEntries.length === 0 && newDirSet.size === 0 && tagFixEntries.length === 0) {
        this.showToast('目录无新增文件和目录，已是最新状态', 'success');
        return;
      }

      // 5. 批量创建新的目录标签（标记为自动创建）
      const sortedDirs = Array.from(newDirSet).sort();
      const newTagNames = sortedDirs.map((dir) => `${rootTagName}/${dir}`);
      if (newFileEntries.length > 0) {
        newTagNames.push(dateTag);
      }
      const newDirTagCount = await this.tagManager.addTagsBatch(newTagNames, { source: 'auto' });

      // 6. 增量添加新文件
      let newFileCount = 0;
      if (newFileEntries.length > 0) {
        newFileCount = await this.fileManager.addFileRecordsWithTags(newFileEntries, (processed, total) => {
          const pct = Math.round((processed / total) * 100);
          this.showToast(`正在同步 ${newFileEntries.length} 个新文件 (${pct}%)...`, 'info');
        });
      }

      // 6b. 为已存在但缺少标签的文件补上目录标签
      let tagFixCount = 0;
      if (tagFixEntries.length > 0) {
        for (const { file, tag } of tagFixEntries) {
          if (!file.tags) file.tags = [];
          if (!file.tags.includes(tag)) {
            file.tags.push(tag);
            tagFixCount++;
          }
        }
        if (tagFixCount > 0) {
          await this.fileManager.save();
        }
      }

      // 7. 更新 UI
      this.expandedTags.add(rootTagName);

      const parts = [];
      if (newFileCount > 0) parts.push(`新增 ${newFileCount} 个文件`);
      if (newDirTagCount > 0) parts.push(`新增 ${newDirTagCount} 个目录标签`);
      if (tagFixCount > 0) parts.push(`补充 ${tagFixCount} 个文件的标签关联`);
      this.showToast(`同步完成：${parts.join('，')}`, 'success');

    } catch (err) {
      console.error('同步目录失败:', err);
      this.showToast(`同步目录失败: ${err.message}`, 'error');
    }

    this.render();
  }

  // ==========================================
  // 排序
  // ==========================================

  async toggleSort() {
    const dropdown = document.getElementById('sort-dropdown');
    if (dropdown.style.display !== 'none') {
      dropdown.style.display = 'none';
      return;
    }
    dropdown.querySelectorAll('.sort-dropdown-item').forEach((item) => {
      const field = item.getAttribute('data-field');
      const dir = item.getAttribute('data-dir');
      item.classList.toggle('active', field === this.sortField && dir === this.sortOrder);
    });
    dropdown.style.display = 'block';
  }

  toggleDepthDropdown() {
    const dropdown = document.getElementById('depth-dropdown');
    if (dropdown.style.display !== 'none') {
      dropdown.style.display = 'none';
      return;
    }
    // 同步下拉框的值
    document.getElementById('depth-op-select').value = this.depthFilter.op;
    document.getElementById('depth-level-input').value = this.depthFilter.level;
    document.getElementById('depth-level-input').disabled = this.depthFilter.op === 'all';
    this._updateDepthHint();
    dropdown.style.display = 'block';
  }

  _updateDepthHint() {
    const hint = document.getElementById('depth-hint');
    const { op, level } = this.depthFilter;
    const levelNames = { 1: '当前标签', 2: '子级', 3: '孙级', 4: '曾孙级', 5: '4级子标签' };
    if (op === 'all') {
      hint.textContent = '显示当前标签及所有子标签的文件';
    } else if (op === '=') {
      hint.textContent = `仅显示第 ${level} 级（${levelNames[level] || level + '级'}）的文件`;
    } else if (op === '<=') {
      hint.textContent = `显示 ${level} 级及以内的文件（1=当前标签，2=子级...）`;
    } else if (op === '>=') {
      hint.textContent = `显示第 ${level} 级及更深层级的文件`;
    }
  }

  setDepthFilter(depth) {
    if (typeof depth === 'number') {
      this.depthFilter = depth === 0 ? { op: 'all', level: 1 } : { op: '<=', level: depth };
    }
    document.getElementById('depth-dropdown').style.display = 'none';
    this.updateDepthButton();
    this.currentPage = 1;
    this.renderFileList();
  }

  async setSortOption(field, dir) {
    this.sortField = field;
    this.sortOrder = dir;
    await StorageService.saveSortField(field);
    await StorageService.saveSortOrder(dir);
    document.getElementById('sort-dropdown').style.display = 'none';
    this.updateSortButton();
    this.currentPage = 1;
    this.renderFileList();
  }

  updateSortButton() {
    const label = document.querySelector('.sort-label');
    const fieldLabels = {
      depth: '层级',
      addedTime: '添加时间',
      name: '文件名',
      size: '文件大小',
      createdTime: '创建时间',
      modifiedTime: '修改时间',
      fileType: '文件类型',
    };
    const dirSymbol = this.sortOrder === 'desc' ? '↓' : '↑';
    label.textContent = `${fieldLabels[this.sortField] || '添加时间'} ${dirSymbol}`;
  }

  updateDepthButton() {
    const label = document.querySelector('.depth-label');
    const { op, level } = this.depthFilter;
    if (op === 'all') {
      label.textContent = '所有层级';
    } else {
      const opSymbols = { '=': '=', '<=': '≤', '>=': '≥' };
      label.textContent = `${opSymbols[op] || op} ${level}级`;
    }
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
    const sorted = [...allTags].sort((a, b) => naturalCompare(a.name, b.name));

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
    const file = this.fileManager.getFileById(fileId);
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
    const file = this.fileManager.getFileById(this.editingFileId);
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
    this.updateDepthButton();
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
        const hasSyncDir = !!this.syncDirMappings[tag.name];
        const isAutoTag = tag.source === 'auto';

        // 同步目录标识：直接关联目录的标签显示同步图标，自动创建的子标签显示小标记
        let syncBadge = '';
        if (hasSyncDir) {
          syncBadge = `<span class="tag-sync-badge" title="已关联同步目录: ${this.escapeHtml(this.syncDirMappings[tag.name])}">
            <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
          </span>`;
        } else if (isAutoTag) {
          syncBadge = `<span class="tag-auto-badge" title="由目录同步自动创建">
            <svg viewBox="0 0 24 24" width="10" height="10"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
          </span>`;
        }

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
              ${syncBadge}
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
          // 点击标签时切换展开/折叠子级
          const hasChildren = this.tagManager.getChildTags(tag).length > 0;
          if (hasChildren) {
            if (this.expandedTags.has(tag)) {
              this.expandedTags.delete(tag);
            } else {
              this.expandedTags.add(tag);
            }
          }
          // 如果已经是当前选中的标签，只刷新侧边栏（展开/折叠），不改变筛选
          if (this.activeTags.size === 1 && this.activeTags.has(tag)) {
            this.renderSidebar();
            return;
          }
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

    this._scheduleAdaptiveLayout();
  }

  renderFileList() {
    const container = document.getElementById('file-list');
    const allFilteredFiles = this.fileManager.getFilteredFiles(this.activeTags, this.filterNoTag, this.searchQuery, this.sortOrder, this.tagDisplayMode, this.searchTags, this.sortField, this.fileInfoCache, this.depthFilter);
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
      this._scheduleAdaptiveLayout();
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
      this._scheduleAdaptiveLayout();
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
    let fileIndex = startIdx; // 全局序号从当前页起始位置开始

    groups.forEach((group) => {
      html += `<div class="date-group-header">${group.label}</div>`;
      group.files.forEach((file) => {
        fileIndex++;
        html += this.renderFileCard(file, fileIndex);
      });
    });

    container.innerHTML = html;

    this.renderBatchBar(this.selectedFiles.size, totalFiles);

    // 渲染分页控件
    this.renderPagination(totalFiles, totalPages);

    // 异步加载文件详细信息（大小、创建时间等）
    this.loadFileInfoForVisibleCards();
    this._scheduleAdaptiveLayout();
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
   * 只返回文件记录中存储的真实 path，没有时返回空字符串
   */
  getFilePath(file) {
    if (!file) return '';

    // 只使用文件记录中存储的真实绝对路径
    if (file.path) return file.path;

    // 没有真实路径时返回空字符串（不要从标签推算虚假路径）
    return '';
  }

  /**
   * 获取选中文件的路径列表
   */
  getSelectedFilePaths() {
    const paths = [];
    for (const fileId of this.selectedFiles) {
      const file = this.fileManager.getFileById(fileId);
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
      const file = this.fileManager.getFileById(fileId);
      if (file) {
        names.push(file.name);
      }
    }
    return names;
  }

  // ==========================================
  // 文件重命名
  // ==========================================

  /**
   * 开始编辑文件名（双击触发）
   * 将文件名 div 替换为 input 输入框
   */
  startEditFileName(fileId, nameEl) {
    // 防止重复进入编辑状态
    if (nameEl.classList.contains('file-name-editing')) return;

    const file = this.fileManager.getFileById(fileId);
    if (!file) return;

    const oldName = file.name;
    nameEl.classList.add('file-name-editing');
    nameEl.classList.remove('file-name-editable');

    // 创建输入框
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'file-name-input';
    input.value = oldName;

    // 如果有扩展名，选中文件名（不含扩展名）
    const dotIdx = oldName.lastIndexOf('.');
    const selectEnd = dotIdx > 0 ? dotIdx : oldName.length;

    // 清空 div 内容并插入 input
    nameEl.textContent = '';
    nameEl.appendChild(input);

    // 聚焦并选中文件名（不含扩展名）
    input.focus();
    input.setSelectionRange(0, selectEnd);

    // 防重入标志，防止 blur+Enter 双重触发
    let renameConfirmed = false;

    // 确认重命名的逻辑
    const confirmRename = async () => {
      if (renameConfirmed) return;
      renameConfirmed = true;

      const newName = input.value.trim();

      // 恢复显示状态
      nameEl.classList.remove('file-name-editing');
      nameEl.classList.add('file-name-editable');

      if (!newName || newName === oldName) {
        // 取消编辑，恢复原文件名
        nameEl.textContent = oldName;
        return;
      }

      // 校验文件名
      if (/[\/\\]/.test(newName)) {
        this.showToast('文件名不能包含路径分隔符', 'error');
        nameEl.textContent = oldName;
        return;
      }

      // 如果文件有本地路径，通过 Native Host 重命名本地文件
      if (file.path) {
        try {
          nameEl.textContent = newName; // 先乐观更新UI
          const result = await this.sendNativeAction('renameFile', {
            oldPath: file.path,
            newName: newName,
          });

          if (result && result.success) {
            // 更新文件记录
            await this.fileManager.renameFileRecord(fileId, newName, result.newPath);
            // 清除旧路径的文件信息缓存
            delete this.fileInfoCache[file.path];
            // 更新卡片上的 data 属性和路径显示
            const card = nameEl.closest('.file-card');
            if (card) {
              card.setAttribute('data-filename', newName);
              card.setAttribute('data-filepath', result.newPath);
              // 更新路径提示文本
              const pathHint = card.querySelector('.file-path-hint');
              if (pathHint) {
                pathHint.textContent = result.newPath;
                pathHint.title = result.newPath;
              }
              // 更新文件名 title
              nameEl.title = result.newPath || newName;
              // 清除文件详情缓存，让其重新加载
              const detailEl = card.querySelector('.file-details');
              if (detailEl) {
                detailEl.innerHTML = '<span class="file-detail-loading">加载文件信息…</span>';
              }
            }
            this.showToast(`文件已重命名: ${oldName} → ${newName}`, 'success');
            // 刷新文件信息
            this.loadFileInfoForVisibleCards();
          } else {
            nameEl.textContent = oldName;
            this.showToast(result?.error || '重命名失败', 'error');
          }
        } catch (err) {
          nameEl.textContent = oldName;
          this.showToast('重命名失败: ' + err.message, 'error');
        }
      } else {
        // 没有本地路径的文件，只更新记录中的名称
        await this.fileManager.renameFileRecord(fileId, newName);
        nameEl.textContent = newName;
        const card = nameEl.closest('.file-card');
        if (card) card.setAttribute('data-filename', newName);
        this.showToast(`文件名已更新: ${oldName} → ${newName}`, 'success');
      }
    };

    // 回车确认
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        // ESC 取消
        e.preventDefault();
        input.value = oldName;
        input.blur();
      }
    });

    // 失焦确认
    input.addEventListener('blur', () => {
      confirmRename();
    });

    // 阻止冒泡（避免触发卡片选中等事件）
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  /**
   * 发送 Native Messaging 消息（通过 background.js 中转）
   */
  sendNativeAction(action, data = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        reject(new Error('当前环境不支持 Native Messaging'));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Native Host 响应超时 (${action}, ${timeoutMs}ms)`));
        }
      }, timeoutMs);
      chrome.runtime.sendMessage(
        { action, ...data },
        (resp) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
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
    const file = this.fileManager.getFileById(fileId);
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
      // 兼容 Windows \ 和 Unix / 路径分隔符
      const lastSlash = Math.max(file.path.lastIndexOf('/'), file.path.lastIndexOf('\\'));
      if (lastSlash <= 0) {
        // Windows 盘符路径如 "C:\file.txt" → lastSlash = 2，取 "C:\"
        const colonIdx = file.path.indexOf(':');
        if (colonIdx === 1) return file.path.substring(0, 3); // "C:\"
        return '/';
      }
      return file.path.substring(0, lastSlash);
    }

    return '';
  }

  /**
   * 在 Finder 中打开文件所在目录
   * 如果目录不存在，则逐级向上找到最近的存在的父目录并打开
   */
  async revealFileById(fileId) {
    const file = this.fileManager.getFileById(fileId);
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
      // 兼容 Windows \ 和 Unix / 路径分隔符
      const lastSlash = Math.max(current.lastIndexOf('/'), current.lastIndexOf('\\'));
      if (lastSlash <= 0) {
        // Windows 盘符根目录 "C:\" 场景
        if (current.length >= 2 && current[1] === ':') return null;
        return null; // 到根目录了
      }
      current = current.substring(0, lastSlash);
      if (!current || (current.length === 2 && current[1] === ':')) return null;
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
   * @param {string} [termApp] 终端应用名，默认根据平台选择
   */
  async openTerminalById(fileId, termApp) {
    if (!termApp) termApp = this.platform === 'win' ? 'cmd' : 'Terminal';
    const file = this.fileManager.getFileById(fileId);
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
   * @param {string} [termApp] 终端应用名，默认根据平台选择
   */
  async batchOpenTerminal(termApp) {
    if (!termApp) termApp = this.platform === 'win' ? 'cmd' : 'Terminal';
    if (this.selectedFiles.size === 0) return;

    // 收集所有目录路径并去重
    const dirPaths = new Set();
    let noPathCount = 0;
    for (const fileId of this.selectedFiles) {
      const file = this.fileManager.getFileById(fileId);
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
        const file = this.fileManager.getFileById(fileId);
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
      const file = this.fileManager.getFileById(fileId);
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
    }).catch(() => {
      this.showToast('复制失败，请检查剪贴板权限', 'error');
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
    const allFilteredFiles = this.fileManager.getFilteredFiles(this.activeTags, this.filterNoTag, this.searchQuery, this.sortOrder, this.tagDisplayMode, this.searchTags, this.sortField, this.fileInfoCache, this.depthFilter);
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

    this.renderBatchBar(this.selectedFiles.size, allFilteredFiles.length);
  }

  async batchRemoveFiles() {
    if (this.selectedFiles.size === 0) return;
    const count = await this.fileManager.moveToTrashBatch(this.selectedFiles);
    this.selectedFiles.clear();
    this.showToast(`已将 ${count} 个文件移入回收站`, 'info');
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

    // 获取所选文件已有的标签，用于决定默认展开哪些
    const selectedFileTags = new Set();
    for (const fileId of this.selectedFiles) {
      const file = this.fileManager.getFileById(fileId);
      if (file && file.tags) {
        file.tags.forEach((t) => selectedFileTags.add(t));
      }
    }

    // 构建树形结构
    const tagNames = allTags.map((t) => t.name);
    const tree = this.buildTagTree(tagNames);

    // 确定需要展开的路径（与选中文件相关的标签路径）
    const expandedPaths = new Set();
    for (const tag of selectedFileTags) {
      const parts = tag.split('/');
      let path = '';
      for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        expandedPaths.add(path);
      }
    }

    // 移除模式下添加提示区域
    const warningHtml = isRemoveMode
      ? `<div id="batch-tag-warning" class="batch-tag-warning" style="display:none;">
           <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
           <span id="batch-tag-warning-text"></span>
         </div>`
      : '';

    // 渲染树（传入已选中文件的标签，用于默认选中）
    container.innerHTML = warningHtml + this.renderBatchTagTreeNodes(tree, '', expandedPaths, isRemoveMode, selectedFileTags);

    // 绑定事件
    this.bindBatchTagTreeEvents(container, expandedPaths, isRemoveMode);
  }

  /**
   * 渲染批量标签树节点
   * @param {Set} preSelectedTags - 需要默认选中的标签（所选文件已有的标签）
   */
  renderBatchTagTreeNodes(tree, parentPath, expandedPaths, isRemoveMode, preSelectedTags = new Set()) {
    const keys = Object.keys(tree).sort((a, b) => naturalCompare(a, b));
    if (keys.length === 0) return '';

    return keys.map((key) => {
      const node = tree[key];
      const fullPath = node.__fullPath;
      const children = node.__children;
      const hasChildren = Object.keys(children).length > 0;
      const isExpanded = expandedPaths.has(fullPath);
      const isPreSelected = preSelectedTags.has(fullPath);

      const displayName = key;

      return `
        <div class="tag-tree-node" data-path="${this.escapeHtml(fullPath)}">
          <div class="tag-tree-node-header${isPreSelected ? ' selected' : ''}">
            <span class="tag-tree-node-toggle${hasChildren ? (isExpanded ? ' expanded' : '') : ' hidden'}">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
            </span>
            <input type="checkbox" class="tag-tree-node-checkbox" value="${this.escapeHtml(fullPath)}"${isPreSelected ? ' checked' : ''}>
            <span class="tag-tree-node-label">${this.escapeHtml(displayName)}</span>
          </div>
          ${hasChildren ? `<div class="tag-tree-children${isExpanded ? ' expanded' : ''}">${this.renderBatchTagTreeNodes(children, fullPath, expandedPaths, isRemoveMode, preSelectedTags)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  /**
   * 绑定批量标签树事件
   */
  bindBatchTagTreeEvents(container, expandedPaths, isRemoveMode) {
    // 折叠/展开事件
    container.querySelectorAll('.tag-tree-node-toggle:not(.hidden)').forEach((toggle) => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const node = toggle.closest('.tag-tree-node');
        const children = node.querySelector('.tag-tree-children');
        if (children) {
          const isExpanded = children.classList.contains('expanded');
          children.classList.toggle('expanded', !isExpanded);
          toggle.classList.toggle('expanded', !isExpanded);
        }
      });
    });

    // checkbox 事件
    container.querySelectorAll('.tag-tree-node-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        const header = cb.closest('.tag-tree-node-header');
        if (cb.checked) {
          header.classList.add('selected');
        } else {
          header.classList.remove('selected');
        }

        // 移除模式：勾选父标签时自动勾选所有子标签
        if (isRemoveMode) {
          const tagName = cb.value;
          const prefix = tagName + '/';

          if (cb.checked) {
            container.querySelectorAll('.tag-tree-node-checkbox').forEach((otherCb) => {
              if (otherCb.value.startsWith(prefix)) {
                otherCb.checked = true;
                otherCb.disabled = true;
                otherCb.closest('.tag-tree-node-header')?.classList.add('auto-checked');
              }
            });
            this._updateBatchTagWarning(container);
          } else {
            container.querySelectorAll('.tag-tree-node-checkbox').forEach((otherCb) => {
              if (otherCb.value.startsWith(prefix)) {
                const stillLocked = this._isLockedByAnotherParent(container, otherCb.value, tagName);
                if (!stillLocked) {
                  otherCb.checked = false;
                  otherCb.disabled = false;
                  otherCb.closest('.tag-tree-node-header')?.classList.remove('auto-checked');
                }
              }
            });
            this._updateBatchTagWarning(container);
          }
        }
      });
    });

    // 点击整行也可以切换选中
    container.querySelectorAll('.tag-tree-node-header').forEach((header) => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('.tag-tree-node-toggle') || e.target.classList.contains('tag-tree-node-checkbox')) {
          return;
        }
        const cb = header.querySelector('.tag-tree-node-checkbox');
        if (!cb.disabled) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        }
      });
    });
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
    const autoChecked = container.querySelectorAll('.tag-tree-node-header.auto-checked');
    if (autoChecked.length > 0) {
      const parentTags = [];
      container.querySelectorAll('.tag-tree-node-checkbox:checked:not(:disabled)').forEach((cb) => {
        // 找有子标签被自动选中的父标签
        const hasAutoChild = container.querySelector(`.tag-tree-node-header.auto-checked .tag-tree-node-checkbox[value^="${CSS.escape(cb.value + '/')}"]`);
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
    if (this._confirmBatchTagRunning) return;
    this._confirmBatchTagRunning = true;
    try {
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
      const file = this.fileManager.getFileById(fileId);
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
    } finally {
      this._confirmBatchTagRunning = false;
    }
  }

  renderFileCard(file, index) {
    const ext = this.getFileExtension(file.name);
    const iconClass = this.getIconClass(ext);
    const time = this.formatTime(file.addedTime);
    const isSelected = this.selectedFiles.has(file.id);
    const tagsHtml = file.tags.map((tag) => {
      const color = this.tagManager.getTagColor(tag);
      return `<span class="file-tag color-${color}">${this.escapeHtml(tag)}</span>`;
    }).join('');

    // 计算文件相对于选中标签的最小层级（1=当前标签，2=子级，3=孙级...）
    let depthBadge = '';
    if (this.activeTags.size > 0) {
      let minDepth = Infinity;
      for (const tag of file.tags) {
        for (const activeTag of this.activeTags) {
          if (tag === activeTag) {
            minDepth = Math.min(minDepth, 1);
          } else if (tag.startsWith(activeTag + '/')) {
            const d = tag.substring(activeTag.length + 1).split('/').length + 1;
            minDepth = Math.min(minDepth, d);
          }
        }
      }
      if (minDepth !== Infinity) {
        const cls = minDepth <= 1 ? 'level-current' : minDepth === 2 ? 'level-child' : 'level-deep';
        depthBadge = `<span class="file-depth-badge ${cls}">${minDepth}</span>`;
      }
    }

    // 推算文件的完整路径（从标签中获取目录信息，仅供显示）
    const filePath = this.getFilePath(file);
    // 真实目录路径（只在有 file.path 时才有值）
    const dirPath = this.getFileDirPath(file);

    return `
      <div class="file-card ${isSelected ? 'selected' : ''}" data-id="${file.id}" data-filepath="${this.escapeHtml(filePath)}" data-dirpath="${this.escapeHtml(dirPath)}" data-filename="${this.escapeHtml(file.name)}">
        <div class="file-index-area">
          <span class="file-index">${index}</span>
          ${depthBadge}
        </div>
        <input type="checkbox" class="file-checkbox" data-id="${file.id}" ${isSelected ? 'checked' : ''} />
        <div class="file-icon ${iconClass}">
          ${this.getFileEmoji(ext)}
        </div>
        <div class="file-info">
          <div class="file-name file-name-editable" data-file-id="${file.id}" title="${this.escapeHtml(filePath || file.name)}">${this.escapeHtml(file.name)}</div>
          <div class="file-meta">
            <span class="file-time">${time}</span>
            ${filePath ? `<span class="file-path-hint" title="${this.escapeHtml(filePath)}">${this.escapeHtml(filePath)}</span>` : '<span class="file-path-hint file-path-unknown">（无真实路径）</span>'}
          </div>
          <div class="file-details">${(filePath && this.fileInfoCache[filePath]) ? '' : (filePath ? '<span class="file-detail-loading">加载文件信息…</span>' : '')}</div>
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
              <button class="terminal-dropdown-item" data-terminal="${this.platform === 'win' ? 'cmd' : 'Terminal'}">${this.platform === 'win' ? '命令提示符 (CMD)' : '终端 (Terminal)'}</button>
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
    const trashCountEl = document.getElementById('trash-count');
    if (trashCountEl) {
      const trashLen = this.fileManager.trash.length;
      trashCountEl.textContent = trashLen > 0 ? `回收站(${trashLen})` : '回收站';
      trashCountEl.classList.toggle('has-items', trashLen > 0);
    }
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
    const isMac = this.platform === 'mac';
    const isWin = this.platform === 'win';

    // 通用编辑器（跨平台）
    const editors = [
      { app: 'Visual Studio Code', label: 'VS Code' },
      { app: 'Cursor', label: 'Cursor' },
      { app: 'Sublime Text', label: 'Sublime Text' },
    ];

    // 平台特定应用
    const textEdit = isMac ? { app: 'TextEdit', label: '文本编辑' }
      : isWin ? { app: 'notepad', label: '记事本' }
      : { app: 'gedit', label: '文本编辑器' };

    const terminal = isMac ? { app: 'Terminal', label: '终端' }
      : isWin ? { app: 'cmd', label: '命令提示符' }
      : { app: 'x-terminal-emulator', label: '终端' };

    const altTerminal = isMac ? { app: 'iTerm', label: 'iTerm2' }
      : isWin ? { app: 'PowerShell', label: 'PowerShell' }
      : { app: 'gnome-terminal', label: 'GNOME 终端' };

    const imageViewer = isMac ? { app: 'Preview', label: '预览' }
      : isWin ? { app: 'mspaint', label: '画图' }
      : { app: 'eog', label: '图像查看器' };

    const chrome = { app: 'Google Chrome', label: 'Chrome' };

    const browser2 = isMac ? { app: 'Safari', label: 'Safari' }
      : isWin ? { app: 'msedge', label: 'Edge' }
      : { app: 'firefox', label: 'Firefox' };

    const fileManager = isMac ? { app: 'Finder', label: 'Finder' }
      : isWin ? { app: 'explorer', label: '资源管理器' }
      : { app: 'nautilus', label: '文件管理器' };

    const spreadsheet = isMac ? { app: 'Numbers', label: 'Numbers' }
      : { app: 'Microsoft Excel', label: 'Excel' };

    const wordProcessor = isMac ? { app: 'Pages', label: 'Pages' }
      : { app: 'Microsoft Word', label: 'Word' };

    const presentation = isMac ? { app: 'Keynote', label: 'Keynote' }
      : { app: 'Microsoft PowerPoint', label: 'PowerPoint' };

    const extLower = (ext || '').toLowerCase();

    // Shell/脚本类
    if (['sh', 'bash', 'zsh', 'command', 'tool'].includes(extLower) || (isWin && ['bat', 'cmd', 'ps1'].includes(extLower))) {
      return [terminal, altTerminal, ...editors, textEdit];
    }
    // Python
    if (['py', 'pyw'].includes(extLower)) {
      return [terminal, altTerminal, ...editors, textEdit];
    }
    // Web 文件
    if (['html', 'htm', 'xhtml'].includes(extLower)) {
      return [chrome, browser2, ...editors, textEdit];
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
      return [imageViewer, chrome, { app: isMac ? 'Photos' : isWin ? 'ms-photos:' : 'eog', label: '照片' }, ...editors];
    }
    // PDF
    if (extLower === 'pdf') {
      if (isWin) return [chrome, { app: 'AcroRd32', label: 'Adobe Reader' }, browser2];
      return [imageViewer, chrome, browser2];
    }
    // Excel / 表格
    if (['xlsx', 'xls', 'numbers'].includes(extLower)) {
      return [spreadsheet, ...(isMac ? [{ app: 'Microsoft Excel', label: 'Excel' }] : []), ...editors];
    }
    // Word / 文档
    if (['doc', 'docx', 'pages'].includes(extLower)) {
      return [wordProcessor, ...(isMac ? [{ app: 'Microsoft Word', label: 'Word' }] : []), textEdit, imageViewer];
    }
    // PPT / 演示文稿
    if (['ppt', 'pptx', 'key'].includes(extLower)) {
      return [presentation, ...(isMac ? [{ app: 'Microsoft PowerPoint', label: 'PowerPoint' }] : []), imageViewer];
    }
    // 音频
    if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'].includes(extLower)) {
      if (isWin) return [{ app: 'wmplayer', label: 'Windows Media Player' }, { app: 'VLC', label: 'VLC' }];
      if (isMac) return [{ app: 'Music', label: '音乐' }, { app: 'QuickTime Player', label: 'QuickTime' }, { app: 'VLC', label: 'VLC' }];
      return [{ app: 'VLC', label: 'VLC' }, { app: 'rhythmbox', label: 'Rhythmbox' }];
    }
    // 视频
    if (['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm'].includes(extLower)) {
      if (isWin) return [{ app: 'wmplayer', label: 'Windows Media Player' }, { app: 'VLC', label: 'VLC' }, { app: 'PotPlayer', label: 'PotPlayer' }];
      if (isMac) return [{ app: 'QuickTime Player', label: 'QuickTime' }, { app: 'IINA', label: 'IINA' }, { app: 'VLC', label: 'VLC' }];
      return [{ app: 'VLC', label: 'VLC' }, { app: 'mpv', label: 'mpv' }];
    }
    // 压缩包
    if (['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'tgz'].includes(extLower)) {
      if (isWin) return [{ app: '7zFM', label: '7-Zip' }, { app: 'WinRAR', label: 'WinRAR' }, fileManager];
      if (isMac) return [{ app: 'Archive Utility', label: '归档实用工具' }, { app: 'The Unarchiver', label: 'The Unarchiver' }, fileManager];
      return [{ app: 'file-roller', label: '归档管理器' }, fileManager];
    }
    // 默认：编辑器 + 文本编辑
    return [...editors, textEdit, imageViewer, chrome];
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

  // ==========================================
  // 清理失效文件 & 回收站
  // ==========================================

  /** 显示/更新/隐藏居中进度浮层 */
  _showProgress(text) {
    let overlay = document.getElementById('cleanup-progress-overlay');
    if (!text) {
      if (overlay) overlay.remove();
      return;
    }
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'cleanup-progress-overlay';
      overlay.className = 'progress-overlay';
      overlay.innerHTML = '<div class="progress-box"><span class="progress-text"></span></div>';
      document.body.appendChild(overlay);
    }
    overlay.querySelector('.progress-text').textContent = text;
  }

  /** 检测并显示失效文件（通过 batchGetFileInfo 批量检测） */
  async showCleanupModal() {
    const filesWithPath = this.fileManager.files.filter((f) => f.path);
    if (filesWithPath.length === 0) {
      this.showToast('没有可检测的文件（文件需要有路径信息）', 'info');
      return;
    }

    this._showProgress(`正在检测文件... (0/${filesWithPath.length})`);

    // 分批检测（每批 200 个路径，避免消息过大）
    const BATCH_SIZE = 200;
    const missingFiles = [];

    for (let i = 0; i < filesWithPath.length; i += BATCH_SIZE) {
      const batch = filesWithPath.slice(i, i + BATCH_SIZE);
      const paths = batch.map((f) => f.path);
      try {
        const result = await this.sendNativeAction('batchGetFileInfo', { paths });
        if (result && result.files) {
          batch.forEach((f) => {
            const info = result.files[f.path];
            if (!info || info.error) {
              missingFiles.push(f);
            }
          });
        }
      } catch (err) {
        console.warn('检测文件批次失败:', err);
        // 检测失败的文件不标记为失效
      }
      const checked = Math.min(i + BATCH_SIZE, filesWithPath.length);
      this._showProgress(`正在检测文件... (${checked}/${filesWithPath.length})`);
    }

    // 隐藏进度浮层
    this._showProgress(null);

    if (missingFiles.length === 0) {
      this.showToast('✓ 所有文件都存在，没有需要清理的', 'success');
      return;
    }

    // 显示清理弹窗
    this._cleanupFiles = missingFiles;
    this._cleanupSelected = new Set(missingFiles.map((f) => f.id));
    this._renderCleanupList();
    this.openModal('modal-cleanup');
  }

  /** 渲染清理弹窗中的失效文件列表 */
  _renderCleanupList() {
    const list = document.getElementById('cleanup-file-list');
    const countEl = document.getElementById('cleanup-count');
    if (!list || !this._cleanupFiles) return;

    countEl.textContent = `检测到 ${this._cleanupFiles.length} 个失效文件`;

    list.innerHTML = this._cleanupFiles.map((f) => {
      const checked = this._cleanupSelected.has(f.id) ? 'checked' : '';
      const tags = (f.tags || []).map((t) => `<span class="cleanup-tag">${this.escapeHtml(t)}</span>`).join('');
      return `
        <label class="cleanup-item">
          <input type="checkbox" data-id="${f.id}" ${checked} />
          <div class="cleanup-item-info">
            <span class="cleanup-item-name" title="${this.escapeHtml(f.path || f.name)}">${this.escapeHtml(f.name)}</span>
            <span class="cleanup-item-path">${this.escapeHtml(f.path || '')}</span>
            ${tags ? `<div class="cleanup-item-tags">${tags}</div>` : ''}
          </div>
        </label>`;
    }).join('');

    // 绑定复选框事件
    list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) {
          this._cleanupSelected.add(cb.dataset.id);
        } else {
          this._cleanupSelected.delete(cb.dataset.id);
        }
        document.getElementById('cleanup-selected-info').textContent =
          `已选择 ${this._cleanupSelected.size} / ${this._cleanupFiles.length}`;
      });
    });

    document.getElementById('cleanup-selected-info').textContent =
      `已选择 ${this._cleanupSelected.size} / ${this._cleanupFiles.length}`;
  }

  /** 全选/取消全选清理列表 */
  toggleCleanupSelectAll() {
    if (!this._cleanupFiles) return;
    const allSelected = this._cleanupSelected.size === this._cleanupFiles.length;
    if (allSelected) {
      this._cleanupSelected.clear();
    } else {
      this._cleanupSelected = new Set(this._cleanupFiles.map((f) => f.id));
    }
    this._renderCleanupList();
  }

  /** 确认清理（移入回收站） */
  async confirmCleanup() {
    if (!this._cleanupSelected || this._cleanupSelected.size === 0) {
      this.showToast('请至少选择一个文件', 'error');
      return;
    }

    const count = await this.fileManager.moveToTrashBatch(this._cleanupSelected);
    this.closeModal('modal-cleanup');
    this._cleanupFiles = null;
    this._cleanupSelected = null;
    this.showToast(`已将 ${count} 个失效文件移入回收站`, 'success');
    this.render();
  }

  /** 打开回收站弹窗 */
  showTrashModal() {
    this.trashCurrentPage = 1;
    this.trashSearchQuery = '';
    this.trashSearchTags = new Set();
    // 重置搜索 UI
    const searchInput = document.getElementById('trash-search-input');
    if (searchInput) searchInput.value = '';
    const chipsEl = document.getElementById('trash-tag-chips');
    if (chipsEl) { chipsEl.style.display = 'none'; chipsEl.innerHTML = ''; }
    const dropdown = document.getElementById('trash-tag-dropdown');
    if (dropdown) dropdown.style.display = 'none';
    const toggle = document.getElementById('trash-tag-toggle');
    if (toggle) toggle.classList.remove('active');
    this._bindTrashSearchEvents();
    this._renderTrashList();
    this.openModal('modal-trash');
  }

  /** 绑定回收站搜索事件（仅绑定一次） */
  _bindTrashSearchEvents() {
    if (this._trashSearchBound) return;
    this._trashSearchBound = true;

    // 文件名搜索（200ms 防抖）
    this._trashSearchDebounce = null;
    document.getElementById('trash-search-input')?.addEventListener('input', (e) => {
      this.trashSearchQuery = e.target.value;
      this.trashCurrentPage = 1;
      clearTimeout(this._trashSearchDebounce);
      this._trashSearchDebounce = setTimeout(() => {
        this._renderTrashList();
      }, 200);
    });

    // 标签筛选按钮
    document.getElementById('trash-tag-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleTrashTagDropdown();
    });

    // 标签过滤输入（150ms 防抖）
    this._trashTagFilterDebounce = null;
    document.getElementById('trash-tag-filter-input')?.addEventListener('input', (e) => {
      clearTimeout(this._trashTagFilterDebounce);
      this._trashTagFilterDebounce = setTimeout(() => {
        this._renderTrashTagList(e.target.value.trim().toLowerCase());
      }, 150);
    });
    document.getElementById('trash-tag-filter-input')?.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // 点击外部关闭标签下拉
    document.getElementById('modal-trash')?.addEventListener('click', (e) => {
      const dropdown = document.getElementById('trash-tag-dropdown');
      if (dropdown && dropdown.style.display !== 'none' &&
          !e.target.closest('.search-tag-dropdown') &&
          !e.target.closest('#trash-tag-toggle')) {
        dropdown.style.display = 'none';
        document.getElementById('trash-tag-toggle')?.classList.remove('active');
      }
    });
  }

  /** 切换回收站标签下拉面板 */
  _toggleTrashTagDropdown() {
    const dropdown = document.getElementById('trash-tag-dropdown');
    const toggle = document.getElementById('trash-tag-toggle');
    const filterInput = document.getElementById('trash-tag-filter-input');

    if (dropdown.style.display !== 'none') {
      dropdown.style.display = 'none';
      toggle.classList.remove('active');
    } else {
      dropdown.style.display = 'flex';
      toggle.classList.add('active');
      filterInput.value = '';
      filterInput.focus();
      this._renderTrashTagList('');
    }
  }

  /** 渲染回收站标签选择列表 */
  _renderTrashTagList(filterText) {
    const container = document.getElementById('trash-tag-list');
    if (!container) return;

    // 收集回收站文件中出现的标签及计数
    const trashFiles = this.fileManager.getTrashFiles();
    const tagCounts = new Map();
    trashFiles.forEach((f) => {
      (f.tags || []).forEach((t) => {
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      });
    });

    const allTags = this.tagManager.getAllTags();
    const tagColors = [
      '#3b82f6', '#10b981', '#f59e0b', '#ec4899',
      '#6366f1', '#a855f7', '#ef4444', '#14b8a6',
    ];

    // 只显示回收站中存在的标签
    const sorted = [...allTags]
      .filter((t) => tagCounts.has(t.name))
      .sort((a, b) => naturalCompare(a.name, b.name));

    const filtered = filterText
      ? sorted.filter((t) => t.name.toLowerCase().includes(filterText))
      : sorted;

    if (filtered.length === 0) {
      container.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px;">没有匹配的标签</div>';
      return;
    }

    container.innerHTML = filtered.map((tag) => {
      const isSelected = this.trashSearchTags.has(tag.name);
      const count = tagCounts.get(tag.name) || 0;
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
        if (this.trashSearchTags.has(tagName)) {
          this.trashSearchTags.delete(tagName);
        } else {
          this.trashSearchTags.add(tagName);
        }
        const filterInput = document.getElementById('trash-tag-filter-input');
        this._renderTrashTagList(filterInput.value.trim().toLowerCase());
        this._updateTrashTagChips();
        this.trashCurrentPage = 1;
        this._renderTrashList();
      });
    });
  }

  /** 更新回收站已选标签 chips */
  _updateTrashTagChips() {
    const chipsContainer = document.getElementById('trash-tag-chips');
    if (!chipsContainer) return;

    if (this.trashSearchTags.size === 0) {
      chipsContainer.style.display = 'none';
      chipsContainer.innerHTML = '';
      return;
    }

    chipsContainer.style.display = 'flex';

    const tagColors = [
      '#3b82f6', '#10b981', '#f59e0b', '#ec4899',
      '#6366f1', '#a855f7', '#ef4444', '#14b8a6',
    ];

    let html = [...this.trashSearchTags].map((tagName) => {
      const displayName = this.tagManager.getDisplayName(tagName);
      const tag = this.tagManager.getAllTags().find((t) => t.name === tagName);
      const color = tag ? tagColors[tag.color % 8] : tagColors[0];
      return `<span class="search-tag-chip" data-tag="${this.escapeHtml(tagName)}" style="border-left: 3px solid ${color};">
        <span class="chip-name">${this.escapeHtml(displayName)}</span>
        <span class="chip-remove" data-tag="${this.escapeHtml(tagName)}">&times;</span>
      </span>`;
    }).join('');

    html += '<button class="search-tag-clear-all">清除</button>';
    chipsContainer.innerHTML = html;

    // 绑定移除单个标签
    chipsContainer.querySelectorAll('.chip-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tagName = btn.getAttribute('data-tag');
        this.trashSearchTags.delete(tagName);
        this._updateTrashTagChips();
        const dropdown = document.getElementById('trash-tag-dropdown');
        if (dropdown && dropdown.style.display !== 'none') {
          const filterInput = document.getElementById('trash-tag-filter-input');
          this._renderTrashTagList(filterInput.value.trim().toLowerCase());
        }
        this.trashCurrentPage = 1;
        this._renderTrashList();
      });
    });

    // 绑定清除全部
    chipsContainer.querySelector('.search-tag-clear-all')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.trashSearchTags.clear();
      this._updateTrashTagChips();
      const dropdown = document.getElementById('trash-tag-dropdown');
      if (dropdown && dropdown.style.display !== 'none') {
        const filterInput = document.getElementById('trash-tag-filter-input');
        this._renderTrashTagList(filterInput.value.trim().toLowerCase());
      }
      this.trashCurrentPage = 1;
      this._renderTrashList();
    });
  }

  /** 渲染回收站列表 */
  _renderTrashList() {
    const list = document.getElementById('trash-file-list');
    const infoEl = document.getElementById('trash-info');
    const emptyBtn = document.getElementById('btn-empty-trash');
    const restoreAllBtn = document.getElementById('btn-restore-all');
    if (!list) return;

    const allTrashFiles = this.fileManager.getTrashFiles();

    if (allTrashFiles.length === 0) {
      list.innerHTML = '<div class="trash-empty">回收站为空</div>';
      infoEl.textContent = '';
      emptyBtn.style.display = 'none';
      restoreAllBtn.style.display = 'none';
      return;
    }

    emptyBtn.style.display = '';
    restoreAllBtn.style.display = '';

    // 搜索过滤
    let trashFiles = allTrashFiles;
    const query = (this.trashSearchQuery || '').trim().toLowerCase();
    const searchTags = this.trashSearchTags || new Set();

    if (searchTags.size > 0) {
      trashFiles = trashFiles.filter((f) =>
        (f.tags || []).some((t) => {
          for (const tag of searchTags) {
            if (this.tagManager.isDescendantOrSelf(t, tag)) return true;
          }
          return false;
        })
      );
    }

    if (query) {
      trashFiles = trashFiles.filter((f) =>
        f.name.toLowerCase().includes(query) ||
        (f.tags || []).some((t) => t.toLowerCase().includes(query))
      );
    }

    // 分页
    const totalPages = Math.max(1, Math.ceil(trashFiles.length / this.trashPageSize));
    if (this.trashCurrentPage > totalPages) this.trashCurrentPage = totalPages;
    const startIdx = (this.trashCurrentPage - 1) * this.trashPageSize;
    const pageFiles = trashFiles.slice(startIdx, startIdx + this.trashPageSize);

    const hasFilter = query || searchTags.size > 0;
    infoEl.textContent = hasFilter
      ? `匹配 ${trashFiles.length}/${allTrashFiles.length} 个文件` +
        (totalPages > 1 ? ` · 第 ${this.trashCurrentPage}/${totalPages} 页` : '')
      : `共 ${trashFiles.length} 个文件` +
        (totalPages > 1 ? ` · 第 ${this.trashCurrentPage}/${totalPages} 页` : '');

    if (trashFiles.length === 0) {
      list.innerHTML = '<div class="trash-empty">没有匹配的文件</div>';
      return;
    }

    list.innerHTML = pageFiles.map((f) => {
      const deletedStr = this.formatTime(f.deletedTime);
      const tags = (f.tags || []).slice(0, 3).map((t) =>
        `<span class="cleanup-tag">${this.escapeHtml(this.tagManager.getDisplayName(t))}</span>`
      ).join('');
      return `
        <div class="trash-item" data-id="${f.id}">
          <div class="trash-item-info">
            <span class="trash-item-name" title="${this.escapeHtml(f.path || f.name)}">${this.escapeHtml(f.name)}</span>
            <div class="trash-item-meta">
              <span class="trash-item-time">删除于 ${deletedStr}</span>
              ${tags}
            </div>
          </div>
          <div class="trash-item-actions">
            <button class="btn btn-sm btn-secondary trash-restore-btn" data-id="${f.id}" title="恢复">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>
              恢复
            </button>
            <button class="btn btn-sm btn-danger trash-delete-btn" data-id="${f.id}" title="永久删除">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </div>`;
    }).join('');

    // 分页控件
    if (totalPages > 1) {
      list.innerHTML += `
        <div class="trash-pagination">
          <button class="btn btn-sm btn-secondary" ${this.trashCurrentPage <= 1 ? 'disabled' : ''} data-trash-page="${this.trashCurrentPage - 1}">上一页</button>
          <span>${this.trashCurrentPage} / ${totalPages}</span>
          <button class="btn btn-sm btn-secondary" ${this.trashCurrentPage >= totalPages ? 'disabled' : ''} data-trash-page="${this.trashCurrentPage + 1}">下一页</button>
        </div>`;
    }

    // 绑定事件
    list.querySelectorAll('.trash-restore-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await this.fileManager.restoreFromTrash(btn.dataset.id);
        this.showToast('已恢复文件', 'success');
        this._renderTrashList();
        this.render();
      });
    });

    list.querySelectorAll('.trash-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await this.fileManager.deleteFromTrash(btn.dataset.id);
        this.showToast('已永久删除', 'info');
        this._renderTrashList();
        this.renderFooter();
      });
    });

    list.querySelectorAll('[data-trash-page]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.trashCurrentPage = parseInt(btn.dataset.trashPage);
        this._renderTrashList();
      });
    });
  }

  /** 清空回收站 */
  async emptyTrash() {
    const count = this.fileManager.trash.length;
    if (count === 0) return;
    if (!confirm(`确定要永久删除回收站中的 ${count} 个文件记录吗？此操作不可恢复！`)) return;
    await this.fileManager.emptyTrash();
    this.showToast(`已永久清除 ${count} 个文件记录`, 'info');
    this._renderTrashList();
    this.renderFooter();
  }

  /** 恢复回收站中所有文件 */
  async restoreAllFromTrash() {
    const count = this.fileManager.trash.length;
    if (count === 0) return;
    await this.fileManager.restoreAllFromTrash();
    this.showToast(`已恢复全部 ${count} 个文件`, 'success');
    this._renderTrashList();
    this.render();
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

    // 取消前一个 toast 的定时器，防止误移除新 toast
    if (this._toastTimer) clearTimeout(this._toastTimer);

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    this._toastTimer = setTimeout(() => {
      if (toast.parentNode) toast.remove();
      this._toastTimer = null;
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
