// ============================
// 数据
// ============================
const DEFAULT_TAG_COLOR = '#639bff';
function safeColor(c) {
  return (typeof c === 'string' && c.length > 0) ? c : DEFAULT_TAG_COLOR;
}

let allFiles = [];
let allTags = [];
let tagColorMap = {};
let tagFileCounts = {};
// 递归统计：包含子标签下的文件
let tagTotalCounts = {};
let tagFileIndex = {};
// 标签层级
let tagChildren = {};   // tagName -> [childTagName, ...]
let tagParent = {};      // tagName -> parentTagName
let allTagNames = new Set();
let cy = null;
// 导航栈：追踪当前浏览路径
let navStack = [];
// 当前层级筛选：0 = 全部, 1 = 仅顶级, 2 = 1~2级...
let currentLevel = 1;
// 展开范围
let rangeUp = 0;      // 上溯几级
let rangeDown = 1;     // 下钻几级
let rangeShowFiles = true; // 是否显示文件
// 当前选中的标签（用于范围调整时重新渲染）
let currentFocusTag = null;
// 用户选择的布局
let preferredLayout = 'concentric';

async function readStorage(key, fallback) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      resolve(result[key] !== undefined ? result[key] : fallback);
    });
  });
}

async function loadData() {
  const [files, tags] = await Promise.all([
    readStorage('files', []),
    readStorage('tags', []),
  ]);
  allFiles = files.map((f) => ({
    ...f,
    tags: Array.isArray(f?.tags) ? f.tags : [],
  }));
  allTags = tags;

  // 颜色
  tagColorMap = {};
  allTags.forEach((t) => {
    tagColorMap[t.name] = safeColor(t.color);
  });

  // 收集所有标签名
  allTagNames = new Set(allTags.map((t) => t.name));
  allFiles.forEach((f) => f.tags.forEach((t) => allTagNames.add(t)));

  // 直接文件计数 + 文件索引
  tagFileCounts = {};
  tagFileIndex = {};
  allFiles.forEach((f) => {
    f.tags.forEach((t) => {
      tagFileCounts[t] = (tagFileCounts[t] || 0) + 1;
      if (!tagFileIndex[t]) tagFileIndex[t] = [];
      tagFileIndex[t].push(f);
    });
  });

  // 层级关系
  tagChildren = {};
  tagParent = {};
  allTagNames.forEach((name) => {
    if (name.includes('/')) {
      const parent = name.split('/').slice(0, -1).join('/');
      if (allTagNames.has(parent)) {
        tagParent[name] = parent;
        if (!tagChildren[parent]) tagChildren[parent] = [];
        tagChildren[parent].push(name);
      }
    }
  });

  // 递归总数（含子标签文件）
  tagTotalCounts = {};
  function calcTotal(tagName) {
    if (tagTotalCounts[tagName] !== undefined) return tagTotalCounts[tagName];
    let total = tagFileCounts[tagName] || 0;
    (tagChildren[tagName] || []).forEach((child) => {
      total += calcTotal(child);
    });
    tagTotalCounts[tagName] = total;
    return total;
  }
  allTagNames.forEach((name) => calcTotal(name));
}

// ============================
// 获取顶级标签
// ============================
function getRootTags() {
  return [...allTagNames].filter((name) => !name.includes('/'));
}

// 获取某标签的直接子标签
function getDirectChildren(tagName) {
  return tagChildren[tagName] || [];
}

// 获取某标签所有后代标签
function getDescendants(tagName) {
  const result = [];
  const queue = [tagName];
  while (queue.length > 0) {
    const cur = queue.shift();
    const children = tagChildren[cur] || [];
    children.forEach((c) => {
      result.push(c);
      queue.push(c);
    });
  }
  return result;
}

// 获取 N 级后代标签
function getDescendantsN(tagName, maxDepth) {
  if (maxDepth <= 0) return [];
  const result = [];
  const queue = [{ name: tagName, depth: 0 }];
  while (queue.length > 0) {
    const { name, depth } = queue.shift();
    const children = tagChildren[name] || [];
    children.forEach((c) => {
      if (depth + 1 <= maxDepth) {
        result.push(c);
        queue.push({ name: c, depth: depth + 1 });
      }
    });
  }
  return result;
}

