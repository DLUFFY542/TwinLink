'use strict';

const path = require('node:path');
const { app } = require('electron');
const { resolveServerJar, verifyServerJar } = require('../core/mirror/scrcpy-server');

function resolveAppPaths() {
  const appRoot = app.getAppPath();
  const resourcesPath = app.isPackaged ? process.resourcesPath : '';
  const serverJar = resolveServerJar({ appRoot, resourcesPath });

  const info = serverJar ? verifyServerJar(serverJar) : { ok: false, sha256: null, size: 0 };
  const userData = app.getPath('userData');

  return {
    appRoot,
    resourcesPath,
    serverJar,
    serverJarVerified: info.ok,
    serverJarSha256: info.sha256,
    userData,
    settingsFile: path.join(userData, 'settings.json'),
    preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    renderer: path.join(__dirname, '..', 'renderer', 'index.html'),
  };
}

module.exports = { resolveAppPaths };
