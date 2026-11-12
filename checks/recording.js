'use strict';

/**
 * Recording format check.
 *
 * Records a real animated canvas with MediaRecorder in every format Twinlink
 * offers, then verifies the produced bytes are WebM (EBML) or MP4 (ftyp) and
 * that the default format works. This proves the encoder/container choices, not
 * the save dialog (which is a native OS dialog and cannot be automated).
 *
 * Run with: npm run check:recording
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ARTIFACTS = path.join(__dirname, '.artifacts');
const REPORT_FILE = path.join(ARTIFACTS, 'recording-report.json');
const TIMEOUT_MS = 90000;

const FORMATS = [
  { id: 'webm-vp9', container: 'webm', mime: 'video/webm;codecs=vp9' },
  { id: 'webm-vp8', container: 'webm', mime: 'video/webm;codecs=vp8' },
  { id: 'webm-av1', container: 'webm', mime: 'video/webm;codecs=av01' },
  { id: 'mp4-h264', container: 'mp4', mime: 'video/mp4;codecs=avc1.42E01E' },
];

function writeReport(report) {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function hasMagic(container, buffer) {
  if (container === 'webm') {
    return buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp';
}

/**
 * Runs inside the renderer. Records a 320x240 animated canvas for `durationMs`
 * and resolves with the bytes as base64 so the main process can validate them.
 */
async function recordInRenderer({ mime, durationMs }) {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext('2d');
  let frame = 0;

  const paint = () => {
    frame += 1;
    ctx.fillStyle = `hsl(${(frame * 12) % 360} 70% 45%)`;
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = '#fff';
    ctx.font = '28px sans-serif';
    ctx.fillText(`Twinlink ${frame}`, 20, 130);
  };
  paint();
  const painter = setInterval(paint, 33);

  const stream = canvas.captureStream(30);
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2000000 });

  try {
    await new Promise((resolve, reject) => {
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener('error', (event) => reject(event.error || new Error('MediaRecorder error')));
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.start(250);
      setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, durationMs);
    });
  } finally {
    clearInterval(painter);
    for (const track of stream.getTracks()) track.stop();
  }

  const blob = new Blob(chunks, { type: mime });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return { base64: btoa(binary), chunks: chunks.length, bytes: bytes.length };
}

async function main() {
  const report = {
    startedAt: new Date().toISOString(),
    formats: [],
    ok: false,
    error: null,
  };

  let win = null;

  const finish = (code, error) => {
    report.finishedAt = new Date().toISOString();
    report.error = error ? String(error.message || error) : null;
    report.ok = code === 0;
    try {
      writeReport(report);
    } catch (writeError) {
      console.error('[recording] could not write report:', writeError.message);
    }
    console.log('[recording] --------------------------------------------------');
    console.log(
      '[recording] RESULT:',
      JSON.stringify({
        ok: report.ok,
        formats: report.formats.map((item) => ({
          id: item.id,
          supported: item.supported,
          bytes: item.bytes,
          magicOk: item.magicOk,
          error: item.error,
        })),
        error: report.error,
      }),
    );
    console.log(`[recording] report: ${REPORT_FILE}`);
    console.log('[recording] --------------------------------------------------');
    if (win && !win.isDestroyed()) win.destroy();
    app.quit();
    setTimeout(() => app.exit(code), 2000);
  };

  const timer = setTimeout(() => finish(1, new Error(`recording check timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);

  win = new BrowserWindow({
    width: 480,
    height: 360,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setBackgroundThrottling(false);

  await win.loadURL('data:text/html,<html><body></body></html>');

  const supported = await win.webContents.executeJavaScript(`(() => {
    const types = ${JSON.stringify(FORMATS.map((item) => item.mime))};
    return types.map((type) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));
  })()`);

  for (let index = 0; index < FORMATS.length; index += 1) {
    const format = FORMATS[index];
    const entry = {
      id: format.id,
      container: format.container,
      mime: format.mime,
      supported: supported[index] === true,
      bytes: 0,
      chunks: 0,
      magicOk: false,
      file: null,
      error: null,
    };

    if (!entry.supported) {
      entry.error = 'MediaRecorder.isTypeSupported returned false';
      report.formats.push(entry);
      continue;
    }

    try {
      const result = await win.webContents.executeJavaScript(
        `(${recordInRenderer.toString()})(${JSON.stringify({
          mime: format.mime,
          durationMs: 1500,
        })})`,
        true,
      );
      const buffer = Buffer.from(result.base64, 'base64');
      const file = path.join(ARTIFACTS, `recording-${format.id}.${format.container}`);
      fs.mkdirSync(ARTIFACTS, { recursive: true });
      fs.writeFileSync(file, buffer);

      entry.bytes = buffer.length;
      entry.chunks = result.chunks;
      entry.magicOk = hasMagic(format.container, buffer);
      entry.file = path.relative(path.join(__dirname, '..'), file);
      if (!entry.magicOk) entry.error = `bytes are not a valid ${format.container.toUpperCase()} file`;
      else if (buffer.length < 1000) entry.error = 'recording is implausibly small';
    } catch (error) {
      entry.error = String(error.message || error);
    }

    report.formats.push(entry);
  }

  clearTimeout(timer);

  if (!supported[0]) {
    finish(1, new Error('the default WebM VP9 encoder is unavailable in this build'));
    return;
  }

  const failures = report.formats.filter((item) => item.supported && item.error);
  if (failures.length > 0) {
    finish(1, new Error(`recording failed for: ${failures.map((item) => item.id).join(', ')}`));
    return;
  }

  finish(0, null);
}

app.whenReady().then(main).catch((error) => {
  console.error('[recording] fatal:', error);
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
