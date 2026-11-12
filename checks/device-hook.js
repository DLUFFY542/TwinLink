'use strict';

/**
 * Real-device end-to-end check, loaded by src/main/main.js when
 * TWINLINK_DEVICE_CHECK=1 and the app is unpackaged.
 *
 * Unlike checks/pipeline.js (mock transport), this drives the real application
 * against a physically attached Android phone:
 *
 *   renderer -> window.twinlink.mirror.start() -> IPC -> MirrorController
 *     -> adb push/forward -> scrcpy-server v4.0 -> real H.264 stream
 *     -> VideoStreamParser -> IPC -> WebCodecs -> canvas
 *
 * It also sends a rotate action through the production input path and requires
 * the device's reported video size to swap, which is observable proof that the
 * phone acted on the injected control message.
 *
 * Evidence (JSON + PNG captures) is written to checks/.artifacts/, which is
 * git-ignored.
 */

const fs = require('node:fs');
const path = require('node:path');

const TOTAL_TIMEOUT_MS = 150000;
const MIN_FRAMES = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writePng(file, dataUrl) {
  const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');
  fs.writeFileSync(file, buffer);
  return { bytes: buffer.length, header: buffer.subarray(0, 8).toString('hex') };
}

function install({ app, win, runtime, reportPath, artifactsDir }) {
  fs.mkdirSync(artifactsDir, { recursive: true });

  const report = {
    startedAt: new Date().toISOString(),
    ok: false,
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    device: null,
    settings: null,
    checks: [],
    transport: {},
    renderer: {},
    control: {},
    cleanup: {},
    errors: [],
    evidence: {},
  };

  const check = (name, ok, detail) => {
    report.checks.push({ name, ok, detail: detail == null ? null : detail, at: new Date().toISOString() });
    console.log(`[device] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  let frameCount = 0;
  let frameBytes = 0;
  let firstFrameAt = 0;
  let lastFrameAt = 0;
  const sessionEvents = [];
  const stateEvents = [];

  runtime.mirror.on('frame', (frame) => {
    frameCount += 1;
    frameBytes += frame?.data?.length || 0;
    if (!firstFrameAt) firstFrameAt = Date.now();
    lastFrameAt = Date.now();
  });
  runtime.mirror.on('session', (info) => sessionEvents.push({ ...info, at: Date.now() }));
  runtime.mirror.on('state', (snapshot) => stateEvents.push({ state: snapshot.state, at: Date.now() }));
  runtime.mirror.on('error', (error) => report.errors.push(String(error.message || error)));
  runtime.mirror.on('failed', (info) => report.errors.push(String(info.error)));

  const exec = (code) => win.webContents.executeJavaScript(code, true);

  async function waitFor(fn, timeoutMs, label) {
    const started = Date.now();
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`${label} timed out after ${timeoutMs} ms`);
      }
      await sleep(250);
    }
  }

  const canvasStats = () =>
    exec(`(() => {
      const canvas = document.getElementById('phone-canvas');
      if (!canvas || !canvas.width) return null;
      const context = canvas.getContext('2d', { alpha: false });
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set();
      const step = 16;
      for (let y = 0; y < canvas.height; y += step) {
        for (let x = 0; x < canvas.width; x += step) {
          const offset = (y * canvas.width + x) * 4;
          colors.add((pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2]);
        }
      }
      return {
        width: canvas.width,
        height: canvas.height,
        distinctColors: colors.size,
        mirrorViewActive: document.getElementById('view-mirror').classList.contains('is-active'),
        mirrorTabSelected: document.querySelector('.tab[data-view="mirror"]').getAttribute('aria-selected'),
        placeholderHidden: document.getElementById('stage-placeholder').classList.contains('hidden'),
      };
    })()`);

  const capture = async (fileName) => {
    const image = await win.webContents.capturePage();
    const buffer = image.toPNG();
    fs.writeFileSync(path.join(artifactsDir, fileName), buffer);
    return { file: fileName, bytes: buffer.length, size: image.getSize() };
  };

  let finished = false;

  const finish = async (ok, error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);

    if (error) report.errors.push(String(error.message || error));
    report.ok = ok;
    report.finishedAt = new Date().toISOString();
    report.frames = { count: frameCount, bytes: frameBytes, firstFrameAt, lastFrameAt };

    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    } catch (writeError) {
      console.error('[device] could not write report:', writeError.message);
    }

    console.log('[device] --------------------------------------------------');
    console.log(
      '[device] RESULT:',
      JSON.stringify({
        ok: report.ok,
        device: report.device?.serial || null,
        model: report.device?.model || null,
        frames: frameCount,
        canvas: report.renderer.canvas || null,
        distinctColors: report.renderer.distinctColors ?? 0,
        rotate: report.control.rotate?.after || null,
        errors: report.errors,
      }),
    );
    console.log(`[device] report: ${reportPath}`);
    console.log(`[device] evidence: ${artifactsDir}`);
    console.log('[device] --------------------------------------------------');

    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch {
      /* already gone */
    }
    app.quit();
    setTimeout(() => app.exit(report.ok ? 0 : 1), 2000);
  };

  const timer = setTimeout(() => {
    void finish(false, new Error(`device check timed out after ${TOTAL_TIMEOUT_MS} ms`));
  }, TOTAL_TIMEOUT_MS);

  async function run() {
    win.show();
    win.focus();

    // 1. Discovery through the production adb path + device manager.
    const adbInfo = await runtime.refreshAdb();
    report.adb = adbInfo;
    await runtime.devices.refresh();

    const snapshot = await waitFor(() => {
      const current = runtime.devices.getSnapshot();
      const device = current.devices.find((entry) => entry.state === 'device');
      return device ? current : null;
    }, 30000, 'authorized device');

    const device = snapshot.devices.find((entry) => entry.state === 'device');
    report.device = {
      serial: device.serial,
      state: device.state,
      connection: device.connection,
      model: device.model,
      details: device.details,
      adbPath: adbInfo.path,
      adbSource: adbInfo.source,
      adbVersion: adbInfo.version,
    };
    report.settings = runtime.settings.get();
    check('device discovered and authorized', true, `${device.model || device.serial} (${device.serial})`);

    // 2. Start mirroring through the same renderer -> preload -> IPC path the
    //    Connect button uses, and switch the UI to the mirror view.
    const startedSerial = await exec(`(async () => {
      const current = await window.twinlink.devices.snapshot();
      const target = current.devices.find((entry) => entry.state === 'device');
      if (!target) throw new Error('no authorized device in renderer snapshot');
      await window.twinlink.mirror.start(target.serial);
      document.querySelector('.tab[data-view="mirror"]').click();
      return target.serial;
    })()`);
    check('renderer connect path accepted', startedSerial === device.serial, startedSerial);

    const streaming = await waitFor(() => {
      const current = runtime.mirror.getSnapshot();
      return current.state === 'streaming' && frameCount > 0 ? current : null;
    }, 40000, 'streaming state');
    report.transport = {
      state: streaming.state,
      serial: streaming.serial,
      deviceName: streaming.deviceName,
      width: streaming.width,
      height: streaming.height,
      codec: streaming.codec,
      audio: streaming.audio,
      sessionEvents: sessionEvents.slice(),
      stateEvents: stateEvents.slice(),
    };
    check('first video frame received', frameCount > 0, `${frameCount} frames, ${frameBytes} bytes, ${Date.now() - firstFrameAt} ms since first`);

    // 3. Wait for a stable picture, then inspect what is actually on the canvas.
    await waitFor(() => frameCount >= MIN_FRAMES, 20000, `${MIN_FRAMES} video frames`);

    const rateStart = { at: Date.now(), frames: frameCount };
    await sleep(3000);
    const observedFps = (frameCount - rateStart.frames) / ((Date.now() - rateStart.at) / 1000);

    let stats = null;
    try {
      stats = await waitFor(canvasStats, 8000, 'canvas pixels');
    } catch (error) {
      report.errors.push(error.message);
    }
    if (!stats) throw new Error('renderer canvas never produced readable pixels');

    report.renderer = {
      canvas: { width: stats.width, height: stats.height },
      distinctColors: stats.distinctColors,
      mirrorViewActive: stats.mirrorViewActive,
      mirrorTabSelected: stats.mirrorTabSelected,
      placeholderHidden: stats.placeholderHidden,
      observedFps: Number(observedFps.toFixed(1)),
      stats: runtime.mirror.getSnapshot(),
    };
    check('canvas shows a decoded, non-uniform picture', stats.distinctColors >= 8, `${stats.width}x${stats.height}, ${stats.distinctColors} colours`);
    check('mirror view is visible', stats.mirrorViewActive === true);
    report.evidence.portrait = await capture('device-mirror-portrait.png');
    check('window capture written', report.evidence.portrait.bytes > 10000, report.evidence.portrait.file);

    // 4. Screenshot export (the part of the button flow that does not require
    //    a native save dialog): canvas -> PNG blob.
    const dataUrl = await exec(`(async () => {
      const canvas = document.getElementById('phone-canvas');
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('canvas export failed'))), 'image/png');
      });
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('png read failed'));
        reader.readAsDataURL(blob);
      });
    })()`);
    const png = writePng(path.join(artifactsDir, 'device-canvas.png'), dataUrl);
    report.evidence.canvasPng = { file: 'device-canvas.png', ...png };
    check('canvas exported a valid PNG', png.header.startsWith('89504e470d0a1a0a'), `${png.bytes} bytes`);

    // 5. Control proof: inject rotate through the real input path and require
    //    the device's video dimensions to swap.
    const before = runtime.mirror.getSnapshot();
    report.control.rotate = {
      before: { width: before.width, height: before.height },
      sent: false,
      after: null,
      restored: null,
    };
    try {
      await exec(`window.twinlink.mirror.sendInput({ type: 'action', name: 'rotate' }); true`);
      report.control.rotate.sent = true;
      const rotated = await waitFor(() => {
        const current = runtime.mirror.getSnapshot();
        return current.width === before.height && current.height === before.width
          ? { width: current.width, height: current.height }
          : null;
      }, 20000, 'device rotation');
      report.control.rotate.after = rotated;
      check('rotate injected and device rotated', true, `${before.width}x${before.height} -> ${rotated.width}x${rotated.height}`);

      await sleep(1000);
      const landscapeStats = await canvasStats();
      report.control.rotate.canvas = landscapeStats
        ? { width: landscapeStats.width, height: landscapeStats.height, distinctColors: landscapeStats.distinctColors }
        : null;
      report.evidence.landscape = await capture('device-mirror-landscape.png');

      await exec(`window.twinlink.mirror.sendInput({ type: 'action', name: 'rotate' }); true`);
      await waitFor(() => {
        const current = runtime.mirror.getSnapshot();
        return current.width === before.width && current.height === before.height ? true : null;
      }, 20000, 'rotation restore');
      report.control.rotate.restored = { width: before.width, height: before.height };
      check('device rotated back to portrait', true);
    } catch (error) {
      check('rotate injected and device rotated', false, error.message);
      report.errors.push(error.message);
    }

    // 6. Stop through the production controller and verify cleanup.
    const stopStart = Date.now();
    await runtime.mirror.stop('device check complete');
    await sleep(700);
    let forwards = '';
    try {
      forwards = (await runtime.adb.exec(['forward', '--list'])).stdout.trim();
    } catch (error) {
      report.errors.push(`forward list failed: ${error.message}`);
    }
    report.cleanup = {
      state: runtime.mirror.getSnapshot().state,
      stopMs: Date.now() - stopStart,
      forwards,
      framesAtStop: frameCount,
    };
    check('session stopped cleanly', report.cleanup.state === 'stopped', report.cleanup.state);
    check('adb forward removed', forwards === '', forwards || '(none)');

    const ok =
      report.errors.length === 0 &&
      frameCount >= MIN_FRAMES &&
      report.renderer.distinctColors >= 8 &&
      report.renderer.canvas.width > 0 &&
      Boolean(report.control.rotate.after) &&
      report.cleanup.forwards === '';
    await finish(ok, ok ? null : new Error('one or more device checks failed'));
  }

  const start = () => run().catch((error) => finish(false, error));

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(start, 1500);
    });
  } else {
    setTimeout(start, 1500);
  }
}

module.exports = { install };