// 获取 N 级祖先标签
function getAncestorsN(tagName, maxDepth) {
  if (maxDepth <= 0) return [];
  const result = [];
  let cur = tagName;
  for (let i = 0; i < maxDepth; i++) {
    const parent = tagParent[cur];
    if (!parent) break;
    result.push(parent);
    cur = parent;
  }
  return result;
}

// 获取某标签及其所有后代的文件（去重）
function getTagAllFiles(tagName) {
  const seen = new Set();
  const result = [];
  const tags = [tagName, ...getDescendants(tagName)];
  tags.forEach((t) => {
    (tagFileIndex[t] || []).forEach((f) => {
      const key = f.id || f.name;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(f);
      }
    });
  });
  return result;
}

// ============================
// 构建视图元素
// ============================
function buildRootView() {
  // currentLevel=0 全部标签, 1=顶级, 2=1~2级, ...
  const elements = [];
  const shownTags = [];

  if (currentLevel === 0) {
    // 全部标签 + 层级连线
    allTagNames.forEach((tagName) => {
      elements.push(makeTagNode(tagName));
      shownTags.push(tagName);
    });
  } else {
    // 只显示 depth <= currentLevel 的标签
    allTagNames.forEach((tagName) => {
      const depth = tagName.split('/').length;
      if (depth <= currentLevel) {
        elements.push(makeTagNode(tagName));
        shownTags.push(tagName);
      }
    });
  }

  // 在显示的标签之间加层级连线
  const shownSet = new Set(shownTags);
  shownTags.forEach((tagName) => {
    if (tagName.includes('/')) {
      const parent = tagName.split('/').slice(0, -1).join('/');
      if (shownSet.has(parent)) {
        elements.push({
          data: {
            id: 'hier:' + parent + '->' + tagName,
            source: 'tag:' + parent,
            target: 'tag:' + tagName,
            type: 'hierarchy',
          },
        });
      }
    }
  });

  return elements;
}

function buildTagDetailView(tagName) {
  // 根据 rangeUp/rangeDown 构建展开范围
  const elements = [];
  const shownTags = new Set();

  // 自身
  shownTags.add(tagName);

  // 上溯 rangeUp 级祖先
  const ancestors = getAncestorsN(tagName, rangeUp >= 99 ? 100 : rangeUp);
  ancestors.forEach((a) => shownTags.add(a));

  // 下钻 rangeDown 级后代
  const descendants = rangeDown >= 99
    ? getDescendants(tagName)
    : getDescendantsN(tagName, rangeDown);
  descendants.forEach((d) => shownTags.add(d));

  // 创建标签节点
  shownTags.forEach((t) => {
    elements.push(makeTagNode(t));
  });

  // 在显示的标签间加层级连线
  shownTags.forEach((t) => {
    const parent = tagParent[t];
    if (parent && shownTags.has(parent)) {
      elements.push({
        data: {
          id: 'hier:' + parent + '->' + t,
          source: 'tag:' + parent,
          target: 'tag:' + t,
          type: 'hierarchy',
        },
      });
    }
  });

  // 文件节点：显示焦点标签直接挂载的文件
  if (rangeShowFiles) {
    const directFiles = tagFileIndex[tagName] || [];
    const showFiles = directFiles.slice(0, 150);
    showFiles.forEach((f) => {
      const fileId = 'file:' + (f.id || f.name);
      const displayName = f.name.includes('/') ? f.name.split('/').pop() : f.name;
      elements.push({
        data: {
          id: fileId,
          label: displayName,
          fullName: f.name,
          path: f.path || f.name,
          type: 'file',
          fileTags: f.tags,
          size: 10,
        },
      });
      elements.push({
        data: {
          id: 'edge:' + fileId + '->' + tagName,
          source: 'tag:' + tagName,
          target: fileId,
          type: 'membership',
        },
      });
    });
    if (directFiles.length > 150) {
      showToast(`显示前 150 个文件（共 ${directFiles.length} 个）`);
    }
  }

  return elements;
}

function makeTagNode(tagName) {
  const directCount = tagFileCounts[tagName] || 0;
  const totalCount = tagTotalCounts[tagName] || 0;
  const childCount = (tagChildren[tagName] || []).length;
  const displayName = tagName.includes('/') ? tagName.split('/').pop() : tagName;

  // 标签文本：名字 + 数量
  let label = displayName;
  if (childCount > 0 && directCount > 0) {
    label += `\n${directCount} 文件 · ${childCount} 子标签`;
  } else if (totalCount > 0) {
    label += `\n${totalCount} 文件`;
  } else if (childCount > 0) {
    label += `\n${childCount} 子标签`;
  }

  return {
    data: {
      id: 'tag:' + tagName,
      label: label,
      fullName: tagName,
      type: 'tag',
      color: safeColor(tagColorMap[tagName]),
      fileCount: directCount,
      totalCount: totalCount,
      childCount: childCount,
      depth: tagName.split('/').length,
      size: Math.max(30, Math.min(70, 30 + Math.sqrt(totalCount) * 5)),
    },
  };
}

