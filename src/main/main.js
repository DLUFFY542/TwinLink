'use strict';

const { app, BrowserWindow } = require('electron');

const { SettingsStore } = require('../core/settings/settings-store');
const { resolveAdbPath } = require('../core/adb/adb-path');
const { AdbClient } = require('../core/adb/adb-client');
const { DeviceManager } = require('../core/device/device-manager');
const { MirrorController } = require('../core/mirror/controller');
const { InputInjector } = require('../core/control/injector');
const { resolveAppPaths } = require('./paths');
const { createMainWindow, hardenSession } = require('./window');
const { createIpc } = require('./ipc');

const logger = {
  info: (...args) => console.log('[twinlink]', ...args),
  warn: (...args) => console.warn('[twinlink]', ...args),
  error: (...args) => console.error('[twinlink]', ...args),
  debug: (...args) => {
    if (!app.isPackaged) console.debug('[twinlink]', ...args);
  },
};

let mainWindow = null;
let services = null;

function getMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = BrowserWindow.getAllWindows()[0] || null;
  return mainWindow;
}

async function bootstrap() {
  hardenSession();

  const paths = resolveAppPaths();
  if (!paths.serverJar) {
    logger.error('scrcpy-server jar is missing; mirroring is unavailable');
  }
  if (paths.serverJar && !paths.serverJarVerified) {
    logger.warn('scrcpy-server checksum does not match the published v4.0 checksum');
  }

  const settings = new SettingsStore({ filePath: paths.settingsFile, logger });
  settings.load();

  const resolved = resolveAdbPath({
    override: settings.get().adbPath,
    appRoot: paths.appRoot,
    resourcesPath: paths.resourcesPath,
  });

  const adb = new AdbClient({ adbPath: resolved.path });
  const adbInfo = {
    path: resolved.path,
    source: resolved.source,
    version: null,
    available: Boolean(resolved.path),
  };

  const devices = new DeviceManager({ adb, pollIntervalMs: 2000, logger });
  const mirror = new MirrorController({ adb, serverJar: paths.serverJar, logger });
  mirror.configure(settings.get());

  const injector = new InputInjector({
    getVideoSize: () => {
      const snapshot = mirror.getSnapshot();
      return { width: snapshot.width, height: snapshot.height };
    },
    send: (buffer) => mirror.sendControl(buffer),
    logger,
  });

  mainWindow = createMainWindow(paths);

  const refreshAdb = async () => {
    const current = settings.get();
    const next = resolveAdbPath({
      override: current.adbPath,
      appRoot: paths.appRoot,
      resourcesPath: paths.resourcesPath,
    });
    adb.setAdbPath(next.path);

    let version = null;
    if (next.path) {
      try {
        version = (await adb.version()).version;
      } catch (err) {
        logger.warn(`adb version check failed: ${err.message}`);
      }
    }

    adbInfo.path = next.path;
    adbInfo.source = next.source;
    adbInfo.version = version;
    adbInfo.available = Boolean(next.path);
    devices.setAdbInfo(adbInfo);
    await devices.refresh();
    return { ...adbInfo };
  };

  const runtime = {
    adb,
    devices,
    mirror,
    settings,
    injector,
    paths,
    logger,
    refreshAdb,
    getAdbInfo: () => ({ ...adbInfo }),
  };

  services = runtime;
  const { send } = createIpc({ win: mainWindow, runtime });

  devices.on('changed', (snapshot) => send('devices:changed', snapshot));

  mirror.on('state', (snapshot) => send('mirror:state', snapshot));
  mirror.on('session', (info) => send('mirror:session', info));
  mirror.on('frame', (frame) => {
    if (mainWindow && mainWindow.isMinimized()) return;
    send('mirror:frame', { data: frame.data, isConfig: frame.isConfig, isKey: frame.isKey });
  });
  mirror.on('stats', (stats) => send('mirror:stats', stats));
  mirror.on('error', (err) => send('mirror:error', { message: err.message }));
  mirror.on('failed', (info) => send('mirror:error', { message: info.error, fatal: true }));
  mirror.on('disconnected', (info) => send('toast', { kind: 'warn', message: info.reason }));
  mirror.on('audio-codec', (info) => send('mirror:audio-codec', info));
  mirror.on('audio-frame', (frame) => send('mirror:audio-frame', frame));
  mirror.on('audio-disabled', (info) => send('mirror:audio-disabled', info));

  settings.on('changed', (next, keys) => send('settings:changed', { settings: next, keys }));

  // Development-only harness (`npm run check`); never runs in a packaged app.
  if (process.env.TWINLINK_SMOKE === '1' && !app.isPackaged) {
    try {
      const nodePath = require('node:path');
      const { install } = require('../../checks/smoke-hook');
      install({
        app,
        win: mainWindow,
        reportPath:
          process.env.TWINLINK_SMOKE_REPORT ||
          nodePath.join(paths.appRoot, 'checks', '.artifacts', 'smoke-report.json'),
      });
    } catch (err) {
      logger.warn(`smoke hook unavailable: ${err.message}`);
    }
  }

  // Real-device check (`npm run check:device`); never runs in a packaged app.
  if (process.env.TWINLINK_DEVICE_CHECK === '1' && !app.isPackaged) {
    try {
      const nodePath = require('node:path');
      const { install } = require('../../checks/device-hook');
      const artifacts = nodePath.join(paths.appRoot, 'checks', '.artifacts');
      install({
        app,
        win: mainWindow,
        runtime,
        reportPath:
          process.env.TWINLINK_DEVICE_REPORT || nodePath.join(artifacts, 'device-report.json'),
        artifactsDir: artifacts,
      });
    } catch (err) {
      logger.warn(`device check hook unavailable: ${err.message}`);
    }
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.once('did-finish-load', async () => {
    const info = await refreshAdb();
    send('adb:changed', info);
    if (!paths.serverJar) {
      send('toast', {
        kind: 'error',
        message: 'The bundled mirroring server is missing. Reinstall Twinlink.',
      });
    }
  });

  devices.start();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((err) => {
    logger.error('startup failed', err);
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  let shuttingDown = false;

  app.on('before-quit', (event) => {
    if (!services || shuttingDown) return;

    // Stop the device session (removes the adb forward and kills the device-side
    // process) before the process tree is torn down. Guard with a deadline so a
    // wedged adb call can never block the user from quitting.
    shuttingDown = true;
    event.preventDefault();

    const finish = () => {
      clearTimeout(deadline);
      app.quit();
    };

    const deadline = setTimeout(finish, 3000);
    if (typeof deadline.unref === 'function') deadline.unref();

    Promise.resolve()
      .then(() => services.mirror.stop('app quit'))
      .catch(() => {})
      .then(() => {
        services.devices.stop();
        services.adb.dispose();
      })
      .finally(finish);
  });
}
