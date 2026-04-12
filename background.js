// 点击扩展图标时，打开新标签页（即插件主界面）
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'newtab.html' });
});

// Native Messaging Host 名称
const NATIVE_HOST_NAME = 'com.workspace_tags.native_host';

function relayNativeMessage(sendResponse, payload, options = {}) {
  const {
    errorPrefix = 'Native Host 未安装。错误: ',
    onError,
    onSuccess,
  } = options;

  chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, payload, (response) => {
    if (chrome.runtime.lastError) {
      if (typeof onError === 'function') {
        sendResponse(onError(chrome.runtime.lastError));
      } else {
        sendResponse({ error: `${errorPrefix}${chrome.runtime.lastError.message}` });
      }
      return;
    }

    if (typeof onSuccess === 'function') {
      sendResponse(onSuccess(response));
      return;
    }

    sendResponse(response);
  });

  return true;
}

// 处理来自前端页面的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'listDir':
      return relayNativeMessage(sendResponse, { action: 'listDir', path: request.path }, {
        onError: (lastError) => ({
          error: 'Native Host 未安装或连接失败。请先运行 native-host/install.sh (macOS/Linux) 或 install.bat (Windows) 安装；如果仍失败，再执行 native-host/check.sh 或 check.bat 自检。\n' +
            '错误详情: ' + lastError.message,
        }),
      });

    case 'listDirPaged':
      return relayNativeMessage(sendResponse, {
        action: 'listDirPaged',
        path: request.path,
        page: request.page || 0,
      });

    case 'openFile': {
      const msg = { action: 'openFile', path: request.path };
      if (request.app) msg.app = request.app;
      return relayNativeMessage(sendResponse, msg);
    }

    case 'readFile':
      return relayNativeMessage(sendResponse, { action: 'readFile', path: request.path });

    case 'revealInFinder':
      return relayNativeMessage(sendResponse, { action: 'revealInFinder', path: request.path });

    case 'chooseDirectory':
      return relayNativeMessage(sendResponse, { action: 'chooseDirectory' });

    case 'chooseAndListDir':
      return relayNativeMessage(sendResponse, { action: 'chooseAndListDir' });

    case 'chooseFiles':
      return relayNativeMessage(sendResponse, { action: 'chooseFiles' });

    case 'pingNativeHost':
      return relayNativeMessage(sendResponse, { action: 'ping' }, {
        onError: (lastError) => ({ available: false, error: lastError.message }),
        onSuccess: (response) => ({ available: true, ...response }),
      });

    case 'listApps':
      return relayNativeMessage(sendResponse, { action: 'listApps' });

    case 'batchGetFileInfo':
      return relayNativeMessage(sendResponse, { action: 'batchGetFileInfo', paths: request.paths || [] });

    case 'renameFile':
      return relayNativeMessage(sendResponse, {
        action: 'renameFile',
        oldPath: request.oldPath,
        newName: request.newName,
      });

    case 'createDirStructure':
      return relayNativeMessage(sendResponse, {
        action: 'createDirStructure',
        basePath: request.basePath || '',
        tagPaths: request.tagPaths || [],
        fileMoves: request.fileMoves || null,
        keepSource: !!request.keepSource,
      });

    case 'openTerminal':
      return relayNativeMessage(sendResponse, {
        action: 'openTerminal',
        path: request.path || '',
        app: request.app || '',
      });

    default:
      // 未知 action 兜底，防止前端 Promise 挂起
      sendResponse({ error: `未知操作: ${request.action || '(empty)'}` });
      return false;
  }
});