// ============================
// Cytoscape 样式
// ============================
const STYLE = [
  {
    selector: 'node[type="tag"]',
    style: {
      'background-color': 'data(color)',
      'label': 'data(label)',
      'width': 'data(size)',
      'height': 'data(size)',
      'font-size': 11,
      'color': '#fff',
      'text-valign': 'bottom',
      'text-margin-y': 6,
      'text-outline-color': '#0f1117',
      'text-outline-width': 2,
      'text-wrap': 'wrap',
      'text-max-width': '120px',
      'text-halign': 'center',
      'opacity': 1,
    },
  },
  {
    selector: 'node[type="file"]',
    style: {
      'background-color': '#6b7280',
      'label': 'data(label)',
      'width': 'data(size)',
      'height': 'data(size)',
      'font-size': 8,
      'color': 'rgba(255,255,255,0.6)',
      'text-valign': 'bottom',
      'text-margin-y': 3,
      'text-outline-color': '#0f1117',
      'text-outline-width': 1,
      'text-wrap': 'ellipsis',
      'text-max-width': '80px',
      'opacity': 0.8,
    },
  },
  {
    selector: 'edge[type="hierarchy"]',
    style: {
      'line-color': 'rgba(255,255,255,0.2)',
      'line-style': 'dashed',
      'width': 1.5,
      'curve-style': 'bezier',
      'opacity': 0.6,
      'target-arrow-shape': 'triangle',
      'target-arrow-color': 'rgba(255,255,255,0.2)',
      'arrow-scale': 0.6,
    },
  },
  {
    selector: 'edge[type="membership"]',
    style: {
      'line-color': 'rgba(99, 155, 255, 0.2)',
      'width': 0.8,
      'curve-style': 'haystack',
      'opacity': 0.4,
    },
  },
];

// ============================
// 创建/刷新图谱
// ============================
function renderView(elements) {
  if (cy) cy.destroy();

  const hasFiles = elements.some((e) => e.data && e.data.type === 'file');
  const nodeCount = elements.filter((e) => !e.data.source).length;

  // 布局选择
  let layoutOpts;
  const layoutName = preferredLayout;

  if (nodeCount <= 1) {
    layoutOpts = { name: 'grid', animate: false, padding: 40 };
  } else if (layoutName === 'cose') {
    layoutOpts = {
      name: 'cose',
      animate: false,
      nodeRepulsion: () => 5000,
      idealEdgeLength: () => 50,
      gravity: 0.5,
      numIter: Math.min(80, Math.max(30, 300 - nodeCount)),
      padding: 30,
      randomize: true,
    };
  } else if (layoutName === 'concentric') {
    layoutOpts = {
      name: 'concentric',
      concentric: (n) => {
        if (n.data('type') !== 'tag') return 0;
        return 10 - (n.data('depth') || 1);
      },
      levelWidth: () => 1,
      animate: false,
      padding: 30,
      minNodeSpacing: 30,
    };
  } else if (layoutName === 'grid') {
    layoutOpts = { name: 'grid', animate: false, padding: 30 };
  } else {
    layoutOpts = { name: 'circle', animate: false, padding: 40 };
  }

  cy = cytoscape({
    container: document.getElementById('cy'),
    elements: elements,
    style: STYLE,
    layout: layoutOpts,
    minZoom: 0.02,
    maxZoom: 8,
    userPanningEnabled: true,
    userZoomingEnabled: true,
    boxSelectionEnabled: false,
    textureOnViewport: nodeCount > 300,
    hideEdgesOnViewport: nodeCount > 500,
    pixelRatio: nodeCount > 300 ? 1 : undefined,
  });

  bindGraphEvents();
  updateBreadcrumb();

  // 渲染后 fit 到所有节点，确保都可见
  cy.ready(() => {
    cy.fit(cy.elements(), 30);
  });
}

