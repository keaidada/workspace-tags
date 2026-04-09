// 点击扩展图标时，打开新标签页（即插件主界面）
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'newtab.html' });
});

// Native Messaging Host 名称
const NATIVE_HOST_NAME = 'com.workspace_tags.native_host';

// 处理来自前端页面的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'listDir') {
    // 通过 Native Messaging 读取本地目录
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'listDir', path: request.path },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            error: 'Native Host 未安装或连接失败。请运行 native-host/install.sh 安装。\n' +
                   '错误详情: ' + chrome.runtime.lastError.message
          });
        } else {
          sendResponse(response);
        }
      }
    );
    return true; // 保持 sendResponse 通道打开（异步回调）
  }

  if (request.action === 'listDirPaged') {
    // 分页读取目录文件列表（大目录用）
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'listDirPaged', path: request.path, page: request.page || 0 },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            error: 'Native Host 未安装。错误: ' + chrome.runtime.lastError.message
          });
        } else {
          sendResponse(response);
        }
      }
    );
    return true;
  }

  if (request.action === 'openFile') {
    // 通过 Native Messaging 打开本地文件
    const msg = { action: 'openFile', path: request.path };
    if (request.app) msg.app = request.app;
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, msg, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: 'Native Host 未安装。错误: ' + chrome.runtime.lastError.message });
      } else {
        sendResponse(response);
      }
    });
    return true;
  }

  if (request.action === 'readFile') {
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'readFile', path: request.path },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: 'Native Host 未安装。错误: ' + chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      }
    );
    return true;
  }

  if (request.action === 'revealInFinder') {
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'revealInFinder', path: request.path },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: 'Native Host 未安装。错误: ' + chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      }
    );
    return true;
  }

  if (request.action === 'chooseDirectory') {
    // 弹出系统原生目录选择对话框
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'chooseDirectory' },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: 'Native Host 未安装。错误: ' + chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      }
    );
    return true;
  }

  if (request.action === 'chooseAndListDir') {
    // 弹出系统原生目录选择对话框 + 列出文件
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'chooseAndListDir' },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: 'Native Host 未安装。错误: ' + chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      }
    );
    return true;
  }

  if (request.action === 'pingNativeHost') {
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'ping' },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ available: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ available: true, ...response });
        }
      }
    );
    return true;
  }

  if (request.action === 'listApps') {
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'listApps' },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: 'Native Host 未安装。错误: ' + chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      }
    );
    return true;
  }

  if (request.action === 'batchGetFileInfo') {
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'batchGetFileInfo', paths: request.paths || [] },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: 'Native Host 未安装。错误: ' + chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      }
    );
    return true;
  }

  if (request.action === 'renameFile') {
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'renameFile', oldPath: request.oldPath, newName: request.newName },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: 'Native Host 未安装。错误: ' + chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      }
    );
    return true;
  }

  if (request.action === 'openTerminal') {
    chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: 'openTerminal', path: request.path || '', app: request.app || 'Terminal' },
      (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: 'Native Host 未安装。错误: ' + chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      }
    );
    return true;
  }
});
