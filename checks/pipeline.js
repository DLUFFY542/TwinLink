'use strict';

/**
 * End-to-end video pipeline check.
 *
 * Proves that a real H.264 stream is framed exactly like scrcpy v4.0, parsed by
 * src/core/protocol/video-parser.js, delivered over IPC, decoded by
 * src/renderer/js/decoder.js (WebCodecs) and rendered into a canvas.
 *
 * Run with: npm run check:pipeline
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app, BrowserWindow, ipcMain } = require('electron');

const { MirrorSession } = require('../src/core/mirror/session');
const { InputInjector } = require('../src/core/control/injector');
const { toAccessUnits } = require('./helpers/annexb');

const STREAM_FILE = path.join(__dirname, '.artifacts', 'test.h264');
const REPORT_FILE = path.join(__dirname, '.artifacts', 'pipeline-report.json');
const DEVICE_NAME = 'Pipeline Check Device';
const TIMEOUT_MS = 45000;
const MIN_DECODED_FRAMES = 25;

const quietLogger = {
  info: (...args) => console.log('[pipeline]', ...args),
  warn: (...args) => console.warn('[pipeline]', ...args),
  error: (...args) => console.error('[pipeline]', ...args),
  debug: () => {},
};

function writeReport(report) {
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function sessionPacket(width, height) {
  const buffer = Buffer.alloc(12);
  buffer.writeUInt32BE(0x80000000, 0);
  buffer.writeUInt32BE(width, 4);
  buffer.writeUInt32BE(height, 8);
  return buffer;
}

function framePacket(payload, { key = false, config = false } = {}) {
  const header = Buffer.alloc(12);
  let flags = 0n;
  if (config) flags |= 1n << 62n;
  if (key) flags |= 1n << 61n;
  header.writeBigUInt64BE(flags, 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

function createStreamServer({ width, height, config, frames }) {
  const state = { controlBytes: Buffer.alloc(0), connections: 0, sockets: [] };

  const server = net.createServer((socket) => {
    const index = state.connections;
    state.connections += 1;
    state.sockets.push(socket);
    socket.on('error', () => {});

    if (index === 0) {
      socket.write(Buffer.from([0]));
      const name = Buffer.alloc(64);
      Buffer.from(DEVICE_NAME, 'utf8').copy(name, 0, 0, 63);
      socket.write(name);

      const codec = Buffer.alloc(4);
      codec.writeUInt32BE(0x68323634, 0); // 'h264'
      socket.write(codec);
      socket.write(sessionPacket(width, height));

      if (config) {
        socket.write(framePacket(config, { config: true }));
      }

      let sent = 0;
      const timer = setInterval(() => {
        if (sent >= frames.length) {
          clearInterval(timer);
          return;
        }
        const frame = frames[sent];
        socket.write(framePacket(frame.data, { key: frame.key }));
        sent += 1;
      }, 8);
      socket.on('close', () => clearInterval(timer));
      return;
    }

    socket.on('data', (chunk) => {
      state.controlBytes = Buffer.concat([state.controlBytes, chunk]);
    });
  });

  return {
    state,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port, host: '127.0.0.1' }, resolve);
      });
    },
    close() {
      for (const socket of state.sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  const report = {
    startedAt: new Date().toISOString(),
    stream: null,
    transport: {},
    renderer: {},
    control: {},
    ok: false,
    error: null,
  };

  let server = null;
  let session = null;
  let finished = false;

  const finish = async (exitCode, error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);

    report.finishedAt = new Date().toISOString();
    report.error = error ? String(error.message || error) : null;
    report.ok = exitCode === 0;
    if (error) report.stack = String(error.stack || '');

    try {
      if (session) await session.stop('pipeline check complete').catch(() => {});
      if (server) await server.close();
    } catch {
      /* best effort */
    }

    try {
      writeReport(report);
    } catch (writeError) {
      console.error('[pipeline] could not write report:', writeError.message);
    }

    console.log('[pipeline] --------------------------------------------------');
    console.log('[pipeline] RESULT:', JSON.stringify({
      ok: report.ok,
      decodedFrames: report.renderer.decodedFrames ?? 0,
      canvas: report.renderer.canvas || null,
      distinctColors: report.renderer.distinctColors ?? 0,
      controlHex: report.control.receivedHex || '',
      error: report.error,
    }));
    console.log(`[pipeline] report: ${REPORT_FILE}`);
    console.log('[pipeline] --------------------------------------------------');

    // Quit gracefully so Electron's child processes do not outlive the check.
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      /* already gone */
    }
    app.quit();
    setTimeout(() => app.exit(exitCode), 2000);
  };

  const timeout = setTimeout(() => {
    void finish(1, new Error(`pipeline timed out after ${TIMEOUT_MS} ms`));
  }, TIMEOUT_MS);

  let src;
  try {
    src = fs.readFileSync(STREAM_FILE);
  } catch (error) {
    throw new Error(`test stream missing (${STREAM_FILE}); run the ffmpeg command from checks/README.md`);
  }

  const parsed = toAccessUnits(src);
  if (parsed.frames.length === 0 || !parsed.config) {
    throw new Error('test stream could not be split into access units + config');
  }

  report.stream = {
    file: path.relative(path.join(__dirname, '..'), STREAM_FILE),
    bytes: src.length,
    accessUnits: parsed.frames.length,
    keyFrames: parsed.frames.filter((frame) => frame.key).length,
    configBytes: parsed.config.length,
  };

  // 720x1280 matches the ffmpeg test source; the session packet also propagates
  // the size to the renderer, which is what the UI uses for input mapping.
  const width = 720;
  const height = 1280;

  const adb = {
    push: async () => {},
    forward: async (_serial, port) => {
      server = createStreamServer({ width, height, config: parsed.config, frames: parsed.frames });
      await server.listen(port);
    },
    removeForward: async () => {},
    spawnLongRunning: () => {
      const child = new EventEmitter();
      child.kill = () => {};
      return child;
    },
  };

  const win = new BrowserWindow({
    width: 760,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'pipeline-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setBackgroundThrottling(false);

  win.webContents.on('console-message', (_event, ...args) => {
    const details = args[0];
    if (details && typeof details === 'object') {
      if (details.level === 'error' || details.level === 'warning') {
        console.log(`[renderer:${details.level}] ${details.message}`);
      }
    } else if (Number(args[0]) >= 2) {
      console.log(`[renderer] ${args[1]}`);
    }
  });

  ipcMain.on('pipeline:ready', async () => {
    try {
      session = new MirrorSession({
        adb,
        serial: 'PIPELINE1234',
        options: {
          maxSize: 720,
          maxFps: 30,
          bitrate: 4000000,
          audio: false,
          audioBitrate: 128000,
          showTouches: false,
          stayAwake: false,
          powerOn: false,
        },
        serverJar: path.join(__dirname, 'fake-server.jar'),
        logger: quietLogger,
      });

      session.on('frame', (frame) => {
        if (win.isDestroyed()) return;
        win.webContents.send('pipeline:frame', {
          data: new Uint8Array(frame.data),
          isConfig: frame.isConfig,
          isKey: frame.isKey,
        });
      });

      session.on('session', (info) => {
        if (win.isDestroyed()) return;
        win.webContents.send('pipeline:session', info);
      });

      session.on('error', (error) => console.warn('[pipeline] session error:', error.message));

      await session.start();
      report.transport.connected = true;
      report.transport.width = session.width;
      report.transport.height = session.height;
      report.transport.codec = session.codec;

      // Exercise the real input path: injector -> control socket.
      const injector = new InputInjector({
        getVideoSize: () => ({ width: session.width, height: session.height }),
        send: (buffer) => session.sendControl(buffer),
        logger: quietLogger,
      });
      const injected = injector.handle({ type: 'action', name: 'rotate' });
      report.control.injected = injected.ok;
      await new Promise((resolve) => setTimeout(resolve, 200));
      report.control.receivedHex = server ? server.state.controlBytes.toString('hex') : '';
      report.control.expectedHex = '0b';
      report.control.ok = report.control.receivedHex === '0b';
    } catch (error) {
      void finish(1, error);
    }
  });

  ipcMain.on('pipeline:result', (_event, result) => {
    report.renderer = result || {};
    const rendererOk =
      report.renderer.decodedFrames >= MIN_DECODED_FRAMES &&
      report.renderer.canvas?.width === width &&
      report.renderer.canvas?.height === height &&
      report.renderer.distinctColors >= 8;

    if (!rendererOk) {
      void finish(1, new Error('renderer did not produce enough decoded, non-uniform frames'));
      return;
    }
    if (report.control.ok === false) {
      void finish(1, new Error('control message did not reach the device socket'));
      return;
    }
    void finish(0, null);
  });

  ipcMain.on('pipeline:error', (_event, message) => {
    void finish(1, new Error(`renderer error: ${message}`));
  });

  await win.loadFile(path.join(__dirname, 'pipeline-page.html'));
}

app.whenReady().then(main).catch((error) => {
  console.error('[pipeline] fatal:', error);
  try {
    writeReport({
      ok: false,
      error: String(error.message || error),
      stack: String(error.stack || ''),
      finishedAt: new Date().toISOString(),
    });
  } catch {
    /* ignore */
  }
  app.exit(1);
});