// ============================
// 事件
// ============================
function bindGraphEvents() {
  // 左键点击标签 → 进入该标签详情视图
  cy.on('tap', 'node[type="tag"]', function (evt) {
    hideCtxMenu();
    const node = evt.target;
    const tagName = node.data('fullName');

    const children = getDirectChildren(tagName);
    const files = tagFileIndex[tagName] || [];

    if (children.length === 0 && files.length === 0) {
      showTagInfo(node);
      return;
    }

    navStack.push(tagName);
    currentFocusTag = tagName;
    const els = buildTagDetailView(tagName);
    renderView(els);
    showTagInfo(cy.getElementById('tag:' + tagName));
  });

  // 右键点击标签 → 弹出范围菜单
  cy.on('cxttap', 'node[type="tag"]', function (evt) {
    evt.originalEvent.preventDefault();
    const node = evt.target;
    const tagName = node.data('fullName');
    const pos = evt.renderedPosition || evt.position;
    const container = document.getElementById('cy').getBoundingClientRect();
    showCtxMenu(tagName, container.left + pos.x, container.top + pos.y);
  });

  // 点击文件 → 显示信息
  cy.on('tap', 'node[type="file"]', function (evt) {
    hideCtxMenu();
    showFileInfo(evt.target);
  });

  // 点击空白 → 隐藏
  cy.on('tap', function (evt) {
    if (evt.target === cy) {
      hideCtxMenu();
      document.getElementById('info-panel').classList.remove('visible');
    }
  });

  // 禁止画布默认右键菜单
  document.getElementById('cy').addEventListener('contextmenu', (e) => e.preventDefault());
}

// ============================
// 导航
// ============================
function goBack() {
  if (navStack.length === 0) return;
  navStack.pop();
  if (navStack.length === 0) {
    currentFocusTag = null;
    hideCtxMenu();
    renderView(buildRootView());
  } else {
    currentFocusTag = navStack[navStack.length - 1];
    const els = buildTagDetailView(currentFocusTag);
    renderView(els);
  }
  document.getElementById('info-panel').classList.remove('visible');
}

function goHome() {
  navStack = [];
  currentFocusTag = null;
  hideRangePanel();
  renderView(buildRootView());
  document.getElementById('info-panel').classList.remove('visible');
}

function updateBreadcrumb() {
  const stats = document.getElementById('graph-stats');
  if (navStack.length === 0) {
    const rootCount = getRootTags().length;
    stats.textContent = `${allTagNames.size} 个标签 · ${allFiles.length} 个文件 · 顶级 ${rootCount} 个`;
  } else {
    const current = navStack[navStack.length - 1];
    const path = navStack.join(' › ');
    stats.textContent = path;
  }
}

// ============================
// 信息面板
// ============================
function showTagInfo(node) {
  if (!node || node.empty()) return;
  const panel = document.getElementById('info-panel');
  const tagName = node.data('fullName');
  const directCount = node.data('fileCount');
  const totalCount = node.data('totalCount');
  const childCount = node.data('childCount');
  const children = getDirectChildren(tagName);

  let html = `<div class="info-type">标签</div>
    <div class="info-name">${esc(tagName)}</div>
    <div class="info-count">直接文件: ${directCount} 个</div>`;

  if (totalCount !== directCount) {
    html += `<div class="info-count">含子标签共: ${totalCount} 个文件</div>`;
  }

  if (children.length > 0) {
    html += `<div class="info-children">子标签 (${children.length}): ${children.map((c) => {
      const name = c.includes('/') ? c.split('/').pop() : c;
      const cnt = tagTotalCounts[c] || 0;
      return `<span>${esc(name)}${cnt > 0 ? ' (' + cnt + ')' : ''}</span>`;
    }).join('')}</div>`;
  }

  // 列出前 10 个直接文件
  const files = tagFileIndex[tagName] || [];
  if (files.length > 0) {
    const shown = files.slice(0, 10);
    html += `<div style="margin-top:10px;font-size:12px;color:rgba(255,255,255,0.4);">直接文件${files.length > 10 ? `（前 10 / 共 ${files.length}）` : ` (${files.length})`}:</div>`;
    html += `<div class="info-tags" style="margin-top:4px;">${shown.map((f) => {
      const name = f.name.includes('/') ? f.name.split('/').pop() : f.name;
      return `<span class="info-tag">${esc(name)}</span>`;
    }).join('')}</div>`;
  }

  panel.innerHTML = html;
  panel.classList.add('visible');
}

