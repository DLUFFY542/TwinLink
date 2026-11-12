'use strict';

/**
 * Dev-only smoke hook, loaded by src/main/main.js when TWINLINK_SMOKE=1.
 * It inspects the loaded renderer, records console errors, writes a JSON report
 * and exits, so `npm run check` can validate the real application shell.
 */
function install({ app, win, reportPath }) {
  const fs = require('node:fs');
  const path = require('node:path');
  const jsQR = require('jsqr');

  const messages = [];
  const failures = [];

  const record = (level, message, source) => {
    messages.push({
      level: typeof level === 'string' ? level : Number(level),
      message: String(message || ''),
      source: source ? String(source) : null,
      at: Date.now(),
    });
  };

  /** Render a QR matrix to RGBA pixels so an independent decoder can read it. */
  const renderMatrix = (modules, scale = 8, quietZone = 4) => {
    const size = modules.length;
    const total = size + quietZone * 2;
    const width = total * scale;
    const height = total * scale;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);

    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        if (!modules[row][column]) continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = (column + quietZone) * scale + dx;
            const y = (row + quietZone) * scale + dy;
            const offset = (y * width + x) * 4;
            data[offset] = 0;
            data[offset + 1] = 0;
            data[offset + 2] = 0;
          }
        }
      }
    }

    return { data, width, height };
  };

  win.webContents.on('console-message', (_event, ...args) => {
    const details = args[0];
    if (details && typeof details === 'object') {
      record(details.level, details.message, details.sourceId);
    } else {
      record(args[0], args[1], args[2]);
    }
  });

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    failures.push(`did-fail-load ${code} ${description} ${url}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    failures.push(`render-process-gone ${details.reason}`);
  });

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    failures.push(`preload-error ${preloadPath}: ${error.message}`);
  });

  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      let state = null;
      try {
        state = await win.webContents.executeJavaScript(`(() => ({
          title: document.title,
          hasBridge: typeof window.twinlink === 'object' && window.twinlink !== null,
          bridgeMethods: window.twinlink ? Object.keys(window.twinlink).sort() : [],
          tabs: document.querySelectorAll('.tab').length,
          views: [...document.querySelectorAll('.view')].map((node) => node.id),
          activeView: document.querySelector('.view.is-active')?.id || null,
          theme: document.documentElement.dataset.theme || null,
          adbChip: document.getElementById('adb-chip-text')?.textContent || null,
          deviceCards: document.querySelectorAll('.device-card').length,
          emptyStateVisible: !document.getElementById('dashboard-empty')?.classList.contains('hidden'),
          hasCanvas: Boolean(document.getElementById('phone-canvas')),
          hasMirrorPlaceholder: Boolean(document.getElementById('stage-placeholder')),
          settingsPath: document.getElementById('diag-settings-path')?.textContent || null,
          recordingFormat: document.getElementById('set-recording-format')?.value || null,
          recordingFormatOptions: document.querySelectorAll('#set-recording-format option').length,
          recordingFormatNote: document.getElementById('recording-format-note')?.textContent || null,
          csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || null,
        }))()`);
      } catch (error) {
        failures.push(`executeJavaScript: ${error.message}`);
      }

      const consoleErrors = messages.filter((entry) => entry.level === 'error' || entry.level >= 3);
      const consoleWarnings = messages.filter((entry) => entry.level === 'warning' || entry.level === 2);

      // Wireless QR pairing: drive the real UI, then decode the generated code
      // with an independent QR decoder to prove a phone could scan it.
      let qr = null;
      try {
        const result = await win.webContents.executeJavaScript(`(async () => {
          document.querySelector('[data-wtab="qr"]').click();
          document.getElementById('do-qr').click();
          await new Promise((resolve) => setTimeout(resolve, 900));
          const canvas = document.getElementById('qr-canvas');
          const session = await window.twinlink.wireless.pairingSession();
          const { drawQr } = await import('./js/qr-render.js');
          const scratch = document.createElement('canvas');
          drawQr(scratch, session.qr);
          return {
            visible: !document.getElementById('qr-wrap').classList.contains('hidden'),
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
            code: session.code,
            payload: session.payload,
            modules: session.qr.modules,
          };
        })()`);

        const rendered = renderMatrix(result.modules);
        const decoded = jsQR(rendered.data, rendered.width, rendered.height);
        qr = {
          visible: result.visible === true,
          canvasWidth: result.canvasWidth,
          canvasHeight: result.canvasHeight,
          code: result.code,
          payload: result.payload,
          decoded: decoded ? decoded.data : null,
          decodedMatches: Boolean(decoded) && decoded.data === result.payload,
        };
      } catch (error) {
        failures.push(`qr pairing: ${error.message}`);
      }

      const ok =
        Boolean(state) &&
        state.hasBridge === true &&
        state.tabs === 3 &&
        state.hasCanvas === true &&
        state.hasMirrorPlaceholder === true &&
        state.recordingFormatOptions === 4 &&
        typeof state.recordingFormat === 'string' &&
        Boolean(qr) &&
        qr.visible === true &&
        qr.canvasWidth > 0 &&
        qr.canvasHeight > 0 &&
        qr.decodedMatches === true &&
        consoleErrors.length === 0 &&
        failures.length === 0;

      const report = {
        ok,
        checkedAt: new Date().toISOString(),
        state,
        qr,
        consoleErrors,
        consoleWarnings,
        failures,
        messages,
      };

      try {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      } catch (error) {
        console.error('[smoke] could not write report:', error.message);
      }

      console.log(`[smoke] report: ${reportPath}`);
      console.log(
        `[smoke] RESULT: ${JSON.stringify({ ok, state, qr, consoleErrors: consoleErrors.length, failures })}`,
      );

      // Quit gracefully so Electron's child processes do not outlive the check.
      try {
        win.destroy();
      } catch {
        /* already gone */
      }
      app.quit();
      setTimeout(() => app.exit(ok ? 0 : 1), 2000);
    }, 3000);
  });
}

module.exports = { install };
