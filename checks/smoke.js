'use strict';

/**
 * Launches the real Twinlink application with a smoke hook and reports whether
 * the renderer shell loaded cleanly. Usage: npm run check
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electron = require('electron');
const root = path.join(__dirname, '..');
const artifacts = path.join(__dirname, '.artifacts');
const reportPath = path.join(artifacts, 'smoke-report.json');
// Isolated profile: another Twinlink instance (e.g. a second checkout) would
// otherwise hold the single-instance lock and make this check exit silently.
const profilePath = path.join(artifacts, 'smoke-profile');

const TIMEOUT_MS = 60000;

try {
  fs.unlinkSync(reportPath);
} catch {
  /* no previous report */
}
fs.rmSync(profilePath, { recursive: true, force: true });

const child = spawn(electron, ['.', `--user-data-dir=${profilePath}`], {
  cwd: root,
  env: {
    ...process.env,
    TWINLINK_SMOKE: '1',
    TWINLINK_SMOKE_REPORT: reportPath,
  },
  stdio: 'inherit',
  windowsHide: false,
});

const timer = setTimeout(() => {
  console.error(`[smoke] timed out after ${TIMEOUT_MS} ms; terminating`);
  child.kill();
}, TIMEOUT_MS);

child.on('error', (error) => {
  clearTimeout(timer);
  console.error('[smoke] could not start Electron:', error.message);
  process.exit(1);
});

child.on('exit', (code) => {
  clearTimeout(timer);

  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    console.error('[smoke] no report was produced');
    process.exit(code === 0 ? 1 : code || 1);
  }

  console.log('[smoke] --------------------------------------------------');
  console.log(
    '[smoke] RESULT:',
    JSON.stringify({
      ok: report.ok,
      activeView: report.state?.activeView || null,
      bridge: report.state?.hasBridge,
      deviceCards: report.state?.deviceCards ?? null,
      consoleErrors: report.consoleErrors?.length ?? 0,
      failures: report.failures || [],
    }),
  );
  console.log('[smoke] --------------------------------------------------');

  if (report.ok) {
    process.exit(0);
  }
  process.exit(code && code !== 0 ? code : 1);
});
