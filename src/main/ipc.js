'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { app, dialog, ipcMain, shell } = require('electron');

const { assertSerial } = require('../core/adb/adb-client');
const { parseMdnsServices } = require('../core/adb/mdns-parser');
const { isAllowedExternal } = require('./window');

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const MP4_FTYP = Buffer.from('ftyp', 'ascii');

function isMp4(buffer) {
  // ISO base media files place the major brand at bytes 4-8 ("....ftyp").
  return buffer.length >= 12 && buffer.subarray(4, 8).equals(MP4_FTYP);
}

function toBuffer(value) {
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  return null;
}

function assertPlainObject(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertHostPort(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._\-]{0,120}:\d{1,5}$/.test(value)) {
    throw new Error(`${label} must look like host:port`);
  }
}

function timestampName(extension) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `twinlink-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes(),
  )}${pad(now.getSeconds())}.${extension}`;
}

function createIpc({ win, runtime }) {
  const { adb, devices, mirror, settings, injector, paths, logger, refreshAdb } = runtime;

  const send = (channel, payload) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  const saveBinary = async (payload, { extension, filters, magic, check, maxBytes, subdir }) => {
    assertPlainObject(payload, 'payload');
    const buffer = toBuffer(payload.data);
    if (!buffer || buffer.length === 0) {
      throw new Error('no data to save');
    }
    if (buffer.length > maxBytes) {
      throw new Error('file is too large to save');
    }
    if (magic && !buffer.subarray(0, magic.length).equals(magic)) {
      throw new Error('unexpected file format');
    }
    if (typeof check === 'function' && !check(buffer)) {
      throw new Error('unexpected file format');
    }

    const targetDir = path.join(app.getPath('pictures'), subdir);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save file',
      defaultPath: path.join(targetDir, timestampName(extension)),
      filters,
    });
    if (canceled || !filePath) {
      return { ok: false, canceled: true };
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer);
    return { ok: true, path: filePath, bytes: buffer.length };
  };

  // ---- application / environment -----------------------------------------

  ipcMain.handle('app:info', () => ({
    app: { name: 'Twinlink', version: app.getVersion(), packaged: app.isPackaged },
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    adb: runtime.getAdbInfo(),
    server: {
      jar: paths.serverJar ? path.basename(paths.serverJar) : null,
      verified: paths.serverJarVerified,
      sha256: paths.serverJarSha256,
    },
    settingsFile: paths.settingsFile,
    features: {
      audio: 'experimental',
      wireless: 'implemented-untested',
      recording: 'webm',
    },
  }));

  ipcMain.handle('app:open-external', (_event, url) => {
    if (!isAllowedExternal(url)) {
      throw new Error('URL is not on the allowlist');
    }
    void shell.openExternal(url);
    return { ok: true };
  });

  // ---- window --------------------------------------------------------------

  ipcMain.handle('window:set-fullscreen', (_event, value) => {
    if (typeof value !== 'boolean') {
      throw new Error('fullscreen must be a boolean');
    }
    win.setFullScreen(value);
    return { fullscreen: win.isFullScreen() };
  });

  win.on('enter-full-screen', () => send('window:fullscreen-changed', { fullscreen: true }));
  win.on('leave-full-screen', () => send('window:fullscreen-changed', { fullscreen: false }));

  // ---- devices -------------------------------------------------------------

  ipcMain.handle('devices:snapshot', () => devices.getSnapshot());
  ipcMain.handle('devices:refresh', async () => {
    await devices.refresh();
    return devices.getSnapshot();
  });
  ipcMain.handle('devices:watch', () => {
    devices.start();
    return devices.getSnapshot();
  });

  // ---- settings ------------------------------------------------------------

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:update', async (_event, partial) => {
    assertPlainObject(partial, 'settings');
    const result = settings.update(partial);
    mirror.configure(result.settings);

    if (Object.prototype.hasOwnProperty.call(partial, 'adbPath')) {
      const adbInfo = await refreshAdb();
      send('adb:changed', adbInfo);
    }

    return result;
  });
  ipcMain.handle('settings:reset', () => {
    const next = settings.reset();
    mirror.configure(next);
    return next;
  });

  ipcMain.handle('adb:redetect', async () => {
    const adbInfo = await refreshAdb();
    return adbInfo;
  });

  ipcMain.handle('adb:pick', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select adb.exe',
      properties: ['openFile'],
      filters: [{ name: 'adb', extensions: ['exe'] }],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    const file = result.filePaths[0];
    if (path.basename(file).toLowerCase() !== 'adb.exe') {
      throw new Error('selected file is not adb.exe');
    }
    const updated = settings.update({ adbPath: file });
    const adbInfo = await refreshAdb();
    return { canceled: false, adb: adbInfo, settings: updated.settings };
  });

  // ---- mirroring -----------------------------------------------------------

  ipcMain.handle('mirror:start', async (_event, serial) => {
    assertSerial(serial);
    const snapshot = devices.getSnapshot();
    const device = snapshot.devices.find((entry) => entry.serial === serial);
    if (!device) {
      throw new Error('device is no longer connected');
    }
    if (device.state !== 'device') {
      throw new Error(
        device.state === 'unauthorized'
          ? 'USB debugging is not authorized. Accept the prompt on the phone.'
          : `device is not ready (${device.state})`,
      );
    }
    return mirror.start(serial, settings.get());
  });

  ipcMain.handle('mirror:stop', async () => {
    await mirror.stop('user');
    return mirror.getSnapshot();
  });

  ipcMain.handle('mirror:snapshot', () => mirror.getSnapshot());

  ipcMain.on('mirror:input', (_event, payload) => {
    try {
      const result = injector.handle(payload);
      if (!result.ok && result.reason && result.reason !== 'video stream not ready') {
        logger.debug?.(`[input] rejected: ${result.reason}`);
      }
    } catch (err) {
      logger.warn?.(`[input] ${err.message}`);
    }
  });

  // ---- wireless ------------------------------------------------------------

  ipcMain.handle('wireless:discover', async () => {
    const output = await adb.mdnsServices();
    return { services: parseMdnsServices(output), raw: output };
  });

  ipcMain.handle('wireless:pair', async (_event, payload) => {
    assertPlainObject(payload, 'pairing request');
    assertHostPort(payload.address, 'address');
    if (typeof payload.code !== 'string' || !/^\d{4,8}$/.test(payload.code)) {
      throw new Error('pairing code must be 4-8 digits');
    }
    const output = await adb.pair(payload.address, payload.code);
    return { ok: /Successfully paired/i.test(output), output };
  });

  ipcMain.handle('wireless:connect', async (_event, payload) => {
    assertPlainObject(payload, 'connect request');
    assertHostPort(payload.address, 'address');
    const output = await adb.connect(payload.address);
    await devices.refresh();
    return { ok: /connected to/i.test(output), output, devices: devices.getSnapshot() };
  });

  ipcMain.handle('wireless:disconnect', async (_event, payload) => {
    assertPlainObject(payload, 'disconnect request');
    assertHostPort(payload.address, 'address');
    const output = await adb.disconnect(payload.address);
    await devices.refresh();
    return { ok: true, output };
  });

  // ---- files ---------------------------------------------------------------

  ipcMain.handle('files:save-screenshot', (_event, payload) =>
    saveBinary(payload, {
      extension: 'png',
      filters: [{ name: 'PNG image', extensions: ['png'] }],
      magic: PNG_MAGIC,
      maxBytes: MAX_IMAGE_BYTES,
      subdir: 'Twinlink',
    }),
  );

  ipcMain.handle('files:save-recording', (_event, payload) => {
    assertPlainObject(payload, 'payload');
    if (payload.format !== 'webm' && payload.format !== 'mp4') {
      throw new Error('recording format must be webm or mp4');
    }
    const mp4 = payload.format === 'mp4';
    return saveBinary(payload, {
      extension: mp4 ? 'mp4' : 'webm',
      filters: [{ name: mp4 ? 'MP4 video' : 'WebM video', extensions: [mp4 ? 'mp4' : 'webm'] }],
      magic: mp4 ? null : WEBM_MAGIC,
      check: mp4 ? isMp4 : null,
      maxBytes: MAX_VIDEO_BYTES,
      subdir: 'Twinlink',
    });
  });

  return { send };
}

module.exports = { createIpc };
