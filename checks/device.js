'use strict';

/**
 * Runs the real-device end-to-end check against an attached, authorized phone.
 * Usage: npm run check:device
 *
 * This is the only check that proves USB mirroring works on hardware. It drives
 * the real application (renderer -> preload -> IPC -> adb -> scrcpy-server ->
 * WebCodecs -> canvas) and writes JSON + PNG evidence to checks/.artifacts/.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electron = require('electron');
const root = path.join(__dirname, '..');
const artifacts = path.join(__dirname, '.artifacts');
const reportPath = path.join(artifacts, 'device-report.json');
const profilePath = path.join(artifacts, 'device-profile');

const TIMEOUT_MS = 180000;

fs.mkdirSync(artifacts, { recursive: true });
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
    TWINLINK_DEVICE_CHECK: '1',
    TWINLINK_DEVICE_REPORT: reportPath,
  },
  stdio: 'inherit',
  windowsHide: false,
});

const timer = setTimeout(() => {
  console.error(`[device] timed out after ${TIMEOUT_MS} ms; terminating`);
  child.kill();
}, TIMEOUT_MS);

child.on('error', (error) => {
  clearTimeout(timer);
  console.error('[device] could not start Electron:', error.message);
  process.exit(1);
});

child.on('exit', (code) => {
  clearTimeout(timer);

  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    console.error(
      '[device] no report was produced. Is an Android phone attached and authorized? (`adb devices -l`)',
    );
    process.exit(code && code !== 0 ? code : 1);
  }

  console.log('[device] --------------------------------------------------');
  console.log(
    '[device] RESULT:',
    JSON.stringify({
      ok: report.ok,
      device: report.device?.model || report.device?.serial || null,
      serial: report.device?.serial || null,
      frames: report.frames?.count ?? 0,
      canvas: report.renderer?.canvas || null,
      distinctColors: report.renderer?.distinctColors ?? 0,
      rotate: report.control?.rotate?.after || null,
      forwards: report.cleanup?.forwards ?? null,
      errors: report.errors || [],
    }),
  );
  console.log('[device] --------------------------------------------------');

  if (report.ok) process.exit(0);
  process.exit(code && code !== 0 ? code : 1);
});
