'use strict';

const { app, BrowserWindow, session, shell } = require('electron');
const path = require('node:path');

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'developer.android.com',
  'github.com',
  'www.genymobile.com',
]);

function isAllowedExternal(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'https:') return false;
    return ALLOWED_EXTERNAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Hardened window: context isolation on, Node off, sandboxed renderer, no
 * remote content, no popups, all permission requests denied.
 */
function createMainWindow(paths) {
  const win = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0e14',
    title: 'Twinlink',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  win.setMenuBarVisibility(false);

  win.webContents.on('will-navigate', (event, url) => {
    // Only the packaged index.html may ever be loaded in this window.
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }

  void win.loadFile(paths.renderer);

  return win;
}

function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
}

module.exports = { createMainWindow, hardenSession, isAllowedExternal };
