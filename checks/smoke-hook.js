'use strict';

/**
 * Dev-only smoke hook, loaded by src/main/main.js when TWINLINK_SMOKE=1.
 * It inspects the loaded renderer, records console errors, writes a JSON report
 * and exits, so `npm run check` can validate the real application shell.
 */
function install({ app, win, reportPath }) {
  const fs = require('node:fs');
  const path = require('node:path');

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

      const ok =
        Boolean(state) &&
        state.hasBridge === true &&
        state.tabs === 3 &&
        state.hasCanvas === true &&
        state.hasMirrorPlaceholder === true &&
        state.recordingFormatOptions === 4 &&
        typeof state.recordingFormat === 'string' &&
        consoleErrors.length === 0 &&
        failures.length === 0;

      const report = {
        ok,
        checkedAt: new Date().toISOString(),
        state,
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
      console.log(`[smoke] RESULT: ${JSON.stringify({ ok, state, consoleErrors: consoleErrors.length, failures })}`);

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