function showFileInfo(node) {
  const panel = document.getElementById('info-panel');
  const name = node.data('fullName');
  const path = node.data('path') || '';
  const fileTags = node.data('fileTags') || [];
  let html = `<div class="info-type">文件</div>
    <div class="info-name">${esc(name.includes('/') ? name.split('/').pop() : name)}</div>`;
  if (path) html += `<div class="info-path">${esc(path)}</div>`;
  if (fileTags.length > 0) {
    html += `<div style="font-size:12px;color:rgba(255,255,255,0.4);margin-bottom:4px;">标签 (${fileTags.length}):</div>`;
    html += `<div class="info-tags">${fileTags.map((t) => `<span class="info-tag">${esc(t)}</span>`).join('')}</div>`;
  }
  panel.innerHTML = html;
  panel.classList.add('visible');
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function showToast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', top: '60px', left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(22,25,35,0.95)', color: '#e0e0e0', padding: '8px 16px',
    borderRadius: '6px', fontSize: '13px', zIndex: '300',
    border: '1px solid rgba(255,255,255,0.1)',
  });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ============================
// 右键菜单
// ============================
function showCtxMenu(tagName, x, y) {
  const menu = document.getElementById('graph-ctx-menu');
  const displayName = tagName.includes('/') ? tagName.split('/').pop() : tagName;
  const count = tagTotalCounts[tagName] || 0;
  document.getElementById('ctx-menu-title').textContent =
    displayName + (count > 0 ? ` (${count} 文件)` : '');

  currentFocusTag = tagName;

  // 同步按钮状态
  document.querySelectorAll('#range-up .range-btn').forEach((b) => {
    b.classList.toggle('active', parseInt(b.dataset.val, 10) === rangeUp);
  });
  document.querySelectorAll('#range-down .range-btn').forEach((b) => {
    b.classList.toggle('active', parseInt(b.dataset.val, 10) === rangeDown);
  });
  document.getElementById('range-show-files').checked = rangeShowFiles;
  document.querySelectorAll('#ctx-layout .range-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.layout === preferredLayout);
  });

  // 定位：确保不超出视口
  menu.style.left = '0';
  menu.style.top = '0';
  menu.classList.add('visible');
  const rect = menu.getBoundingClientRect();
  const mx = Math.min(x, window.innerWidth - rect.width - 8);
  const my = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = Math.max(0, mx) + 'px';
  menu.style.top = Math.max(0, my) + 'px';
}

function hideCtxMenu() {
  document.getElementById('graph-ctx-menu').classList.remove('visible');
}

function refreshFocusView() {
  if (!currentFocusTag) return;
  // 更新导航栈末尾
  if (navStack.length > 0) {
    navStack[navStack.length - 1] = currentFocusTag;
  } else {
    navStack.push(currentFocusTag);
  }
  const els = buildTagDetailView(currentFocusTag);
  renderView(els);
  const node = cy.getElementById('tag:' + currentFocusTag);
  if (node && !node.empty()) showTagInfo(node);
}

function setupRangePanel() {
  const menu = document.getElementById('graph-ctx-menu');

  // 阻止菜单内点击冒泡导致关闭
  menu.addEventListener('click', (e) => e.stopPropagation());

  // 上级按钮
  document.getElementById('range-up').addEventListener('click', (e) => {
    const btn = e.target.closest('.range-btn');
    if (!btn) return;
    rangeUp = parseInt(btn.dataset.val, 10);
    document.querySelectorAll('#range-up .range-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    refreshFocusView();
  });

  // 下级按钮
  document.getElementById('range-down').addEventListener('click', (e) => {
    const btn = e.target.closest('.range-btn');
    if (!btn) return;
    rangeDown = parseInt(btn.dataset.val, 10);
    document.querySelectorAll('#range-down .range-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    refreshFocusView();
  });

  // 显示文件
  document.getElementById('range-show-files').addEventListener('change', (e) => {
    rangeShowFiles = e.target.checked;
    refreshFocusView();
  });

  // "展开此标签" 按钮
  document.getElementById('ctx-expand').addEventListener('click', () => {
    hideCtxMenu();
    if (!currentFocusTag) return;
    navStack.push(currentFocusTag);
    const els = buildTagDetailView(currentFocusTag);
    renderView(els);
    const node = cy.getElementById('tag:' + currentFocusTag);
    if (node && !node.empty()) showTagInfo(node);
  });

  // 布局切换
  document.getElementById('ctx-layout').addEventListener('click', (e) => {
    const btn = e.target.closest('.range-btn');
    if (!btn) return;
    preferredLayout = btn.dataset.layout;
    document.querySelectorAll('#ctx-layout .range-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    // 重新布局当前视图
    if (currentFocusTag) {
      refreshFocusView();
    } else {
      renderView(buildRootView());
    }
  });

  // 点击页面任意位置关闭菜单
  document.addEventListener('click', () => hideCtxMenu());
  document.addEventListener('contextmenu', (e) => {
    // 只有图谱区域的右键由 Cytoscape 处理，其他地方关闭菜单
    if (!e.target.closest('#cy')) hideCtxMenu();
  });
}

// ============================
// 搜索
// ============================
function setupSearch() {
  const input = document.getElementById('search-input');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = input.value.trim().toLowerCase();
      if (!q) {
        // 恢复当前视图
        if (navStack.length === 0) {
          renderView(buildRootView());
        } else {
          renderView(buildTagDetailView(navStack[navStack.length - 1]));
        }
        document.getElementById('info-panel').classList.remove('visible');
        return;
      }

      // 搜索匹配的标签
      const matchedTags = [...allTagNames].filter((name) =>
        name.toLowerCase().includes(q)
      );
      // 搜索匹配的文件
      const matchedFiles = allFiles.filter((f) => {
        const fname = (f.name || '').toLowerCase();
        const fpath = (f.path || '').toLowerCase();
        return fname.includes(q) || fpath.includes(q);
      }).slice(0, 50);

      // 构建搜索结果视图
      const elements = [];
      matchedTags.forEach((tagName) => {
        elements.push(makeTagNode(tagName));
      });
      matchedFiles.forEach((f) => {
        const fileId = 'file:' + (f.id || f.name);
        const displayName = f.name.includes('/') ? f.name.split('/').pop() : f.name;
        elements.push({
          data: {
            id: fileId,
            label: displayName,
            fullName: f.name,
            path: f.path || f.name,
            type: 'file',
            fileTags: f.tags,
            size: 10,
          },
        });
      });

      if (elements.length === 0) {
        showToast('未找到匹配结果');
        return;
      }

      // 不推入导航栈，搜索是临时视图
      if (cy) cy.destroy();
      cy = cytoscape({
        container: document.getElementById('cy'),
        elements: elements,
        style: STYLE,
        layout: { name: 'circle', animate: false, padding: 40 },
        minZoom: 0.02,
        maxZoom: 8,
        userPanningEnabled: true,
      });
      bindGraphEvents();
      cy.ready(() => cy.fit(cy.elements(), 30));

      document.getElementById('graph-stats').textContent =
        `搜索 "${esc(q)}"：${matchedTags.length} 个标签 · ${matchedFiles.length} 个文件`;
    }, 250);
  });
}

// ============================
// 返回按钮
// ============================
function setupBackButton() {
  document.getElementById('btn-back').addEventListener('click', () => {
    if (navStack.length > 0) {
      goBack();
    } else if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = 'newtab.html';
    }
  });
}

// ============================
// 启动
// ============================
async function main() {
  setupBackButton();
  setupSearch();
  setupRangePanel();

  // "返回首页"
  const modeBtn = document.getElementById('btn-show-files');
  modeBtn.textContent = '返回首页';
  modeBtn.addEventListener('click', () => goHome());

  // 适应屏幕
  document.getElementById('btn-fit').addEventListener('click', () => {
    if (cy) cy.animate({ fit: { eles: cy.elements(), padding: 30 }, duration: 300 });
  });

  // 层级筛选按钮
  document.getElementById('level-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('.level-btn');
    if (!btn) return;
    const level = parseInt(btn.dataset.level, 10);
    currentLevel = level;
    // 更新按钮样式
    document.querySelectorAll('.level-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    // 重回首页视图并用层级筛选
    navStack = [];
    renderView(buildRootView());
    document.getElementById('info-panel').classList.remove('visible');
  });

  await loadData();

  if (allTagNames.size === 0) {
    document.getElementById('graph-loading').innerHTML =
      '<p style="color:rgba(255,255,255,0.5);">暂无数据，请先在标签管理器中添加标签和文件</p>';
    return;
  }

  renderView(buildRootView());
  document.getElementById('graph-loading').classList.add('hidden');
}

main();
